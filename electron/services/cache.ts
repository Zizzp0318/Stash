// 缓存占用统计与清理。
//
// 缓存全在 `<库>/.thumbs/` 里，但**三类东西混住**，清理时必须分开：
//   · 缩略图      `{hash}/grid.webp` `{hash}/detail.webp` —— 删了能重新生成（秒级）
//   · 派生预览    `{hash}/preview.{webp,mp3,mp4}` —— HEIC/TIFF 的高清大图、老视频的转码结果，
//                 删了要**重新转码**（慢，几十秒都正常），所以绝不能被「清理缓存」一把带走
//   · 其它        `placeholder-*.webp`（占位图，删了会重新生成）、`*.tmp`（写一半的临时文件）
//
// 分类靠文件名而不是靠子目录：`{hash}` 目录是两者共用的（同一个素材的缩略图与派生预览就在一起）。
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

function classify(name: string): CacheKind {
  if (name === 'grid.webp' || name === 'detail.webp') return 'thumbs'
  if (name.startsWith('preview.')) return 'derived'
  return 'other' // placeholder-*.webp / *.tmp / 未知残留
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
