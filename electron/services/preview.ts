// 派生预览层：把「浏览器解不了/播不了的素材」变成能看能播的东西，并统一走 stash://media 服务出去。
//
// 为什么需要它（结论来自 2026-09-28 的实测探针，别凭印象改）：
//   Chromium 能不能播/看图，**完全由它的解码器决定，跟播放器 UI 库无关** ——
//   Plyr / Vidstack / media-chrome 都只是套在原生 <video> 外面的控制条，底层解不了照样白给。
//   实测矩阵：mp4 / **HEVC(hvc1)** / **mkv** / mov / webm / mp3 / flac / wav / m4a / aac / ogg
//   都能直接播（mkv 与 HEVC 能播这两条反常识，但确实是实测结果）；**只有 avi 这类老容器不行**。
//   图片侧 Chromium 解不了 heic / heif / tiff。
//
// 所以这里做的是「**按需产出浏览器能播的版本并缓存**」，而不是引入播放器库：
//   图片（heic/heif/tiff）→ sharp 出 2560px 大图（sharp 本来就在依赖里）
//   视频（avi/wmv/flv…）  → 先 `-c copy` remux 成 mp4（秒级无损）；mp4 装不下那个编码
//                            （xvid/divx/mjpeg/indeo…）才退到转码
//   音频（wma/ape/aiff…） → 转 mp3
//   派生文件与缩略图同住 `<库>/.thumbs/{hash}/`，**随库迁移**，且按内容哈希天然共享。
//
// 判定顺序上有个刻意的选择：**先看容器（扩展名）再看编码**。
// 因为探针已经证明 canPlayType 完全不可信（对 hvc1 / quicktime 报「不支持」却真播成功，
// 对 matroska 报 maybe 也真播成功），所以「能不能播」只按扩展名白名单 + 真播失败后回退，
// 绝不用 canPlayType 猜。白名单内的文件一律直出原文件，省掉一次转码。
import { spawn } from 'child_process'
import {
  createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
  type ReadStream
} from 'fs'
import { stat } from 'fs/promises'
import { Readable } from 'stream'
import { isAbsolute, join, relative, resolve } from 'path'
import { BrowserWindow } from 'electron'
import sharp from 'sharp'
import { FFMPEG } from './ffmpeg'
import { getSettings } from './config'
import { contentHash } from './importer'
import { requireCurrent } from './library'
import { ensureBatch } from './thumbs'
import { MEDIA_SUPPRESS_MS, type MediaHandleGuard } from './handles'

export type PreviewKind = 'image' | 'video' | 'audio' | 'text'
/** 派生方式，UI 拿它显示「正在转码…」这类文案 */
export type DeriveKind = 'image' | 'remux' | 'transcode' | 'audio'

/** 参与判定的素材行（只取用得到的列，避免把整个 DB 行类型拖进来） */
export interface PreviewRow {
  id: number
  type: string
  ext: string
  content_hash: string | null
  rel_path: string
}

/** 派生大图的最长边。2560 够 4K 屏全屏看，又不至于把上亿像素的 TIFF 撑爆内存 */
/**
 * 图片派生的长边上限、文本预览上限：**每次用时现读设置**，不做模块级常量 ——
 * 常量在 import 时就求值了，改设置永远不生效（`preview.ts` 是被 main 与多个服务 import 的，
 * 那份快照会比用户改设置早得多）。
 */
export function maxImagePx(): number {
  return getSettings().preview.maxImagePx
}
/** 文本预览/编辑的大小上限：超过就只读（避免把几百 MB 的日志读进渲染层）。P4 用 */
export function textMaxBytes(): number {
  return getSettings().preview.textMaxBytes
}

/** 浏览器能直接解码的图片格式（其余交给 sharp 派生） */
const IMG_NATIVE = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico'])
// ⚠️ **tif / tiff 不在里面**，heic / heif 也不在 —— 这几个才是图片派生路径要救的格式。
// 这里记一段踩过的坑，免得下次又「发现」一遍：曾有一轮冒烟里「<img> 加载 tiff 成功」，
// 于是把 tiff 挪进了白名单。那是**测试假象**：tiff 当时被判为 derived，而
// `stash://media/{id}` 在派生文件已生成后送出去的就是**派生出来的 webp** ——
// 断言里那个「加载成功」测到的是我们自己刚生成的 webp，跟 Chromium 能不能解 tiff 毫无关系。
// 教训：**别用被测抽象自己的出口去证伪它**。真正的解码能力要拿 `createImageBitmap`
// 直接吃原始字节来测（P6 冒烟的 S1b 段干的就是这个，并断言「白名单」与「实测能力」一致）。

/**
 * 浏览器能直接播的容器。按实测结果写：mkv / mov 都在里面（探针实测能播），
 * avi 不在（实测 SRC_NOT_SUPPORTED）。白名单之外的一律走派生 ——
 * 宁可多转一次，也不要让用户点了没反应。
 */
const VIDEO_NATIVE = new Set(['mp4', 'm4v', 'webm', 'mov', 'mkv', 'ogv'])
const AUDIO_NATIVE = new Set(['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'weba'])

/** remux 时允许直接 `-c copy` 的编码（mp4 装得下、Chromium 也解得开） */
const COPYABLE_V = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1'])
const COPYABLE_A = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'ac3', 'eac3'])

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mkv: 'video/x-matroska', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', weba: 'audio/webm',
  txt: 'text/plain', md: 'text/markdown'
}

export function mimeOf(ext: string): string {
  return MIME[ext.replace(/^\./, '').toLowerCase()] ?? 'application/octet-stream'
}

// ==================== 素材定位 ====================
function libPath(): string {
  return requireCurrent().path
}

/** 库内相对路径 → 绝对路径。rel_path 一律用 `/` 分隔，落盘时按平台拼 */
export function absOfRel(relPath: string): string {
  return join(libPath(), ...relPath.split('/'))
}

/** 按 id 取行；找不到抛 ERR_ASSET_NOT_FOUND（IPC 与协议处理器共用同一种错误码） */
export function rowOf(id: number): PreviewRow {
  const row = requireCurrent()
    .db.prepare('SELECT id, type, ext, content_hash, rel_path FROM assets WHERE id=?')
    .get(id) as PreviewRow | undefined
  if (!row) throw new Error('ERR_ASSET_NOT_FOUND')
  return row
}

/**
 * 派生文件路径：与缩略图同住 `.thumbs/{hash}/`，按内容哈希天然共享。
 * `tag` 是**把设置算进文件名**用的：图片派生的上限尺寸变了就该生成新文件，
 * 否则会命中旧尺寸的缓存、用户看着像「改了没生效」。
 */
export function derivedAbs(hash: string, ext: string, tag = ''): string {
  return join(libPath(), '.thumbs', hash, `preview${tag ? `-${tag}` : ''}.${ext}`)
}

/**
 * 按「这次要哪种派生」算最终路径。
 * serve / analyze(ready) / derive 三处**必须**走这一个函数，否则会各认一个文件名。
 * 冒烟也用它（别自己拼路径，否则改了命名规则就会假红）。
 */
export function derivedPathFor(derive: DeriveKind | null, hash: string): string {
  return derivedAbs(hash, derivedExtOf(derive), derive === 'image' ? String(maxImagePx()) : '')
}

/** 单张素材的原文件绝对路径（「用系统播放器打开」「在文件夹中显示」用） */
export function originalAbsOf(id: number): string {
  const row = rowOf(id)
  const abs = absOfRel(row.rel_path)
  if (!existsSync(abs)) throw new Error('ERR_ASSET_MISSING')
  return abs
}

// ==================== 探测 ====================
export interface MediaProbe {
  container: string
  vcodec: string | null
  acodec: string | null
  durationMs: number
  width: number
  height: number
}

/**
 * 用 `ffmpeg -i` 探容器/编码/时长。
 * ⚠️ 两个坑：① `ffmpeg-static` **不含 ffprobe**，所以只能解析 `-i` 的 stderr（thumbs.ts 的 probe 同款）；
 * ② 只给 `-i` 不给输出时，ffmpeg **必然以退出码 1 结束** —— 那是正常的，不能当失败。
 */
export function probeMedia(abs: string): Promise<MediaProbe> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-i', abs], { windowsHide: true })
    let err = ''
    p.stderr.on('data', (d: Buffer) => { err += d.toString() })
    p.on('error', reject)
    p.on('close', () => {
      if (!err.includes('Input #0')) {
        reject(new Error('ERR_PROBE_FAILED'))
        return
      }
      const dur = /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/.exec(err)
      const dim = /Stream.*Video:.*?,\s*(\d+)x(\d+)/.exec(err)
      resolve({
        container: /Input #0,\s*([a-zA-Z0-9_,]+)\s*,/.exec(err)?.[1] ?? '',
        vcodec: /Stream.*Video:\s*([a-zA-Z0-9_]+)/.exec(err)?.[1] ?? null,
        acodec: /Stream.*Audio:\s*([a-zA-Z0-9_]+)/.exec(err)?.[1] ?? null,
        durationMs: dur
          ? (+dur[1] * 3600 + +dur[2] * 60 + +dur[3]) * 1000 + Number(dur[4].padEnd(3, '0').slice(0, 3))
          : 0,
        width: dim ? +dim[1] : 0,
        height: dim ? +dim[2] : 0
      })
    })
  })
}

// ==================== 判定 ====================
export interface PreviewInfo {
  id: number
  kind: PreviewKind
  /** original = 原文件直出；derived = 用派生文件；unsupported = 本项目打不开 */
  strategy: 'original' | 'derived' | 'unsupported'
  /** derived 时派生文件是否已生成好（original 恒为 true） */
  ready: boolean
  derive: DeriveKind | null
  /** 即将服务出去的 MIME（unsupported 时为 null） */
  mime: string | null
  /** unsupported 的原因，中文，可直接显示给用户 */
  reason: string | null
  /** 即将服务出去的字节数（未知为 0） */
  bytes: number
  /** 文本专用：是否在可编辑大小内 */
  editable: boolean
  width: number | null
  height: number | null
  durationMs: number | null
}

/**
 * 决定这张素材怎么给渲染层。
 *
 * **只看扩展名这一步不探盘** —— 探盘要 spawn ffmpeg，几百毫秒起，不该在浏览时对每张图都做。
 * 只有「视频且容器不在白名单」时才探编码，因为那决定了是 remux（秒级）还是转码（可能几分钟）。
 */
export async function analyze(row: PreviewRow): Promise<PreviewInfo> {
  const ext = (row.ext || '').toLowerCase()
  const abs = absOfRel(row.rel_path)
  const base: PreviewInfo = {
    id: row.id, kind: 'image', strategy: 'original', ready: true, derive: null,
    mime: mimeOf(ext), reason: null, bytes: 0, editable: false, width: null, height: null, durationMs: null
  }
  if (!existsSync(abs)) {
    return { ...base, strategy: 'unsupported', mime: null, reason: '库内找不到该文件（可能已被外部删除）' }
  }
  const size = statSync(abs).size

  if (row.type === 'text') {
    return { ...base, kind: 'text', mime: mimeOf(ext), bytes: size, editable: size <= textMaxBytes() }
  }

  if (row.type === 'image') {
    if (IMG_NATIVE.has(ext)) {
      // 原图直出。尺寸交给 <img> 自己的 naturalWidth，这里不额外读盘
      return { ...base, kind: 'image', bytes: size }
    }
    const hash = row.content_hash ?? ''
    if (!hash) {
      return { ...base, kind: 'image', strategy: 'unsupported', mime: null, reason: '该素材没有内容哈希，无法生成预览' }
    }
    const out = derivedPathFor('image', hash)
    const ready = existsSync(out)
    return {
      ...base, kind: 'image', strategy: 'derived', derive: 'image', ready,
      mime: 'image/webp', bytes: ready ? statSync(out).size : 0,
      reason: '浏览器无法解码该格式，将转为高清预览图'
    }
  }

  if (row.type === 'audio') {
    if (AUDIO_NATIVE.has(ext)) return { ...base, kind: 'audio', bytes: size }
    const hash = row.content_hash ?? ''
    if (!hash) {
      return { ...base, kind: 'audio', strategy: 'unsupported', mime: null, reason: '该素材没有内容哈希，无法生成预览' }
    }
    const out = derivedPathFor('audio', hash)
    const ready = existsSync(out)
    return {
      ...base, kind: 'audio', strategy: 'derived', derive: 'audio', ready,
      mime: 'audio/mpeg', bytes: ready ? statSync(out).size : 0,
      reason: '浏览器无法解码该音频格式，将转为 MP3 预览'
    }
  }

  if (row.type === 'video') {
    if (VIDEO_NATIVE.has(ext)) return { ...base, kind: 'video', bytes: size }
    const hash = row.content_hash ?? ''
    if (!hash) {
      return { ...base, kind: 'video', strategy: 'unsupported', mime: null, reason: '该素材没有内容哈希，无法生成预览' }
    }
    let probe: MediaProbe
    try {
      probe = await probeMedia(abs)
    } catch {
      return { ...base, kind: 'video', strategy: 'unsupported', mime: null, reason: 'ffmpeg 读不出这个文件的编码信息' }
    }
    // 编码本身 mp4 装得下 → remux（秒级）；装不下才转码
    const canRemux = !!probe.vcodec && COPYABLE_V.has(probe.vcodec) &&
      (!probe.acodec || COPYABLE_A.has(probe.acodec))
    const out = derivedPathFor(canRemux ? 'remux' : 'transcode', hash)
    const ready = existsSync(out)
    return {
      ...base, kind: 'video', strategy: 'derived', derive: canRemux ? 'remux' : 'transcode', ready,
      mime: 'video/mp4', bytes: ready ? statSync(out).size : size,
      width: probe.width || null, height: probe.height || null, durationMs: probe.durationMs || null,
      reason: canRemux
        ? '这个容器浏览器不认，将无损换个封装（很快）'
        : '这个容器与编码浏览器都不认，需要转码（视时长可能要等一会儿）'
    }
  }

  return { ...base, strategy: 'unsupported', mime: null, reason: `未知的素材类型：${row.type}` }
}

export async function previewInfo(id: number): Promise<PreviewInfo> {
  return analyze(rowOf(id))
}

// ==================== 派生（生成）====================
/** 在跑的派生任务：key = assetId，value = previewId（同一张重复请求直接复用，避免并发转两遍） */
const inFlight = new Map<number, number>()
let previewSeq = 0

function send(channel: string, payload: unknown): void {
  BrowserWindow.getAllWindows()[0]?.webContents.send(channel, payload)
}

function runFfmpeg(args: string[], onProgress?: (ratio: number, totalMs: number) => void, totalMs = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    // `-progress pipe:1` 把机器可读的进度写到 stdout（stderr 留给错误信息）。
    // 有了它，大文件转码才有进度条，不然用户面对的是一块假死的界面。
    const p = spawn(FFMPEG, ['-hide_banner', '-y', ...args, '-progress', 'pipe:1', '-nostats'], { windowsHide: true })
    let err = ''
    let buf = ''
    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const m = /out_time_ms=(\d+)/.exec(line)
        if (m && totalMs > 0 && onProgress) onProgress(Math.min(1, +m[1] / 1000 / totalMs), totalMs)
      }
    })
    p.stderr.on('data', (d: Buffer) => { err += d.toString() })
    p.on('error', reject)
    p.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      // 只截最后一段：ffmpeg 的 stderr 前面全是无用的 build 信息
      reject(new Error('ERR_FFMPEG: ' + err.trim().split('\n').slice(-1)[0].slice(0, 200)))
    })
  })
}

/**
 * 图片：sharp 出 2560px 的 webp。顺带 `rotate()` 按 EXIF 摆正、HDR 转 sRGB
 * （与缩略图管线同一套处理，保证同一张图在两处观感一致）。
 */
async function deriveImage(abs: string, out: string): Promise<void> {
  mkdirSync(join(out, '..'), { recursive: true })
  const tmp = `${out}.tmp`
  try {
    await sharp(abs)
      .rotate()
      .toColourspace('srgb')
      .resize({ width: maxImagePx(), height: maxImagePx(), fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 88 })
      .toFile(tmp)
    renameOverwrite(tmp, out)
  } catch (e) {
    unlinkQuiet(tmp)
    throw e
  }
}

/** 视频：能 remux 就 remux（秒级无损），不行才转码 */
async function deriveVideo(
  abs: string, out: string, kind: DeriveKind, probe: MediaProbe,
  onProgress?: (r: number, t: number) => void
): Promise<void> {
  mkdirSync(join(out, '..'), { recursive: true })
  const tmp = join(out, '..', `preview.${Date.now()}.tmp.mp4`)
  try {
    // 两条命令都带 `-map 0:v:0? -map 0:a:0?` 与 `-sn`：
    // ① 只取第一路视频/音频，避免多音轨/内封字幕把 mp4 写坏；
    // ② 字幕一律丢掉 —— mp4 装不了 ASS，`-c copy` 撞上内封 ASS 会直接失败（社区里最常见的翻车点）。
    const common = ['-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-movflags', '+faststart']
    const args = kind === 'remux'
      ? ['-i', abs, ...common, '-c', 'copy', ...(probe.vcodec === 'hevc' ? ['-tag:v', 'hvc1'] : []), tmp]
      : [
          '-i', abs, ...common,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '160k', tmp
        ]
    await runFfmpeg(args, onProgress, probe.durationMs)
    renameOverwrite(tmp, out)
  } catch (e) {
    unlinkQuiet(tmp)
    throw e
  }
}

/** 音频：转 mp3（转码很快，没必要为它做 remux 分支） */
async function deriveAudio(abs: string, out: string, onProgress?: (r: number, t: number) => void): Promise<void> {
  mkdirSync(join(out, '..'), { recursive: true })
  const tmp = join(out, '..', `preview.${Date.now()}.tmp.mp3`)
  try {
    await runFfmpeg(['-i', abs, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', tmp], onProgress)
    renameOverwrite(tmp, out)
  } catch (e) {
    unlinkQuiet(tmp)
    throw e
  }
}

/** Windows 上 rename 不覆盖已存在文件，所以先删目标 */
function renameOverwrite(from: string, to: string): void {
  try { unlinkSync(to) } catch { /* 不存在就算了 */ }
  renameSync(from, to)
}

function unlinkQuiet(p: string): void {
  try { unlinkSync(p) } catch { /* ignore */ }
}

/** 派生文件在磁盘上的扩展名（analyze 的 derive 决定用哪个） */
function derivedExtOf(derive: DeriveKind | null): string {
  return derive === 'image' ? 'webp' : derive === 'audio' ? 'mp3' : 'mp4'
}

/**
 * 真正干活的派生流程：分析 → 生成 → 返回用了哪种派生方式。
 * 直出（original）返回 null；不支持则**抛错**（调用方决定是回事件还是回 Promise）。
 *
 * 单独抽出来是为了让冒烟能直接 `await` 它 —— 走 `ensureDerived` 那条只能靠事件或轮询，
 * 失败会退化成一个「等超时」，看不出真正原因。
 */
export async function deriveFor(id: number, onProgress?: (ratio: number) => void): Promise<DeriveKind | null> {
  const row = rowOf(id)
  const info = await analyze(row)
  if (info.strategy === 'original') return null
  if (info.strategy === 'unsupported' || !row.content_hash) {
    throw new Error(info.reason ?? '不支持该格式')
  }
  const abs = absOfRel(row.rel_path)
  const hash = row.content_hash
  onProgress?.(0)

  if (info.derive === 'image') {
    await deriveImage(abs, derivedPathFor('image', hash))
  } else if (info.derive === 'audio') {
    // 探不到时长就只报不确定进度（0），不假装知道
    let totalMs = 0
    try { totalMs = (await probeMedia(abs)).durationMs } catch { /* ignore */ }
    await deriveAudio(abs, derivedPathFor('audio', hash), (r, t) => onProgress?.(t ? r : 0))
  } else {
    const probe = await probeMedia(abs)
    await deriveVideo(abs, derivedPathFor(info.derive, hash), info.derive ?? 'transcode', probe, (r) => onProgress?.(r))
  }
  return info.derive
}

/**
 * 开始生成派生文件；**立即返回**，进度与结果走 `preview:progress` / `preview:done` 事件
 * （与 import 管线同一套风格：IPC 不等长任务，避免渲染层以为卡死）。
 * 同一张素材重复请求会复用同一个在跑的任务。
 */
export function ensureDerived(id: number): { previewId: number } {
  const running = inFlight.get(id)
  if (running != null) return { previewId: running }
  const previewId = ++previewSeq
  inFlight.set(id, previewId)

  void (async () => {
    try {
      const derive = await deriveFor(id, (ratio) => send('preview:progress', { previewId, assetId: id, ratio }))
      send('preview:done', { previewId, assetId: id, ok: true, derive })
    } catch (e) {
      send('preview:done', { previewId, assetId: id, ok: false, error: String((e as Error).message ?? e) })
    } finally {
      inFlight.delete(id)
    }
  })()

  return { previewId }
}

// ==================== 文本读写 ====================
export interface TextReadResult {
  text: string
  encoding: string
  bytes: number
  mtime: number
  readOnly: boolean
  readOnlyReason: string | null
}

/**
 * 读文本：先按 UTF-8 严格解码，失败再退 GB18030。
 *
 * **为什么不引 iconv-lite**：WHATWG 的 `TextDecoder` 自带全编码表
 * （实测 gbk / gb2312 / gb18030 / big5 / shift_jis 全可用），Chrome 与 Node（full ICU）都支持，
 * 为了一个解码再塞一个纯 JS 依赖不划算。
 *
 * 中途把实际用的编码回传，UI 可以在「原本是 GBK」时给一句提示（保存会写成 UTF-8）。
 */
export function readText(id: number): TextReadResult {
  const row = rowOf(id)
  if (row.type !== 'text') throw new Error('ERR_NOT_TEXT')
  const abs = absOfRel(row.rel_path)
  if (!existsSync(abs)) throw new Error('ERR_ASSET_MISSING')
  const st = statSync(abs)
  const buf = readFileSync(abs)

  let text = ''
  let encoding = 'utf-8'
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    // 带 BOM：切掉 BOM 再解，否则编辑器里会多一个看不见的字符
    text = buf.subarray(3).toString('utf8')
    encoding = 'utf-8 (BOM)'
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    } catch {
      try {
        text = new TextDecoder('gb18030').decode(buf)
        encoding = 'gb18030'
      } catch {
        text = buf.toString('utf8')
        encoding = 'utf-8 (含无法解码的字节)'
      }
    }
  }

  const tooBig = st.size > textMaxBytes()
  return {
    text,
    encoding,
    bytes: st.size,
    mtime: Math.floor(st.mtimeMs),
    readOnly: tooBig,
    readOnlyReason: tooBig
      ? `文件超过 ${Math.round(textMaxBytes() / 1024 / 1024)}MB，为避免卡顿只读`
      : null
  }
}

export interface TextWriteResult {
  bytes: number
  mtime: number
  hash: string
  name: string
}

/**
 * 写文本。**这是往库里的真文件写字节**，所以先挡住两种危险：
 * ① 内容超过上限 —— 编辑态本来就不该进来，防的是绕过 UI 的调用；
 * ② `baseMtime` 与磁盘当前 mtime 不一致 —— 说明文件在软件外被改过，
 *    此时覆盖会**静默吞掉别人的改动**，必须抛 `ERR_MTIME_CONFLICT` 让 UI 去问用户。
 *
 * 写完同步索引的 size / file_mtime / content_hash：
 * 文本的缩略图是占位图（按内容哈希命名），哈希一变旧图就失效，
 * 所以要为新哈希补一张，并清理旧哈希目录（确认没人再引用时）。
 */
export function writeText(id: number, text: string, baseMtime?: number): TextWriteResult {
  const { db } = requireCurrent()
  const row = rowOf(id)
  if (row.type !== 'text') throw new Error('ERR_NOT_TEXT')
  const abs = absOfRel(row.rel_path)
  if (!existsSync(abs)) throw new Error('ERR_ASSET_MISSING')

  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength > textMaxBytes()) throw new Error('ERR_TOO_LARGE')

  const stBefore = statSync(abs)
  if (baseMtime != null && Math.floor(stBefore.mtimeMs) !== Math.floor(baseMtime)) {
    throw new Error('ERR_MTIME_CONFLICT')
  }

  writeFileSync(abs, buf)
  const st = statSync(abs)
  const hash = contentHash(abs)
  const oldHash = row.content_hash
  db.prepare('UPDATE assets SET size=?, file_mtime=?, content_hash=? WHERE id=?')
    .run(st.size, Math.floor(st.mtimeMs), hash, id)

  if (oldHash && oldHash !== hash) {
    const stillUsed = (db.prepare('SELECT count(*) AS c FROM assets WHERE content_hash=?').get(oldHash) as { c: number }).c
    if (stillUsed === 0) {
      try {
        rmSync(join(libPath(), '.thumbs', oldHash), { recursive: true, force: true })
      } catch { /* 删不掉不算错，下次还有机会 */ }
    }
  }
  // 新哈希还没有缩略图，补一张（占位图是全局缓存复制的，很快）
  ensureBatch([{ id, type: row.type, ext: row.ext, content_hash: hash, rel_path: row.rel_path }], 'grid')

  return { bytes: st.size, mtime: Math.floor(st.mtimeMs), hash, name: row.rel_path.split('/').pop() ?? '' }
}

// ==================== 媒体句柄登记 / 释放 / 抑制 ====================
//
// 这一段是「重命名一级文件夹必定失败」这个 bug 的修复核心。
//
// 根因（2026-10-16 实测，探针 `.workbuddy/audit/probe-media-rename.mjs`，别凭印象改）：
//   `stash://media/{id}` 走 `streamBody()` 的 `createReadStream(abs)` 把**原文件**流式送出去；
//   详情栏（`DetailPanel.vue`）对视频/音频就渲染这个 URL，浮层同理 —— 也就是说
//   **只要详情栏里选中了一个素材，它的原文件就被我们自己的进程打开着**。
//   而 Windows 上「目录内有文件被打开」会让 `renameSync(该目录)` 抛 EPERM：
//     · 流打开中 → `renameSync(父目录)` = EPERM            （探针 [a]）
//     · 同一个被打开**文件**改名 = OK                        （探针 [a2]，所以修的重心是「目录」）
//     · `rs.destroy()` + 等 'close'（实测 1ms）→ rename = OK （探针 [b]）
//     · `rs.destroy()` 后**同一 tick** → EPERM（0/20）        （探针 [c1]/[c4]）
//     · `rs.destroy()` 后**下一个 setImmediate** → EPERM（0/20）（探针 [c2]/[c4]）
//     · `rs.destroy()` 后**下一个 setTimeout(0)** → OK         （探针 [c3]）
//   → 结论一：**只 destroy 不够**，必须等 'close'（或至少让出一轮宏任务），
//     所以改名路径用 `releaseMediaUnderAsync()`；同步调用点只能 `release()`，
//     靠 `renameWithShortRetrySync` 的 50ms 让位兜底。
//   → 结论二：destroy 之后渲染层会**立刻重开**同一个 URL（探针 [d]：重开耗时 0ms，
//     且立刻重新占住目录 → rename 又 EPERM）。所以必须有一个**抑制窗口**，
//     在改名期间拒绝该子树下的媒体请求；否则「释放 → 重开 → 失败」无限循环。
//
// 为什么登记表按绝对路径分组：释放的粒度是「这棵子树」（重命名一级目录要放掉它里面所有素材），
// 而 serveMedia 只知道本次要服务的那个绝对路径 —— 前缀匹配是最直接的对应关系。

/** 活跃的媒体读流：key = 规范化后的绝对路径（win32 小写，见 `handleKeyOf`） */
const openMediaStreams = new Map<string, Set<ReadStream>>()

/**
 * 路径归一化：Windows 上路径大小写不敏感（`C:\A` 与 `c:\a` 是同一个目录），
 * 登记表若按原样字符串分组，大小写差异会让「释放」漏掉本该释放的流。
 * 非 win32 保持原样（Linux 上大小写敏感，压平反而会误伤）。
 */
function handleKeyOf(absPath: string): string {
  const abs = resolve(absPath)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

/**
 * `candidate` 是否就是 `root` 或位于其子树内。
 * 一律走 `path.relative` 判断，不做 `startsWith` 手工前缀算术（MEMORY.md A4）——
 * 否则 `D:\a\bc` 会被判成 `D:\a\b` 的子路径。
 */
function isSameOrUnder(candidate: string, root: string): boolean {
  if (candidate === root) return true
  const rel = relative(root, candidate)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

/** 登记一个流，并在它 close / error 时自行摘除（不摘会一路泄漏到进程退出） */
function trackMediaStream(absPath: string, rs: ReadStream): void {
  const key = handleKeyOf(absPath)
  let set = openMediaStreams.get(key)
  if (!set) {
    set = new Set<ReadStream>()
    openMediaStreams.set(key, set)
  }
  const bucket = set
  bucket.add(rs)

  // `close` 与 `error` 都挂上：fs.ReadStream 出错后通常仍会 emit 'close'（emitClose 默认 true），
  // 但**不能指望**它 —— 摘除动作做成幂等，谁先到都行。
  const drop = (): void => {
    bucket.delete(rs)
    if (!bucket.size && openMediaStreams.get(key) === bucket) openMediaStreams.delete(key)
  }
  rs.once('close', drop)
  rs.once('error', drop)
}

/** 收集「该路径本身或其子树下」当前所有活跃流 */
function collectStreamsUnder(absPath: string): ReadStream[] {
  const root = handleKeyOf(absPath)
  const out: ReadStream[] = []
  for (const [key, set] of openMediaStreams) {
    if (!isSameOrUnder(key, root)) continue
    for (const rs of set) out.push(rs)
  }
  return out
}

/**
 * 同步释放：只 `destroy()`，**不等**句柄真的关掉。
 * 给「活在同步上下文里」的调用点用（`assets.renameAsset` / `moveAssets`，
 * 它们在 `BEGIN…COMMIT` 里，一个 await 都不能有）。
 * ⚠️ 探针 [c1]/[c2]：destroy 后同一 tick / 下一个 setImmediate 都还是 EPERM，
 * 所以同步上下文只能靠 `renameWithShortRetrySync` 的 50ms 让位兜底（那些场景改的是**文件**，
 * 而文件改名本来就不被句柄挡住 —— 探针 [a2] —— 真正需要等 close 的是「目录」）。
 */
export function releaseMediaUnder(absPath: string): number {
  // ⚠️ 当前**没有同步调用点**：`assets.renameAsset` / `moveAssets` 里那两个调用已按 QA 回归证据移除
  // （改的是文件，探针 [a2] 证明不被句柄挡住；释放只会把正在播的素材打断）。
  // 保留它是作为注册表原语（`releaseMediaUnderAsync` 复用同一套收集逻辑），别再往同步上下文里加调用点。
  const victims = collectStreamsUnder(absPath)
  for (const rs of victims) rs.destroy()
  return victims.length
}

/**
 * 异步释放：destroy + 等所有流 `close`。
 * 这是 `library.renameFolder` 用的那个「够用」的版本 —— 探针 [b] 实测 close 只需 1ms，
 * 等它比「把重试预算加长」正确得多（长驻流面前重试永远打不过，那只是兜底而非修复）。
 *
 * 300ms 上限兜底：万一某个流因为消费端卡住而迟迟不 close，也不能把重命名悬死
 * （此后还有 `renameWithRetry` 自己的重试）。
 */
export async function releaseMediaUnderAsync(absPath: string): Promise<number> {
  const victims = collectStreamsUnder(absPath)
  if (!victims.length) return 0
  // 先挂监听再 destroy：destroy 的 close 走后续 tick，但不要赌，顺序上先订阅更稳
  const closedAll = Promise.all(
    victims.map(
      (rs) =>
        new Promise<void>((done) => {
          if (rs.closed) return done()
          rs.once('close', () => done())
          rs.once('error', () => done())
        })
    )
  )
  for (const rs of victims) rs.destroy()
  await Promise.race([closedAll, new Promise<void>((r) => setTimeout(r, 300))])
  return victims.length
}

/** 抑制窗口：key = 子树根的规范化绝对路径，value = 失效时间戳 */
const mediaSuppressedUntil = new Map<string, number>()

/**
 * 「抑制窗口被开过多少次」（只增不减）。
 *
 * 用途：冒烟里锁**接线**——`library.renameFolder` 改名前必须真的开过窗。
 * 为什么不能只断言抑制机制本身（开窗→请求被拒）：那是直接调 `suppressMediaUnder`，
 * 拿掉 `renameFolder` 里的那行调用它照样绿（QA 的 D1 注入实测）。
 */
let suppressActivations = 0

/** 供冒烟断言「renameFolder 真的开过窗」（接线断言，不是行为断言） */
export function mediaSuppressionActivations(): number {
  return suppressActivations
}

/**
 * 开一个抑制窗口：窗口内落到该子树下的 `stash://media` 请求直接拒（见 `serveMedia`）。
 *
 * 为什么必须「按子树」：改名的是一级目录，而渲染层重开的是「里面某个素材」的 URL，
 * 两者不是同一个路径。按子串/前缀匹配才能挡住它。
 */
export function suppressMediaUnder(absPath: string, ms: number = MEDIA_SUPPRESS_MS): void {
  suppressActivations++
  const root = handleKeyOf(absPath)
  const now = Date.now()
  mediaSuppressedUntil.set(root, now + Math.max(0, ms))
  // 顺手清掉已过期的条目：抑制窗口只在改名时开，条目数天然很小，
  // 但万一 `clearSuppression` 没被调到，也不该无限堆积。
  for (const [k, until] of mediaSuppressedUntil) if (until <= now) mediaSuppressedUntil.delete(k)
}

/** 立刻解除所有抑制（改名动作一结束就调：成功→按新路径重取；失败→继续允许预览） */
export function clearMediaSuppression(): void {
  mediaSuppressedUntil.clear()
}

/** 当前是否处于抑制窗口内（过期条目顺手清掉） */
function isMediaSuppressed(absPath: string): boolean {
  if (!mediaSuppressedUntil.size) return false
  const key = handleKeyOf(absPath)
  const now = Date.now()
  let hit = false
  for (const [root, until] of mediaSuppressedUntil) {
    if (until <= now) {
      mediaSuppressedUntil.delete(root)
      continue
    }
    if (isSameOrUnder(key, root)) hit = true
  }
  return hit
}

/**
 * **测试缝**（只给冒烟用，产品路径绝不调用）：登记一个「destroy 之后**永远不会 emit close**」的假流。
 *
 * 为什么需要它：`releaseMediaUnderAsync` 的 300ms 上限是防「等 close 等死」的兜底，
 * 而真实 `fs.ReadStream` 的 close 只要 1ms —— 正常路径上那个上限**永远不会被触发**，
 * 于是「把上限删掉」这种回归用任何端到端用例都测不出来（QA 的 D3 注入印证了这点）。
 * 有了这条缝，冒烟能造出「卡在等 close」的真实态：此时 rename 必须在 ≈300ms 内完成，
 * 耗时既不会缩到 0（说明上限被改成 0、根本没在等）也不会无限长（说明上限被删了）。
 *
 * 返回一个卸载函数（emit 'error' 让登记表自摘），用例结束务必调用，别污染后续计数。
 */
export function __testAddUnclosableStream(absPath: string): () => void {
  // 用**真的** Readable（`emitClose: false` → destroy 之后永不发 'close'），
  // 而不是自己拼一个 EventEmitter 假对象：假对象在真实事件循环里踩过坑（会把后续的
  // `serveMedia` 卡死），用 Node 自己的类最稳。
  const stuck = new Readable({ read: () => undefined, emitClose: false })
  trackMediaStream(absPath, stuck as unknown as ReadStream)
  return () => {
    stuck.emit('error', new Error('TEST_DETACH'))
  }
}

/**
 * 冒烟/诊断用：当前活跃流数量。传路径则只数该子树。
 * ⚠️ 这条是给断言用的**真判据**（不是自证的计数器）：它直接读登记表，
 *    而登记表由流的 `close`/`error` 事件驱动摘除 —— 流没真的关掉就不会变 0。
 */
export function activeMediaStreamCount(absPath?: string): number {
  if (absPath == null) {
    let n = 0
    for (const set of openMediaStreams.values()) n += set.size
    return n
  }
  return collectStreamsUnder(absPath).length
}

/**
 * 交给 `handles.ts` 注册表的那份实现（`main.ts` 启动时接上，见那里的注释）。
 * 之所以做成对象而不是让 library 直接 import 本文件：依赖方向是 `preview → library`，
 * 反向 import 会成环（MEMORY.md I3）。
 */
export const mediaHandleGuard: MediaHandleGuard = {
  release: releaseMediaUnder,
  releaseAsync: releaseMediaUnderAsync,
  suppress: suppressMediaUnder,
  clearSuppression: clearMediaSuppression
}

// ==================== 协议：服务媒体字节 ====================
/**
 * 读取并发闸门。
 *
 * 借鉴 Serpent 的做法（它取 2）：createReadStream 的 open 走 libuv 线程池（默认 4 个），
 * 媒体请求一多就会把线程池占满，其它主进程 I/O 全排队。这里限流，宁可让后面的请求等一会儿。
 */
const READ_CONCURRENCY = 4
let readActive = 0
const readWaiters: Array<() => void> = []

async function withReadSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (readActive >= READ_CONCURRENCY) {
    await new Promise<void>((resolve) => readWaiters.push(resolve))
  }
  readActive++
  try {
    return await fn()
  } finally {
    readActive--
    readWaiters.shift()?.()
  }
}

/** 解析 Range。四种形式都要吃：`bytes=0-`（首包）、`bytes=N-`（向后 seek）、`bytes=N-M`、`bytes=-N`（读尾部 moov） */
export function parseRange(header: string | null, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return 'invalid'
  const [, s, e] = m
  if (!s && !e) return 'invalid'
  let start: number
  let end: number
  if (!s) {
    // 后缀区间：最后 N 字节。mp4 把 moov 放在文件尾时 Chromium 就靠这个探测
    const n = Number(e)
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(s)
    end = e ? Number(e) : size - 1
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}

/**
 * 建一个可 seek 的响应体：只读被请求的那段字节，流式送出去。
 *
 * `signal` 是必须的：Chromium 拖进度条时会**取消上一个 Range 请求**，
 * 不跟着销毁文件流的话，每次 seek 都会漏一个挂在磁盘上的读取句柄。
 */
function streamBody(abs: string, range: { start: number; end: number } | null, signal: AbortSignal | null): ReadableStream {
  const rs = range ? createReadStream(abs, range) : createReadStream(abs)
  // 登记进「活跃媒体流」表：重命名文件夹前要靠它把**我们自己的**句柄放掉。
  // 登记/摘除都在 `trackMediaStream` 里闭合，不会泄漏（摘除挂在 close/error 上）。
  trackMediaStream(abs, rs)
  if (signal) {
    const destroy = (): void => { rs.destroy() }
    if (signal.aborted) destroy()
    else {
      signal.addEventListener('abort', destroy, { once: true })
      rs.once('close', () => signal.removeEventListener('abort', destroy))
    }
  }
  // 流自身出错（例如文件被外部删掉）不能把主进程带崩：吞掉并结束这个响应
  rs.on('error', () => { /* ignore */ })
  return Readable.toWeb(rs) as unknown as ReadableStream
}

/**
 * `stash://media/{id}` 的处理器：把「当前最该给渲染层的那份字节」流式送出去。
 *
 * 三条硬约束（都来自实测与本项目的既有教训）：
 * ① **必须流式**（createReadStream → Response），不能像缩略图那样 readFileSync 整读 ——
 *    一个 2GB 的视频整读会把主进程内存直接打爆；
 * ② **必须支持 Range / 206**，否则 <video> 只能从头播、拖不动进度条；
 * ③ **派生文件没就绪就返回 404**：生成必须由渲染层显式发起（preview:ensure），
 *    不能在这里同步跑转码 —— 那会让 <video> 的请求悬住几分钟，看起来就是个卡死的播放器。
 */
export async function serveMedia(req: Request, idRaw: string): Promise<Response> {
  // URL 上可能带扩展名或 ?v= 后缀，只取开头的数字
  const id = Number(idRaw.replace(/\.[a-z0-9]+$/i, ''))
  if (!Number.isInteger(id) || id <= 0) return new Response('bad id', { status: 400 })

  let abs: string
  let mime: string
  try {
    const row = rowOf(id)
    const info = await analyze(row)
    if (info.strategy === 'unsupported' || !info.mime) {
      return new Response(info.reason ?? 'unsupported', { status: 415 })
    }
    if (info.strategy === 'derived') {
      abs = derivedPathFor(info.derive, row.content_hash ?? '')
      mime = info.mime
      if (!existsSync(abs)) return new Response('derived-not-ready', { status: 404 })
    } else {
      abs = absOfRel(row.rel_path)
      mime = info.mime
    }
  } catch (e) {
    const code = String((e as Error).message ?? e)
    return new Response(code, { status: code === 'ERR_ASSET_NOT_FOUND' ? 404 : 500 })
  }

  /**
   * 抑制窗口：这棵子树正在被改名，此刻**不能再把句柄打开**（哪怕一秒）——
   * 探针 [d] 实测「destroy 后重开耗时 0ms，且立刻重新占住目录」，只要放进来一次，
   * 紧接着的 rename 就又 EPERM。窗口由 `library.renameFolder` 开、结束时立刻 clear，
   * 兜底 10s 自动过期（见 handles.MEDIA_SUPPRESS_MS）。
   *
   * 为什么用 409 而不是 404：404 在本函数里已有确定含义（派生文件还没生成 / 文件不存在），
   * 混在一起会让排错时分不清「该等派生」还是「正在改名」。两者对 <video>/<img> 都是加载失败，
   * 行为上无差别。
   */
  if (isMediaSuppressed(abs)) {
    return new Response('media-suppressed', { status: 409 })
  }

  return withReadSlot(async () => {
    // 用异步 stat（fs/promises）而不是 statSync：后者在主线程同步读元数据，
    // 大库快速滚动时会把请求串起来（Serpent 记过这条，实测能看到几秒延迟）。
    let size: number
    try {
      const st = await stat(abs)
      if (!st.isFile()) return new Response('not a file', { status: 404 })
      size = st.size
    } catch {
      return new Response('not found', { status: 404 })
    }

    const head: Record<string, string> = {
      'content-type': mime,
      'accept-ranges': 'bytes',
      // 原文件可能被重命名/重新导入，派生文件也可能被重新生成；
      // 所以禁用缓存，靠 URL 上的 ?v= 控制版本（与缩略图协议同一套约定）
      'cache-control': 'no-store'
    }

    const range = parseRange(req.headers.get('range'), size)
    if (range === 'invalid') {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
    }
    const isHead = req.method === 'HEAD'
    const signal = req.signal ?? null

    if (range) {
      return new Response(isHead ? null : streamBody(abs, range, signal), {
        status: 206,
        headers: {
          ...head,
          'content-range': `bytes ${range.start}-${range.end}/${size}`,
          'content-length': String(range.end - range.start + 1)
        }
      })
    }
    return new Response(isHead ? null : streamBody(abs, null, signal), {
      status: 200,
      headers: { ...head, 'content-length': String(size) }
    })
  })
}
