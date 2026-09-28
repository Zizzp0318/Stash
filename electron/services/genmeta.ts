// 生成参数提取 + AI 来源识别。
//
// 数据从哪来（都是实测确认过的，不是照文档推测）：
// - **PNG**：sharp 的 `metadata().comments` 直接给出 `[{keyword, text}]`，
//   且 `tEXt` / `zTXt` / `iTXt` 三种块都覆盖、`zTXt` 自动解压（sharp 0.35.4 实测）。
//   ComfyUI 写 `prompt`(API JSON) + `workflow`(UI JSON)，A1111/Forge/Fooocus 写 `parameters`，
//   NovelAI 写 `Comment`(JSON)，InvokeAI 写 `invokeai_metadata`(JSON)，Midjourney 写 `Description`。
// - **EXIF**：JPEG 的 `UserComment`(0x9286) 装 A1111 的 parameters；ComfyUI 的**动画 WebP**
//   把 `prompt:{json}` / `workflow:{json}` 塞进 `Make`(0x010F) / `Model`(0x0110)。
//   ⚠️ 这两个标签是 **ASCII 型**：非 ASCII 会被写成一串 `?`（实测 sharp 的 EXIF 写入就是如此）。
//   所以动画 WebP + 中文提示词基本拿不回原文 —— PNG 那条路没这个问题（文本块是 UTF-8）。
//   ⚠️ WebP 的 `comments` 是 undefined —— 绝不能只靠文本块，否则动画 WebP 全军覆没。
// - **C2PA / XMP**：GPT-image、Gemini、Firefly 只写内容凭据，**里面没有提示词**
//   （OpenAI 的清单只有 `description:"AI Generated Image"` + `softwareAgent` + 时间）。
//   所以这条路径只能标「这是 AI 生成的」，拿不回提示词 —— 别对用户承诺相反的事。
//
// 两个刻意的边界：
// ① **不引任何新依赖**。sharp 已经把原始数据递到手上，剩下的就是分派取值；
//    引入 `sd-parsers`（其 README 自述 PNG 文本块尚未实现）或 ExifTool（要捆 Perl ~20MB）
//    都不如自己写这一百多行可控。C2PA 也**不做验签** —— 只看标记，不引 Rust 原生模块。
// ② **纯解析不碰 DB**（`scanBuffers` 是纯函数，冒烟可以脱库喂缓冲区断言）；
//    落库与队列在文件末尾，只有那一小段依赖 `requireCurrent()`。
import { openSync, closeSync, readSync } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import sharp from 'sharp'
import { requireCurrent } from './library'
import { getSettings } from './config'

/** 识别出的生成器。`unknown` = 有生成参数但认不出是哪家 */
export type GenGenerator =
  | 'comfyui'
  | 'a1111'
  | 'fooocus'
  | 'invokeai'
  | 'novelai'
  | 'midjourney'
  | 'unknown'

export interface GenMeta {
  generator: GenGenerator
  /** 正面提示词（多段用换行拼接） */
  prompt: string
  negativePrompt: string
  /** 主模型（权重文件名，不是路径） */
  model: string
  sampler: string
  scheduler: string
  steps: number | null
  cfg: number | null
  /** 种子按字符串存 —— 它可能超过 2^53，当数字读会丢精度 */
  seed: string | null
  width: number | null
  height: number | null
  loras: string[]
  /** ComfyUI：`workflow` 块是否也在（在的话这张图能拖回 ComfyUI 复原工作流） */
  hasWorkflow: boolean
  /** 命中的原始块名，排错时用（用户说「这张读不出来」时第一眼要看的东西） */
  rawKeys: string[]
}

/** AI 来源标识：`id` 给代码/角标用，`label` 给用户看 */
export interface AiSource {
  id: string
  label: string
}

export interface ScanInput {
  comments?: Array<{ keyword: string; text: string }>
  exif?: Buffer
  /** XMP（XML 文本），sharp 的 `metadata().xmp` */
  xmp?: Buffer
  /** 文件头部若干字节，用来找 C2PA / JUMBF 这类**二进制**标记（文本块里没有） */
  head?: Buffer | null
  format?: string
}

export interface ScanOutput {
  meta: GenMeta | null
  ai: AiSource | null
}

export const AI_SOURCE_LABELS: Record<string, string> = {
  comfyui: 'ComfyUI',
  a1111: 'Stable Diffusion WebUI (A1111)',
  fooocus: 'Fooocus',
  invokeai: 'InvokeAI',
  novelai: 'NovelAI',
  midjourney: 'Midjourney',
  'c2pa:openai': 'OpenAI 内容凭据（GPT-image / DALL·E）',
  'c2pa:adobe': 'Adobe Firefly 内容凭据',
  'c2pa:google': 'Google Imagen 内容凭据',
  'c2pa:other': 'C2PA 内容凭据',
  'iptc:ai': 'IPTC 合成内容标记',
  'aigc-cn': 'AIGC 隐式标识（国内标识办法）',
  'xmp:ai': 'XMP 合成内容声明',
  'exif:openai': 'EXIF 中的 OpenAI 痕迹'
}

// ==================== EXIF：最小 IFD 扫描 ====================
//
// 只要 4 个标签，不值得为它引一个 EXIF 库：ImageDescription / Make / Model / Software / UserComment。
// sharp 给的 `metadata().exif` 是**带 `Exif\0\0` 前缀**的标准 TIFF 块（实测），所以从这里开始解析。

interface ExifTags {
  imageDescription?: string
  make?: string
  model?: string
  software?: string
  userComment?: string
}

const TAG_IMAGE_DESCRIPTION = 0x010e
const TAG_MAKE = 0x010f
const TAG_MODEL = 0x0110
const TAG_SOFTWARE = 0x0131
const TAG_EXIF_IFD = 0x8769
const TAG_USER_COMMENT = 0x9286

/** 一个 IFD 条目 */
interface IfdEntry {
  tag: number
  type: number
  count: number
  /** 值本身（短到能放进 4 字节时）/ 值在 TIFF 内的偏移 */
  valueOffset: number
  /** 值字段的原始 4 字节（就地取短值用） */
  raw: Buffer
}

function readIfd(buf: Buffer, tiff: number, dirOffset: number, little: boolean): IfdEntry[] {
  const out: IfdEntry[] = []
  if (dirOffset + 2 > buf.length) return out
  const count = little ? buf.readUInt16LE(dirOffset) : buf.readUInt16BE(dirOffset)
  // 条目数上限：损坏文件里这个值可能是天文数字，不设上限会读到越界/卡死
  for (let i = 0; i < Math.min(count, 512); i++) {
    const off = dirOffset + 2 + i * 12
    if (off + 12 > buf.length) break
    out.push({
      tag: little ? buf.readUInt16LE(off) : buf.readUInt16BE(off),
      type: little ? buf.readUInt16LE(off + 2) : buf.readUInt16BE(off + 2),
      count: little ? buf.readUInt32LE(off + 4) : buf.readUInt32BE(off + 4),
      valueOffset: little ? buf.readUInt32LE(off + 8) : buf.readUInt32BE(off + 8),
      raw: buf.subarray(off + 8, off + 12)
    })
  }
  void tiff
  return out
}

/** 取条目的字节内容（就地值 or 偏移指向的数据） */
function entryBytes(buf: Buffer, tiff: number, e: IfdEntry, little: boolean): Buffer {
  // 类型 2(ASCII)/7(UNDEFINED)/1(BYTE) 每单位 1 字节；3(SHORT)=2、4(LONG)=4、5(RATIONAL)=8
  const unit = e.type === 3 ? 2 : e.type === 4 || e.type === 9 ? 4 : e.type === 5 || e.type === 10 ? 8 : 1
  const size = unit * e.count
  if (size <= 4) return e.raw.subarray(0, size)
  const start = tiff + e.valueOffset
  if (start < 0 || start + size > buf.length) return Buffer.alloc(0)
  return buf.subarray(start, start + size)
}

function entryString(buf: Buffer, tiff: number, e: IfdEntry, little: boolean): string {
  const b = entryBytes(buf, tiff, e, little)
  // ASCII 值以 NUL 结尾，去掉尾部 NUL 再按 UTF-8 解（很多工具直接写 UTF-8）
  let end = b.length
  while (end > 0 && b[end - 1] === 0) end--
  return b.subarray(0, end).toString('utf8')
}

/**
 * UserComment 的解码：按 EXIF 规范前 8 字节是字符集代码
 * （`ASCII\0\0\0` / `UNICODE\0` / `JIS\0\0\0\0\0` / 全 0 = 未定义）。
 * A1111 走 piexif 写的是 `UNICODE\0` + **UTF-16**，不带 BOM —— 大端小端要自己猜。
 */
/** 两两交换字节（小端 ↔ 大端） */
function swapPairs(b: Buffer): Buffer {
  const out = Buffer.alloc(b.length)
  for (let i = 0; i + 1 < b.length; i += 2) {
    out[i] = b[i + 1]
    out[i + 1] = b[i]
  }
  return out
}

function decodeUserComment(raw: Buffer): string {
  if (raw.length <= 8) return ''
  const head = raw.subarray(0, 8).toString('latin1')
  const body = raw.subarray(8)
  if (head.startsWith('UNICODE')) {
    // 无 BOM 时只能看空字节落在哪一位：
    //   UTF-16**LE** 的 ASCII 是 [0x41, 0x00] → 0 在**奇数位**
    //   UTF-16**BE** 的 ASCII 是 [0x00, 0x41] → 0 在**偶数位**
    // ⚠️ 这两个判据极易写反（本套件第一次跑就把自己写红过：判反了之后 A1111 的 JPEG
    // 整段参数变成乱码，`Steps:` 匹配不上 → 整条 EXIF 路径静默失效）。
    let odd = 0
    let even = 0
    for (let i = 0; i < Math.min(body.length, 32); i++) {
      if (body[i] === 0) (i % 2 === 0 ? even++ : odd++)
    }
    const le = odd > even
    // Node 的 Buffer 只认 'utf16le'，大端得自己把字节对调过来
    const bytes = le ? body : swapPairs(body)
    let s = bytes.toString('utf16le')
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)
    return s.replace(/\0+$/, '').trim()
  }
  return body.toString('utf8').replace(/\0+$/, '').trim()
}

export function readExifTags(exif: Buffer | undefined): ExifTags {
  const out: ExifTags = {}
  if (!exif || exif.length < 14) return out
  // sharp 给的首 6 字节是 "Exif\0\0"；没有也不强求（有些来源直接给 TIFF 头）
  const tiff = exif.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? 6 : 0
  if (tiff + 8 > exif.length) return out
  const bo = exif.subarray(tiff, tiff + 2).toString('latin1')
  const little = bo === 'II'
  if (!little && bo !== 'MM') return out
  const read32 = (o: number): number => (little ? exif.readUInt32LE(o) : exif.readUInt32BE(o))
  const ifd0 = tiff + read32(tiff + 4)
  const entries = readIfd(exif, tiff, ifd0, little)

  let exifIfdOffset = 0
  for (const e of entries) {
    if (e.tag === TAG_IMAGE_DESCRIPTION) out.imageDescription = entryString(exif, tiff, e, little)
    else if (e.tag === TAG_MAKE) out.make = entryString(exif, tiff, e, little)
    else if (e.tag === TAG_MODEL) out.model = entryString(exif, tiff, e, little)
    else if (e.tag === TAG_SOFTWARE) out.software = entryString(exif, tiff, e, little)
    else if (e.tag === TAG_USER_COMMENT) out.userComment = decodeUserComment(entryBytes(exif, tiff, e, little))
    else if (e.tag === TAG_EXIF_IFD) exifIfdOffset = read32(ifd0 + 2 + entries.indexOf(e) * 12 + 8)
  }
  // UserComment 规范上住在 Exif 子目录里
  if (exifIfdOffset) {
    for (const e of readIfd(exif, tiff, tiff + exifIfdOffset, little)) {
      if (e.tag === TAG_USER_COMMENT && !out.userComment) {
        out.userComment = decodeUserComment(entryBytes(exif, tiff, e, little))
      }
    }
  }
  return out
}

// ==================== 各家解析器 ====================

/** 按 `Key: value, Key: value` 切分（值里可能含逗号，靠「下一个 Key:」前瞻切） */
function parsePairs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Za-z][A-Za-z0-9 _./-]*?):\s*([\s\S]*?)(?=,\s*[A-Za-z][A-Za-z0-9 _./-]*?:\s|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) out[m[1].trim()] = m[2].trim()
  return out
}

function toNum(v: string | undefined): number | null {
  if (v == null) return null
  const n = Number(String(v).trim())
  return Number.isFinite(n) ? n : null
}

/**
 * A1111 / Forge / Fooocus 的 `parameters` 文本块：
 * `<正面>\nNegative prompt: <负面>\nSteps: 30, Sampler: ..., CFG scale: 7, Seed: 123, Size: 512x768, Model: ...`
 *
 * 注意提示词本身可以含换行，所以**不能按行切开**：只认 `\nNegative prompt: ` 与
 * **最后一处** `\nSteps: `（有的插件还会在参数行后面追加东西）。
 */
function parseA1111(params: string, generator: GenGenerator): Partial<GenMeta> {
  const negMark = '\nNegative prompt: '
  const negIdx = params.indexOf(negMark)
  const stepIdx = params.lastIndexOf('\nSteps: ')
  const positive = (negIdx >= 0 ? params.slice(0, negIdx) : stepIdx >= 0 ? params.slice(0, stepIdx) : params).trim()
  const negative = negIdx >= 0 ? params.slice(negIdx + negMark.length, stepIdx >= 0 ? stepIdx : undefined).trim() : ''
  const pairs = stepIdx >= 0 ? parsePairs(params.slice(stepIdx + 1)) : {}
  const size = pairs['Size'] ?? ''
  const m = /^(\d+)\s*x\s*(\d+)$/.exec(size.trim())
  const loraRe = /<lora:([^:>]+)(?::([\d.]+))?>/g
  const loras: string[] = []
  let lm: RegExpExecArray | null
  while ((lm = loraRe.exec(positive)) !== null) loras.push(lm[2] ? `${lm[1]} (${lm[2]})` : lm[1])
  return {
    generator,
    prompt: positive,
    negativePrompt: negative,
    model: pairs['Model'] ?? '',
    sampler: pairs['Sampler'] ?? '',
    scheduler: pairs['Schedule type'] ?? pairs['Scheduler'] ?? '',
    steps: toNum(pairs['Steps']),
    cfg: toNum(pairs['CFG scale'] ?? pairs['CFG Scale']),
    seed: pairs['Seed'] ?? null,
    width: m ? Number(m[1]) : null,
    height: m ? Number(m[2]) : null,
    loras,
    hasWorkflow: false
  }
}

/** NovelAI 的 `Comment` JSON */
function parseNovelAI(json: string): Partial<GenMeta> {
  const j = JSON.parse(json) as Record<string, unknown>
  const v4 = j.v4_prompt as { caption?: { base_caption?: string; char_captions?: Array<{ char_caption?: string }> } } | undefined
  const base = v4?.caption?.base_caption
  const chars = (v4?.caption?.char_captions ?? []).map((c) => c.char_caption).filter((x): x is string => !!x)
  const prompt = [base, ...chars].filter(Boolean).join('\n') || String(j.prompt ?? '')
  return {
    generator: 'novelai',
    prompt,
    negativePrompt: String(j.uc ?? j.negative_prompt ?? ''),
    model: String(j.model ?? ''),
    sampler: String(j.sampler ?? ''),
    scheduler: String(j.noise_schedule ?? ''),
    steps: toNum(String(j.steps ?? '')),
    cfg: toNum(String(j.scale ?? j.cfg_scale ?? '')),
    seed: j.seed != null ? String(j.seed) : null,
    width: toNum(String(j.width ?? '')),
    height: toNum(String(j.height ?? '')),
    loras: [],
    hasWorkflow: false
  }
}

/** InvokeAI 的 `invokeai_metadata` JSON */
function parseInvoke(json: string): Partial<GenMeta> {
  const j = JSON.parse(json) as Record<string, unknown>
  const model = j.model as { model_name?: string } | undefined
  return {
    generator: 'invokeai',
    prompt: String(j.positive_prompt ?? ''),
    negativePrompt: String(j.negative_prompt ?? ''),
    model: String(model?.model_name ?? j.model_name ?? ''),
    sampler: String(j.sampler ?? ''),
    scheduler: String(j.scheduler ?? ''),
    steps: toNum(String(j.steps ?? '')),
    cfg: toNum(String(j.cfg_scale ?? '')),
    seed: j.seed != null ? String(j.seed) : null,
    width: toNum(String(j.width ?? '')),
    height: toNum(String(j.height ?? '')),
    loras: [],
    hasWorkflow: false
  }
}

/** Midjourney：`Description` 块里是提示词 + `--ar 16:9 --v 6` 之类参数 */
function parseMidjourney(desc: string): Partial<GenMeta> {
  const clean = desc.replace(/\*\*/g, '').trim()
  const flag = (name: string): string | null => {
    const m = new RegExp(`--${name}\\s+(\\S+)`).exec(clean)
    return m ? m[1] : null
  }
  const ar = /--ar\s+(\d+):(\d+)/.exec(clean)
  const v = flag('v') ?? flag('niji')
  return {
    generator: 'midjourney',
    prompt: clean.replace(/\s*--\S+(?:\s+\S+)?/g, '').trim() || clean,
    negativePrompt: flag('no') ?? '',
    model: v ? `Midjourney v${v}` : 'Midjourney',
    sampler: '',
    scheduler: '',
    steps: null,
    cfg: null,
    // Midjourney 的 --seed 是"参考图种子"，语义与 SD 的种子不同，但用户照样想复制
    seed: flag('seed'),
    width: null,
    height: null,
    loras: [],
    hasWorkflow: false
  }
}

// —— ComfyUI ——
//
// ⚠️ 这里**必须按节点类型枚举**，不能只认 KSampler：实测用户库里的 ComfyUI 图全是 FLUX 系
// （Flux2Scheduler / UNETLoader / CLIPLoader / SamplerCustomAdvanced / CFGGuider），
// **一个 KSampler 都没有** —— 只认 KSampler 的解析器会「什么参数都取不到」却又不报错。
// 种子的在 `RandomNoise.noise_seed`、步数在 `Flux2Scheduler.steps`、采样器在 `KSamplerSelect`。
const COMFY_MODEL_KEYS = ['ckpt_name', 'unet_name', 'model_name', 'clip_name', 'vae_name', 'model']
const COMFY_SEED_KEYS = ['seed', 'noise_seed']
const COMFY_STEP_KEYS = ['steps', 'steps_total']
const COMFY_CFG_KEYS = ['cfg', 'cfg_scale', 'guidance']
const COMFY_SAMPLER_KEYS = ['sampler_name', 'sampler']
const COMFY_SCHED_KEYS = ['scheduler', 'scheduler_name']
const COMFY_LORA_KEYS = ['lora_name']

type ComfyGraph = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>

/** 判断是不是「文本节点」：类名带 CLIPTextEncode，或就是几种通用的纯文本节点 */
function isComfyTextNode(classType: string, inputs: Record<string, unknown>): boolean {
  if (typeof inputs.text !== 'string' || !inputs.text.trim()) return false
  return /CLIPTextEncode|Text\s*Encode|^Text$|^Text Multiline$|^ttN text$/i.test(classType)
}

/** 引用可能是字面值，也可能是 `[nodeId, slot]` 连线 */
function isLink(v: unknown): v is [string, number] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number'
}

/**
 * 从某个输入出发沿链路往回找出所有文本节点。
 * 需要递归是因为中间常夹着 `ConditioningZeroOut` / `ConditioningSetArea` / `ControlNetApply` 之类
 * 不改文本的节点 —— 只看一层会漏掉一半以上的工作流。
 */
function resolveComfyTexts(
  graph: ComfyGraph,
  ref: unknown,
  out: string[],
  seen: Set<string>,
  depth: number
): void {
  if (depth > 32 || !isLink(ref)) return
  const id = ref[0]
  if (seen.has(`${id}:${depth}`)) return
  seen.add(`${id}:${depth}`)
  const node = graph[id]
  if (!node) return
  const inputs = node.inputs ?? {}
  if (isComfyTextNode(String(node.class_type ?? ''), inputs)) {
    out.push(String(inputs.text))
    return
  }
  for (const v of Object.values(inputs)) resolveComfyTexts(graph, v, out, seen, depth + 1)
}

function parseComfyUI(promptJson: string, hasWorkflow: boolean): Partial<GenMeta> {
  const graph = JSON.parse(promptJson) as ComfyGraph
  const nodes = Object.entries(graph)

  const positive: string[] = []
  const negative: string[] = []
  const negativeIds = new Set<string>()
  // 先从「采样器/引导器」的 negative 口往回找，命中的标记成负面 —— 否则无从区分正负
  for (const [, n] of nodes) {
    const inputs = n.inputs ?? {}
    for (const key of Object.keys(inputs)) {
      const isNeg = /^negative/i.test(key)
      const isPos = /^positive/i.test(key)
      if (!isNeg && !isPos) continue
      const found: string[] = []
      resolveComfyTexts(graph, inputs[key], found, new Set(), 0)
      for (const t of found) {
        if (isNeg) negativeIds.add(t)
        else if (!positive.includes(t)) positive.push(t)
      }
    }
  }
  // 没被标成负面的文本节点都算正面（有些工作流把负面提示词直接接在 ConditioningZeroOut 上）
  for (const [, n] of nodes) {
    const inputs = n.inputs ?? {}
    if (isComfyTextNode(String(n.class_type ?? ''), inputs)) {
      const t = String(inputs.text)
      if (!negativeIds.has(t) && !positive.includes(t)) positive.push(t)
    }
  }
  for (const t of negativeIds) negative.push(t)

  // 参数：按「所有节点里第一个出现该键的名」取值，与节点类型无关 ——
  // 这样 FLUX / SD3 / 各种自定义采样器都不用单独适配
  const pick = (keys: string[]): string => {
    for (const [, n] of nodes) {
      const inputs = n.inputs ?? {}
      for (const k of keys) {
        const v = inputs[k]
        // 连线是 `[nodeId, slot]` 数组，被 typeof 挡在外面，不用再单独判
        if (typeof v === 'string' || typeof v === 'number') return String(v)
      }
    }
    return ''
  }
  const models: string[] = []
  const loras: string[] = []
  for (const [, n] of nodes) {
    const inputs = n.inputs ?? {}
    for (const k of COMFY_MODEL_KEYS) {
      const v = inputs[k]
      if (typeof v === 'string' && v.trim() && !models.includes(v)) models.push(v)
    }
    for (const k of COMFY_LORA_KEYS) {
      const v = inputs[k]
      if (typeof v === 'string' && v.trim()) {
        const w = inputs.strength_model ?? inputs.strength
        loras.push(typeof w === 'number' ? `${v} (${w})` : v)
      }
    }
  }
  // 尺寸优先取 EmptyLatentImage 之类；取不到就留空（缩略图那边已经写了真实宽高）
  let width: number | null = null
  let height: number | null = null
  for (const [, n] of nodes) {
    const inputs = n.inputs ?? {}
    if (typeof inputs.width === 'number' && typeof inputs.height === 'number' && /Latent|Empty/i.test(String(n.class_type))) {
      width = inputs.width
      height = inputs.height
      break
    }
  }
  return {
    generator: 'comfyui',
    prompt: positive.join('\n').trim(),
    negativePrompt: negative.join('\n').trim(),
    model: models[0] ?? '',
    sampler: pick(COMFY_SAMPLER_KEYS),
    scheduler: pick(COMFY_SCHED_KEYS),
    steps: toNum(pick(COMFY_STEP_KEYS)),
    cfg: toNum(pick(COMFY_CFG_KEYS)),
    seed: pick(COMFY_SEED_KEYS) || null,
    width,
    height,
    loras,
    hasWorkflow
  }
}

// ==================== AI 来源标识 ====================

/**
 * 只做**标记检测**，不做验签（验签要完整的 C2PA 实现，得引 Rust 原生模块，与项目原则冲突；
 * 而且我们只想知道「是不是 AI 生成的」，不关心「有没有被篡改」）。
 * 这些标记在文本块里看不到（PNG 的 `caBX`/`caMs`/`caSt`、JPEG 的 APP11+JUMBF 都是二进制块），
 * 所以要看原始文件头字节。
 */
function detectFromHead(head: Buffer | null | undefined, tags: ExifTags, xmp: string): AiSource | null {
  const probe = (head ?? Buffer.alloc(0)).toString('latin1')
  const all = probe + '\n' + Object.values(tags).join('\n') + '\n' + xmp
  const hasC2pa =
    probe.includes('caBX') || probe.includes('caMs') || probe.includes('caSt') ||
    /jumbf|JUMBF|JPEG universal metadata box|c2pa/i.test(probe)
  const openai = /OpenAI|DALL[\s·-]?E|gpt-image|ChatGPT/i.test(all)
  const adobe = /Firefly|Adobe Inc|Adobe Systems/i.test(all)
  const google = /Google LLC|Imagen|SynthID/i.test(all)
  const iptcAi = /trainedAlgorithmicMedia|compositeSynthetic/i.test(all)

  if (hasC2pa) {
    if (openai) return { id: 'c2pa:openai', label: AI_SOURCE_LABELS['c2pa:openai'] }
    if (adobe) return { id: 'c2pa:adobe', label: AI_SOURCE_LABELS['c2pa:adobe'] }
    if (google) return { id: 'c2pa:google', label: AI_SOURCE_LABELS['c2pa:google'] }
    return { id: 'c2pa:other', label: AI_SOURCE_LABELS['c2pa:other'] }
  }
  if (iptcAi) return { id: 'iptc:ai', label: AI_SOURCE_LABELS['iptc:ai'] }
  // 没有 C2PA 时退回 EXIF / XMP 里的痕迹（GPT-image 的图常见 Software="openai"）
  if (openai) return { id: 'exif:openai', label: AI_SOURCE_LABELS['exif:openai'] }
  if (/trainedAlgorithmicMedia|ai[:_-]?generated/i.test(all)) {
    return { id: 'xmp:ai', label: AI_SOURCE_LABELS['xmp:ai'] }
  }
  return null
}

// ==================== 主入口（纯函数） ====================

/**
 * 从「已经读出来的元数据」解析生成参数与 AI 来源。**不碰磁盘、不碰 DB**，
 * 所以冒烟可以直接喂构造好的缓冲区断言，不用先造一张真图。
 *
 * `want` 决定**要不要采纳**哪一类结果：关掉的项不写回，但状态位也会跟着不置 ——
 * 这样用户以后把设置打开，backfill 还能把它们补上（见文件末尾的位标记设计）。
 */
export function scanBuffers(input: ScanInput): ScanOutput {
  const comments = input.comments ?? []
  const byKey = new Map(comments.map((c) => [c.keyword, c.text]))
  const tags = readExifTags(input.exif)
  const xmp = input.xmp ? (input.xmp.toString('utf8') || '') : ''
  const rawKeys = comments.map((c) => c.keyword)
  let meta: GenMeta | null = null

  const finish = (partial: Partial<GenMeta>): void => {
    meta = {
      prompt: '', negativePrompt: '', model: '', sampler: '', scheduler: '',
      steps: null, cfg: null, seed: null, width: null, height: null,
      loras: [], hasWorkflow: false, rawKeys, generator: 'unknown',
      ...partial
    }
  }

  // ⚠️ 顺序有讲究：ComfyUI 的块名（prompt/workflow）最短最通用，必须先认它，
  // 否则会被后面某个「有 parameters 就当 A1111」的分支抢走。
  const comfyPrompt = byKey.get('prompt')
  if (comfyPrompt && /^\s*\{/.test(comfyPrompt)) {
    try {
      finish(parseComfyUI(comfyPrompt, byKey.has('workflow')))
    } catch {
      meta = null // prompt 块存在但不是合法 JSON → 不是 ComfyUI，交给后面的解析器
    }
  }
  // ComfyUI 动画 WebP：prompt/workflow 被塞进 EXIF 的 Make / Model
  if (!meta && tags.make?.startsWith('prompt:') ) {
    try {
      finish(parseComfyUI(tags.make.slice('prompt:'.length), !!tags.model?.startsWith('workflow:')))
    } catch { meta = null }
  }
  if (!meta && tags.userComment && /\bSteps:\s*\d/.test(tags.userComment)) {
    finish(parseA1111(tags.userComment, 'a1111'))
  }
  if (!meta) {
    const params = byKey.get('parameters')
    if (params && /(^|\n)Steps:\s*\d/.test(params)) {
      finish(parseA1111(params, byKey.has('fooocus_scheme') || byKey.has('fooocus') ? 'fooocus' : 'a1111'))
    }
  }
  if (!meta) {
    const inv = byKey.get('invokeai_metadata')
    if (inv) { try { finish(parseInvoke(inv)) } catch { meta = null } }
  }
  if (!meta) {
    const nai = byKey.get('Comment') ?? byKey.get('comment')
    if (nai && /^\s*\{/.test(nai)) {
      try {
        const parsed = parseNovelAI(nai)
        // 别把任意 JSON 注释都当 NovelAI：必须有它那几个特征字段之一
        if (/"(prompt|uc|steps|sampler|v4_prompt)"/.test(nai)) finish(parsed)
      } catch { meta = null }
    }
  }
  if (!meta) {
    const mj = byKey.get('Description') ?? byKey.get('Title')
    // Midjourney 的 Description 就是提示词本身，没有别的特征可验证 ——
    // 要求它至少像个提示词（有 `--` 参数，或有实质文字），避免把普通说明文字当成提示词
    if (mj && (/\s--[a-z]+/.test(mj) || mj.trim().length > 12)) {
      const looksLikeAi = /\s--(ar|v|niji|stylize|chaos|seed|no|iw|s)\b/.test(mj)
      if (looksLikeAi) finish(parseMidjourney(mj))
    }
  }

  // 来源标识的优先级：
  // ① 认出了生成器 → 用它（说明我们连提示词都拿到了，信息量最大）
  // ② 国内《AI 生成合成内容标识办法》的 `AIGC` 隐式标识块（**文本块**，head 扫描看不到）
  // ③ C2PA / IPTC / EXIF·XMP 痕迹 —— 只有来源、没有提示词
  // `meta` 是在闭包 `finish()` 里赋的值，TS 的控制流分析看不见，这里显式收回类型
  const resolved = meta as GenMeta | null
  let ai: AiSource | null = null
  if (resolved && resolved.generator !== 'unknown') {
    ai = { id: resolved.generator, label: AI_SOURCE_LABELS[resolved.generator] ?? resolved.generator }
  }
  if (!ai && byKey.has('AIGC')) ai = { id: 'aigc-cn', label: AI_SOURCE_LABELS['aigc-cn'] }
  if (!ai) ai = detectFromHead(input.head, tags, xmp)
  return { meta: resolved, ai }
}

// ==================== 文件头读取 ====================
//
// C2PA / JUMBF 是二进制块，sharp 的 comments 里看不到，只能自己看文件头。
// 只读前 256KB：C2PA 与 PNG 文本块都写在 IDAT 之前，256KB 足够覆盖；
// 全量读一个几十 MB 的图为了找几个标记不值得。

const HEAD_BYTES = 262144

export function readHead(abs: string): Buffer | null {
  let fd: number | null = null
  try {
    fd = openSync(abs, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0)
    return buf.subarray(0, n)
  } catch {
    return null
  } finally {
    if (fd != null) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

// ==================== 扫描队列 + 落库 ====================

/**
 * 自动填入「提示词」字段的文本。
 * 有负向提示词时按 A1111 的惯例另起一段加 `Negative prompt:` 前缀 ——
 * 这样整段可以原样复制回生成器，也不会和正面提示词糊在一起分不清。
 */
function noteTextOf(m: GenMeta): string {
  if (!m.prompt) return ''
  return m.negativePrompt ? `${m.prompt}\n\nNegative prompt: ${m.negativePrompt}` : m.prompt
}

/** 位标记：哪一类已经扫过。用位而不是「有没有值」判断，见下方 backfillMeta 的注释 */
export const STATE_META = 1
export const STATE_AI = 2

interface MetaJob {
  id: number
  rel_path: string
}

const META_CONCURRENCY = 3
const metaQueue: MetaJob[] = []
const queuedIds = new Set<number>()
let metaRunning = 0

function broadcast(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows()[0]?.webContents.send(channel, data)
}

/**
 * 扫描并落库。
 *
 * `gen_state` 用**位标记**记录「扫过哪一类」，而不是「有没有值」：
 * 靠「值为空」判断的话，「本来就没有元数据」的图会被**无限次重扫**；
 * 用位标记还能处理「只开了 AI 识别、后开提示词提取」—— 状态位只置了 AI 那一位，
 * 后开的那位没置，backfill 自然会把它们再捞一遍。
 */
export async function scanAsset(job: MetaJob): Promise<void> {
  const { db, path: libPath } = requireCurrent()
  const s = getSettings()
  const wantMeta = s.importing.extractMeta
  const wantAi = s.importing.detectAi
  if (!wantMeta && !wantAi) return // 交给 backfillMeta 早退，这里再兜一层

  const abs = join(libPath, ...job.rel_path.split('/'))
  let out: ScanOutput = { meta: null, ai: null }
  try {
    const md = await sharp(abs).metadata()
    // 开关关掉的那一类连读都不读（头部读取是额外的 IO）
    const head = wantAi ? readHead(abs) : null
    const r = scanBuffers({ comments: md.comments, exif: md.exif, xmp: md.xmp, head, format: md.format })
    out = { meta: wantMeta ? r.meta : null, ai: wantAi ? r.ai : null }
  } catch {
    // 读失败也照样落状态：否则每次 backfill 都会重试同一个坏文件
  }

  let mask = 0
  if (wantMeta) mask |= STATE_META
  if (wantAi) mask |= STATE_AI
  try {
    const cur = db.prepare('SELECT gen_state, note FROM assets WHERE id=?').get(job.id) as
      | { gen_state: number | null; note: string | null }
      | undefined
    if (!cur) return // 扫描期间素材被删了
    const next = (cur.gen_state ?? 0) | mask

    // 提取到的提示词**直接填进「提示词」字段**（这是本功能唯一的对外表现），
    // 但**只在这张素材的 note 还是空的时候**才写 —— 用户手写过的内容绝不覆盖。
    //
    // ⚠️ 必须与上面那几个字段**写在同一条 UPDATE 里**：分两条写的话，
    // 中间存在「状态位已置位、提示词还没写」的窗口，任何按状态位判断「扫完了」的调用方
    // （冒烟、以及将来可能的 UI）都会读到一半的结果。
    const fill = wantMeta && out.meta?.prompt && !(cur.note ?? '').trim() ? noteTextOf(out.meta) : null
    db.prepare('UPDATE assets SET gen_meta=?, ai_source=?, gen_state=?, note=? WHERE id=?')
      .run(
        out.meta ? JSON.stringify(out.meta) : null,
        out.ai ? out.ai.id : null,
        next,
        fill ?? cur.note,
        job.id
      )
  } catch {
    /* 落库失败不重试，避免坏行把队列卡死 */
  }
}

function metaPump(): void {
  while (metaRunning < META_CONCURRENCY && metaQueue.length > 0) {
    const job = metaQueue.shift()!
    queuedIds.delete(job.id)
    metaRunning++
    scanAsset(job)
      .catch(() => { /* scanAsset 内部已兜底 */ })
      .finally(() => {
        metaRunning--
        metaPump()
        if (metaRunning === 0 && metaQueue.length === 0) broadcast('meta:done', {})
      })
  }
}

/** 把「该扫但还没扫的图片」入队。返回入队数量（冒烟断言用） */
export function backfillMeta(): { queued: number } {
  const s = getSettings()
  let mask = 0
  if (s.importing.extractMeta) mask |= STATE_META
  if (s.importing.detectAi) mask |= STATE_AI
  // 两类都关就什么都不做：**状态位一个都不置**，用户以后打开开关还能补扫
  if (!mask) return { queued: 0 }

  const { db } = requireCurrent()
  const rows = db
    .prepare(`SELECT id, rel_path FROM assets WHERE missing=0 AND type='image' AND (coalesce(gen_state,0) & ?) <> ?`)
    .all(mask, mask) as unknown as MetaJob[]
  const fresh = rows.filter((r) => !queuedIds.has(r.id))
  if (!fresh.length) return { queued: 0 }
  for (const r of fresh) queuedIds.add(r.id)
  metaQueue.push(...fresh)
  metaPump()
  return { queued: fresh.length }
}
