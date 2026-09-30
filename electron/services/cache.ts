// 缓存占用统计与清理。
//
// 缓存全在 `<库>/.thumbs/` 里，但**三类东西混住**，清理时必须分开：
//   · 缩略图      `{hash}/grid.webp` `{hash}/detail.webp` —— 删了能重新生成（秒级）
//   · 派生预览    `{hash}/preview.mp4`（老视频 remux/转码）、`{hash}/preview.mp3`（音频转码）、
//                 `{hash}/preview-{尺寸}.webp`（HEIC/TIFF 的高清大图，**图片派生的文件名带尺寸 tag**，
//                 见 `preview.ts` 的 `derivedPathFor()` / `derivedAbs()`）——
//                 删了要**重新转码**（慢，几十秒都正常），所以绝不能被「清理缓存」一把带走
//   · 其它        `placeholder-*.webp`（占位图，删了会重新生成）、`*.tmp`（写一半的临时文件）
//
// 分类靠文件名而不是靠子目录：`{hash}` 目录是三者共用的
// （同一个素材的缩略图、派生预览、以及派生中途的临时文件都落在里面）。
import { existsSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { requireCurrent } from './library'

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
 *     —— 那恰恰是最占空间的 HEIC/TIFF 高清大图，本项目 I2 就栽在这里。
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
  for (const e of targets) {
    try {
      unlinkSync(e.abs)
      removed++
      freed += e.bytes
    } catch {
      /* 删不掉（被占用）就跳过，别中断整轮清理 */
    }
  }
  return { removed, freed }
}
