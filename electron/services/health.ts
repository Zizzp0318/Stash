// 库体检：找出「索引里还在、磁盘上文件已经没了」的素材。
//
// 这类行怎么来的：文件被别的程序删掉/移走，而监听器没收到事件（应用没开着、
// 网络盘掉线、批量操作没触发 unlink…）。它们在界面上表现为一张**点不开的灰卡**，
// 而用户完全不知道发生了什么 —— 这是目前唯一能看到并清理它们的入口。
//
// 边界：本模块只**报告**与**按用户明确指令清理索引行**，
// 绝不自动删磁盘上的任何用户文件。
import { readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { requireCurrent, getLibrary, pruneUnlinkedTags } from './library'
import { isThumbHash } from './paths'
import { bumpThumbsBytes, cachedThumbsBytes, recountThumbsBytesAsync } from './usage'

export interface LibraryStats {
  name: string
  path: string
  /** 索引里有效素材数（missing=0） */
  assets: number
  /** 索引标记为失效的条数（可能滞后于现实，精确值要跑一次体检） */
  missingFlagged: number
  /** 素材文件占用（字节，不含 .thumbs 缓存） */
  bytes: number
}

/** 快：纯查库，不碰磁盘。面板一打开就能显示，适合大库 */
export function libraryStats(): LibraryStats {
  const { db, path } = requireCurrent()
  const one = (sql: string): number => (db.prepare(sql).get() as { c: number }).c
  return {
    name: getLibrary()?.name ?? '',
    path,
    assets: one('SELECT count(*) AS c FROM assets WHERE missing=0'),
    missingFlagged: one('SELECT count(*) AS c FROM assets WHERE missing=1'),
    // size 是导入时记下的原始文件大小，不需要再 stat 一遍
    bytes: (db.prepare('SELECT coalesce(sum(size),0) AS c FROM assets WHERE missing=0').get() as { c: number }).c
  }
}

/**
 * ⚠️ 这里曾经有一个 `thumbsDirBytes()`（同步遍历 `.thumbs` 两层）。
 * 它现在搬到了 `usage.ts` 的 `thumbsDirBytesSync()`，**只给测试/兜底用** ——
 * 开库路径上不许再同步遍历（2 万条 1.1 s、5 万条 2.8 s，正是「开库卡死」的根因）。
 */

export interface LibraryUsage {
  /** 素材文件占用（索引里的 size 之和，不碰磁盘） */
  assetsBytes: number
  /**
   * `.thumbs` 缩略图缓存占用。
   *
   * ⚠️ 这个值来自**账本**（`meta.thumbs_bytes`，由 `usage.ts` 增量维护），不再每次遍历目录 ——
   * 同步遍历 `.thumbs` 在 2 万条库上要 1.1 秒、5 万条要 2.8 秒，而那正是「开库卡死」的根因。
   * 账还没算出来时它是 0，同时 `thumbsPending` 为 true，稍后由异步重算推事件补上。
   */
  thumbsBytes: number
  totalBytes: number
  /** 账本还没算出来（首次开库 / 外部动过 .thumbs）：界面显示 `…`，后台正在重算 */
  thumbsPending?: boolean
}

/**
 * 库占用空间 —— 侧栏那一行用的。
 *
 * 与 `libraryStats()` 分开的原因：那个要「快、一打开面板就有」，而这里多了缓存占用。
 *
 * ⚠️ **开库路径上必须是 O(1)**：本函数现在只查一条 SQL（素材字节）+ 读一行 `meta`（缓存字节），
 * 实测 2 万/5 万条库都是亚毫秒级。历史上它在这里同步遍历 `.thumbs`（2 万条 1.1 s、5 万条 2.8 s），
 * 而且侧栏 `watch(counts.total)` 一变就再算一次 —— 等于每次导入/删除都冻一次界面。
 * 需要精确值时用刷新按钮（`refreshUsage`）或让账本缺失后自动重算（见 `usage.ts`）。
 */
export function libraryUsage(): LibraryUsage {
  const { db } = requireCurrent()
  const assetsBytes = (
    db.prepare('SELECT coalesce(sum(size),0) AS c FROM assets WHERE missing=0').get() as { c: number }
  ).c
  const cached = cachedThumbsBytes(db)
  if (cached == null) {
    // 没有账本：先把界面交出去，重算跑在后台（分块遍历，不阻塞事件循环），
    // 算完写回 meta 并由 `main.ts` 接好的通知口推一次 `library:usage`
    void recountThumbsBytesAsync()
    return { assetsBytes, thumbsBytes: 0, totalBytes: assetsBytes, thumbsPending: true }
  }
  return { assetsBytes, thumbsBytes: cached, totalBytes: assetsBytes + cached }
}

export interface ScanResult {
  /** 核对了多少个素材 */
  checked: number
  /** 磁盘上确实不在了的条数 */
  missing: number
  /** 抽样（最多 8 个名字），让用户看看是些什么东西再决定清不清 */
  samples: string[]
  /** 本次核对把多少行的 missing 标记**改成了一致**（索引自愈） */
  flagFixed: number
}

/**
 * 慢：逐个 statSync 核对磁盘。
 *
 * 为什么值得做全量核对而不只读 `missing` 标记：标记是监听器写进去的，
 * 监听失效时它**永远是 0**，光看标记会报「一切正常」——那正是用户最需要答案的时候。
 * 所以这是**用户显式点「开始体检」才跑**的动作，不挂在面板打开时自动跑。
 *
 * 顺手把 `missing` 标记按磁盘实况改写，让网格的灰卡样式与之一致（索引自愈）。
 */
export function scanMissing(): ScanResult {
  const { db, path } = requireCurrent()
  const rows = db
    .prepare('SELECT id, name, rel_path, missing FROM assets')
    .all() as Array<{ id: number; name: string; rel_path: string; missing: number }>

  const setFlag = db.prepare('UPDATE assets SET missing=? WHERE id=?')
  let gone = 0
  let flagFixed = 0
  const samples: string[] = []

  for (const r of rows) {
    const abs = join(path, ...r.rel_path.split('/'))
    // statSync 而不是 existsSync：existsSync 对「目录」也返回 true，
    // 同名目录（rel_path 指向目录）会被误判成「文件还在」。
    let ok = false
    try {
      ok = statSync(abs).isFile()
    } catch {
      ok = false
    }
    const shouldBeMissing = ok ? 0 : 1
    if (shouldBeMissing) {
      gone++
      if (samples.length < 8) samples.push(r.name)
    }
    if (shouldBeMissing !== r.missing) {
      setFlag.run(shouldBeMissing, r.id)
      flagFixed++
    }
  }
  return { checked: rows.length, missing: gone, samples, flagFixed }
}

export interface CleanMissingResult {
  removed: number
  /** 释放的缓存字节（.thumbs 里那些只服务失效素材的目录） */
  freed: number
  pruned: Array<{ id: number; name: string }>
}

/**
 * 清理失效索引行。
 *
 * **只删索引与缓存，不碰磁盘上的任何东西** —— 这些行的文件本来就已经不在了，
 * 所以这里不存在「删掉用户素材」的可能；但为了绝对安全，落刀前**再核一次磁盘**：
 * 万一文件又回来了（移动盘重新插上、网络盘恢复），这一行就保留、不动。
 *
 * 素材行删掉后 asset_tags 靠外键 CASCADE 消失，挂在它们上的标签可能归零，
 * 所以候选集**必须在 DELETE 之前取**（同 assets.ts 的 deleteAssets 那条铁律）。
 */
export function cleanMissing(): CleanMissingResult {
  const { db, path } = requireCurrent()
  const rows = db
    .prepare('SELECT id, rel_path, content_hash FROM assets WHERE missing=1')
    .all() as Array<{ id: number; rel_path: string; content_hash: string | null }>

  const ph = rows.map(() => '?').join(',')
  const affectedTagIds = rows.length
    ? (db.prepare(`SELECT DISTINCT tag_id FROM asset_tags WHERE asset_id IN (${ph})`).all(...rows.map((r) => r.id)) as Array<{ tag_id: number }>).map((r) => r.tag_id)
    : []

  const del = db.prepare('DELETE FROM assets WHERE id=?')
  const stillUsed = db.prepare('SELECT count(*) AS c FROM assets WHERE content_hash=?')

  let removed = 0
  let freed = 0
  for (const row of rows) {
    // 落刀前复核：文件又回来了就留下这一行（宁可少删，不可错删）
    try {
      if (statSync(join(path, ...row.rel_path.split('/'))).isFile()) {
        db.prepare('UPDATE assets SET missing=0 WHERE id=?').run(row.id)
        continue
      }
    } catch {
      /* 确实不在了，继续删 */
    }
    try {
      del.run(row.id)
      removed++
    } catch {
      continue
    }
    // 同 hash 仍被别的素材引用时，缓存要留着
    const hash = row.content_hash
    if (isThumbHash(hash) && !(stillUsed.get(hash) as { c: number }).c) {
      const dir = join(path, '.thumbs', hash)
      try {
        freed += dirSize(dir)
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 缓存清理失败不影响结果 */
      }
    }
  }
  // 体检删掉了整个 hash 目录（含派生预览）→ 账本按实际释放量扣减，别让下次开库去重建账
  bumpThumbsBytes(-freed)
  return { removed, freed, pruned: pruneUnlinkedTags(db, affectedTagIds) }
}

function dirSize(dir: string): number {
  let total = 0
  try {
    for (const f of readdirSync(dir) as string[]) {
      try {
        total += statSync(join(dir, f)).size
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* 目录不存在 */
  }
  return total
}
