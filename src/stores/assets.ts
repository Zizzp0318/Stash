// 素材列表/筛选/选中/详情 + 导入进度状态
import { defineStore } from 'pinia'
import { reactive, ref, watch } from 'vue'
import { useLibraryStore } from './library'
import type { StashAssetRow, StashAssetDetail } from '../env'

const PAGE = 200

/** 卡片下方常驻显示的字段开关 */
export type CardField = 'name' | 'dims' | 'size' | 'time'
export const CARD_FIELDS: Array<{ key: CardField; label: string }> = [
  { key: 'name', label: '文件名' },
  { key: 'dims', label: '尺寸' },
  { key: 'size', label: '大小' },
  { key: 'time', label: '导入时间' }
]

const FIELD_STORE_KEY = 'stash.cardFields'

/**
 * 瀑布视图缩放：滑块值 = 目标列宽（px），实际卡片宽度按容器撑满。
 * 上限刻意压低，避免放大到只剩一两列的大图。
 */
export const VIEW_ZOOM_MIN = 140
export const VIEW_ZOOM_MAX = 280
export const VIEW_ZOOM_DEFAULT = 170
const ZOOM_STORE_KEY = 'stash.viewZoom'

function readViewZoom(): number {
  try {
    const n = Number(localStorage.getItem(ZOOM_STORE_KEY))
    if (Number.isFinite(n) && n >= VIEW_ZOOM_MIN && n <= VIEW_ZOOM_MAX) return Math.round(n)
  } catch {
    /* 读取失败用默认值 */
  }
  return VIEW_ZOOM_DEFAULT
}

function readCardFields(): Record<CardField, boolean> {
  const def: Record<CardField, boolean> = { name: true, dims: true, size: true, time: true }
  try {
    const raw = localStorage.getItem(FIELD_STORE_KEY)
    if (!raw) return def
    const saved = JSON.parse(raw) as Partial<Record<CardField, boolean>>
    for (const { key } of CARD_FIELDS) if (typeof saved[key] === 'boolean') def[key] = saved[key] as boolean
  } catch {
    /* 读取失败用默认值 */
  }
  return def
}

export const useAssetStore = defineStore('assets', () => {
  const query = reactive({
    folderId: null as number | null,
    tagId: null as number | null,
    type: null as string | null,
    rating: 0,
    fav: false,
    keyword: '',
    sort: 'imported_at',
    order: 'desc'
  })
  const items = ref<StashAssetRow[]>([])
  const total = ref(0)
  const loading = ref(false)
  const selectedId = ref<number | null>(null)
  const detail = ref<StashAssetDetail | null>(null)

  // 导入浮层状态
  const importing = ref<{ done: number; total: number } | null>(null)
  // 导入结果提示（错误 / 摘要）
  const importNotice = ref<{ kind: 'error' | 'info'; text: string } | null>(null)

  // 卡片下方常驻显示哪些字段（偏好持久化到 localStorage）
  const cardFields = reactive(readCardFields())
  function toggleCardField(key: CardField): void {
    cardFields[key] = !cardFields[key]
    try {
      localStorage.setItem(FIELD_STORE_KEY, JSON.stringify(cardFields))
    } catch {
      /* 写入失败忽略，仅本次会话生效 */
    }
  }

  // 瀑布视图缩放（目标列宽 px），
  const viewZoom = ref(readViewZoom())
  watch(viewZoom, (v) => {
    try {
      localStorage.setItem(ZOOM_STORE_KEY, String(v))
    } catch {
      /* 写入失败忽略 */
    }
  })

  // 缩略图版本号：后台批量生成完成后 +1，URL 加 ?v= 触发 <img> 重新加载
  const thumbV = ref(0)
  function bumpThumbs(): void {
    thumbV.value++
  }

  function thumbUrl(hash: string | null, size: 'grid' | 'detail' = 'grid'): string {
    if (!hash) return ''
    const lib = useLibraryStore()
    if (!lib.info) return ''
    // 走自定义协议 stash://（主进程 protocol.handle 直接读当前库 .thumbs 目录）。
    // 不用 file://：开发模式下渲染层起源是 http://localhost:xxxx，Chromium 会拦截
    // http 页面加载 file:// 子资源（Not allowed to load local resource），缩略图全空白。
    // 自定义协议在 http:// 与 file:// 两种起源下均可加载。
    return `stash://thumb/${hash}/${size}.webp?v=${thumbV.value}`
  }

  /** 切换库时清空全部素材状态（查询条件、列表、选中、详情） */
  function reset(): void {
    query.folderId = null
    query.tagId = null
    query.type = null
    query.rating = 0
    query.fav = false
    query.keyword = ''
    query.sort = 'imported_at'
    query.order = 'desc'
    items.value = []
    total.value = 0
    selectedId.value = null
    detail.value = null
  }

  async function refresh(): Promise<void> {
    loading.value = true
    const r = await window.stash.asset.list({ ...query, offset: 0, limit: PAGE })
    loading.value = false
    if (r.data) {
      items.value = r.data.items
      total.value = r.data.total
      // 当前选中项可能已不在列表中
      if (selectedId.value != null && !items.value.some((i) => i.id === selectedId.value)) {
        selectedId.value = null
        detail.value = null
      }
    }
  }

  async function loadMore(): Promise<void> {
    if (loading.value || items.value.length >= total.value) return
    loading.value = true
    const r = await window.stash.asset.list({ ...query, offset: items.value.length, limit: PAGE })
    loading.value = false
    if (r.data) {
      const seen = new Set(items.value.map((i) => i.id))
      items.value.push(...r.data.items.filter((i) => !seen.has(i.id)))
      total.value = r.data.total
    }
  }

  async function select(id: number): Promise<void> {
    selectedId.value = id
    const r = await window.stash.asset.get(id)
    detail.value = r.data ?? null
  }

  async function patchLocal(id: number, patch: Partial<Pick<StashAssetRow, 'rating' | 'is_fav'>>): Promise<void> {
    await window.stash.asset.update(id, patch)
    const it = items.value.find((i) => i.id === id)
    if (it) Object.assign(it, patch)
    if (detail.value?.id === id) Object.assign(detail.value, patch)
  }

  return { query, items, total, loading, selectedId, detail, importing, importNotice, thumbV, bumpThumbs, thumbUrl, cardFields, toggleCardField, viewZoom, refresh, loadMore, select, patchLocal, reset }
})
