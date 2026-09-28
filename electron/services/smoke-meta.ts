// AI 生成参数提取冒烟：electron . --smoke-meta
//
// 覆盖 services/genmeta.ts：
//   M1 纯解析（喂缓冲区，不落盘）—— 六家解析器各来一张，外加「不该被认出来」的反例
//   M2 端到端            —— 造带真元数据的图 → 导入 → 后台扫 → 落库 → **提示词自动填进「提示词」字段** + 卡片角标
//   M3 设置开关          —— 关掉提取只留来源识别 / 两个都关 / 关掉角标，各自的行为边界
//
// ⚠️ 会写真实的 userData/config.json（偏好就存在那儿），开头快照、finally 原样还原。
//
// 造样本的做法（都是**真图**，不是 mock）：
// - PNG 文本块（tEXt / zTXt / iTXt）自己拼 chunk 插到 IHDR 后面 —— 中英文都试过，三种块都能原样读回
// - A1111 存 JPEG 时参数在 EXIF `UserComment`（"UNICODE\0" + UTF-16BE），sharp 不会**写**这个标签，
//   所以手搓一段最小 TIFF 塞进 APP1 —— 顺带把自写的 IFD 扫描器也验了
// - ComfyUI 动画 WebP 的参数在 EXIF 的 Make / Model（"prompt:{json}"），用 sharp 的 withMetadata 真写
import { app, BrowserWindow } from 'electron'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import zlib from 'zlib'
import sharp from 'sharp'
import { closeCurrent, createLibrary, mkdirRel, requireCurrent } from './library'
import { importFiles } from './importer'
import { DEFAULT_SETTINGS, getSettings, patchSettings, type Settings } from './config'
import { scanBuffers, type GenMeta } from './genmeta'

interface Check { name: string; pass: boolean; detail?: string }

// ==================== 造样本用的工具 ====================

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(body) >>> 0)
  return Buffer.concat([len, body, crc])
}

const tEXt = (kw: string, t: string): Buffer =>
  pngChunk('tEXt', Buffer.concat([Buffer.from(kw, 'latin1'), Buffer.from([0]), Buffer.from(t, 'utf8')]))
const zTXt = (kw: string, t: string): Buffer =>
  pngChunk('zTXt', Buffer.concat([Buffer.from(kw, 'latin1'), Buffer.from([0, 0]), zlib.deflateSync(Buffer.from(t, 'utf8'))]))
const iTXt = (kw: string, t: string): Buffer =>
  pngChunk(
    'iTXt',
    Buffer.concat([
      Buffer.from(kw, 'latin1'), Buffer.from([0]), Buffer.from([0, 0]),
      Buffer.from([0]), Buffer.from([0]), Buffer.from(t, 'utf8')
    ])
  )
/** 任意二进制块（用来放 C2PA 的 caBX 这类非文本块） */
const binChunk = (type: string, payload: string): Buffer => pngChunk(type, Buffer.from(payload, 'latin1'))

/** 把若干块插到 IHDR 之后 */
function splicePng(base: Buffer, chunks: Buffer[]): Buffer {
  const sig = base.subarray(0, 8)
  let off = 8
  let head: Buffer | null = null
  const rest: Buffer[] = []
  while (off < base.length) {
    const len = base.readUInt32BE(off)
    const type = base.subarray(off + 4, off + 8).toString('latin1')
    const whole = base.subarray(off, off + 12 + len)
    if (type === 'IHDR') head = whole
    else rest.push(whole)
    off += 12 + len
  }
  return Buffer.concat([sig, head ?? Buffer.alloc(0), ...chunks, ...rest])
}

const utf16be = (s: string): Buffer => Buffer.from(s, 'utf16le').swap16()

/**
 * 最小 TIFF：IFD0 里只放一个「指向 Exif 子目录」的指针，子目录里放 UserComment。
 * 布局（小端）：0 头 / 8 IFD0(18B) / 26 ExifIFD(18B) / 44 数据
 */
function exifWithUserComment(text: string): Buffer {
  const body = Buffer.concat([Buffer.from('UNICODE\0', 'latin1'), utf16be(text)])
  const ifd0Off = 8
  const exifIfdOff = ifd0Off + 18
  const dataOff = exifIfdOff + 18
  const buf = Buffer.alloc(dataOff + body.length)
  buf.write('II', 0, 'latin1')
  buf.writeUInt16LE(42, 2)
  buf.writeUInt32LE(ifd0Off, 4)
  buf.writeUInt16LE(1, ifd0Off)
  buf.writeUInt16LE(0x8769, ifd0Off + 2)
  buf.writeUInt16LE(4, ifd0Off + 4)
  buf.writeUInt32LE(1, ifd0Off + 6)
  buf.writeUInt32LE(exifIfdOff, ifd0Off + 10)
  buf.writeUInt32LE(0, ifd0Off + 14)
  buf.writeUInt16LE(1, exifIfdOff)
  buf.writeUInt16LE(0x9286, exifIfdOff + 2)
  buf.writeUInt16LE(7, exifIfdOff + 4)
  buf.writeUInt32LE(body.length, exifIfdOff + 6)
  buf.writeUInt32LE(dataOff, exifIfdOff + 10)
  buf.writeUInt32LE(0, exifIfdOff + 14)
  body.copy(buf, dataOff)
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), buf])
}

/** 把 EXIF 作为 APP1 插到 SOI 之后 */
function jpegWithExif(base: Buffer, exif: Buffer): Buffer {
  const len = Buffer.alloc(2)
  len.writeUInt16BE(2 + exif.length)
  const seg = Buffer.concat([Buffer.from([0xff, 0xe1]), len, exif])
  return Buffer.concat([base.subarray(0, 2), seg, base.subarray(2)])
}

// ==================== 样本数据 ====================

const CN_PROMPT = '移除左上角和右下角的文字水印，保持其他元素不变'
const CN_NEGATIVE = '模糊，低质量，多余手指'

/**
 * FLUX 系 ComfyUI 工作流（照用户库里真实的那批抄的：没有 KSampler）。
 * 刻意把负面提示词接在 `ConditioningZeroOut` 后面 —— 中间夹一层不改文本的节点，
 * 只往上看一层的解析器会漏掉它（这是真实工作流里最常见的样子）。
 */
function fluxGraph(): string {
  return JSON.stringify({
    '3': { class_type: 'UNETLoader', inputs: { unet_name: 'flux2-dev-fp8.safetensors', weight_dtype: 'default' } },
    '4': { class_type: 'CLIPLoader', inputs: { clip_name: 't5xxl_fp16.safetensors', type: 'flux' } },
    '199': { class_type: 'CLIPTextEncode', inputs: { text: CN_PROMPT, clip: ['4', 0] } },
    '200': { class_type: 'CLIPTextEncode', inputs: { text: CN_NEGATIVE, clip: ['4', 0] } },
    '201': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['200', 0] } },
    '202': { class_type: 'CFGGuider', inputs: { model: ['3', 0], positive: ['199', 0], negative: ['201', 0], cfg: 1.5 } },
    '203': { class_type: 'RandomNoise', inputs: { noise_seed: 123456789012345 } },
    '204': { class_type: 'Flux2Scheduler', inputs: { steps: 20, width: 1024, height: 1024 } },
    '205': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    '206': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['203', 0], guider: ['202', 0], sampler: ['205', 0], sigmas: ['204', 0], latent_image: ['207', 0] } },
    '207': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '208': { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'detail_enhancer.safetensors', strength_model: 0.8 } },
    '209': { class_type: 'SaveImage', inputs: { images: ['206', 0] }, _meta: { title: 'Save' } }
  })
}
const FLUX_WORKFLOW = JSON.stringify({ nodes: [], links: [], version: 0.4, state: {} })

const A1111_PARAMS = [
  'a beautiful landscape, <lora:add_detail:0.8>',
  `Negative prompt: ${CN_NEGATIVE}`,
  'Steps: 30, Sampler: DPM++ 2M Karras, Schedule type: Karras, CFG scale: 7, Seed: 12345, ' +
    'Size: 1024x768, Model hash: abc123, Model: sd_xl_base_1.0, Denoising strength: 0.6'
].join('\n')

const NOVELAI_COMMENT = JSON.stringify({
  prompt: '1girl, cat ears, masterpiece',
  uc: 'bad anatomy, extra limbs',
  steps: 28, scale: 5, seed: 777, sampler: 'k_euler', width: 832, height: 1216
})

const INVOKE_META = JSON.stringify({
  positive_prompt: 'invoke positive here', negative_prompt: 'invoke negative',
  seed: 11, steps: 25, cfg_scale: 7.5, scheduler: 'karras', width: 512, height: 512,
  model: { model_name: 'invoke-model-v2' }
})

const MJ_DESC = 'a cat sitting on a windowsill, cinematic --ar 16:9 --v 6.1 --seed 42'

/** 国内《AI 生成合成内容标识办法》的隐式标识块（照用户库里的真样抄） */
const AIGC_CHUNK = JSON.stringify({
  Label: '1', ContentProducer: '001191340100MAEB4N8H7600000',
  ProduceID: '0f122a56d8edeecdba309303a2f22436_20260908_ed1218', ReservedCode1: ''
})

/** 一段像 C2PA 清单的字节（含 caBX 块名与 OpenAI 的 softwareAgent） */
const C2PA_PAYLOAD =
  'jumbf c2pa urn:uuid:1a2b3c4d {"description":"AI Generated Image","softwareAgent":"OpenAI OpCo, LLC"}'

// ==================== 主流程 ====================

export async function runSmokeMeta(win: BrowserWindow): Promise<void> {
  const checks: Check[] = []
  const check = (name: string, pass: boolean, detail?: string): void => {
    checks.push({ name, pass, detail })
  }
  const js = async <T>(code: string): Promise<T | null> => {
    try {
      return (await win.webContents.executeJavaScript(code)) as T
    } catch {
      return null
    }
  }
  const waitFor = async (cond: string, timeout = 8000): Promise<boolean> => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      if ((await js<boolean>(`!!(${cond})`)) === true) return true
      await new Promise((r) => setTimeout(r, 120))
    }
    return false
  }
  const jsErrors: string[] = []
  const armErrors = async (): Promise<void> => {
    await js(
      'window.__smErrors = [];' +
        "window.addEventListener('error', (e) => window.__smErrors.push(String(e.message)));" +
        "window.addEventListener('unhandledrejection', (e) => window.__smErrors.push(String(e.reason)));"
    )
  }
  const capture = async (name: string): Promise<void> => {
    await new Promise((r) => setTimeout(r, 350))
    try {
      writeFileSync(join(process.cwd(), name), (await win.webContents.capturePage()).toPNG())
    } catch { /* 截图失败不影响结论 */ }
  }
  const clickEl = async (selector: string): Promise<boolean> =>
    (await js<boolean>(
      `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.click(); return true })()`
    )) === true
  const q = <T>(sql: string): T => requireCurrent().db.prepare(sql).get() as T
  const cfgPath = join(app.getPath('userData'), 'config.json')
  const diskSettings = (): Settings => {
    try {
      const raw = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { settings?: Settings }
      return raw.settings ?? DEFAULT_SETTINGS
    } catch {
      return DEFAULT_SETTINGS
    }
  }

  // ==================== M1 纯解析（不碰磁盘、不碰 DB） ====================
  {
    const r1 = scanBuffers({
      comments: [
        { keyword: 'prompt', text: fluxGraph() },
        { keyword: 'workflow', text: FLUX_WORKFLOW },
        { keyword: 'AIGC', text: AIGC_CHUNK }
      ]
    })
    const m = r1.meta
    check('M1 ComfyUI：正面提示词（中文）完整取出', m?.prompt === CN_PROMPT, JSON.stringify(m?.prompt))
    check('M1 ComfyUI：负面提示词穿过 ConditioningZeroOut 也能归到负面',
      m?.negativePrompt === CN_NEGATIVE, JSON.stringify(m?.negativePrompt))
    check('M1 ComfyUI FLUX：seed 在 RandomNoise 里也取得到（只认 KSampler 会什么都拿不到）',
      m?.seed === '123456789012345', String(m?.seed))
    check('M1 ComfyUI FLUX：steps 在 Flux2Scheduler 里也取得到', m?.steps === 20, String(m?.steps))
    check('M1 ComfyUI FLUX：cfg 在 CFGGuider、sampler 在 KSamplerSelect',
      m?.cfg === 1.5 && m?.sampler === 'euler', `cfg=${m?.cfg} sampler=${m?.sampler}`)
    check('M1 ComfyUI：模型取自 UNETLoader、LoRA 带权重',
      m?.model === 'flux2-dev-fp8.safetensors' && m?.loras[0] === 'detail_enhancer.safetensors (0.8)',
      `${m?.model} / ${JSON.stringify(m?.loras)}`)
    check('M1 ComfyUI：带 workflow 块标记为「可复原工作流」', m?.hasWorkflow === true)
    check('M1 有生成器信息时，来源标识用生成器而不是 AIGC 块',
      r1.ai?.id === 'comfyui', JSON.stringify(r1.ai))

    const r2 = scanBuffers({ comments: [{ keyword: 'parameters', text: A1111_PARAMS }] })
    const a = r2.meta
    check('M1 A1111：正负提示词与参数全部拆对',
      a?.prompt === 'a beautiful landscape, <lora:add_detail:0.8>' && a?.negativePrompt === CN_NEGATIVE &&
        a?.steps === 30 && a?.cfg === 7 && a?.seed === '12345' && a?.width === 1024 && a?.height === 768,
      JSON.stringify(a))
    check('M1 A1111：采样器含空格与加号、Schedule type 归到 scheduler、LoRA 从提示词里抽出来',
      a?.sampler === 'DPM++ 2M Karras' && a?.scheduler === 'Karras' && a?.loras[0] === 'add_detail (0.8)',
      `${a?.sampler} / ${a?.scheduler} / ${JSON.stringify(a?.loras)}`)

    // A1111 存 JPEG：参数在 EXIF UserComment（UTF-16BE，无 BOM）
    const r3 = scanBuffers({ exif: exifWithUserComment(A1111_PARAMS) })
    check('M1 A1111·JPEG：EXIF UserComment（UTF-16 大端、无 BOM）也能解出提示词',
      r3.meta?.prompt === 'a beautiful landscape, <lora:add_detail:0.8>' && r3.meta?.generator === 'a1111',
      JSON.stringify(r3.meta?.prompt))

    const r4 = scanBuffers({ comments: [{ keyword: 'Comment', text: NOVELAI_COMMENT }] })
    check('M1 NovelAI：Comment JSON 解出提示词与参数',
      r4.meta?.generator === 'novelai' && r4.meta?.prompt === '1girl, cat ears, masterpiece' &&
        r4.meta?.negativePrompt === 'bad anatomy, extra limbs' && r4.meta?.cfg === 5,
      JSON.stringify(r4.meta))

    const r5 = scanBuffers({ comments: [{ keyword: 'invokeai_metadata', text: INVOKE_META }] })
    check('M1 InvokeAI：positive/negative 与模型名都取到',
      r5.meta?.generator === 'invokeai' && r5.meta?.prompt === 'invoke positive here' &&
        r5.meta?.model === 'invoke-model-v2',
      JSON.stringify(r5.meta))

    const r6 = scanBuffers({ comments: [{ keyword: 'Description', text: MJ_DESC }] })
    check('M1 Midjourney：从 Description 里剥掉 --参数 得到纯提示词、版本进模型名',
      r6.meta?.generator === 'midjourney' && r6.meta?.prompt === 'a cat sitting on a windowsill, cinematic' &&
        r6.meta?.model === 'Midjourney v6.1' && r6.meta?.seed === '42',
      JSON.stringify(r6.meta))
    check('M1 Midjourney：普通 Description（不像提示词）不该被误判',
      scanBuffers({ comments: [{ keyword: 'Description', text: '会议纪要附件截图' }] }).meta === null)

    // 只有 AIGC 标识、没有生成参数 → 来源标 aigc-cn
    const r7 = scanBuffers({ comments: [{ keyword: 'AIGC', text: AIGC_CHUNK }] })
    check('M1 只有 AIGC 隐式标识块时，来源识别为国内 AIGC 标识',
      r7.meta === null && r7.ai?.id === 'aigc-cn', JSON.stringify(r7.ai))

    // C2PA / OpenAI：只有来源、没有提示词
    const r8 = scanBuffers({ head: binChunk('caBX', C2PA_PAYLOAD) })
    check('M1 C2PA + OpenAI：来源识别为 OpenAI 内容凭据，且**不编造**提示词',
      r8.ai?.id === 'c2pa:openai' && r8.meta === null, `${JSON.stringify(r8.ai)} meta=${JSON.stringify(r8.meta)}`)

    // 反例：prompt 块存在但不是 JSON → 不能当 ComfyUI
    check('M1 反例：`prompt` 块不是 JSON 时不该被误判成 ComfyUI',
      scanBuffers({ comments: [{ keyword: 'prompt', text: 'just a caption' }] }).meta === null)

    // 反例：EXIF 里只有相机信息
    const camExif = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#333' } })
      .jpeg().withMetadata({ exif: { IFD0: { Make: 'Canon', Model: 'EOS R5', Software: 'Firmware 1.0' } } }).toBuffer()
    const camMeta = await sharp(camExif).metadata()
    const r9 = scanBuffers({ exif: camMeta.exif })
    check('M1 反例：普通相机 EXIF（Canon / EOS R5）不该被当成 AI 生成',
      r9.meta === null && r9.ai === null, JSON.stringify(r9))

    // ComfyUI 动画 WebP：prompt / workflow 在 EXIF 的 Make / Model。
    // ⚠️ 这里刻意用 **ASCII** 提示词：Make / Model 是 ASCII 型标签，非 ASCII 会被写成 '?'，
    // 拿中文去测就变成「测 sharp 的写入限制」而不是「测我们的读取逻辑」。
    const asciiGraph = fluxGraph().replace(CN_PROMPT, 'remove the watermark in the corner')
    const webp = await sharp({ create: { width: 48, height: 48, channels: 3, background: '#246' } })
      .webp()
      .withMetadata({ exif: { IFD0: { Make: `prompt:${asciiGraph}`, Model: `workflow:${FLUX_WORKFLOW}` } } })
      .toBuffer()
    const webpMeta = await sharp(webp).metadata()
    const r10 = scanBuffers({ exif: webpMeta.exif, format: 'webp' })
    check('M1 ComfyUI 动画 WebP：参数藏在 EXIF 的 Make / Model 里（WebP 没有文本块，只能走这条路）',
      r10.meta?.generator === 'comfyui' && r10.meta?.prompt === 'remove the watermark in the corner' &&
        r10.meta?.hasWorkflow === true,
      JSON.stringify(r10.meta?.prompt))
    void camExif
  }

  // ==================== 准备测试库 ====================
  const backup = JSON.parse(JSON.stringify(getSettings())) as Settings

  let dir: string | null = null
  try {
    void 0
    dir = mkdtempSync(join(tmpdir(), 'stash-smoke-meta-'))
    const lib = createLibrary({ name: 'meta-lib', parentDir: dir })
    const folder = mkdirRel('素材')
    const src = join(dir, 'src')
    mkdirSync(src)

    const base = await sharp({ create: { width: 96, height: 96, channels: 3, background: '#2b3a4a' } }).png().toBuffer()
    const baseJpg = await sharp({ create: { width: 96, height: 96, channels: 3, background: '#4a3a2b' } }).jpeg().toBuffer()

    // ① ComfyUI（含国内 AIGC 隐式标识）—— 用户库里真实的那一类
    writeFileSync(join(src, 'comfy.png'), splicePng(base, [
      zTXt('prompt', fluxGraph()),
      zTXt('workflow', FLUX_WORKFLOW),
      tEXt('AIGC', AIGC_CHUNK)
    ]))
    // ② A1111（PNG 的 parameters 块）
    writeFileSync(join(src, 'a1111.png'), splicePng(base, [tEXt('parameters', A1111_PARAMS)]))
    // ③ A1111 存 JPEG（EXIF UserComment）
    writeFileSync(join(src, 'a1111.jpg'), jpegWithExif(baseJpg, exifWithUserComment(A1111_PARAMS)))
    // ④ NovelAI
    writeFileSync(join(src, 'novelai.png'), splicePng(base, [iTXt('Comment', NOVELAI_COMMENT)]))
    // ⑤ Midjourney
    writeFileSync(join(src, 'mj.png'), splicePng(base, [tEXt('Description', MJ_DESC)]))
    // ⑥ 只有 C2PA 来源、没有提示词（模拟 GPT-image 那类）
    writeFileSync(join(src, 'c2pa.png'), splicePng(base, [binChunk('caBX', C2PA_PAYLOAD)]))
    // ⑦ 普通照片：什么 AI 信息都没有（对照组）
    writeFileSync(join(src, 'plain.png'), base)

    const paths = ['comfy.png', 'a1111.png', 'a1111.jpg', 'novelai.png', 'mj.png', 'c2pa.png', 'plain.png']
      .map((f) => join(src, f))
    patchSettings({ importing: { extractMeta: true, detectAi: true } })
    await new Promise<void>((resolve) => {
      importFiles({ paths, folderId: folder.id, mode: 'copy', onDone: () => resolve() })
    })

    // 开库 → 走正常引导（缩略图 backfill 会顺带补扫生成参数）
    await js(`window.stash.library.open(${JSON.stringify(lib.path)}).then(() => location.reload())`)
    await waitFor("document.querySelector('.masonry-card')", 15000)
    await armErrors()
    await new Promise((r) => setTimeout(r, 400))

    const rowOf = (name: string): { id: number; gen_meta: string | null; gen_state: number | null; ai_source: string | null; note: string | null } =>
      q(`SELECT id, gen_meta, gen_state, ai_source, note FROM assets WHERE name='${name}'`)

    /** 等某张图扫完（gen_state 被置位） */
    const waitScanned = async (name: string, timeout = 25000): Promise<boolean> => {
      const t0 = Date.now()
      while (Date.now() - t0 < timeout) {
        const r = rowOf(name)
        if (r && (r.gen_state ?? 0) !== 0) return true
        await new Promise((r2) => setTimeout(r2, 250))
      }
      return false
    }

    // ==================== M2 端到端 ====================
    const scanned = await waitScanned('comfy.png')
    check('M2 导入后后台会自动扫生成参数（gen_state 被置位）', scanned, String(rowOf('comfy.png').gen_state))

    const comfy = rowOf('comfy.png')
    const comfyMeta = comfy.gen_meta ? (JSON.parse(comfy.gen_meta) as GenMeta) : null
    check('M2 落库的生成参数与解析结果一致（中文提示词）',
      comfyMeta?.prompt === CN_PROMPT && comfyMeta?.steps === 20, JSON.stringify(comfyMeta?.prompt))
    check('M2 落库的 AI 来源是生成器（而不是退化成 AIGC 标识）',
      comfy.ai_source === 'comfyui', String(comfy.ai_source))

    await waitScanned('a1111.jpg')
    check('M2 A1111 的 JPEG 也扫到了（EXIF 那条路真的通）',
      rowOf('a1111.jpg').gen_meta?.includes('DPM++ 2M Karras') === true, String(rowOf('a1111.jpg').gen_meta).slice(0, 80))

    await waitScanned('c2pa.png')
    check('M2 只有 C2PA 的图：来源标出来但 v**没有**提示词（不编造）',
      rowOf('c2pa.png').ai_source === 'c2pa:openai' && rowOf('c2pa.png').gen_meta === null,
      `ai=${rowOf('c2pa.png').ai_source} meta=${rowOf('c2pa.png').gen_meta}`)

    await waitScanned('plain.png')
    const plain = rowOf('plain.png')
    check('M2 普通图片：扫过了（gen_state 置位，不会反复重扫）但没有任何 AI 信息',
      (plain.gen_state ?? 0) !== 0 && plain.gen_meta === null && plain.ai_source === null,
      `state=${plain.gen_state} meta=${plain.gen_meta} ai=${plain.ai_source}`)

    // —— DOM：卡片角标 ——
    const afterRefresh = await waitFor(
      `document.querySelector('.masonry-card[data-id="${comfy.id}"] [data-thumb-ai]')`,
      8000
    )
    const badge = await js<{ v: string; pos: string; pe: string }>(
      `(() => { const e = document.querySelector('.masonry-card[data-id="${comfy.id}"] [data-thumb-ai]');
         if (!e) return null; const s = getComputedStyle(e);
         return { v: e.dataset.thumbAi, pos: s.position, pe: s.pointerEvents } })()`
    )
    check('M2 卡片出现 AI 角标，且标的是来源 id', afterRefresh && badge?.v === 'comfyui', JSON.stringify(badge))
    check('M2 AI 角标是 absolute + pointer-events:none（不撑高卡片、不拦点击）',
      badge?.pos === 'absolute' && badge?.pe === 'none', JSON.stringify(badge))
    check('M2 普通图片没有 AI 角标',
      (await js<boolean>(`!!document.querySelector('.masonry-card[data-id="${plain.id}"] [data-thumb-ai]')`)) === false)

    // —— 自动填入「提示词」字段（本功能唯一的对外表现）——
    // 期望：正面提示词 + 空行 + `Negative prompt: 负向`（A1111 的惯例，可原样复制回生成器）
    const expectNote = `${CN_PROMPT}\n\nNegative prompt: ${CN_NEGATIVE}`
    // 先选中那张卡片，把详情栏拉起来（提示词字段在详情栏里）
    await js(
      `(() => { const c = document.querySelector('.masonry-card[data-id="${comfy.id}"]'); if (c) c.click(); return true })()`
    )
    const autoFilled = await waitFor(
      `(() => { const el = document.querySelector('[data-note-view]'); return !!el && el.textContent.includes('移除左上角') })()`,
      8000
    )
    check('M2 提取到的提示词落库进了「提示词」字段（正面 + Negative prompt 段）',
      comfy.note === expectNote, JSON.stringify(comfy.note))
    check('M2 详情栏里能看到自动填入的提示词',
      autoFilled &&
        (await js<string>("document.querySelector('[data-note-view]')?.textContent.trim() ?? ''"))?.startsWith(CN_PROMPT) === true,
      (await js<string>("document.querySelector('[data-note-view]')?.textContent.trim() ?? ''"))?.slice(0, 40) ?? '')
    await capture('shot-meta-detail.png')

    // 没有提示词的图不该被填任何东西进去
    check('M2 只有 C2PA 来源、没有提示词的图：提示词字段保持为空',
      rowOf('c2pa.png').note === null, String(rowOf('c2pa.png').note))
    check('M2 普通图片的提示词字段也保持为空', plain.note === null, String(plain.note))

    // 详情栏**不再渲染**「AI 生成信息」区块（用户要求只保留自动填入这一个能力）
    check('M2 详情栏不再有「AI 生成信息」区块',
      (await js<boolean>("!!document.querySelector('[data-meta-section]')")) === false)
    check('M2 也不再有「填入提示词 / 重新识别」这类按钮',
      (await js<number>(
        "document.querySelectorAll('[data-meta-fill], [data-meta-rescan], [data-meta-prompt]').length"
      )) === 0)

    // 列表视图没有缩略图，角标无处可放 —— 退化成一行「AI」小字，同样要能看到
    await clickEl('[title="列表视图"]')
    const listMarked = await waitFor(`document.querySelector('.list-row[data-id="${comfy.id}"] .list-ai')`)
    const listAi = await js<string>(
      `document.querySelector('.list-row[data-id="${comfy.id}"] .list-ai')?.dataset.listAi ?? ''`
    )
    check('M2 列表视图里也有 AI 标记', listMarked && listAi === 'comfyui', String(listAi))
    await clickEl('[title="瀑布视图"]')
    await waitFor("document.querySelector('.masonry-card')")

    // ==================== M3 设置开关 ====================
    const openPanel = async (): Promise<boolean> => {
      await clickEl('[data-open-settings]')
      return await waitFor("document.querySelector('[data-settings-panel]')")
    }
    await openPanel()
    await clickEl('[data-sp-group="importing"]')
    await waitFor("!!document.querySelector('[data-sp-extract-meta]')")

    // —— 关掉「提取生成参数」，只留「识别 AI 来源」——
    await clickEl('[data-sp-extract-meta]')
    await new Promise((r) => setTimeout(r, 350))
    check('M3 关掉「提取生成参数」会落盘', diskSettings().importing.extractMeta === false)

    const onlyAi = join(src, 'only-ai.png')
    writeFileSync(onlyAi, splicePng(base, [zTXt('prompt', fluxGraph()), tEXt('AIGC', AIGC_CHUNK)]))
    await js(`window.stash.import.files({ paths: [${JSON.stringify(onlyAi)}], folderId: ${folder.id} })`)
    await waitScanned('only-ai.png')
    const oa = rowOf('only-ai.png')
    // 关掉的是「提取生成参数」（提示词是否落库），不是「来源识别」——
    // 能从图片里看出这是 ComfyUI 出的图，就该照实标 ComfyUI，而不是退化成笼统的 AIGC 标识
    check('M3 只开「识别 AI 来源」时：不写提示词，但仍然标出是 ComfyUI 出的图',
      oa.gen_meta === null && oa.ai_source === 'comfyui', `meta=${oa.gen_meta} ai=${oa.ai_source}`)

    // —— 两个都关：状态位一个都不置，留给以后补扫 ——
    await clickEl('[data-sp-detect-ai]')
    await new Promise((r) => setTimeout(r, 350))
    check('M3 关掉「识别 AI 来源」会落盘', diskSettings().importing.detectAi === false)

    const nonePng = join(src, 'none.png')
    writeFileSync(nonePng, splicePng(base, [zTXt('prompt', fluxGraph())]))
    await js(`window.stash.import.files({ paths: [${JSON.stringify(nonePng)}], folderId: ${folder.id} })`)
    await new Promise((r) => setTimeout(r, 1500))
    const nn = rowOf('none.png')
    check('M3 两类都关时：状态位保持 0（不写「已扫过」），以后打开开关还能补扫',
      (nn.gen_state ?? 0) === 0 && nn.gen_meta === null && nn.ai_source === null,
      `state=${nn.gen_state} meta=${nn.gen_meta} ai=${nn.ai_source}`)

    // —— 重新打开开关后，开库时的自动补扫应该把之前跳过的图补上（没有手动按钮了）——
    await clickEl('[data-sp-extract-meta]')
    await clickEl('[data-sp-detect-ai]')
    await new Promise((r) => setTimeout(r, 350))
    check('M3 「立即补扫」按钮已移除（不再有手动入口）',
      (await js<boolean>("!!document.querySelector('[data-sp-meta-backfill]')")) === false)
    // 补扫入口挂在 backfill 上，而 backfill 就是**回缩略图**——
    // 这里直接走 IPC 等价于「重开一次库」，触发的是同一条路径。
    await js('window.stash.thumb.backfill("grid")')
    const backfilled = await waitScanned('none.png')
    const bf = rowOf('none.png')
    check('M3 重新打开开关后会补扫，并把提示词一并填进「提示词」字段',
      backfilled && bf.gen_meta?.includes(CN_PROMPT) === true && bf.ai_source === 'comfyui' &&
        bf.note?.includes('移除左上角') === true,
      `state=${bf.gen_state} ai=${bf.ai_source} note=${bf.note}`)

    // —— 关掉 AI 角标：卡片标记消失（区块不受影响）——
    await clickEl('[data-sp-group="appearance"]')
    await waitFor("!!document.querySelector('[data-sp-ai-badge]')")
    await clickEl('[data-sp-ai-badge]')
    await new Promise((r) => setTimeout(r, 400))
    check('M3 关掉「AI 来源角标」会落盘', diskSettings().cardFields.aiBadge === false)
    await clickEl('[data-sp-close]')
    await new Promise((r) => setTimeout(r, 300))
    check('M3 关掉角标后卡片上的 AI 标记消失',
      (await js<boolean>(`!!document.querySelector('.masonry-card[data-id="${comfy.id}"] [data-thumb-ai]')`)) === false)
    await clickEl('[data-open-settings]')
    await waitFor("document.querySelector('[data-settings-panel]')")
    await clickEl('[data-sp-group="appearance"]')
    await waitFor("!!document.querySelector('[data-sp-ai-badge]')")
    await clickEl('[data-sp-ai-badge]')
    await new Promise((r) => setTimeout(r, 350))
    await clickEl('[data-sp-group="importing"]')
    await waitFor("!!document.querySelector('[data-sp-extract-meta]')")
    await capture('shot-meta-settings.png')
    await clickEl('[data-sp-close]')
    await new Promise((r) => setTimeout(r, 250))

    // 运行期错误
    const errs = (await js<string[]>('window.__smErrors || []')) ?? []
    jsErrors.push(...errs)
    check('M1~M3 全流程渲染层无运行期错误', jsErrors.length === 0, JSON.stringify(jsErrors.slice(0, 3)))
  } catch (e) {
    check('套件执行未抛异常', false, String((e as Error).message ?? e))
  } finally {
    // 把用户的真实偏好写回去（本套件直接动了 userData/config.json）
    try {
      patchSettings(backup)
    } catch { /* 还原失败不挡住退出 */ }
    try {
      closeCurrent()
    } catch { /* 库已经关了 */ }
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch { /* Windows 句柄未释放，忽略 */ }
    }
    const failed = checks.filter((c) => !c.pass)
    console.log('[SMOKE-META] ' + JSON.stringify({ checks, failed, ok: failed.length === 0 }, null, 2))
    app.exit(0)
  }
}
