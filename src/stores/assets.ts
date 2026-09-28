// 素材列表/筛选/选中/详情 + 导入进度状态
import { defineStore } from 'pinia'
import { computed, reactive, ref, watch } from 'vue'
import { useLibraryStore } from './library'
import type { StashAssetRow, StashAssetDetail, StashPrunedTag } from '../env'

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

/** 右侧信息栏是否收起（布局偏好，全局一份，不按库隔离） */
const DETAIL_COLLAPSED_KEY = 'stash.detailCollapsed'

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

/** 右侧信息栏的收起状态（默认展开；只有明确存过 '1' 才收起） */
function readDetailCollapsed(): boolean {
  try {
    return localStorage.getItem(DETAIL_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
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

  // —— 多选集合（批量操作的作用域）——
  // 用数组而非 Set：组件里 isSelected 是热路径（每帧每卡一次），数组 includes 在
  // 单页 200 项量级下开销可忽略，且替换式赋值能保证触发更新，不依赖 Set 的响应式代理
  const selectedIds = ref<number[]>([])
  const selectedCount = computed(() => selectedIds.value.length)
  /** 选中项是否全部已喜欢（决定右键/悬浮条显示「设为喜欢」还是「取消喜欢」） */
  const selectedAllFav = computed(() => {
    if (!selectedIds.value.length) return false
    const set = selectedIds.value
    const list = items.value.filter((i) => set.includes(i.id))
    return list.length > 0 && list.every((i) => i.is_fav === 1)
  })
  /** 选中项的公共评分：全部一致时返回该值，不一致返回 0（UI 另用 mixed 提示，避免被误读成「无评分」） */
  const selectedRating = computed(() => {
    const set = selectedIds.value
    const list = items.value.filter((i) => set.includes(i.id))
    if (!list.length) return 0
    const first = list[0].rating
    return list.every((i) => i.rating === first) ? first : 0
  })
  /** 选中项评分是否存在分歧 */
  const selectedRatingMixed = computed(() => {
    const set = selectedIds.value
    const list = items.value.filter((i) => set.includes(i.id))
    if (list.length < 2) return false
    return list.some((i) => i.rating !== list[0].rating)
  })

  function isSelected(id: number): boolean {
    return selectedIds.value.includes(id)
  }

  // 导入浮层状态
  const importing = ref<{ done: number; total: number } | null>(null)
  // 导入结果提示（错误 / 摘要）
  const importNotice = ref<{ kind: 'error' | 'info'; text: string } | null>(null)

  /** 统一的轻提示出口（批量操作等非导入场景也走这里，自动消失） */
  let noticeTimer: ReturnType<typeof setTimeout> | null = null
  function notify(kind: 'error' | 'info', text: string): void {
    importNotice.value = { kind, text }
    if (noticeTimer) clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => (importNotice.value = null), kind === 'error' ? 10000 : 5000)
  }

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

  /**
   * 右侧信息栏是否收起。
   *
   * 这是**一个显式的布局状态**，不是「当前有没有选中素材」的派生值 ——
   * 所以收起之后点素材也不会把它拉回来（渲染只看这个标志）。
   * 收起时整个面板不渲染：既省掉 detail 缩略图的预生成，也让中栏顺势占满宽度。
   */
  const detailCollapsed = ref(readDetailCollapsed())
  watch(detailCollapsed, (v) => {
    try {
      localStorage.setItem(DETAIL_COLLAPSED_KEY, v ? '1' : '0')
    } catch {
      /* 写入失败忽略，仅本次会话生效 */
    }
  })
  function toggleDetail(): void {
    detailCollapsed.value = !detailCollapsed.value
  }

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

  // ==================== 中栏放大预览（浮出层）====================
  /**
   * 正在浮层里查看的素材 id；null = 浮层关闭。
   *
   * **触发是双击**（用户拍板）：单击仍然是「选中 + 右侧详情」，所以这个状态与
   * `selectedId` 完全独立 —— 不能写成「选中就弹浮层」，那会把多选流程整个打乱。
   */
  const previewId = ref<number | null>(null)

  /**
   * 预览里有没有未保存的改动（P4 的文本编辑器会写它）。
   * 放 store 而不是组件里：浮层要拦「关闭 / 左右切换」，编辑器要上报 —— 两头都得读得到。
   */
  const previewDirty = ref(false)

  function openPreview(id: number): void {
    previewId.value = id
  }

  function closePreview(): void {
    previewId.value = null
    previewDirty.value = false
  }

  /**
   * 在**当前列表顺序**里前后切换。
   * 只在已加载的 `items` 里走，越界就停住（不自动 loadMore —— 翻页加载是异步的，
   * 浮层里等加载再跳会闪一下；想看更后面的，关掉浮层滚下去再双击即可）。
   * 返回是否真的切换了（没切换时 UI 不用重置媒体状态）。
   */
  function stepPreview(delta: number): boolean {
    const id = previewId.value
    if (id == null || items.value.length === 0) return false
    const idx = items.value.findIndex((i) => i.id === id)
    if (idx < 0) return false
    const next = items.value[idx + delta]
    if (!next) return false
    previewId.value = next.id
    return true
  }

  /** 切换库时清空全部素材状态（查询条件、列表、选中、详情、浮层） */
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
    selectedIds.value = []
    detail.value = null
    previewId.value = null
    previewDirty.value = false
  }

  /**
   * 点文件夹时递归取子文件夹的素材。
   *
   * 只有真的选了文件夹才加这个键 —— 没选文件夹时后端压根不看它，
   * 但传出去会让「同一次浏览的查询对象长什么样」变得不一致（调试时容易被误导）。
   * 刻意写成普通函数而不是 `computed`：store setup 内部拿到的是 ref，`...ref` 展开是空的。
   */
  const deepOpt = (): { folderDeep?: boolean } => (query.folderId != null ? { folderDeep: true } : {})

  async function refresh(): Promise<void> {
    loading.value = true
    const r = await window.stash.asset.list({ ...query, ...deepOpt(), offset: 0, limit: PAGE })
    loading.value = false
    if (r.data) {
      items.value = r.data.items
      total.value = r.data.total
      // 选中项可能已不在列表中（被删/被移走/切换了筛选条件）
      const visible = new Set(items.value.map((i) => i.id))
      const kept = selectedIds.value.filter((id) => visible.has(id))
      if (kept.length !== selectedIds.value.length) selectedIds.value = kept
      if (selectedId.value != null && !visible.has(selectedId.value)) {
        selectedId.value = null
        detail.value = null
      }
    }
  }

  async function loadMore(): Promise<void> {
    if (loading.value || items.value.length >= total.value) return
    loading.value = true
    const r = await window.stash.asset.list({ ...query, ...deepOpt(), offset: items.value.length, limit: PAGE })
    loading.value = false
    if (r.data) {
      const seen = new Set(items.value.map((i) => i.id))
      items.value.push(...r.data.items.filter((i) => !seen.has(i.id)))
      total.value = r.data.total
    }
  }

  // —— 筛选状态 ——
  /**
   * 工具栏上生效的筛选条件数（关键词 / 类型 / 评分 / 喜欢）。
   *
   * 刻意**不统计** folderId 与 tagId：那是侧栏的「导航定位」，
   * 用户点「设计稿」文件夹是想看那里面的东西，不是给结果加了道筛子；
   * 把它们算进去会让「清除筛选」变成「跳回全部素材」，误伤导航意图。
   */
  const activeFilterCount = computed(
    () =>
      (query.keyword ? 1 : 0) + (query.type ? 1 : 0) + (query.rating > 0 ? 1 : 0) + (query.fav ? 1 : 0)
  )

  /** 清空工具栏筛选（保留文件夹/标签定位与排序偏好），需调用方自行 refresh */
  function clearFilters(): void {
    query.keyword = ''
    query.type = null
    query.rating = 0
    query.fav = false
  }

  /** 拉取详情并把它设为右侧面板展示的对象 */
  async function loadDetail(id: number): Promise<void> {
    selectedId.value = id
    const r = await window.stash.asset.get(id)
    detail.value = r.data ?? null
  }

  /** 普通左键点击：单选（清掉其他选中），右侧详情同步 */
  async function select(id: number): Promise<void> {
    selectedIds.value = [id]
    await loadDetail(id)
  }

  /** Ctrl+左键点击：把该项加入 / 移出选中集合 */
  async function toggleSelect(id: number): Promise<void> {
    if (selectedIds.value.includes(id)) {
      const rest = selectedIds.value.filter((x) => x !== id)
      selectedIds.value = rest
      if (selectedId.value === id) {
        const next = rest[rest.length - 1]
        if (next != null) await loadDetail(next)
        else {
          selectedId.value = null
          detail.value = null
        }
      }
    } else {
      selectedIds.value = [...selectedIds.value, id]
      await loadDetail(id)
    }
  }

  /** 框选：additive=true（Ctrl 拖拽）在现有选中上追加，否则整体替换 */
  async function selectMany(ids: number[], additive = false): Promise<void> {
    const next = additive ? Array.from(new Set([...selectedIds.value, ...ids])) : ids.slice()
    selectedIds.value = next
    const last = next[next.length - 1]
    if (last != null) await loadDetail(last)
    else {
      selectedId.value = null
      detail.value = null
    }
  }

  /** 取消选择（点击空白处触发） */
  function clearSelection(): void {
    selectedIds.value = []
    selectedId.value = null
    detail.value = null
  }

  // ==================== 拖拽素材到文件夹 ====================
  // 状态放 store：拖拽要跨越两个组件 —— 画廊负责跟随鼠标的 ghost，
  // 侧栏负责把落点文件夹高亮出来（两者都需要知道「正在拖什么、悬停在哪个文件夹」）。
  const dragIds = ref<number[]>([])
  /** 当前鼠标悬停的落点文件夹；不可能是有效落点时（源文件夹 / 空白）保持 null */
  const dragOverFolderId = ref<number | null>(null)
  /** 被拖素材的公共源文件夹（跨目录多选时为 null）——用来判定「拖回原地」这个无效落点 */
  const dragOriginFolderId = ref<number | null>(null)

  function beginDragMove(ids: number[], originFolderId: number | null): void {
    dragIds.value = ids.slice()
    dragOriginFolderId.value = originFolderId
    dragOverFolderId.value = null
  }

  function setDragOver(folderId: number | null): void {
    // 拖回素材原本所在的文件夹等于什么都没做，不作为有效落点（否则会白亮一下再消失）
    dragOverFolderId.value = folderId != null && folderId === dragOriginFolderId.value ? null : folderId
  }

  function endDragMove(): void {
    dragIds.value = []
    dragOverFolderId.value = null
    dragOriginFolderId.value = null
  }

  // —— 批量操作：作用于当前选中集合 ——

  /** 批量评分：0 表示清除评分 */
  async function bulkRate(rating: number): Promise<void> {
    const ids = selectedIds.value.slice()
    if (!ids.length) return
    const r = await window.stash.asset.bulkUpdate(ids, { rating })
    if (!r.ok) {
      notify('error', `设置评分失败：${r.error}`)
      return
    }
    const set = new Set(ids)
    for (const it of items.value) if (set.has(it.id)) it.rating = rating
    if (detail.value && set.has(detail.value.id)) detail.value.rating = rating
    notify('info', rating > 0 ? `已为 ${ids.length} 项设置 ${rating} 星` : `已清除 ${ids.length} 项的评分`)
  }

  /** 批量喜欢 / 取消喜欢 */
  async function bulkFav(isFav: boolean): Promise<void> {
    const ids = selectedIds.value.slice()
    if (!ids.length) return
    const r = await window.stash.asset.bulkUpdate(ids, { isFav })
    if (!r.ok) {
      notify('error', `操作失败：${r.error}`)
      return
    }
    const v = isFav ? 1 : 0
    const set = new Set(ids)
    for (const it of items.value) if (set.has(it.id)) it.is_fav = v
    if (detail.value && set.has(detail.value.id)) detail.value.is_fav = v
    notify('info', isFav ? `已喜欢 ${ids.length} 项` : `已取消喜欢 ${ids.length} 项`)
  }

  /**
   * 批量移动到库内文件夹：文件真的搬走，列表与侧栏计数同步刷新。
   * `explicitIds` 供拖拽移动使用 —— 那种场景下「要拖的东西」不一定等于当前选中集合。
   */
  async function bulkMove(folderId: number, explicitIds?: number[]): Promise<void> {
    const ids = (explicitIds ?? selectedIds.value).slice()
    if (!ids.length) return
    const r = await window.stash.asset.move(ids, folderId)
    if (!r.ok) {
      notify('error', `移动失败：${r.error}`)
      return
    }
    const moved = r.data?.moved ?? 0
    const renamed = r.data?.renamed ?? 0
    const failed = r.data?.failed ?? []
    clearSelection()
    const lib = useLibraryStore()
    const target = lib.folderById.get(folderId)?.name
    await lib.loadMeta()
    await refresh()
    // 目标文件夹里已有同名文件时会被自动改成 `名字 (1).ext`，得说清楚，否则用户会以为文件被覆盖了
    const note = renamed ? `（${renamed} 个因重名已自动改名）` : ''
    if (failed.length) notify('error', `${moved} 项已移动，${failed.length} 项失败（${failed[0].name}：${failed[0].error}）`)
    else notify('info', `${target ? `已移动 ${moved} 项到「${target}」` : `已移动 ${moved} 项`}${note}`)
  }

  /**
   * 标签被自动删除时的说明文案，无则空串。
   *
   * ⚠️ 刻意**不在这里 notify**：通知是单槽位（后一条直接覆盖前一条），
   * 若这里弹一次、调用方紧接着又弹自己的结果，前一条会被吃掉。
   * 所以这里只产出文案片段，由调用方拼进自己的那一条提示里。
   */
  function prunedNote(pruned?: StashPrunedTag[]): string {
    if (!pruned?.length) return ''
    return `标签${pruned.map((p) => `「${p.name}」`).join('')}已无任何素材，已自动清除`
  }

  /**
   * 清掉指向「已被自动删除的标签」的筛选，返回是否真的重置了。
   *
   * 服务层在各条会减少标签关联的路径（摘标签 / 删素材 / 删文件夹）收尾时会清空标签
   * （见 `pruneUnlinkedTags`）。此时若 `query.tagId` 还指着它，列表就卡在一个
   * 永远查不到东西的条件上 —— 表现为「删完标签，列表变成空的」。
   * **必须在 refresh 之前调用**，否则刷新用的还是旧条件。
   */
  function dropPrunedTagFilter(pruned?: StashPrunedTag[]): boolean {
    if (!pruned?.length) return false
    if (pruned.some((p) => p.id === query.tagId)) {
      query.tagId = null
      return true
    }
    return false
  }

  /** 批量删除：直接真删除，不可恢复（无回收站；调用方必须先做二次确认） */
  async function bulkDelete(): Promise<void> {
    const ids = selectedIds.value.slice()
    if (!ids.length) return
    const r = await window.stash.asset.remove(ids)
    if (!r.ok) {
      notify('error', `删除失败：${r.error}`)
      return
    }
    const deleted = r.data?.deleted ?? 0
    const failed = r.data?.failed ?? []
    clearSelection()
    const lib = useLibraryStore()
    // 删素材会让挂在它身上的标签归零。先清掉指向这些标签的筛选，再刷新
    const pruned = r.data?.pruned
    dropPrunedTagFilter(pruned)
    await lib.loadMeta()
    await refresh()
    const note = prunedNote(pruned)
    const tail = note ? `；${note}` : ''
    if (failed.length) notify('error', `${deleted} 项已删除，${failed.length} 项失败（${failed[0].name}：${failed[0].error}）${tail}`)
    else notify('info', `已删除 ${deleted} 项（已从磁盘移除，不可恢复）${tail}`)
  }

  /**
   * 详情页 / 卡片上的即时改评分与喜欢。
   *
   * ⚠️ 入参用 **DB 列名**（`is_fav`）而不是 IPC 那边的 camelCase `isFav`，
   * 因为它会被直接 `Object.assign` 到本地行对象上；行对象字段名取自数据库。
   * 曾经这里收 `isFav` 就原样 assign，结果本地对象被塞了个没人读的 `isFav` 字段，
   * **数据库确实改了、但模板绑定的 `is_fav` 没变 → UI 不刷新**，
   * 表现为「点详情页爱心没反应」（重开库才看得到其实早已生效）。
   * 两个方向的映射都在这里显式做掉，调用方不用关心。
   *
   * 另注意：`rating` 两边同名，所以它一直是正常的。
   */
  async function patchLocal(id: number, patch: Partial<Pick<StashAssetRow, 'rating' | 'is_fav'>>): Promise<void> {
    const r = await window.stash.asset.update(id, {
      rating: patch.rating,
      isFav: patch.is_fav == null ? undefined : patch.is_fav === 1
    })
    if (!r.ok) {
      // 写库失败必须说出来，否则又是一次「点了没反应」
      notify('error', `保存失败：${r.error}`)
      return
    }
    const it = items.value.find((i) => i.id === id)
    if (it) Object.assign(it, patch)
    if (detail.value?.id === id) Object.assign(detail.value, patch)
  }

  /**
   * 改提示词 / 备注。
   *
   * 同样**不能**直接 `Object.assign` 到后端那份 —— 这里传的是 DB 列名 `note`，两边同名，
   * 但服务层会把纯空白存成 NULL，本地也照着归一化，免得「有内容」和「没内容」判断不一致。
   */
  async function saveNote(id: number, note: string): Promise<boolean> {
    const r = await window.stash.asset.update(id, { note })
    if (!r.ok) {
      notify('error', `保存提示词失败：${r.error}`)
      return false
    }
    const normalized = note.trim() ? note : null
    const it = items.value.find((i) => i.id === id)
    if (it) it.note = normalized
    if (detail.value?.id === id) detail.value.note = normalized
    return true
  }

  // —— 复制 / 粘贴源文件 ——

  /** 库内相对路径 → 绝对路径（复制源文件时要交给系统剪贴板） */
  function absPathOf(relPath: string): string {
    const root = useLibraryStore().info?.path
    if (!root) return ''
    return `${root}\\${relPath.replace(/\//g, '\\')}`
  }

  /**
   * 复制选中素材的**源文件**到系统剪贴板（Windows 上是 CF_HDROP，
   * 所以既能去资源管理器 Ctrl+V，也能在本应用内 Ctrl+V 得到副本）。
   */
  async function copySelection(ids?: number[]): Promise<void> {
    const list = (ids ?? selectedIds.value).slice()
    if (!list.length) return
    const paths = list
      .map((id) => items.value.find((i) => i.id === id)?.rel_path)
      .filter((p): p is string => !!p)
      .map(absPathOf)
      .filter(Boolean)
    if (!paths.length) return void notify('error', '复制失败：找不到源文件路径')
    const r = await window.stash.clipboard.writeFiles(paths)
    if (!r.ok) return void notify('error', `复制失败：${r.error}`)
    notify('info', `已复制 ${paths.length} 个文件，可粘贴到当前文件夹或资源管理器`)
  }

  /**
   * 粘贴：读系统剪贴板里的文件列表再交给服务层分流 ——
   * 库内文件生成**保留评分/喜欢/备注/标签的副本**，库外文件走导入管线。
   * 导入那部分的进度/完成由 `import:progress|done` 事件驱动（App.vue 统一处理）。
   */
  async function pasteInto(folderId: number | null): Promise<void> {
    const r = await window.stash.clipboard.readFiles()
    if (!r.ok) return void notify('error', `读取剪贴板失败：${r.error}`)
    const paths = r.data ?? []
    if (!paths.length) return void notify('info', '剪贴板里没有可粘贴的文件')

    const p = await window.stash.asset.paste(paths, folderId)
    if (!p.ok) return void notify('error', `粘贴失败：${p.error}`)
    const copied = p.data?.copied ?? 0
    const renamed = p.data?.renamed ?? 0
    const importing = p.data?.importing ?? 0
    const failed = p.data?.failed ?? []

    if (copied) {
      const lib = useLibraryStore()
      await lib.loadMeta()
      await refresh()
    }
    const parts: string[] = []
    if (copied) parts.push(`已创建 ${copied} 份副本${renamed ? `（${renamed} 个因重名已自动改名）` : ''}`)
    if (importing) parts.push(`正在粘贴 ${importing} 个文件…`)
    if (failed.length) {
      notify('error', `${parts.join('，') || '粘贴未完成'}；${failed.length} 项失败（${failed[0].name}：${failed[0].error}）`)
      return
    }
    if (parts.length) notify('info', parts.join('，'))
  }

  return {
    query, items, total, loading,
    selectedId, detail,
    selectedIds, selectedCount, selectedAllFav, selectedRating, selectedRatingMixed, isSelected,
    importing, importNotice, notify,
    thumbV, bumpThumbs, thumbUrl,
    cardFields, toggleCardField, viewZoom,
    detailCollapsed, toggleDetail,
    previewId, previewDirty, openPreview, closePreview, stepPreview,
    activeFilterCount, clearFilters,
    refresh, loadMore, select, loadDetail, toggleSelect, selectMany, clearSelection,
    dragIds, dragOverFolderId, dragOriginFolderId, beginDragMove, setDragOver, endDragMove,
    patchLocal, saveNote, copySelection, pasteInto, bulkRate, bulkFav, bulkMove, bulkDelete, reset,
    prunedNote, dropPrunedTagFilter
  }
})
