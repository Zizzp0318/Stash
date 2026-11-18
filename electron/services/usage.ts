// `.thumbs` 缓存占用的**缓存化记账**。
//
// 为什么需要这个模块（实测，2026-11-08）：
//   侧栏「占用空间」在开库时会调一次 `library:usage`，而它原先每次都把 `.thumbs` 下
//   **每个文件 statSync 一遍**（两层目录 + 3~4 个产物/素材）。同步遍历把主进程整条事件循环
//   钉死，于是整个界面「点不动、滚不动」：
//
//   | 素材数 | .thumbs 文件数 | 一次 usage 的同步耗时 | cacheStats（同类遍历） |
//   |---|---|---|---|
//   | 2 万   | ~4 万          | 1104 ms                | 872 ms |
//   | 5 万   | ~10 万         | 2838 ms                | 2241 ms |
//
//   它不只开库跑：`counts` 一变（导入/删除/压缩）侧栏就会再算一次 —— 相当于每次导入收尾
//   再冻一次界面。而真正需要精确数字的时机几乎没有：那行字本来就是「看个大概」，旁边还有刷新按钮。
//
// 策略：**增量记账 + 缺账时异步分块重算**。
//   ① 有账（`meta.thumbs_bytes`）就直接读一行，开库路径 0 ms；
//   ② 缩略图/派生预览写入与删除时按字节差累加（`bumpThumbsBytes`）——
//      写入点只有三处（`thumbs.renameTmp` / `preview.renameOverwrite` / 清理路径）；
//   ③ 账不存在（新库、老库首次升级、外部动过 `.thumbs`）→ `recountThumbsBytesAsync()`
//      分块遍历（每 200 个 hash 目录让出一次事件循环），算完写回 `meta` 并**推事件**给渲染层。
//
// ⚠️ 纪律：本模块只碰 `meta` 与 `.thumbs` 的**只读**遍历，绝不删任何文件。
import { readdir, stat } from 'fs/promises'
import { readdirSync, statSync } from 'fs'
import { join } from 'path'
import { requireCurrent } from './library'
import type { DB } from './db'

/** `meta` 表里存「.thumbs 总字节数」的键（值是十进制字符串，与 schema_version 同一套约定） */
export const THUMBS_BYTES_KEY = 'thumbs_bytes'

/** 分块粒度：每遍历这么多个 hash 目录让出一次事件循环（让 IPC / 绘制有机会插进来） */
const YIELD_EVERY = 200

/** 读缓存值；`null` = 还没记过账（调用方应触发一次异步重算） */
export function cachedThumbsBytes(db: DB): number | null {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key=?').get(THUMBS_BYTES_KEY) as
      | { value?: string }
      | undefined
    if (!row || row.value == null) return null
    const n = Number(row.value)
    return Number.isFinite(n) && n >= 0 ? n : null
  } catch {
    return null
  }
}

function writeCachedThumbsBytes(db: DB, bytes: number): void {
  db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run(THUMBS_BYTES_KEY, String(Math.max(0, Math.round(bytes))))
}

/**
 * 按**增量**更新账本（缩略图/派生预览写入为正，清理为负）。
 *
 * ⚠️ 没有账本时**什么都不做**：一个「从 0 开始累加」的偏小数字比没有更糟（用户会以为缓存很小），
 * 这种情况下留给 `recountThumbsBytesAsync()` 给出真值。没有打开的库时静默跳过（脚本/冒烟里常见）。
 */
export function bumpThumbsBytes(delta: number): void {
  if (!delta) return
  try {
    const { db } = requireCurrent()
    const cur = cachedThumbsBytes(db)
    if (cur == null) return
    writeCachedThumbsBytes(db, cur + delta)
  } catch {
    /* 没开库 / 连接已关：记账失败不影响主流程 */
  }
}

/**
 * 把账本置脏（整行 DELETE）。
 *
 * 用在「清理路径没法精确给出释放量」的地方（例如体检删掉了整个 hash 目录）。
 * 下次 `library:usage` 读到 `null` 会自己排一次异步重算 —— 也就是「先显示旧值/空，随后自愈」。
 * 与 `thumbs` 的 `grid_presence_dirty` 用同一种写法（**洗白是 DELETE，不写 '0'**）。
 */
export function markThumbsBytesDirty(): void {
  try {
    requireCurrent().db.prepare('DELETE FROM meta WHERE key=?').run(THUMBS_BYTES_KEY)
  } catch {
    /* ignore */
  }
}

/** 账本更新后的通知口（由 `main.ts` 接上：把新的 usage 推给渲染层） */
let onUpdated: (() => void) | null = null
export function setThumbsBytesNotifier(fn: (() => void) | null): void {
  onUpdated = fn
}

/** 重算进行中（单飞：开库 + 面板同时要，只跑一份） */
let recounting: Promise<number | null> | null = null

/**
 * 同步遍历（两层：`.thumbs/<hash>/<file>`）。**只给测试/兜底用**，正常路径别再调它。
 */
export function thumbsDirBytesSync(root: string): number {
  let hashes: string[]
  try {
    hashes = readdirSync(root)
  } catch {
    return 0
  }
  let total = 0
  for (const h of hashes) {
    const dir = join(root, h)
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }
    for (const f of files) {
      try {
        total += statSync(join(dir, f)).size
      } catch {
        /* 正被写入/刚被清理，跳过 */
      }
    }
  }
  return total
}

/**
 * 异步分块重算 `.thumbs` 总字节数，写回 `meta` 并通知渲染层。
 *
 * 每 `YIELD_EVERY` 个目录 `await setImmediate` 让出一次 —— 遍历期间主进程仍能处理 IPC、
 * 渲染层也不会被卡住（这正是它相对同步版的全部意义）。
 *
 * 切库安全：算完先核对「库还是同一个」再写账，否则会把 A 库的数字写进 B 库。
 *
 * @returns 重算出的字节数；失败/无库返回 `null`
 */
export function recountThumbsBytesAsync(): Promise<number | null> {
  if (recounting) return recounting
  recounting = (async (): Promise<number | null> => {
    let libPath = ''
    let db: DB
    try {
      const cur = requireCurrent()
      libPath = cur.path
      db = cur.db
    } catch {
      return null
    }
    let total = 0
    try {
      const hashes = await readdir(join(libPath, '.thumbs'))
      for (let i = 0; i < hashes.length; i++) {
        const dir = join(libPath, '.thumbs', hashes[i])
        try {
          const files = await readdir(dir)
          for (const f of files) {
            try {
              total += (await stat(join(dir, f))).size
            } catch {
              /* 遍历途中被删（并发清理）就跳过 */
            }
          }
        } catch {
          /* 目录刚被删掉/改名，跳过 */
        }
        if (i > 0 && i % YIELD_EVERY === 0) {
          await new Promise<void>((r) => setImmediate(r))
        }
      }
      // 切库核对：遍历是异步的，中途用户可能换了库
      let stillSame = false
      try {
        stillSame = requireCurrent().path === libPath
      } catch {
        stillSame = false
      }
      if (!stillSame) return null
      writeCachedThumbsBytes(db, total)
    } catch {
      return null
    } finally {
      recounting = null
    }
    try {
      onUpdated?.()
    } catch {
      /* 通知失败不影响数值 */
    }
    return total
  })()
  return recounting
}

/** 目前是否有一次重算在飞（冒烟用来断言「只跑一份」） */
export function isRecountingThumbsBytes(): boolean {
  return recounting !== null
}
