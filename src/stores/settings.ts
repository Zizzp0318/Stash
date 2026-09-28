// 全局偏好（跨库一份）。
//
// 唯一真相在主进程的 `userData/config.json`，这里只是它的**响应式镜像**。
// 为什么不继续用 localStorage：① 设置面板要统一读写，而 localStorage 只有渲染层看得见；
// ② dev（http://localhost）与打包（file://）是**两个 origin**，localStorage 不共享 ——
//    表现为「设置莫名其妙被重置」。老的三个键由 init() 一次性迁进 config 再删掉
//    （键没了，迁移自然只跑一次，不需要额外记标记）。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  StashCardFields,
  StashImportSettings,
  StashPreviewSettings,
  StashSettings,
  StashSettingsPatch,
  StashThumbSettings
} from '../env'

/**
 * 瀑布视图缩放：滑块值 = 目标列宽（px），上下限刻意压低，避免放大到只剩一两列。
 * **范围的唯一定义在这里**（滑块、设置面板、钳制都用它），主进程只做类型校验不重复钳。
 */
export const VIEW_ZOOM_MIN = 140
export const VIEW_ZOOM_MAX = 280
export const VIEW_ZOOM_DEFAULT = 170

/**
 * 补丁类型：`Partial<StashSettings>` 只会把**顶层**变可选，嵌套对象仍是必填 ——
 * 而我们要的是「只改其中一两个开关」。直接复用 `env.d.ts` 里那份深可选定义，
 * 别再抄一遍（抄漏一层就是「改 A 把 B 弄没了」）。
 */
export type SettingsPatch = StashSettingsPatch

const FALLBACK: StashSettings = {
  defaultView: 'masonry',
  viewZoom: VIEW_ZOOM_DEFAULT,
  cardFields: { name: true, dims: true, size: true, time: true, typeBadge: true },
  detailCollapsed: false,
  thumbs: { concurrency: 4, quality: 82 },
  preview: { idleHideMs: 2600, maxImagePx: 2560, textMaxBytes: 2 * 1024 * 1024, volume: 1, autoPlay: false },
  importing: { mode: 'copy', dedupe: true, palette: true }
}

/** 老键（搬家前的位置） */
const LEGACY = {
  zoom: 'stash.viewZoom',
  fields: 'stash.cardFields',
  detail: 'stash.detailCollapsed'
} as const

function clone(s: StashSettings): StashSettings {
  return {
    ...s,
    cardFields: { ...s.cardFields },
    thumbs: { ...s.thumbs },
    preview: { ...s.preview },
    importing: { ...s.importing }
  }
}

/** 把后端/旧数据来的值补齐并钳到合法范围（配置文件是能手改的，不能信） */
function normalize(raw: SettingsPatch | null | undefined): StashSettings {
  const src = raw ?? {}
  const cf: StashCardFields = { ...FALLBACK.cardFields }
  if (src.cardFields && typeof src.cardFields === 'object') {
    for (const k of Object.keys(cf) as Array<keyof StashCardFields>) {
      if (typeof src.cardFields[k] === 'boolean') cf[k] = src.cardFields[k] as boolean
    }
  }
  // ⚠️ 新增一个设置分组时，**这里必须同步** —— 忘了补默认值的话
  // `settings.value.thumbs` 就是 undefined，模板一读 `s.thumbs.concurrency` 当场抛错、
  // 后面的控件整段渲染不出来（本轮就这么翻过一次车）。
  // 范围与白名单的校验在主进程（config.ts 的 sanitizeSettings），这里只补默认值，别两处各判一次。
  const th = (src.thumbs ?? {}) as Partial<StashThumbSettings>
  const pv = (src.preview ?? {}) as Partial<StashPreviewSettings>
  const im = (src.importing ?? {}) as Partial<StashImportSettings>
  const conc = Number(th.concurrency)
  const qual = Number(th.quality)
  const z = Number(src.viewZoom)
  const zoom = Number.isFinite(z) ? Math.min(VIEW_ZOOM_MAX, Math.max(VIEW_ZOOM_MIN, Math.round(z))) : VIEW_ZOOM_DEFAULT
  return {
    defaultView: src.defaultView === 'list' ? 'list' : 'masonry',
    viewZoom: zoom,
    cardFields: cf,
    detailCollapsed: src.detailCollapsed === true,
    thumbs: {
      concurrency: Number.isFinite(conc) ? Math.round(conc) : FALLBACK.thumbs.concurrency,
      quality: Number.isFinite(qual) ? Math.round(qual) : FALLBACK.thumbs.quality
    },
    preview: {
      idleHideMs: Number.isFinite(Number(pv.idleHideMs)) ? Math.round(Number(pv.idleHideMs)) : FALLBACK.preview.idleHideMs,
      maxImagePx: Number.isFinite(Number(pv.maxImagePx)) ? Math.round(Number(pv.maxImagePx)) : FALLBACK.preview.maxImagePx,
      textMaxBytes: Number.isFinite(Number(pv.textMaxBytes))
        ? Math.round(Number(pv.textMaxBytes))
        : FALLBACK.preview.textMaxBytes,
      volume: Number.isFinite(Number(pv.volume))
        ? Math.min(1, Math.max(0, Number(pv.volume)))
        : FALLBACK.preview.volume,
      autoPlay: pv.autoPlay === true
    },
    importing: {
      mode: im.mode === 'move' ? 'move' : 'copy',
      // 判据写成 `!== false`：这两项默认都是「开」，只有明确 false 才关，
      // 否则老配置里缺键会被判成关 → 升级后行为悄悄变了
      dedupe: im.dedupe !== false,
      palette: im.palette !== false
    }
  }
}

/** 读旧的 localStorage 偏好；三个键都不在就返回 null（= 没什么可搬的） */
function readLegacy(): SettingsPatch | null {
  try {
    const zoomRaw = localStorage.getItem(LEGACY.zoom)
    const fieldsRaw = localStorage.getItem(LEGACY.fields)
    const detailRaw = localStorage.getItem(LEGACY.detail)
    if (zoomRaw == null && fieldsRaw == null && detailRaw == null) return null
    const out: SettingsPatch = {}
    const z = Number(zoomRaw)
    if (zoomRaw != null && Number.isFinite(z)) out.viewZoom = z
    if (fieldsRaw != null) {
      const saved = JSON.parse(fieldsRaw) as Partial<StashCardFields>
      const cf = { ...FALLBACK.cardFields }
      for (const k of Object.keys(cf) as Array<keyof StashCardFields>) {
        if (typeof saved[k] === 'boolean') cf[k] = saved[k] as boolean
      }
      out.cardFields = cf
    }
    if (detailRaw != null) out.detailCollapsed = detailRaw === '1'
    return out
  } catch {
    return null
  }
}

function clearLegacy(): void {
  try {
    localStorage.removeItem(LEGACY.zoom)
    localStorage.removeItem(LEGACY.fields)
    localStorage.removeItem(LEGACY.detail)
  } catch {
    /* 清不掉也不影响：值已经进 config 了 */
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<StashSettings>(normalize(FALLBACK))
  /** 已经从主进程读到过一次（在此之前用的是 FALLBACK，别拿它当用户设置看） */
  const loaded = ref(false)
  /** 设置面板是否打开（全局单例状态，SideBar 开、App 渲染） */
  const panelOpen = ref(false)
  /** 最近一次落盘失败的原因（面板上提示用） */
  const lastError = ref<string | null>(null)

  function apply(next: SettingsPatch): void {
    settings.value = normalize({
      ...settings.value,
      ...next,
      // 嵌套对象要各自深合并：浅合并会把没传的那层整个替换掉
      cardFields: { ...settings.value.cardFields, ...(next.cardFields ?? {}) },
      thumbs: { ...settings.value.thumbs, ...(next.thumbs ?? {}) },
      preview: { ...settings.value.preview, ...(next.preview ?? {}) },
      importing: { ...settings.value.importing, ...(next.importing ?? {}) }
    })
  }

  async function init(): Promise<void> {
    const r = await window.stash.settings.get()
    if (r.ok && r.data) apply(r.data)

    const legacy = readLegacy()
    if (legacy) {
      await patch(legacy)
      clearLegacy()
    }
    loaded.value = true
    // 别的窗口改了偏好，这边要跟着变（偏好是全局状态，不能各看各的）。
    // 但本地正在改的时候先别套用：广播里那份可能比本地还旧。
    window.stash.settings.onChanged((next) => {
      if (inFlight === 0) apply(next)
    })
  }

  /**
   * 本地改动的序号。只有**最新**的那一次才允许拿服务端快照回填 ——
   * 两次改动挨得近时（A 的回包还没到、B 又点了），A 的旧快照会把 B 刚改的值盖回去，
   * 表现就是「点了没反应 / 自己弹回原样」。
   */
  let patchSeq = 0
  /** 本地在途改动数：在途期间不套用广播来的快照（它可能是改之前的旧值） */
  let inFlight = 0

  /** 改偏好：**先本地生效**（UI 立刻响应）再落盘；落盘失败回滚并记下原因 */
  async function patch(p: SettingsPatch): Promise<void> {
    const my = ++patchSeq
    const before = clone(settings.value)
    apply(p)
    inFlight++
    try {
      const r = await window.stash.settings.patch(p)
      if (!r.ok) {
        if (my === patchSeq) settings.value = before // 只有它还代表最新意图时才回滚
        lastError.value = r.error ?? '设置保存失败'
        return
      }
      if (my === patchSeq && r.data) apply(r.data) // 以后端清洗后的值为准（它可能钳掉了越界值）
      lastError.value = null
    } finally {
      inFlight--
    }
  }

  function openPanel(): void {
    panelOpen.value = true
  }
  function closePanel(): void {
    panelOpen.value = false
  }

  /** 恢复外观默认值（只动外观，不碰缩略图管线/库列表等其它设置） */
  async function resetAppearance(): Promise<void> {
    await patch({
      defaultView: FALLBACK.defaultView,
      viewZoom: FALLBACK.viewZoom,
      cardFields: { ...FALLBACK.cardFields },
      detailCollapsed: FALLBACK.detailCollapsed
    })
  }

  return { settings, loaded, panelOpen, lastError, init, patch, openPanel, closePanel, resetAppearance }
})
