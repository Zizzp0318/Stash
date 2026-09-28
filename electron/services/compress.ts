// 按需压缩：把库里体积大的图转成 JPG / WebP，原地替换以省磁盘。
//
// ⚠️ 这个模块有三条**有实测/源码依据**的铁律，别凭直觉改：
//
// ① **PNG 必须显式给 `effort`**。实测 `sharp().png({ compressionLevel: 9 })` 不传 effort 时
//    写入 5475 KB，而原文件才 3823 KB —— 大了 43%，「压缩」直接变成「膨胀」。
//    给 effort=7 后是 1279 KB（33%），而 effort=10 只再省 0.3% 却慢 58%。7 是甜点。
//
// ② **透明转 JPEG 必须先 flatten**。实测不 flatten 时透明区变成纯黑 RGB(0,0,0)，
//    `flatten({ background: '#ffffff' })` 才是白的。压坏一张透明图是不可逆的。
//
// ③ **原地替换的顺序不能变**：写临时文件 → 校验 → rename → **先更新索引** → 最后删旧文件。
//    反过来的话 watcher 会 `UPDATE ... SET missing=1`（把旧路径标失效）或
//    `INSERT` 一行重复素材（把新文件当外部新增）。除了顺序，还主动 `suppressRel()` 抑制一次，
//    不依赖 `awaitWriteFinish` 的 800ms 时间窗 —— 那 800ms 里我们还要哈希大文件 + 写 sqlite，
//    慢机器 / 网络盘上完全可能超时。
import { BrowserWindow } from 'electron'
import { existsSync, renameSync, rmSync, statSync } from 'fs'
import { unlinkSync } from 'fs'
import { basename, dirname, extname, join } from 'path'
import sharp, { type Metadata } from 'sharp'
import { requireCurrent } from './library'
import { contentHash, EXT_TYPE } from './importer'
import { uniqueName } from './naming'
import { ensureBatch } from './thumbs'
import { suppressRel } from './watcher'

export type CompressFormat = 'jpeg' | 'webp'

export interface CompressOptions {
  format?: CompressFormat
  /** 1~100；JPG 走 mozjpeg、WebP 走 libwebp */
  quality?: number
  /** 长边上限，0 = 不限制（默认） */
  maxEdge?: number
  /** 是否也重新压缩已经是 JPG 的图。默认 false —— 二次有损编码会叠加画质损失 */
  alsoJpeg?: boolean
}

export interface CompressItemResult {
  id: number
  name: string
  /** done = 已替换；skipped = 按规则跳过；failed = 出错 */
  status: 'done' | 'skipped' | 'failed'
  reason: string
  before: number
  after: number
  newName?: string
}

export interface CompressSummary {
  total: number
  done: number
  skipped: number
  failed: number
  beforeBytes: number
  afterBytes: number
  savedBytes: number
  items: CompressItemResult[]
}

interface CompressRow {
  id: number
  name: string
  rel_path: string
  ext: string
  type: string
  size: number
  content_hash: string | null
}

function broadcast(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows()[0]?.webContents.send(channel, data)
}

/** 临时文件序号：同一进程内单调递增，保证并发/连续任务不会撞名 */
let tmpSeq = 0

/**
 * 临时文件路径：**与目标文件同目录**，这样 rename 是同盘操作（跨盘 rename 要先复制，慢得多）。
 * 命名同时满足两个「不会被 watcher 当成外部新增」的条件（双保险）：
 *   - 扩展名 `.tmp` 不在 `EXT_TYPE` 白名单里（watcher 的 add 处理会直接 return）
 *   - 文件名以 `.stash-compress-` 开头，已加进 watcher 的 `ignored`
 */
function tmpPathFor(abs: string): string {
  return join(dirname(abs), `.stash-compress-${process.pid}-${++tmpSeq}.tmp`)
}

/** 目标扩展名 */
function targetExt(fmt: CompressFormat): string {
  return fmt === 'jpeg' ? 'jpg' : 'webp'
}

/** 压缩后的预计原始尺寸（只用于校验，不用于断言格式） */
interface Probe {
  width: number
  height: number
  format: string | undefined
}

/** 主进程侧串行跑（图像解码是内存与 CPU 大头，串行最可预测，也避免 sqlite 交叉写） */
let running = false

export async function compressAssets(ids: number[], opts: CompressOptions = {}): Promise<CompressSummary> {
  const { db, path: libPath } = requireCurrent()
  const summary: CompressSummary = {
    total: 0,
    done: 0,
    skipped: 0,
    failed: 0,
    beforeBytes: 0,
    afterBytes: 0,
    savedBytes: 0,
    items: []
  }
  if (!ids.length) return summary

  // 已经在跑就拒绝：这是「就地改文件 + 改索引」的重活，叠在一起跑必然互相打脸
  if (running) throw new Error('ERR_COMPRESS_BUSY')
  running = true
  try {
    const ph = ids.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT id, name, rel_path, ext, type, size, content_hash
           FROM assets WHERE id IN (${ph}) AND missing=0 AND type='image'`
      )
      .all(...ids) as unknown as CompressRow[]

    summary.total = rows.length
    let idx = 0
    // 进度里的「已省」必须**边跑边累计**：summary.savedBytes 是循环结束才结算的，
    // 直接广播它的话整个过程中都是 0，用户会以为一点没省
    let savedSoFar = 0
    for (const row of rows) {
      idx++
      let item: CompressItemResult
      try {
        item = await compressOne(row, opts)
      } catch (e) {
        item = {
          id: row.id,
          name: row.name,
          status: 'failed',
          reason: String((e as Error)?.message ?? e).slice(0, 120),
          before: 0,
          after: 0
        }
      }
      summary.items.push(item)
      summary.beforeBytes += item.before
      summary.afterBytes += item.status === 'done' ? item.after : item.before
      if (item.status === 'done') {
        summary.done++
        savedSoFar += item.before - item.after
      } else if (item.status === 'skipped') summary.skipped++
      else summary.failed++
      broadcast('compress:progress', {
        done: idx,
        total: rows.length,
        name: item.name,
        status: item.status,
        reason: item.reason,
        savedBytes: savedSoFar
      })
    }
    summary.savedBytes = summary.beforeBytes - summary.afterBytes
  } finally {
    running = false
  }
  broadcast('compress:done', { summary })
  return summary
}

async function compressOne(row: CompressRow, opts: CompressOptions): Promise<CompressItemResult> {
  const { db, path: libPath } = requireCurrent()
  const fmt: CompressFormat = opts.format ?? 'jpeg'
  const quality = Math.min(100, Math.max(1, Math.round(opts.quality ?? 90)))
  const maxEdge = Math.max(0, Math.round(opts.maxEdge ?? 0))

  const abs = join(libPath, ...row.rel_path.split('/'))
  if (!existsSync(abs)) {
    return { id: row.id, name: row.name, status: 'skipped', reason: '文件不在磁盘上', before: 0, after: 0 }
  }
  const before = statSync(abs).size
  const base = { id: row.id, name: row.name, before, after: before }

  // ---- 先看清楚源文件：动图与不可解码的一律不碰 ----
  let srcMeta: Metadata
  try {
    srcMeta = await sharp(abs).metadata()
  } catch {
    return { ...base, status: 'skipped', reason: '无法解码，跳过' }
  }
  if ((srcMeta.pages ?? 1) > 1) {
    // 转 JPEG/WebP 单帧会把动图压成一张静图 —— 那是「破坏」不是「压缩」
    return { ...base, status: 'skipped', reason: '动图（多帧），压缩会只剩一帧，跳过' }
  }
  if (!srcMeta.width || !srcMeta.height) {
    return { ...base, status: 'skipped', reason: '读不到尺寸信息，跳过' }
  }

  // 已经是 JPG 且用户没允许 → 跳过。二次有损编码会把上一代的损失叠上来，
  // 而库里的 JPG 平均只有 200KB，压它收益小、代价是画质
  const srcExt = row.ext.toLowerCase()
  if (fmt === 'jpeg' && (srcExt === 'jpg' || srcExt === 'jpeg') && opts.alsoJpeg !== true) {
    return { ...base, status: 'skipped', reason: '已是 JPG（避免二次有损编码）' }
  }
  if (fmt === 'webp' && srcExt === 'webp') {
    return { ...base, status: 'skipped', reason: '已是 WebP' }
  }

  // ---- 转码到临时文件 ----
  const tmp = tmpPathFor(abs)
  try {
    let pipe = sharp(abs).rotate() // 按 EXIF 方向摆正（转完就没 EXIF 了，方向必须烧进像素）

    // ② 透明先压白底：不压的话透明区会变成纯黑（实测 RGB 0,0,0）
    if (srcMeta.hasAlpha) pipe = pipe.flatten({ background: '#ffffff' })

    if (maxEdge > 0 && Math.max(srcMeta.width, srcMeta.height) > maxEdge) {
      pipe = pipe.resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    }

    // ICC 必须留着：剥掉的话广色域图（手机照片、HEIC 转来的）颜色会变。
    // 其它元数据（EXIF / PNG 文本块）就随它去 —— 见文件末尾的说明。
    pipe = pipe.keepIccProfile()

    if (fmt === 'jpeg') {
      // mozjpeg：实测同质量比普通 JPEG 编码器小 18%（240KB vs 293KB）
      pipe = pipe.jpeg({ quality, mozjpeg: true, progressive: true })
    } else {
      pipe = pipe.webp({ quality, effort: 5 })
    }
    await pipe.toFile(tmp)
  } catch (e) {
    safeUnlink(tmp)
    return { ...base, status: 'failed', reason: `转码失败：${String((e as Error)?.message ?? e).slice(0, 90)}` }
  }

  // ---- 校验：能解码、格式对、尺寸对 —— 三道都过了才敢往原文件上动手 ----
  let outMeta: Probe
  try {
    const m = await sharp(tmp).metadata()
    outMeta = { width: m.width ?? 0, height: m.height ?? 0, format: m.format }
  } catch {
    safeUnlink(tmp)
    return { ...base, status: 'failed', reason: '转码结果无法解码，已放弃（原文件未动）' }
  }
  const wantFormat = fmt === 'jpeg' ? 'jpeg' : 'webp'
  if (outMeta.format !== wantFormat) {
    safeUnlink(tmp)
    return { ...base, status: 'failed', reason: `转码结果格式是 ${outMeta.format}，不是 ${wantFormat}` }
  }
  const expectW = maxEdge > 0 ? Math.min(srcMeta.width, maxEdge) : srcMeta.width
  const expectH = maxEdge > 0 ? Math.min(srcMeta.height, maxEdge) : srcMeta.height
  // 缩放是等比 contain，只要「不超过上限」且比例一致即可，不要求像素级相等
  if (outMeta.width > expectW + 1 || outMeta.height > expectH + 1 || outMeta.width <= 0 || outMeta.height <= 0) {
    safeUnlink(tmp)
    return {
      ...base,
      status: 'failed',
      reason: `尺寸校验不过：得到 ${outMeta.width}x${outMeta.height}，期望不超过 ${expectW}x${expectH}`
    }
  }

  // ---- 只有更小才替换 ----
  const after = statSync(tmp).size
  if (after >= before) {
    safeUnlink(tmp)
    return {
      ...base,
      status: 'skipped',
      reason: `压缩后没有更小（${fmtSize(before)} → ${fmtSize(after)}）`
    }
  }

  // ---- 落到磁盘 + 同步索引（顺序见文件头 ③）----
  const dir = dirname(abs)
  const dirRel = row.rel_path.includes('/') ? row.rel_path.slice(0, row.rel_path.lastIndexOf('/')) : ''
  const wantExt = targetExt(fmt)
  const srcBase = basename(abs, extname(abs))
  const sameName = extname(abs).slice(1).toLowerCase() === wantExt

  let targetName: string
  if (sameName) {
    // 同格式覆盖（jpg→jpg / webp→webp）：目标就是它自己，不去做唯一化，
    // 否则 uniqueName 会因为「文件已存在」（就是原文件）而生成 `a (1).jpg`
    targetName = basename(abs)
  } else {
    targetName = uniqueName(dir, `${srcBase}.${wantExt}`)
  }
  const targetAbs = join(dir, targetName)
  const newRel = dirRel ? `${dirRel}/${targetName}` : targetName

  try {
    if (sameName) {
      // 覆盖同一个路径：只要抑制旧 rel 就够了
      suppressRel(row.rel_path)
      renameSync(tmp, targetAbs)
    } else {
      suppressRel(newRel) // 新文件出现 → 别被当成外部新增
      suppressRel(row.rel_path) // 旧文件消失 → 别把已经改好的行标 missing
      renameSync(tmp, targetAbs)
    }
  } catch (e) {
    safeUnlink(tmp)
    return { ...base, status: 'failed', reason: `替换失败：${String((e as Error)?.message ?? e).slice(0, 90)}` }
  }

  // 索引先更新：此后 watcher 收到 add(newRel) 会查到自己这行而 return
  const newHash = contentHash(targetAbs)
  const st = statSync(targetAbs)
  const newType = EXT_TYPE[wantExt] ?? 'image'
  db.prepare(
    `UPDATE assets
        SET name=?, rel_path=?, ext=?, type=?, size=?, file_mtime=?, content_hash=?,
            width=?, height=?, missing=0
      WHERE id=?`
  ).run(targetName, newRel, wantExt, newType, st.size, Math.floor(st.mtimeMs), newHash, outMeta.width, outMeta.height, row.id)

  // 旧文件在索引改完之后才删（顺序反了就是「有记录没文件」的幽灵条目）
  if (!sameName) {
    try {
      unlinkSync(abs)
    } catch {
      /* 删不掉也不回滚：索引已指向新文件，留个孤儿文件比留个幽灵记录好 */
    }
  }

  // ---- 旧缩略图缓存：hash 变了，`.thumbs/{旧hash}/` 成孤儿 ----
  if (row.content_hash && row.content_hash !== newHash && /^[0-9a-f]{20}$/.test(row.content_hash)) {
    const used = db.prepare('SELECT count(*) AS c FROM assets WHERE content_hash=?').get(row.content_hash) as {
      c: number
    }
    if (!used.c) {
      try {
        rmSync(join(libPath, '.thumbs', row.content_hash), { recursive: true, force: true })
      } catch {
        /* 缓存清理失败不影响压缩结果 */
      }
    }
  }

  // ---- 重建缩略图（hash 变 → 路径也变，不重建卡片就是一块灰）----
  const fresh = [{ id: row.id, type: newType, ext: wantExt, content_hash: newHash, rel_path: newRel }]
  ensureBatch(fresh, 'grid')
  ensureBatch(fresh, 'detail')

  return { ...base, status: 'done', reason: '', after, newName: targetName }
}

function safeUnlink(p: string): void {
  try {
    unlinkSync(p)
  } catch {
    /* 临时文件可能已经被移走 */
  }
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
