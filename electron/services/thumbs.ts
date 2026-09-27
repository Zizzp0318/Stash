// M2 缩略图管线
// 图片: sharp → webp（两级尺寸）；视频: ffmpeg 截帧 → sharp 缩放；
// 音频/文本: 生成占位图。缓存: {库目录}/.thumbs/{hash}/{size}.webp
import { spawn } from 'child_process'
import { existsSync, mkdirSync, copyFileSync } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import sharp from 'sharp'
import ffmpegPath from 'ffmpeg-static'
import { requireCurrent } from './library'

export const SIZES = { grid: 320, detail: 800 } as const
export type ThumbSize = keyof typeof SIZES

const CONCURRENCY = 4

function thumbFile(hash: string, size: ThumbSize): string {
  return join(requireCurrent().path, '.thumbs', hash, `${size}.webp`)
}

/** 确保单个缩略图存在。返回 { path, generated }；不支持的类型/失败返回 null */
async function ensureOne(asset: { id: number; type: string; ext: string; content_hash: string | null; rel_path: string }, size: ThumbSize): Promise<{ path: string; generated: boolean } | null> {
  if (!asset.content_hash) return null
  const out = thumbFile(asset.content_hash, size)
  if (existsSync(out)) return { path: out, generated: false }

  const libPath = requireCurrent().path
  const abs = join(libPath, ...asset.rel_path.split('/'))
  if (!existsSync(abs)) return null

  mkdirSync(join(out, '..'), { recursive: true })
  const tmp = `${out}.tmp`

  try {
    if (asset.type === 'image') {
      await sharp(abs)
        .rotate() // 按 EXIF 方向摆正
        .toColourspace('srgb') // HDR 广色域（HEIC 等）转 sRGB，避免缩略图偏灰
        .resize({ width: SIZES[size], height: SIZES[size], fit: 'inside', withoutEnlargement: true, animated: false })
        .webp({ quality: 82 })
        .toFile(tmp)
    } else if (asset.type === 'video') {
      const frame = `${out}.frame.png`
      await extractFrame(abs, frame)
      await sharp(frame)
        .resize({ width: SIZES[size], height: SIZES[size], fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(tmp)
      try { require('fs').unlinkSync(frame) } catch { /* ignore */ }
    } else {
      // 音频/文本占位图（全局缓存一份，按需复制）
      const ph = await placeholder(asset.type)
      copyFileSync(ph, tmp)
      // 音频：顺带把时长写回索引
      if (asset.type === 'audio') {
        try {
          const info = await probe(abs)
          requireCurrent().db.prepare('UPDATE assets SET duration_ms=? WHERE id=? AND duration_ms IS NULL')
            .run(Math.round(info.durationMs), asset.id)
        } catch { /* ignore */ }
      }
    }
    renameTmp(tmp, out)
    return { path: out, generated: true }
  } catch {
    try { require('fs').unlinkSync(tmp) } catch { /* ignore */ }
    return null
  }
}

function renameTmp(tmp: string, out: string): void {
  // Windows 上 rename 不覆盖已存在文件，先尝试删除
  try { require('fs').unlinkSync(out) } catch { /* ignore */ }
  require('fs').renameSync(tmp, out)
}

/** ffmpeg 截帧：取 10% 处（不足 1s 取 0s），同时把时长/分辨率写回 assets */
function extractFrame(abs: string, outPng: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const { db } = requireCurrent()
    // 先跑一次 -i 探测元信息（ffmpeg 打印在 stderr）
    probe(abs)
      .then((info) => {
        const seek = info.durationMs > 2000 ? Math.min(info.durationMs * 0.1 / 1000, 5) : 0
        const args = ['-y', '-ss', String(seek), '-i', abs, '-frames:v', '1', outPng]
        const p = spawn(ffmpegPath as string, args, { windowsHide: true })
        p.on('close', (code) => {
          if (code === 0 && existsSync(outPng)) {
            // 元信息回写（首次）
            db.prepare('UPDATE assets SET duration_ms=?, width=?, height=? WHERE rel_path=? AND duration_ms IS NULL')
              .run(Math.round(info.durationMs), info.width, info.height, relOf(abs))
            resolve()
          } else reject(new Error(`ffmpeg exit ${code}`))
        })
        p.on('error', reject)
      })
      .catch(reject)
  })
}

interface ProbeInfo { durationMs: number; width: number; height: number }

function probe(abs: string): Promise<ProbeInfo> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath as string, ['-i', abs], { windowsHide: true })
    let stderr = ''
    p.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    p.on('close', () => {
      const dur = /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/.exec(stderr)
      const dim = /Stream.*Video:.*?,\s*(\d+)x(\d+)/.exec(stderr)
      if (!dur) { reject(new Error('probe: no duration')); return }
      const durationMs = (+dur[1] * 3600 + +dur[2] * 60 + +dur[3]) * 1000 + +`${dur[4]}`.padEnd(3, '0')
      resolve({
        durationMs,
        width: dim ? +dim[1] : 0,
        height: dim ? +dim[2] : 0
      })
    })
    p.on('error', reject)
  })
}

function relOf(abs: string): string {
  const libPath = requireCurrent().path
  return abs.slice(libPath.length + 1).replace(/\\/g, '/')
}

// —— 占位图（音频/文本）：按类型生成一次，内存缓存 ——
const placeholderCache = new Map<string, string>()

async function placeholder(type: string): Promise<string> {
  const hit = placeholderCache.get(type)
  if (hit && existsSync(hit)) return hit
  const tmp = join(requireCurrent().path, '.thumbs', `placeholder-${type}.webp`)
  if (!existsSync(tmp)) {
    const svg = type === 'audio'
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="#2A2D31"/><g fill="#7FA8D9"><circle cx="140" cy="180" r="14"/><circle cx="190" cy="164" r="14"/><rect x="150" y="100" width="6" height="82" rx="3"/><rect x="200" y="84" width="6" height="82" rx="3"/></g></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="#2A2D31"/><g stroke="#9AA3AD" stroke-width="10" stroke-linecap="round"><line x1="100" y1="120" x2="220" y2="120"/><line x1="100" y1="160" x2="220" y2="160"/><line x1="100" y1="200" x2="180" y2="200"/></g></svg>`
    await sharp(Buffer.from(svg)).webp().toFile(tmp)
  }
  placeholderCache.set(type, tmp)
  return tmp
}

// —— 图片元数据 + 主色回写 ——
async function writeImageMeta(asset: { id: number; rel_path: string }): Promise<void> {
  const { db } = requireCurrent()
  const row = db.prepare('SELECT width FROM assets WHERE id=?').get(asset.id) as { width: number | null } | undefined
  if (!row || row.width != null) return // 已写过
  const abs = join(requireCurrent().path, ...asset.rel_path.split('/'))
  try {
    const meta = await sharp(abs).metadata()
    db.prepare('UPDATE assets SET width=?, height=? WHERE id=?')
      .run(meta.width ?? 0, meta.height ?? 0, asset.id)
  } catch { /* HEIC 之外解析失败忽略 */ }
}

/** 图片主色板：取 50px 缩图原始像素，粗量化后取出现最多的 5 个颜色 */
export async function computePalette(abs: string): Promise<string | null> {
  try {
    const { data, info } = await sharp(abs)
      .rotate()
      .toColourspace('srgb')
      .resize(50, 50, { fit: 'inside' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const counts = new Map<number, number>()
    for (let i = 0; i < data.length; i += info.channels) {
      const r = data[i] & 0xF0, g = data[i + 1] & 0xF0, b = data[i + 2] & 0xF0
      const key = (r << 16) | (g << 8) | b
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    return JSON.stringify(top.map(([k]) => `#${((k | 0x080808) & 0xFFFFFF).toString(16).padStart(6, '0')}`))
  } catch {
    return null
  }
}

// —— 队列 ——
/**
 * 每一批（一次 ensureBatch 调用）单独记进度。
 * 早先是 totalInJob / doneCount / pendingDone 三个模块级变量，两批重叠时（例如
 * 开库的 thumb:backfill 与导入后的 backfill 撞在一起）会互相踩：
 * 先结束的那批把计数清零，后一批永远凑不满 total → 它的 onDone 永远不触发、
 * thumb:done 也提前广播（渲染层提前刷新，部分缩略图要等下次事件才出现）。
 */
interface Batch { total: number; done: number; cb: (() => void) | null }
const batches = new Map<number, Batch>()
let batchSeq = 0

interface Job {
  asset: { id: number; type: string; ext: string; content_hash: string | null; rel_path: string }
  size: ThumbSize
  batch: number
}
const queue: Job[] = []
let running = 0

function broadcast(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows()[0]?.webContents.send(channel, data)
}

function pump(): void {
  while (running < CONCURRENCY && queue.length > 0) {
    const job = queue.shift()!
    running++
    ensureOne(job.asset, job.size)
      .then(async (r) => {
        // 首个 grid 缩略图成功后补写图片元数据与主色板
        if (r?.generated && job.size === 'grid' && job.asset.type === 'image') {
          const abs = join(requireCurrent().path, ...job.asset.rel_path.split('/'))
          await writeImageMeta(job.asset)
          const { db } = requireCurrent()
          const row = db.prepare('SELECT palette FROM assets WHERE id=?').get(job.asset.id) as { palette: string | null } | undefined
          if (row && !row.palette) {
            const pal = await computePalette(abs)
            if (pal) db.prepare('UPDATE assets SET palette=? WHERE id=?').run(pal, job.asset.id)
          }
        }
      })
      .catch(() => { /* ignore */ })
      .finally(() => {
        running--
        const b = batches.get(job.batch)
        if (b) {
          b.done++
          if (b.done % 10 === 0 || b.done === b.total) {
            broadcast('thumb:progress', { done: b.done, total: b.total })
          }
          if (b.done >= b.total) {
            broadcast('thumb:done', { done: b.done, total: b.total })
            batches.delete(job.batch)
            b.cb?.()
          }
        }
        pump()
      })
  }
}

/** 批量生成（入队，立即返回）。onDone 在**这一批**全部完成时回调（冒烟测试用） */
export function ensureBatch(
  assets: Array<{ id: number; type: string; ext: string; content_hash: string | null; rel_path: string }>,
  size: ThumbSize,
  onDone?: () => void
): void {
  const fresh = assets.filter((a) => a.content_hash && !existsSync(thumbFile(a.content_hash, size)))
  if (fresh.length === 0) {
    onDone?.()
    return
  }
  const id = ++batchSeq
  batches.set(id, { total: fresh.length, done: 0, cb: onDone ?? null })
  queue.push(...fresh.map((asset) => ({ asset, size, batch: id })))
  pump()
}

/** 单个确保存在（IPC 用），返回 file:// 可用路径 */
export async function ensureThumb(assetId: number, size: ThumbSize): Promise<{ url: string | null; generated: boolean }> {
  const { db } = requireCurrent()
  const asset = db.prepare('SELECT id, type, ext, content_hash, rel_path FROM assets WHERE id=?').get(assetId) as
    | { id: number; type: string; ext: string; content_hash: string | null; rel_path: string }
    | undefined
  if (!asset) throw new Error('ERR_ASSET_NOT_FOUND')
  const r = await ensureOne(asset, size)
  return r ? { url: r.path, generated: r.generated } : { url: null, generated: false }
}
