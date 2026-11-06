// M2 缩略图管线
// 图片: sharp → webp（两级尺寸）；视频: ffmpeg 截帧 → sharp 缩放；
// 音频/文本: 生成占位图。缓存: {库目录}/.thumbs/{hash}/{size}.webp
import { spawn } from 'child_process'
import { existsSync, mkdirSync, copyFileSync, writeFileSync, unlinkSync, renameSync, readFileSync, statSync, readdirSync } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import sharp, { type Sharp, type Metadata } from 'sharp'
import { FFMPEG } from './ffmpeg'
import { requireCurrent, getLibrary } from './library'
import { getSettings } from './config'
import { isThumbHash, relFromLib } from './paths'
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

/**
 * `.thumbs/{hash}/{size}.webp` 的绝对路径。
 *
 * ⚠️ 这里的 `throw` 是**最后一道闸**，不是常规分支：`paths.ts` 明确要求「凡是用 hash 拼路径
 * 或删缓存的代码，必须先过 `isThumbHash`」，因为 `content_hash` 一旦被写成 `..` 这类脏值，
 * `join(lib, '.thumbs', '..')` 会归一成**库根**，缩略图就被写到 `.thumbs` 之外去了。
 * 本项目其余五处（assets / library / compress / watcher / preview）都校验了，只有这里漏 ——
 * 而它恰恰是写 `.thumbs` 的主路径。调用方（`ensureOne` / `ensureBatch`）现在都先过类型守卫，
 * 所以这个 throw 正常永不触发；真触发了说明新调用点忘了守卫，宁可报错也别写脏文件。
 */
function thumbFile(hash: string, size: ThumbSize): string {
  if (!isThumbHash(hash)) throw new Error('ERR_BAD_CONTENT_HASH')
  return join(requireCurrent().path, '.thumbs', hash, `${size}.webp`)
}

/**
 * 一次 `readdir` 拿到所有已有缩略图 hash 目录 —— 替代逐条 `existsSync`。
 *
 * 为什么：3000 个素材 = 3000 次同步 stat（每次进内核、还要过杀软实时扫描），
 * 开库时把主进程占住 1–3 秒（渲染层的所有 IPC 都得排队 → 界面点不动）；
 * 而 `.thumbs` 本来就是「一个 hash 一个目录」（见 `thumbFile`），
 * 一次 readdir 就能拿到全集，同一份数据 20–30ms 完成。
 *
 * 取舍（**已知且接受**）：目录存在 ≠ `grid.webp` 一定写完 —— 生成是先 `mkdirSync` 再
 * `sharp().toFile()`，若生成中断（进程被杀 / 断电）会留下一个空目录，这里会被误判成「已有」，
 * 该图 `stash://thumb/…` 404。兜底在渲染层：`GalleryGrid` 的 `onImgErr` 有自愈
 * （`thumbRetried` → `thumb:ensure` 补生成），下一次加载就回来。
 * 这个代价换的是开库从「秒级卡死」变「一次 readdir」，值得。
 *
 * ⚠️ 还有一个**必须显式处理**的「目录在、文件没了」来源：设置里的**清理缩略图缓存**
 * （`cache.clearCache('thumbs')`）只 `unlink` 文件、留下 hash 目录。若不管，清完之后的
 * `thumb:backfill` 会把整库都当成「已有 grid」→ **一张都不重建**，网格全是 404。
 * 处理方式：清理方调 `invalidateGridPresence()`，下一次「全量」grid 批次改用逐条
 * `existsSync`（见该函数与 `ensureBatch`）。另外 `clearCache` 会把变空的 hash 目录一并
 * `rmdir`，让「目录存在」这个前提在磁盘上尽量重新成立（跨进程重启也安全）。
 *
 * ⚠️ **只对 `grid` 有效**，`detail` 不要用（见 `ensureBatch` 里的说明）。
 *
 * 失败（没有库 / `.thumbs` 还不存在 / 权限问题）返回**空集**：调用方据此把这些素材全当
 * 「缺缩略图」入队 —— 队列里 `ensureOne` 仍会先 `existsSync` 命中缓存，所以只是多排一轮，
 * 不会重复生成，也不会出错。
 */
function thumbHashDirs(): Set<string> {
  try {
    const entries = readdirSync(join(requireCurrent().path, '.thumbs'), { withFileTypes: true })
    const dirs = new Set<string>()
    // 只要目录：`.thumbs` 根下还躺着 `placeholder-audio.webp` 这类**文件**，不能算进来
    for (const e of entries) if (e.isDirectory()) dirs.add(e.name)
    return dirs
  } catch {
    return new Set<string>()
  }
}

/**
 * 「`.thumbs/{hash}` 目录存在」还能不能代表「`grid.webp` 也在」？—— 被清理缓存破坏后置脏。
 *
 * 谁置脏：`cache.clearCache('thumbs'|'all')` 之后由 `main.ts` 的 `cache:clear` handler 调
 * `invalidateGridPresence()`（清缓存只删文件、不删目录，目录集合会撒谎）。
 * 谁洗白：**下一次覆盖整个索引的 `grid` 批次**（`thumb:backfill` 正是这种）改用逐条
 * `existsSync`，跑完把标记清掉。
 *
 * 为什么只在「全量批次」消费、而不是「下一次批次」：清完缓存后渲染层先发的是
 * `thumb:ensure-batch`（首屏那几十张），若被它消费掉，紧随其后的全量回填又会被目录集合骗 →
 * 整库不重建。按「资产数 ≥ 索引总数」认定全量，判定只多一次 `COUNT(*)`（有索引，~0.1ms），
 * 且只在标记为脏时才算。
 *
 * ⚠️ **必须跨进程存活**（这是 meta 那一半存在的唯一理由）：
 * `clearCache` 的 `rmdirSync` 只能删「变空」的 hash 目录 —— 目录里还有 `preview-*.webp`
 * （打开过高清预览的素材）就删不掉、目录原地保留。于是「清理缩略图 → 重启软件」后：
 * 内存标记早没了（模块级变量），空目录也没删掉（非空），目录集合凭空撒谎 →
 * 那些素材永远不会被重建，只能等渲染层 `onImgErr` 自愈（没滚到的卡片一直缺图）。
 * 所以标记**双写 `meta`**：`meta` 是**按库**存的（`.stash` 里），重启后照样读得到。
 */
let gridPresenceUnreliable = false

/**
 * 内存标记**属于哪个库**的绝对路径。
 *
 * `gridPresenceUnreliable` 是模块级变量、跨库残留：A 库清过缓存脏着，`closeCurrent()` 不会
 * 清零，直接 `openLibrary(B)` 就会让 B 的第一次回填也退回逐条 stat（慢但不错）。
 * `meta` 是按库的，所以「库变了 → 只信 meta」是最省事又正确的复位点：
 * 不用在 `library.ts` 的关库/切库收口点插钩子（那里加钩子还得管「没库时」「切到同一个库」等分支）。
 */
let gridPresenceLibPath: string | null = null

/** `meta` 里的键名。值只写 `'1'`；洗白是整行 DELETE，不留 `'0'` 这种第二种真值形态。 */
const GRID_DIRTY_KEY = 'grid_presence_dirty'

/** 当前库路径；没库（切库中途 / 欢迎页）返回 null */
function libPathOrNull(): string | null {
  try {
    return requireCurrent().path
  } catch {
    return null
  }
}

/**
 * 标记为脏：**内存 + meta 双写**（meta 让它在重启后依然生效）。
 * 幂等；多次调用等价于一次（下一次全量 grid 批次统一重扫）。
 */
export function invalidateGridPresence(): void {
  gridPresenceUnreliable = true
  gridPresenceLibPath = libPathOrNull()
  try {
    requireCurrent().db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES(?, '1')").run(GRID_DIRTY_KEY)
  } catch {
    /* 没库 / 写失败：退化成只在本进程生效（内存标记已经置了），不影响正确性 */
  }
}

/**
 * 是否脏（= 不能信 `.thumbs` 的目录集合）。内存优先，否则读 `meta`。
 *
 * 每次 `ensureBatch` 多一次 meta SELECT（~0.05ms，主键查询）——**刻意不做模块级缓存**：
 * 缓存一旦跨进程/跨库失效就会重演「清完缓存一张都不重建」，那点查询开销远比这个风险便宜。
 */
function gridPresenceIsDirty(): boolean {
  if (gridPresenceUnreliable) {
    const cur = libPathOrNull()
    // 内存标记是模块级、会跨库残留；meta 是按库的 → 库变了就丢掉内存标记、只信 meta。
    if (cur !== null && gridPresenceLibPath !== null && cur !== gridPresenceLibPath) {
      gridPresenceUnreliable = false
      gridPresenceLibPath = null
    } else {
      return true
    }
  }
  try {
    const row = requireCurrent().db.prepare('SELECT value FROM meta WHERE key=?').get(GRID_DIRTY_KEY) as
      | { value?: string }
      | undefined
    return row?.value === '1'
  } catch {
    return false
  }
}

/** 洗白：内存标记与 meta 行一起清（只清内存会让重启后又变脏，只清 meta 会让本进程继续逐条 stat） */
function clearGridPresenceDirty(): void {
  gridPresenceUnreliable = false
  gridPresenceLibPath = null
  try {
    requireCurrent().db.prepare('DELETE FROM meta WHERE key=?').run(GRID_DIRTY_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * 只读诊断（冒烟断言取证用）：当前库的「目录集合是否可信」。
 * 生产代码不依赖它；它也不会写出任何东西（唯一的副作用是顺手复位跨库残留的内存标记）。
 */
export function gridPresenceState(): { dirty: boolean } {
  return { dirty: gridPresenceIsDirty() }
}

/**
 * 小批次的阈值：**这么多条以内直接逐条 `existsSync`，不值得为几行数据 readdir 整个 `.thumbs`**。
 *
 * 谁在用：`preview.ts` 的「新哈希补一张缩略图」是**单条**批次，且挂在**交互路径**上
 * （每次打开高清预览都会触发）；1 万目录的一次 readdir 约 4ms，而一次 stat 约 0.03ms。
 * 首屏 `thumb:ensure-batch` 的几十条也会落到这条路径上（只多几十次 stat，可忽略）。
 *
 * ⚠️ 这不只是省时间，也**更准**：小批次根本不需要「目录存在」这种近似判据，
 * 逐条 `existsSync` 是零取舍的真值（连「目录在、文件没了」都不会误判）。
 */
const SMALL_BATCH_MAX = 8

/** 这批资产是否覆盖了索引里全部「未缺失」素材（= 一次全量回填） */
function isFullScan(count: number): boolean {
  try {
    const row = requireCurrent().db.prepare('SELECT COUNT(*) AS c FROM assets WHERE missing=0').get() as
      | { c: number }
      | undefined
    return count >= (row?.c ?? 0)
  } catch {
    // 读不到就保守地**不**消费标记：多跑一轮逐条判断，总比漏生成好
    return false
  }
}

/**
 * 确保单个缩略图存在。返回 `{ path, generated, hash }`；不支持的类型/失败返回 null。
 *
 * `hash` = 本次**实际使用**的 content_hash（就是 `asset.content_hash`）。回传它是必须的：
 * 渲染层拼 `stash://` URL 时需要「磁盘上这份缩略图对应的 hash」，而不是它自己那一帧（可能是旧的）
 * 素材行里的 hash —— 见 `ensureThumb` 与 `GalleryGrid.onImgErr` 的注释。
 */
async function ensureOne(asset: { id: number; type: string; ext: string; content_hash: string | null; rel_path: string }, size: ThumbSize): Promise<{ path: string; generated: boolean; hash: string } | null> {
  // 形状不合法的 hash 一律当"没有 hash"：不拿它拼路径（见 thumbFile 的说明）
  const hash = asset.content_hash
  if (!isThumbHash(hash)) return null
  const out = thumbFile(hash, size)
  if (existsSync(out)) return { path: out, generated: false, hash }

  const libPath = requireCurrent().path
  const abs = join(libPath, ...asset.rel_path.split('/'))
  if (!existsSync(abs)) return null

  mkdirSync(join(out, '..'), { recursive: true })
  const tmp = tmpPath(out)

  try {
    if (asset.type === 'image') {
      await openSource(abs)
        .rotate() // 按 EXIF 方向摆正
        .toColourspace('srgb') // HDR 广色域照片转 sRGB，避免缩略图偏灰
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
    return { path: out, generated: true, hash }
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
export function orientedDims(m: Metadata): { width: number; height: number } {
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
  } catch { /* 解析失败忽略 */ }
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

/**
 * 泵是否被**临时**暂停（改名隔离用，见 `pausePumpAsync`）。
 *
 * 语义：暂停后 `pump()` 立即返回、**不取新任务**，但已在跑的 job 照常跑完并照常 settle 批次 ——
 * 队列不清空、进度不丢。恢复（`resumePump`）后从队列原样继续。
 */
let paused = false

/** 一次「暂停」的观测量（冒烟断言用：证明暂停**真的**等到在场任务收尾，而不是空转） */
export interface PumpPauseInfo {
  /** 暂停瞬间的在场并发数 */
  inFlight: number
  /** 等到全部收尾花了多久（毫秒）；`inFlight === 0` 时为 0 */
  waitedMs: number
  /** 是否等到上限仍有任务在场（超时后照样继续，靠 finally 恢复） */
  timedOut: boolean
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * **暂停**取新任务，并有界等待在场任务收尾。
 *
 * 用途（`library.renameFolder` 的隔离链第 2 步）：改名瞬间若缩略图 job 正在解码同一子树里的文件，
 * 它会短暂持有该文件的句柄；虽然 `openSource` 已改成「读进内存」（避免长驻句柄），
 * 但 `statSync` / 写 `.thumbs` 与「改名同一目录」撞上仍可能抢到瞬时占用。
 * 停一下泵比加长重试预算可靠得多（对常驻句柄重试一万次也没用）。
 *
 * @param maxWaitMs 有界上限（默认 3s）。到点仍在跑就返回 `timedOut: true` 继续往下走 ——
 *                  **绝不**因为缩略图没跑完就把改名卡死（改名是用户主动操作，优先级更高）。
 */
export async function pausePumpAsync(maxWaitMs = 3000): Promise<PumpPauseInfo> {
  paused = true
  const inFlight = running
  const t0 = Date.now()
  while (running > 0 && Date.now() - t0 < maxWaitMs) await sleepMs(10)
  return { inFlight, waitedMs: Date.now() - t0, timedOut: running > 0 }
}

/**
 * **恢复**泵。幂等、可在任何时刻调用（没有暂停过也安全）。
 * 必须放在 `finally` 里调 —— 否则改名失败会把缩略图队列**永久**停掉（用户看到「卡片一直灰」）。
 */
export function resumePump(): void {
  paused = false
  pump()
}

/** 泵的当前状态（冒烟断言「恢复到位」用；生产代码不依赖它） */
export function pumpState(): { paused: boolean; running: number; queued: number } {
  return { paused, running, queued: queue.length }
}

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
  // 暂停中：**不取新任务**（在场 job 的 `finishJob` 仍会调回这里，也走这条早退）。
  // 队列原样保留，`resumePump()` 会再推一次。
  if (paused) return
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
  /*
   * 「这个 hash 是否已有 grid 缩略图」走**一次 readdir** 的目录集合，不再逐条 `existsSync`。
   *
   * ⚠️ **必须区分尺寸**：`detail` 那份缩略图是**按需**生成的（放大预览时才要），
   * 所以「目录存在」**不代表** `detail.webp` 存在 —— 用目录集合判断 detail 会漏生成，
   * 表现就是「点开放大一直转圈 / 图不出来」。因此 detail 保持逐条 `existsSync`。
   * （grid 是开库就全量回填的，几乎每个目录都有 grid.webp，才有这个优化空间。）
   *
   * ⚠️ 三种情况**不用**目录集合、退回逐条 `existsSync`（都是「省这点时间不值当/不正确」）：
   *   ① 清过缓存（`gridPresenceIsDirty()`，含**重启后从 meta 读回来的脏标记**）——
   *      目录在、grid.webp 不在，用它判会「清完缓存一张都不重建」；
   *   ② 批次很小（`SMALL_BATCH_MAX` 以内，`preview.ts` 的单条补图就走这条）——
   *      readdir 一个上万目录的 `.thumbs` 要 ~4ms，一次 stat 只要 ~0.03ms，而且 stat 是零取舍的真值；
   *   ③ `detail` 尺寸（上面那条）。
   */
  const stale = size === 'grid' && gridPresenceIsDirty()
  const useDirSet = size === 'grid' && !stale && assets.length > SMALL_BATCH_MAX
  const haveGrid = useDirSet ? thumbHashDirs() : null
  const fresh = assets.filter((a) => {
    // 形状校验而不是裸 `!hash`：脏值（`..` / 手改 DB）不能拿去拼 `.thumbs` 下的路径
    const h = a.content_hash
    if (!isThumbHash(h)) return false
    if (sink.has(a.id)) return true // 索引字段欠账：缩略图在也要跑一遍（见 indexFieldsSinkIds 的注释）
    if (haveGrid) return !haveGrid.has(h)
    return !existsSync(thumbFile(h, size))
  })
  // 全量批次已经用逐条判断把整库重新捞了一遍 → 目录集合重新可信，标记可以洗白了。
  // （小批次不消费：否则紧随其后的全量回填又会被目录集合骗过去。）
  // 洗白同时清 meta —— 只清内存会让「重启后」又变脏、只清 meta 会让本进程继续逐条 stat。
  if (stale && isFullScan(assets.length)) clearGridPresenceDirty()
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
