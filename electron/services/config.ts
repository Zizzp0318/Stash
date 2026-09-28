import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'

/**
 * 全局偏好（与库无关、跨库共用一份）。
 *
 * 为什么放主进程的 config.json 而不是渲染层的 localStorage：
 * ① 设置面板要能统一读写，而 localStorage 只有渲染层看得见；
 * ② 清缓存 / 换 origin（dev 的 http:// 与打包后的 file:// 是**两个 origin**）都会丢，
 *    表现为「设置莫名其妙被重置」（历史遗留的三个键就踩过这个）。
 * 老的 localStorage 值由渲染层在启动时**一次性迁移**过来（见 stores/settings.ts）。
 */
export interface Settings {
  /** 打开素材库时的默认视图 */
  defaultView: 'masonry' | 'list'
  /** 瀑布卡片的目标列宽（px）。范围校验在渲染层（滑块与它同一处定义） */
  viewZoom: number
  /** 卡片下方显示哪些字段；typeBadge 是缩略图右上角的类型角标 */
  cardFields: { name: boolean; dims: boolean; size: boolean; time: boolean; typeBadge: boolean }
  /** 右侧信息栏默认收起 */
  detailCollapsed: boolean
  /** 缩略图管线 */
  thumbs: {
    /** 并发生成数（队列同时跑几个 job）。机器弱就调小，SSD 快可以调大 */
    concurrency: number
    /** webp 质量。⚠️ 只影响**之后新生成**的缩略图，已缓存的不会重算（要生效得先清缓存） */
    quality: number
  }
  /** 预览与播放 */
  preview: {
    /** 播放条 / 图片提示的自动隐藏延迟（ms）。0 = 不自动隐藏 */
    idleHideMs: number
    /** 图片派生（HEIC/TIFF/超大图）的长边上限 */
    maxImagePx: number
    /** 文本预览与保存的字节上限 */
    textMaxBytes: number
    /** 播放器初始音量 0~1（用户当场拖的音量不落盘） */
    volume: number
    /** 中栏浮层打开时是否自动播放（右侧信息栏不自动播 —— 那会一路点一路响） */
    autoPlay: boolean
  }
}

export const DEFAULT_SETTINGS: Settings = {
  defaultView: 'masonry',
  viewZoom: 170,
  cardFields: { name: true, dims: true, size: true, time: true, typeBadge: true },
  detailCollapsed: false,
  thumbs: { concurrency: 4, quality: 82 },
  preview: { idleHideMs: 2600, maxImagePx: 2560, textMaxBytes: 2 * 1024 * 1024, volume: 1, autoPlay: false }
}

/** 可选的 webp 质量档位（面板上给三档，别让用户随便填个 1） */
export const THUMB_QUALITY_CHOICES = [70, 82, 92] as const
export const THUMB_CONCURRENCY_MIN = 1
export const THUMB_CONCURRENCY_MAX = 8

/** 预览各项的可选档位（面板直接用这套，别再各写一份） */
export const IDLE_HIDE_CHOICES = [0, 1500, 2600, 4000] as const
export const MAX_IMAGE_PX_CHOICES = [1920, 2560, 4096] as const
export const TEXT_MAX_MB_CHOICES = [1, 2, 8] as const

export interface Config {
  recentLibraries: string[]
  settings: Settings
}

/**
 * 形状校验：配置文件是用户能直接手改的，坏值一律回落默认。
 * 只做类型/枚举白名单，**不做范围钳制** —— 范围的唯一定义在渲染层
 * （`VIEW_ZOOM_MIN/MAX`，滑块与它同源），两处各钳一次迟早会不一致。
 */
export function sanitizeSettings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS
  if (!raw || typeof raw !== 'object') {
    return { ...d, cardFields: { ...d.cardFields } }
  }
  const r = raw as Partial<Settings>
  const cf = { ...d.cardFields }
  if (r.cardFields && typeof r.cardFields === 'object') {
    for (const k of Object.keys(cf) as Array<keyof Settings['cardFields']>) {
      if (typeof r.cardFields[k] === 'boolean') cf[k] = r.cardFields[k] as boolean
    }
  }
  const th = (r.thumbs && typeof r.thumbs === 'object' ? r.thumbs : {}) as Partial<Settings['thumbs']>
  const pv = (r.preview && typeof r.preview === 'object' ? r.preview : {}) as Partial<Settings['preview']>
  const pickOf = (list: readonly number[], v: unknown, def: number): number => {
    const n = Number(v)
    return list.includes(n) ? n : def
  }
  const volRaw = Number(pv.volume)
  const vol = Number.isFinite(volRaw) ? Math.min(1, Math.max(0, volRaw)) : d.preview.volume
  const conc = Number(th.concurrency)
  const qual = Number(th.quality)
  return {
    defaultView: r.defaultView === 'list' ? 'list' : 'masonry',
    viewZoom: typeof r.viewZoom === 'number' && Number.isFinite(r.viewZoom) ? Math.round(r.viewZoom) : d.viewZoom,
    cardFields: cf,
    detailCollapsed: r.detailCollapsed === true,
    thumbs: {
      concurrency: Number.isFinite(conc)
        ? Math.min(THUMB_CONCURRENCY_MAX, Math.max(THUMB_CONCURRENCY_MIN, Math.round(conc)))
        : d.thumbs.concurrency,
      // 质量走白名单：填 1 或 100 都会把缩略图搞成灾难
      quality: (THUMB_QUALITY_CHOICES as readonly number[]).includes(qual) ? qual : d.thumbs.quality
    },
    preview: {
      idleHideMs: pickOf(IDLE_HIDE_CHOICES, pv.idleHideMs, d.preview.idleHideMs),
      maxImagePx: pickOf(MAX_IMAGE_PX_CHOICES, pv.maxImagePx, d.preview.maxImagePx),
      // 档位对外是 MB，存的是字节
      textMaxBytes: pickOf(TEXT_MAX_MB_CHOICES, Math.round(Number(pv.textMaxBytes) / 1024 / 1024), 2) * 1024 * 1024,
      volume: vol,
      autoPlay: pv.autoPlay === true
    }
  }
}

let cache: Config | null = null

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

/**
 * 路径规范化：resolve 统一斜杠风格与相对段。
 * Windows 下同一个库可能以 "E:\a" / "E:/a" / "e:\A" 等多种写法出现，
 * 不规范化会导致最近列表出现重复项。
 */
function norm(p: string): string {
  try {
    return resolve(p)
  } catch {
    return p
  }
}

function normKey(p: string): string {
  return norm(p).toLowerCase()
}

/** 清洗 + 去重（保留顺序，先出现的在前） */
function dedupe(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    const k = normKey(p)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(norm(p))
  }
  return out
}

function load(): Config {
  if (cache) return cache
  let raw: unknown = null
  try {
    raw = JSON.parse(readFileSync(configPath(), 'utf-8'))
  } catch {
    raw = null // 首次运行 / 文件损坏：整体回落默认，不让一条脏数据把配置卡死
  }
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Config>
  // 先落到局部常量再赋给 cache：闭包（下面的 .some）里用模块级可空变量会丢掉类型收窄
  const cfg: Config = {
    recentLibraries: Array.isArray(r.recentLibraries)
      ? r.recentLibraries.filter((p): p is string => typeof p === 'string')
      : [],
    settings: sanitizeSettings(r.settings)
  }
  cache = cfg
  // 读取时顺带清洗历史脏数据（多写法重复项）
  const cleaned = dedupe(cfg.recentLibraries)
  if (cleaned.length !== cfg.recentLibraries.length || cleaned.some((p, i) => p !== cfg.recentLibraries[i])) {
    cfg.recentLibraries = cleaned
    save()
  }
  return cfg
}

function save(): void {
  writeFileSync(configPath(), JSON.stringify(load(), null, 2), 'utf-8')
}

/**
 * 面板要用的「可选值」也由主进程给：质量档位/并发范围在这里定义一次，
 * 校验和 UI 同源 —— 渲染层再抄一份迟早会分叉。
 */
export function settingsChoices(): {
  quality: number[]
  concurrency: { min: number; max: number }
  idleHideMs: number[]
  maxImagePx: number[]
  textMaxMb: number[]
} {
  return {
    quality: [...THUMB_QUALITY_CHOICES],
    concurrency: { min: THUMB_CONCURRENCY_MIN, max: THUMB_CONCURRENCY_MAX },
    idleHideMs: [...IDLE_HIDE_CHOICES],
    maxImagePx: [...MAX_IMAGE_PX_CHOICES],
    textMaxMb: [...TEXT_MAX_MB_CHOICES]
  }
}

/** 当前全局偏好（已补默认值 + 形状校验） */
export function getSettings(): Settings {
  return load().settings
}

/** 只覆盖传进来的字段（浅合并；cardFields 单独深合并一层，否则会把没传的开关抹成 undefined） */
export function patchSettings(patch: Partial<Settings>): Settings {
  const c = load()
  c.settings = sanitizeSettings({
    ...c.settings,
    ...patch,
    // ⚠️ 每个嵌套对象都要**逐个深合并**：`...patch` 只是浅合并，
    // 传 `{thumbs:{quality:92}}` 会把整个 thumbs 替换掉 → concurrency 变 undefined →
    // sanitize 回落默认值 → 用户「只改了质量」却把并发数悄悄重置了（冒烟当场抓到过）。
    cardFields: { ...c.settings.cardFields, ...(patch.cardFields ?? {}) },
    thumbs: { ...c.settings.thumbs, ...(patch.thumbs ?? {}) },
    preview: { ...c.settings.preview, ...(patch.preview ?? {}) }
  })
  save()
  return c.settings
}

export function addRecentLibrary(p: string): void {
  const c = load()
  const np = norm(p)
  c.recentLibraries = [np, ...c.recentLibraries.map(norm).filter((x) => normKey(x) !== normKey(np))].slice(0, 10)
  save()
}

export function removeRecentLibrary(p: string): void {
  const c = load()
  const k = normKey(p)
  c.recentLibraries = c.recentLibraries.filter((x) => normKey(x) !== k)
  save()
}

export function listRecentLibraries(): string[] {
  const all = dedupe(load().recentLibraries)
  const alive = all.filter((p) => existsSync(join(p, '.stash')))
  // 目录已不存在的库（被外部删除/移动）自动从记录中剔除，保持配置自清理
  if (alive.length !== all.length) {
    const c = load()
    c.recentLibraries = alive
    save()
  }
  return alive
}
