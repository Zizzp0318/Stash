// M2 缩略图管线
// 图片: sharp → webp（两级尺寸）；视频: ffmpeg 截帧 → sharp 缩放；
// 音频/文本: 生成占位图。缓存: {库目录}/.thumbs/{hash}/{size}.webp
import { spawn } from 'child_process'
import { existsSync, mkdirSync, copyFileSync, writeFileSync, unlinkSync, renameSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import sharp, { type Sharp, type Metadata } from 'sharp'
import { FFMPEG } from './ffmpeg'
import { requireCurrent, getLibrary } from './library'
import { getSettings } from './config'
import { relFromLib } from './paths'
import { thumbSinkWhere } from './derived'

export const SIZES = { grid: 320, detail: 800 } as const
export type ThumbSize = keyof typeof SIZES

/**
 * 把「库内原文件」读进内存后交给 sharp，**不要** `sharp(abs)` 直接按路径打开。
 *
 * 为什么（实测，见 `.workbuddy/audit/probe-inflight-rename.mjs`）：libvips 按文件名打开一个文件后，
 * 在整个（异步的）解码过程中会**持有该文件的句柄**。此刻若用户去重命名这个文件所在的**文件夹**，
 * Windows 直接拒绝 → `EPERM: operation not permitted, rename '…' -> '…'`（与用户截图逐字一致）。
 * 这正是「重命名偶发失败」的根因：开库/导入时缩略图队列在后台跑，用户恰好在某个 job 处理
 * 「该文件夹内」某文件时改了文件夹名。实测三连：
 *   `sharp(abs)` 进行中 rename 目录 → EPERM；完成后 → OK；cache.files=0 也救不了；
 *   换成 `sharp(readFileSync(abs))`（同步读入后源文件立即关闭）进行中 rename 目录 → **OK**。
 *
 * ⚠️ 大文件（几十~上百 MB）读进内存有代价，超过阈值就**保留按路径打开**、只依赖
 * `fsutil.renameWithRetry` 的重试兜底（大图本来就少见，且生成耗时长、与用户改名撞上的概率更低）。
 */
const READ_INTO_MEMORY_MAX_BYTES = 64 * 1024 * 1024

/** 打开一个库内原文件给 sharp：正常大小走内存（避免持句柄），超大文件按路径（省内存） */
function openSource(abs: string): Sharp {
  try {
    if (statSync(abs).size <= READ_INTO_MEMORY_MAX_BYTES) return sharp(readFileSync(abs))
  } catch {
    /* stat 失败就退回按路径打开，让 sharp 自己去报错 */
  }
  return sharp(abs)
}

/**
 * 并发数与质量**每次用时现读设置**，不做模块级常量。
 * 常量会在 import 时求值 —— 那时设置还没读、之后改了也不会变，
 * 表现就是「设置里改了没反应」。`pump()` 是按次调用的，现读的开销可忽略。
 */
function concurrency(): number {
  return getSettings().thumbs.concurrency
}
function quality(): number {
  return getSettings().thumbs.quality
}

function thumbFile(hash: string, size: ThumbSize): string {
  return join(requireCurrent().path, '.thumbs', hash, `${size}.webp`)
}

/**
 * 确保单个缩略图存在。返回 `{ path, generated, hash }`；不支持的类型/失败返回 null。
 *
 * `hash` = 本次**实际使用**的 content_hash（就是 `asset.content_hash`）。回传它是必须的：
 * 渲染层拼 `stash://` URL 时需要「磁盘上这份缩略图对应的 hash」，而不是它自己那一帧（可能是旧的）
 * 素材行里的 hash —— 见 `ensureThumb` 与 `GalleryGrid.onImgErr` 的注释。
 */
async function ensureOne(asset: { id: number; type: string; ext: string; content_hash: string | null; rel_path: string }, size: ThumbSize): Promise<{ path: string; generated: boolean; hash: string } | null> {
  if (!asset.content_hash) return null
  const out = thumbFile(asset.content_hash, size)
  if (existsSync(out)) return { path: out, generated: false, hash: asset.content_hash }

  const libPath = requireCurrent().path
  const abs = join(libPath, ...asset.rel_path.split('/'))
  if (!existsSync(abs)) return null

  mkdirSync(join(out, '..'), { recursive: true })
  const tmp = tmpPath(out)

  try {
    if (asset.type === 'image') {
      await openSource(abs)
        .rotate() // 按 EXIF 方向摆正
        .toColourspace('srgb') // HDR 广色域（HEIC 等）转 sRGB，避免缩略图偏灰
        // 注意：`animated` 是 sharp 的**输入选项**（`sharp(input, { animated })`），
        // 不是 resize 选项 —— 写在这里既无效果又过不了类型检查，所以不写。
        // 动图在本项目走的是「取首帧」策略（见 preview.ts 的 IMG_NATIVE：gif 直出原文件）。
        .resize({ width: SIZES[size], height: SIZES[size], fit: 'inside', withoutEnlargement: true })
        .webp({ quality: quality() })
        .toFile(tmp)
    } else if (asset.type === 'video') {
      const frame = tmpPath(out, '.frame.png')
      await extractFrame(abs, frame)
      await sharp(frame)
        .resize({ width: SIZES[size], height: SIZES[size], fit: 'inside', withoutEnlargement: true })
        .webp({ quality: quality() })
        .toFile(tmp)
      try { unlinkSync(frame) } catch { /* ignore */ }
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
    return { path: out, generated: true, hash: asset.content_hash }
  } catch {
    try { unlinkSync(tmp) } catch { /* ignore */ }
    return null
  }
}

/**
 * 每个 job 用**独立**的临时文件名。
 * 早先是固定的 `${out}.tmp` / `${out}.frame.png`：同一目标被两个并发 job 处理时
 * （同一批 grid 重复入队、或 grid 与 detail 撞在一起）会互相写坏对方正在写的文件 ——
 * 和占位图那个竞态是同一类问题，一起收掉。
 */
let tmpSeq = 0
function tmpPath(out: string, ext = '.tmp'): string {
  return `${out}.${process.pid}-${++tmpSeq}${ext}`
}

function renameTmp(tmp: string, out: string): void {
  // Windows 上 rename 不覆盖已存在文件，先尝试删除
  try { unlinkSync(out) } catch { /* ignore */ }
  renameSync(tmp, out)
}

/** ffmpeg 截帧：取 10% 处（不足 1s 取 0s），同时把时长/分辨率写回 assets */
function extractFrame(abs: string, outPng: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // 先跑一次 -i 探测元信息（ffmpeg 打印在 stderr）
    probe(abs)
      .then((info) => {
        const seek = info.durationMs > 2000 ? Math.min(info.durationMs * 0.1 / 1000, 5) : 0
        const args = ['-y', '-ss', String(seek), '-i', abs, '-frames:v', '1', outPng]
        const p = spawn(FFMPEG, args, { windowsHide: true })
        p.on('close', (code) => {
          if (code === 0 && existsSync(outPng)) {
            // 元信息回写（首次）—— 写法与「命中缓存时补写」共用 `writeVideoMeta`
            writeVideoMeta(info, abs)
            resolve()
          } else reject(new Error(`ffmpeg exit ${code}`))
        })
        p.on('error', reject)
      })
      .catch(reject)
  })
}

interface ProbeInfo { durationMs: number; width: number; height: number }

/**
 * 从 ffmpeg `-i` 的 banner 里抠出**旋转角（度）**，没有则 `null`。
 *
 * 两种写法都要认（不同 ffmpeg 版本/来源输出不同，实测见 `.workbuddy/audit/probe-orient.mjs`）：
 *   · 现代输出：`displaymatrix: rotation of 90.00 degrees`（`-display_rotation` 产物）
 *   · 老式标签：`rotate          : 90`（部分手机/老工具写进 metadata 的 rotate tag）
 */
function parseRotation(stderr: string): number | null {
  const m1 = /displaymatrix:\s*rotation of\s*(-?[\d.]+)\s*degrees/i.exec(stderr)
  if (m1) return Number(m1[1])
  const m2 = /rotate\s*:\s*(-?[\d.]+)/i.exec(stderr)
  if (m2) return Number(m2[1])
  return null
}

/**
 * 是否「四分一转」（±90 或 ±270，即显示时需要把宽高对调）。
 *
 * ⚠️ 判据取**模 180 ≈ 90**、**不看正负号**：`displaymatrix: rotation of 90` 与 `rotate : -90`
 * 两种写法的正负约定相反（实测 `-display_rotation 90` → `rotation of 90.00`，
 * `-display_rotation -90` → `rotation of -90.00`），但都代表同一个「竖过来」。180° 是上下颠倒、
 * 不换宽高。容差 2° 兜住 89.9/90.1 这类浮点写法。
 */
function isQuarterTurn(deg: number | null): boolean {
  if (deg == null) return false
  const a = ((deg % 180) + 180) % 180
  return Math.abs(a - 90) <= 2
}

function probe(abs: string): Promise<ProbeInfo> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-i', abs], { windowsHide: true })
    let stderr = ''
    p.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    p.on('close', () => {
      const dur = /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/.exec(stderr)
      const dim = /Stream.*Video:.*?,\s*(\d+)x(\d+)/.exec(stderr)
      if (!dur) { reject(new Error('probe: no duration')); return }
      const durationMs = (+dur[1] * 3600 + +dur[2] * 60 + +dur[3]) * 1000 + +`${dur[4]}`.padEnd(3, '0')
      // 显示尺寸：banner 里的 `1920x1080` 是**编码尺寸**，忽略 display matrix 旋转。
      // 而 `extractFrame` 截出的帧 ffmpeg **默认已应用旋转**（实测：1920x1080 旋转 90° 的素材，
      // 带旋转的截帧是 1080x1920）。两边不一致 → 卡片按横屏排版。命中四分一转就交换宽高，
      // 让索引尺寸与缩略图同形。
      let width = dim ? +dim[1] : 0
      let height = dim ? +dim[2] : 0
      if (width > 0 && height > 0 && isQuarterTurn(parseRotation(stderr))) {
        const t = width
        width = height
        height = t
      }
      resolve({ durationMs, width, height })
    })
    p.on('error', reject)
  })
}

// —— 占位图（音频/文本）：按类型生成一次，内存缓存 ——
//
// ⚠️ **必须 single-flight**，不能只是「不存在就生成」：
// 队列并发是 4，同一批导入里的音频会同时走到这里，而那一刻 `.thumbs/placeholder-audio.webp`
// 还不存在 —— 4 个 `sharp().toFile()` 往**同一个路径**写，libvips 的落盘不是原子的，
// 实测每轮都有 1~2 个抛 `unable to ...` / `Warning treated as error due to failOn setting`。
// 失败的 job 在 `ensureOne` 里被 catch → 返回 null → **这个素材的缩略图永远不会生成**，
// 渲染层 `stash://thumb/...` 404 → 卡片一块灰（`onImgErr` 只隐藏不重试），
// 要等下次开库 backfill 才补上。用户表现就是「**有时候**导入素材进去预览图是灰色的」。
// 所以并发调用共享**同一个 Promise**，并且先写临时文件再原子 rename，别让半个文件留在最终路径。
const placeholderCache = new Map<string, string>()
const placeholderPending = new Map<string, Promise<string>>()

/**
 * 占位图缓存的键必须**带库路径**。
 * 键只用 type 的话，切库后 `placeholderCache.get(type)` 会命中**上一个库**的
 * `.thumbs/placeholder-audio.webp` 绝对路径，然后被 `copyFileSync` 复制进新库 ——
 * 内容虽然一样，但拿旧库的路径当新库的缓存用是错的（旧库被删/移动后才自愈）。
 */
function placeholderKey(type: string): string {
  return `${requireCurrent().path}|${type}`
}

function placeholder(type: string): Promise<string> {
  const key = placeholderKey(type)
  const hit = placeholderCache.get(key)
  if (hit && existsSync(hit)) return Promise.resolve(hit)
  const pending = placeholderPending.get(key)
  if (pending) return pending // 已经有人在生成了，等他就行
  const p = generatePlaceholder(key, type).finally(() => placeholderPending.delete(key))
  placeholderPending.set(key, p)
  return p
}

async function generatePlaceholder(key: string, type: string): Promise<string> {
  const out = join(requireCurrent().path, '.thumbs', `placeholder-${type}.webp`)
  if (existsSync(out)) {
    placeholderCache.set(key, out)
    return out
  }
  mkdirSync(join(out, '..'), { recursive: true })
  const svg = type === 'audio'
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="#2A2D31"/><g fill="#7FA8D9"><circle cx="140" cy="180" r="14"/><circle cx="190" cy="164" r="14"/><rect x="150" y="100" width="6" height="82" rx="3"/><rect x="200" y="84" width="6" height="82" rx="3"/></g></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="#2A2D31"/><g stroke="#9AA3AD" stroke-width="10" stroke-linecap="round"><line x1="100" y1="120" x2="220" y2="120"/><line x1="100" y1="160" x2="220" y2="160"/><line x1="100" y1="200" x2="180" y2="200"/></g></svg>`
  const buf = await sharp(Buffer.from(svg)).webp({ quality: quality() }).toBuffer()
  const tmp = tmpPath(out)
  writeFileSync(tmp, buf)
  renameTmp(tmp, out) // 原子替换：失败也只可能留下临时文件，最终路径要么没有、要么是完整的
  placeholderCache.set(key, out)
  return out
}

// —— 图片元数据 + 主色回写 ——

/**
 * 取图片的**显示尺寸**（已按 EXIF 方向摆正），写进索引的就是这个。
 *
 * 为什么不能直接用 `metadata().width/height`（缺陷 2 的根因）：那两个字段是 **EXIF 旋转前**的
 * 原始像素尺寸。手机竖拍存成 4032×3024 + `Orientation=6`，`metadata()` 报 4032×3024（横），
 * 而缩略图管线走了 `.rotate()` → 输出是竖的 —— 两边不一致，瀑布流卡片就按横屏排版（用户看到的 bug）。
 * 实测（`.workbuddy/audit/probe-orient.mjs`）：`metadata().autoOrient` = `{900,1200}`（竖），
 * 正是缩略图的真实形状；`orientation=1` 的横图 autoOrient 与原始宽高一致（正对照，没被误交换）。
 *
 * 取法：优先用 sharp 的 `autoOrient`（sharp 0.35.4 实测提供）；它缺失时按
 * `orientation ∈ {5,6,7,8}`（这四种需要转置/旋转 90°）手动交换宽高；都没有就保持原样。
 */
function orientedDims(m: Metadata): { width: number; height: number } {
  const ao = m.autoOrient as { width?: number; height?: number } | undefined
  if (ao && typeof ao.width === 'number' && typeof ao.height === 'number' && ao.width > 0 && ao.height > 0) {
    return { width: ao.width, height: ao.height }
  }
  const w = m.width ?? 0
  const h = m.height ?? 0
  const o = m.orientation ?? 1
  // 5/6/7/8 都是「需要转过 90°/270°」的方向，显示时宽高对调
  const swap = o === 5 || o === 6 || o === 7 || o === 8
  return swap ? { width: h, height: w } : { width: w, height: h }
}

async function writeImageMeta(asset: { id: number; rel_path: string }): Promise<void> {
  const { db } = requireCurrent()
  const row = db.prepare('SELECT width FROM assets WHERE id=?').get(asset.id) as { width: number | null } | undefined
  if (!row || row.width != null) return // 已写过
  const abs = join(requireCurrent().path, ...asset.rel_path.split('/'))
  try {
    const { width, height } = orientedDims(await openSource(abs).metadata())
    db.prepare('UPDATE assets SET width=?, height=? WHERE id=?').run(width, height, asset.id)
  } catch { /* HEIC 之外解析失败忽略 */ }
}

/**
 * 把一个图片素材的「索引字段」（尺寸 + 主色板）补齐。
 *
 * 两个字段都自身幂等（算过就不再算），所以可以对每个 grid job 无脑调用 ——
 * 正常库里这里只是两次 SELECT，开销可忽略。
 *
 * ⚠️ 色板算不出来（文件损坏等）时**保持 NULL、不写哨兵**：NULL 的语义就是「还没算出来过」，
 * 下次 backfill 会再试。敢这么写是因为「能解码的图必定算得出颜色」——
 * 算不出来只可能是解码失败，而那时 sharp 会立刻抛错，重试成本极低。
 * （对比 `genmeta` 那边必须用状态位：那里「本来就没元数据」是**常态**，会无限重扫。）
 */
async function writeIndexFields(asset: { id: number; rel_path: string }): Promise<void> {
  await writeImageMeta(asset)
  if (!getSettings().importing.palette) return
  const { db } = requireCurrent()
  const row = db.prepare('SELECT palette FROM assets WHERE id=?').get(asset.id) as
    | { palette: string | null }
    | undefined
  if (!row || row.palette != null) return
  const abs = join(requireCurrent().path, ...asset.rel_path.split('/'))
  const pal = await computePalette(abs)
  if (pal) db.prepare('UPDATE assets SET palette=? WHERE id=?').run(pal, asset.id)
}

/**
 * 把 ffmpeg 探到的时长/分辨率写回（**幂等**：只在 `duration_ms IS NULL` 时写）。
 *
 * 抽成一处是为了让两条路径共用同一份写法：① 生成缩略图时由 `extractFrame` 调；
 * ② 缩略图**命中缓存**时由 `writeVideoMetaIfPending` 调。分头各写一份迟早跑偏。
 */
function writeVideoMeta(info: ProbeInfo, abs: string): void {
  const { db, path: libPath } = requireCurrent()
  db.prepare('UPDATE assets SET duration_ms=?, width=?, height=? WHERE rel_path=? AND duration_ms IS NULL').run(
    Math.round(info.durationMs),
    info.width,
    info.height,
    relFromLib(libPath, abs)
  )
}

/**
 * 视频缩略图**命中缓存**时补写时长/分辨率 —— 与图片的 `writeIndexFields` 同属 B2 那族欠账。
 *
 * 为什么需要它：`ensureOne` 命中缓存就早退（`thumbs.ts:43`），`extractFrame` 根本不会跑，
 * 而时长/分辨率原先**只在** `extractFrame` 里写 → `duration_ms` 永远是 NULL。
 * 典型触发与色板那条一样：素材删掉后**重新导入同一文件**（`content_hash` 相同 →
 * `.thumbs/{hash}/` 缓存还在），或「该字段的回写是后来才加的」的老库。
 *
 * 只 probe、**不截帧**（缩略图本来就在，不需要帧）。失败不重试也不写哨兵 ——
 * `duration_ms` 仍为 NULL，下次 backfill / 导入会把它再捞回来。
 */
async function writeVideoMetaIfPending(asset: { id: number; rel_path: string }): Promise<void> {
  const { db, path: libPath } = requireCurrent()
  const row = db.prepare('SELECT duration_ms FROM assets WHERE id=?').get(asset.id) as
    | { duration_ms: number | null }
    | undefined
  if (!row || row.duration_ms != null) return
  const abs = join(libPath, ...asset.rel_path.split('/'))
  if (!existsSync(abs)) return
  try {
    writeVideoMeta(await probe(abs), abs)
  } catch {
    /* 探测失败：保持 NULL，下次再试 */
  }
}

/** 图片主色板：取 50px 缩图原始像素，粗量化后取出现最多的 5 个颜色 */
export async function computePalette(abs: string): Promise<string | null> {
  try {
    const { data, info } = await openSource(abs)
      .rotate()
      .toColourspace('srgb')
      .resize(50, 50, { fit: 'inside' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    // 灰度/双通道输入按 3 通道去读会越界（`data[i+1]` 是 undefined → 位运算得 0），
    // 结果是整块偏黑的**错色板**。宁可不给，也不给错的。
    if (info.channels < 3) return null
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
  /**
   * 入队时所属的库。**执行前必须核对** —— 缩略图是按「当前库目录 + content_hash」落盘的，
   * 排队期间用户切了库的话，同一个 job 会拿**新库的 `.thumbs` 目录 + 旧库的 rel_path/hash**
   * 去执行：运气好文件不存在直接失败，运气不好新库有同名相对路径，就会把 B 文件的缩略图
   * 写进 `hashA` 的目录里（**内容与 hash 对不上**，之后这张图永远显示错图）。
   * 校验不过就丢弃 —— 新库自己的 backfill 会把它的素材重新入队，不会漏。
   */
  libPath: string
}
const queue: Job[] = []
let running = 0

function broadcast(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows()[0]?.webContents.send(channel, data)
}

/** 当前库路径；没有打开的库（切库中途）返回 null */
function libPathNow(): string | null {
  try {
    return getLibrary()?.path ?? null
  } catch {
    return null
  }
}

/** 更新 job 所属批次的进度（到齐了就广播 thumb:done 并回调） */
function settleBatch(job: Job): void {
  const b = batches.get(job.batch)
  if (!b) return
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

/** 异步 job 收尾：让出并发位、结批次、继续推队列 */
function finishJob(job: Job): void {
  running--
  settleBatch(job)
  pump()
}

function pump(): void {
  while (running < concurrency() && queue.length > 0) {
    const job = queue.shift()!
    running++
    if (libPathNow() !== job.libPath) {
      // 排队期间用户切了库 → 这个 job 的 rel_path/hash 属于上一个库，直接丢弃。
      // 见 Job.libPath 的注释：不丢的话会按旧库的 hash 往新库的 .thumbs 里写东西。
      // 这里**不要**调 pump()：外层 while 会继续（同步分支里递归反而重复推进）。
      running--
      settleBatch(job)
      continue
    }
    ensureOne(job.asset, job.size)
      .then(async (r) => {
        // 缩略图可用就补写索引字段。
        // ⚠️ **不要再要求 `r.generated`**（这里原本是 `r?.generated && ...`）：
        // 缩略图命中缓存的素材同样要补写 —— 否则 palette/width（图片）、duration_ms（视频）
        // 为空的存量素材永远补不上，只能「清理缓存 + 重建」。详见 ensureBatch 里 indexFields 的注释。
        if (r && job.size === 'grid') {
          if (job.asset.type === 'image') {
            await writeIndexFields(job.asset)
          } else if (job.asset.type === 'video' && !r.generated) {
            // 生成路径的时长回写已在 `extractFrame` 里做了；只有「命中缓存」这条要在这里补
            await writeVideoMetaIfPending(job.asset)
          }
        }
      })
      .catch(() => { /* ignore */ })
      .finally(() => finishJob(job))
  }
}

/**
 * 索引里还缺「尺寸 / 主色板」的图片 id（`size==='grid'` 的 job 会顺带补写这两个字段）。
 *
 * ⚠️ **必须把它们也放进队列**：`ensureBatch` 原本只收「缩略图文件不存在」的素材，
 * 而索引字段的回写挂在入队 job 上 —— 于是
 * 「缩略图已缓存（命中）、但 palette/width 仍为 NULL」的素材**永远补不上**，
 * 只能手工「清理缓存 + 重建」。两个真实成因都很常见：
 *   · 素材删掉后重新导入同一文件（content_hash 相同 → `.thumbs/{hash}/` 缓存还在）
 *   · 导入那一刻「生成主色板」关着，之后才打开（开关只影响以后，存量不会补）
 * 用户报的「有些图片导入进去色板读不出来，要清理并重建才行」就是这条。
 * `genmeta` 的 `backfillMeta` 早就用位标记绕过了同一个坑（见 main.ts `thumb:backfill`
 * 里那段注释），色板这条当时漏了。
 *
 * 「哪些字段算欠账」现由 `derived.ts` 的**派生字段注册表**派生（审计 §2.17）——
 * 见 `thumbSinkCondition`；加派生字段只改注册表，别再手改这里的条件。
 */
function indexFieldsSinkIds(wantPalette: boolean): Set<number> {
  const { db } = requireCurrent()
  // 欠账条件由**派生字段注册表**派生（审计 §2.17）：加派生字段别再手改这条 SQL。
  // 条件自带素材类型限定（图片：尺寸/色板；视频：时长），见 `thumbSinkWhere`。
  const where = thumbSinkWhere({ palette: wantPalette })
  const rows = db
    .prepare(`SELECT id FROM assets WHERE missing=0 AND (${where})`)
    .all() as Array<{ id: number }>
  return new Set(rows.map((r) => r.id))
}

/**
 * 「尺寸重测」的版本号（存 `meta.dims_rev`）。当前 = 2。
 *
 * v1 → v2 修的语义：`width/height` 从「EXIF 旋转前的原始像素尺寸 / 视频编码尺寸」改为
 * **显示尺寸**（图片按 `autoOrient`、视频按 display matrix 交换宽高）。存量库里已写错的尺寸
 * 不会自动重算 —— `writeImageMeta` 有 `if (row.width != null) return`、`writeVideoMeta` 的条件是
 * `duration_ms IS NULL`，两者都「写过就不再碰」。所以必须显式清一次、让它们落回欠账条件被重测。
 */
const DIMS_REV = 2

/**
 * 版本化的一次性「尺寸重测」（幂等）。
 *
 * 做法：若 `meta.dims_rev` 还不到 `DIMS_REV`，就把**全部图片/视频**的 `width/height` 置空
 * （视频的 `duration_ms` 也一并置空，让它落回 `thumbSinkWhere` 的欠账条件被重新入队 ——
 * 视频的宽高是在 probe 时与时长一起写回的，不置空时长就进不了补写分支）。
 * 随后**已有的** `thumb:backfill` 机制自然重测：全量 `SELECT … WHERE missing=0` → `ensureBatch(rows,'grid')`
 * → `ensureOne` 命中缩略图缓存 → `generated:false` → 泵的补写分支（`writeIndexFields` /
 * `writeVideoMetaIfPending`）把新尺寸补上。
 *
 * 触发点：`main.ts` 的 `thumb:backfill` handler（所有「开库」路径都会经过它）。无库时直接返回。
 *
 * ⚠️ **刻意的取舍**：视频的 `duration_ms` 会被短暂清空 → 卡片上的时长角标暂时消失，重测后恢复。
 * 这是为了让视频宽高也能被重测（宽高与时长同一条 UPDATE 写回）。一次性、代价可接受。
 */
export function retestLegacyDims(): { cleared: boolean; rev: number } {
  if (!getLibrary()) return { cleared: false, rev: DIMS_REV } // 无库：幂等直接返回
  const { db } = requireCurrent()
  const row = db.prepare("SELECT value FROM meta WHERE key='dims_rev'").get() as { value: string } | undefined
  // 读不到 / 非数字一律当 0（最老）—— 老库没有这个键，必须当「需要重测」
  const stored = row && /^\d+$/.test(row.value) ? Number(row.value) : 0
  if (stored >= DIMS_REV) return { cleared: false, rev: stored }
  db.prepare("UPDATE assets SET width=NULL, height=NULL WHERE type IN ('image','video')").run()
  db.prepare("UPDATE assets SET duration_ms=NULL WHERE type='video'").run()
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('dims_rev',?)").run(String(DIMS_REV))
  return { cleared: true, rev: DIMS_REV }
}

/** 批量生成（入队，立即返回）。onDone 在**这一批**全部完成时回调（冒烟测试用） */
export function ensureBatch(
  assets: Array<{ id: number; type: string; ext: string; content_hash: string | null; rel_path: string }>,
  size: ThumbSize,
  onDone?: () => void
): void {
  // grid 顺带回写尺寸与色板 → 「索引里缺这两个字段」的也要进队列（虽然缩略图早就在了）
  const sink = size === 'grid' ? indexFieldsSinkIds(getSettings().importing.palette) : new Set<number>()
  const fresh = assets.filter(
    (a) => a.content_hash && (!existsSync(thumbFile(a.content_hash, size)) || sink.has(a.id))
  )
  if (fresh.length === 0) {
    onDone?.()
    return
  }
  const id = ++batchSeq
  const libPath = requireCurrent().path
  batches.set(id, { total: fresh.length, done: 0, cb: onDone ?? null })
  queue.push(...fresh.map((asset) => ({ asset, size, batch: id, libPath })))
  pump()
  pump()
}

/**
 * 单个确保存在（IPC 用）。
 *
 * 返回值里的 `hash` 是**本次实际使用的 content_hash**（`ensureOne` 现场从 DB 读出、就是磁盘上
 * 那份缩略图对应的 hash）。渲染层必须用它拼 `stash://` URL，不能用自己的素材行里的 hash ——
 * 素材行可能在外部改写后仍是旧的一帧，用它拼 URL 会再次 404（详见 `GalleryGrid.onImgErr`）。
 * `ensureOne` 返回 null（不支持的类型 / 文件缺失 / 生成失败）时，`hash` 一并回 null，避免渲染层
 * 拿到一个「没有对应产物」的 hash 去拼 URL。
 */
export async function ensureThumb(assetId: number, size: ThumbSize): Promise<{ url: string | null; generated: boolean; hash: string | null }> {
  const { db } = requireCurrent()
  const asset = db.prepare('SELECT id, type, ext, content_hash, rel_path FROM assets WHERE id=?').get(assetId) as
    | { id: number; type: string; ext: string; content_hash: string | null; rel_path: string }
    | undefined
  if (!asset) throw new Error('ERR_ASSET_NOT_FOUND')
  const r = await ensureOne(asset, size)
  return r ? { url: r.path, generated: r.generated, hash: r.hash } : { url: null, generated: false, hash: null }
}
