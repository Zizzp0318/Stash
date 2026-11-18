// 缓存占用统计与清理。
//
// 缓存全在 `<库>/.thumbs/` 里，但**三类东西混住**，清理时必须分开：
//   · 缩略图      `{hash}/grid.webp` `{hash}/detail.webp` —— 删了能重新生成（秒级）
//   · 派生预览    `{hash}/preview.mp4`（老视频 remux/转码）、`{hash}/preview.mp3`（音频转码）、
//                 `{hash}/preview-{尺寸}.webp`（TIFF 的高清大图，**图片派生的文件名带尺寸 tag**，
//                 见 `preview.ts` 的 `derivedPathFor()` / `derivedAbs()`）——
//                 删了要**重新转码**（慢，几十秒都正常），所以绝不能被「清理缓存」一把带走
//   · 其它        `placeholder-*.webp`（占位图，删了会重新生成）、`*.tmp`（写一半的临时文件）
//
// 分类靠文件名而不是靠子目录：`{hash}` 目录是三者共用的
// （同一个素材的缩略图、派生预览、以及派生中途的临时文件都落在里面）。
import { existsSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'fs'
import { readdir, stat } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { requireCurrent } from './library'
import { bumpThumbsBytes } from './usage'

export type CacheKind = 'thumbs' | 'derived' | 'other'

export interface CacheBucket {
  files: number
  bytes: number
}

export interface CacheStats {
  /** .thumbs 根目录（面板上「打开位置」用） */
  dir: string
  total: CacheBucket
  thumbs: CacheBucket
  derived: CacheBucket
  other: CacheBucket
}

interface Entry {
  kind: CacheKind
  abs: string
  bytes: number
}

/**
 * 派生预览的**完整文件名形态**。
 *
 * ⚠️ 必须精确匹配，**不能只判 `startsWith('preview')` 或 `startsWith('preview.')`**：
 *   · 图片派生带尺寸 tag → `preview-2560.webp`（`preview.ts` 的 `derivedPathFor()` 把
 *     `maxImagePx()` 算进文件名，改设置就换个文件、不会命中旧尺寸）；只认 `preview.` 会**整类漏掉**
 *     —— 那恰恰是最占空间的 TIFF 高清大图，本项目 I2 就栽在这里。
 *   · 派生**中途的临时文件**也以 `preview` 开头 → 图片 `preview-{尺寸}.webp.tmp`、
 *     视频/音频 `preview.{时间戳}.tmp.{mp4,mp3}`（见 `preview.ts` 的
 *     `deriveImage/deriveVideo/deriveAudio`）。它们**不是**可用的派生预览，归「其它」，
 *     与头注释里 `*.tmp` 的归类一致（否则占用虚高、「清理派生预览」也会误报删除数）。
 * 一个正则同时把「真派生」与「写一半的临时文件」分开，以后改判据别再退化成前缀判断。
 */
const DERIVED_RE = /^preview(-\d+)?\.(webp|mp3|mp4)$/

function classify(name: string): CacheKind {
  if (name === 'grid.webp' || name === 'detail.webp') return 'thumbs'
  if (DERIVED_RE.test(name)) return 'derived'
  return 'other' // placeholder-*.webp / *.tmp（含 `preview` 前缀的临时文件）/ 未知残留
}

/** 遍历 `.thumbs`：一层 hash 目录 + 根目录下的散文件（占位图、临时文件） */
function walk(): { dir: string; entries: Entry[] } {
  const dir = join(requireCurrent().path, '.thumbs')
  const entries: Entry[] = []
  if (!existsSync(dir)) return { dir, entries }

  const push = (abs: string, name: string): void => {
    try {
      const st = statSync(abs)
      if (st.isFile()) entries.push({ kind: classify(name), abs, bytes: st.size })
    } catch {
      /* 遍历途中被删掉（并发写）就跳过，不要因为一个文件把统计搞崩 */
    }
  }

  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    let isDir = false
    try {
      isDir = statSync(abs).isDirectory()
    } catch {
      continue
    }
    if (!isDir) {
      push(abs, name)
      continue
    }
    let inner: string[] = []
    try {
      inner = readdirSync(abs)
    } catch {
      continue
    }
    for (const f of inner) push(join(abs, f), f)
  }
  return { dir, entries }
}

function sum(entries: Entry[]): CacheBucket {
  let files = 0
  let bytes = 0
  for (const e of entries) {
    files++
    bytes += e.bytes
  }
  return { files, bytes }
}

export function cacheStats(): CacheStats {
  const { dir, entries } = walk()
  const of = (k: CacheKind): CacheBucket => sum(entries.filter((e) => e.kind === k))
  return { dir, total: sum(entries), thumbs: of('thumbs'), derived: of('derived'), other: of('other') }
}

/** 异步遍历的分块粒度：每处理这么多个顶层项让出一次事件循环 */
const YIELD_EVERY_DIRS = 120

/**
 * 异步分块版的缓存统计（`cache:stats` 走这条）。
 *
 * 为什么需要：同步版在 2 万条库上要 **872ms**、5 万条 **2241ms**（每个文件一次 `statSync`），
 * 而用户点开「设置 → 缩略图与缓存」就会触发 —— 这段时间主进程整条事件循环被钉死，
 * 界面表现是「点开设置卡两秒」，和 `library:usage` 那个坑同源（见 §5.5）。
 *
 * 做法：目录**成批并行**处理（每批 `PARALLEL_DIRS` 个，批内 `Promise.all`），每批结束
 * `await setImmediate` 让出事件循环。实测 3006 个文件 ≈ 60–120ms（同步版同数据 ~150–300ms，
 * 但会把 UI 钉住），遍历期间 IPC / 绘制都能插进来 —— 数字晚几十毫秒到完全可以接受。
 */
const PARALLEL_DIRS = 48

export async function cacheStatsAsync(): Promise<CacheStats> {
  const dir = join(requireCurrent().path, '.thumbs')
  const buckets: Record<CacheKind, CacheBucket> = {
    thumbs: { files: 0, bytes: 0 },
    derived: { files: 0, bytes: 0 },
    other: { files: 0, bytes: 0 }
  }
  const add = (kind: CacheKind, bytes: number): void => {
    buckets[kind].files++
    buckets[kind].bytes += bytes
  }
  const countFile = async (abs: string, name: string): Promise<void> => {
    try {
      const st = await stat(abs)
      if (st.isFile()) add(classify(name), st.size)
    } catch {
      /* 遍历途中被删（并发清理）就跳过 */
    }
  }
  /** 处理 `.thumbs` 下的一个顶层项（文件 = 占位图/临时文件；目录 = 一个 hash 的一堆产物） */
  const countTop = async (name: string): Promise<void> => {
    const abs = join(dir, name)
    let isDir = false
    try {
      isDir = (await stat(abs)).isDirectory()
    } catch {
      return
    }
    if (!isDir) {
      await countFile(abs, name)
      return
    }
    let inner: string[] = []
    try {
      inner = await readdir(abs)
    } catch {
      return // 目录刚被删/改名
    }
    await Promise.all(inner.map((f) => countFile(join(abs, f), f)))
  }

  let names: string[] = []
  try {
    names = await readdir(dir)
  } catch {
    // 还没生成过任何缓存：等价于「全是 0」，与同步版语义一致
    return { dir, total: { files: 0, bytes: 0 }, ...buckets }
  }

  for (let i = 0; i < names.length; i += PARALLEL_DIRS) {
    await Promise.all(names.slice(i, i + PARALLEL_DIRS).map((n) => countTop(n)))
    // 让出事件循环：开库/滚动/点击都不该被统计拖住
    await new Promise<void>((r) => setImmediate(r))
  }

  const total = { files: 0, bytes: 0 }
  for (const b of Object.values(buckets)) {
    total.files += b.files
    total.bytes += b.bytes
  }
  return { dir, total, ...buckets }
}

/**
 * 清理某类缓存。返回删掉的文件数与释放的字节数。
 * ⚠️ 调用方负责善后：清完「缩略图」必须触发一次 `thumb.backfill('grid')`，
 * 否则网格里的 `<img>` 会 404（虽然有自愈兜底，但那是兜底不是主路径）。
 */
export function clearCache(kind: CacheKind | 'all'): { removed: number; freed: number } {
  const { entries } = walk()
  const targets = kind === 'all' ? entries : entries.filter((e) => e.kind === kind)
  let removed = 0
  let freed = 0
  // 删完文件后，把**变空**的 hash 目录一并收掉（见下方说明）
  const touchedDirs = new Set<string>()
  for (const e of targets) {
    try {
      unlinkSync(e.abs)
      removed++
      freed += e.bytes
      touchedDirs.add(dirname(e.abs))
    } catch {
      /* 删不掉（被占用）就跳过，别中断整轮清理 */
    }
  }
  /*
   * 收掉空掉的 hash 目录 —— 不只是「顺手打扫」：
   *
   * `thumbs.ensureBatch` 判断「已有 grid 缩略图」用的是**一次 readdir 的目录集合**
   * （每个 hash 一个目录，比逐条 stat 快一个数量级）。前提是「目录存在 ⇒ 里面真的有
   * grid.webp」。而清理缓存只 unlink 文件、目录会留下来 —— 那样清完之后的回填会把整库
   * 误判成「已有缩略图」，一张都不重建（网格全 404）。
   *
   * `rmdirSync` 是**非递归**的：目录里还有东西（典型是同一 hash 目录下的
   * `preview-*.webp` 派生预览、写一半的临时文件）就删不掉、自动跳过 ——
   * 正好保住「清理缩略图绝不能连带删掉派生预览」这条硬约束。
   * 剩下的混合目录由 `thumbs.invalidateGridPresence()` 兜（见 main.ts 的 cache:clear）。
   */
  if (kind === 'thumbs' || kind === 'all') {
    for (const dir of touchedDirs) {
      // 别去 rmdir `.thumbs` 根目录本身（占位图、派生临时文件都躺在这一层）
      if (basename(dir) === '.thumbs') continue
      try {
        rmdirSync(dir)
      } catch {
        /* 非空 / 被占用：保留目录，交给 invalidateGridPresence 那一轮重扫 */
      }
    }
  }
  // 账本按**实际释放量**扣减（`freed` 是逐个文件的真实大小之和）。
  // 不置脏、不清零：清理完仍有派生预览/占位图留在 `.thumbs` 里，账要继续对得上。
  bumpThumbsBytes(-freed)
  return { removed, freed }
}
