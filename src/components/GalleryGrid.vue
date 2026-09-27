<script setup lang="ts">
import { ref, computed, reactive, onMounted, onBeforeUnmount } from 'vue'
import { heart, folderIcon } from '@/data/mock'
import { useLibraryStore } from '../stores/library'
import { useAssetStore, CARD_FIELDS, VIEW_ZOOM_MIN, VIEW_ZOOM_MAX } from '../stores/assets'
import { fmtSize, fmtDate, fmtCount, fmtDuration } from '../utils/format'
import type { StashAssetRow } from '../env'
import BatchBar from './BatchBar.vue'

const lib = useLibraryStore()
const assets = useAssetStore()

const view = ref<'masonry' | 'list'>('masonry')

// 上下文标题
const title = computed(() => {
  if (assets.query.tagId != null) {
    return lib.tags.find((t) => t.id === assets.query.tagId)?.name ?? '标签'
  }
  if (assets.query.folderId != null) {
    // Pinia setup store 的 computed 在实例上已解包，直接 .get()
    return lib.folderById.get(assets.query.folderId)?.name ?? '文件夹'
  }
  return '所有素材'
})

/**
 * 当前范围（文件夹/标签）内的素材总数，**不含**工具栏筛选 —— 用作「N / 共 M」的分母。
 *
 * 刻意与列表查询保持同一语义：后端 `folderId != null` 只匹配 `a.folder_id = ?`（直接子项，不递归），
 * 所以这里用 `byFolder` 直接计数而不是 `subtreeCount`（后者含子文件夹子树）。
 * 用 subtreeCount 会让分母比不带筛选时列表里实际能看到的还多，数字对不上。
 * 侧栏文件夹的计数走同一条口径（`lib.directCount`），三处保持一致。
 */
const scopeTotal = computed(() => {
  if (assets.query.folderId != null) return lib.counts.byFolder[String(assets.query.folderId)] ?? 0
  if (assets.query.tagId != null) return lib.counts.byTag[String(assets.query.tagId)] ?? 0
  return lib.counts.total
})

/** 有没有生效的工具栏筛选（决定空态文案与计数写法） */
const filtering = computed(() => assets.activeFilterCount > 0)

// —— 筛选芯片 ——
async function toggleFav(): Promise<void> {
  assets.query.fav = !assets.query.fav
  await assets.refresh()
}

/** 排序方向：名称按「A→Z」直觉用升序，其余维度默认降序更符合「最新/最大优先」 */
async function toggleOrder(): Promise<void> {
  assets.query.order = assets.query.order === 'asc' ? 'desc' : 'asc'
  await assets.refresh()
}

// ==================== 工具栏下拉菜单 ====================
// 类型 / 评分 / 排序共用同一个弹层骨架，只有 `key` 与内容不同。
// 三者都做成「点开选」而不是「点一下循环」：循环式芯片用户看不到有哪些可选项，
// 想从「≥3 星」退回「不限」要点三下，也没法一步跳到目标值。
type MenuKey = 'type' | 'rating' | 'sort'
type SortKey = 'imported_at' | 'name' | 'size' | 'rating'
const chipMenu = ref<{ key: MenuKey; x: number; y: number } | null>(null)

const TYPE_OPTS: Array<{ value: string | null; label: string }> = [
  { value: null, label: '全部类型' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
  { value: 'text', label: '文本' }
]

/** 评分只支持「≥N 星」语义（0 = 不限），与后端 `rating >= ?` 一一对应，没有「恰好 N 星」 */
const RATING_OPTS: Array<{ value: number; label: string }> = [
  { value: 0, label: '不限评分' },
  { value: 1, label: '1 星及以上' },
  { value: 2, label: '2 星及以上' },
  { value: 3, label: '3 星及以上' },
  { value: 4, label: '4 星及以上' },
  { value: 5, label: '5 星' }
]

const SORT_OPTS: Array<{ value: SortKey; label: string }> = [
  { value: 'imported_at', label: '导入时间' },
  { value: 'name', label: '名称' },
  { value: 'size', label: '大小' },
  { value: 'rating', label: '评分' }
]

const typeLabel = computed(() => TYPE_OPTS.find((o) => o.value === assets.query.type)?.label ?? '全部类型')
const sortLabel = computed(() => SORT_OPTS.find((o) => o.value === assets.query.sort)?.label ?? '排序')

/**
 * 芯片只显示图标，状态信息全部搬到 title：
 * 图标形状编码「哪一类」（类型/排序维度），颜色与填充编码「是否生效」，
 * 具体档位（≥N 星、哪种类型、哪个排序维度）由悬停提示与菜单内高亮承担。
 */
const ratingTitle = computed(() =>
  assets.query.rating > 0 ? `评分筛选：≥${assets.query.rating} 星（点击更换）` : '评分筛选：不限（点击更换）'
)
const favTitle = computed(() =>
  assets.query.fav ? '喜欢筛选：已开启（点击关闭）' : '喜欢筛选：未开启（点击只看喜欢）'
)
const typeTitle = computed(() => `类型筛选：${typeLabel.value}（点击更换）`)
const sortTitle = computed(
  () => `排序方式：${sortLabel.value} · ${assets.query.order === 'asc' ? '升序' : '降序'}（点击更换）`
)

/** 各菜单的估算宽度，仅用于把弹层挡在窗口右缘之内 */
const MENU_W: Record<MenuKey, number> = { type: 124, rating: 172, sort: 136 }

/**
 * 打开某个芯片的菜单。
 * 对着同一个芯片再点一次则收起 —— 否则会「先关后开」，看起来像没反应。
 */
function openChipMenu(key: MenuKey, e: MouseEvent): void {
  if (chipMenu.value?.key === key) {
    chipMenu.value = null
    return
  }
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  chipMenu.value = {
    key,
    x: Math.max(8, Math.min(r.left, window.innerWidth - MENU_W[key] - 8)),
    y: r.bottom + 4
  }
}

async function setType(v: string | null): Promise<void> {
  chipMenu.value = null
  assets.query.type = v
  await assets.refresh()
}

async function setRating(v: number): Promise<void> {
  chipMenu.value = null
  assets.query.rating = v
  await assets.refresh()
}

/**
 * 选排序维度。点「当前维度」本身 = 翻转升降序（菜单项右侧已有 ↑/↓ 提示），
 * 这样在菜单里也能改方向，不用再去够旁边那个小箭头。
 */
async function setSort(v: SortKey): Promise<void> {
  const same = assets.query.sort === v
  chipMenu.value = null
  if (same) {
    assets.query.order = assets.query.order === 'asc' ? 'desc' : 'asc'
  } else {
    assets.query.sort = v
    assets.query.order = v === 'name' ? 'asc' : 'desc'
  }
  await assets.refresh()
}

/** 清空全部工具栏筛选（关键词会通过 store 反向同步把顶栏搜索框也清掉） */
async function clearAllFilters(): Promise<void> {
  assets.clearFilters()
  await assets.refresh()
}

// —— 搜索高亮 ——

/** HTML 转义：文件名可以含 `&`、`<`、引号等任意合法字符，绝不能直接拼进 v-html */
const HTML_ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}
function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESC[c] as string)
}

/**
 * 把文件名里命中搜索词的部分包成 `<mark>`。
 *
 * 顺序很讲究：**先对文件名与关键词都做 HTML 转义，再匹配**。
 * - 先转义：否则 `a<b.txt` 会被当成标签、甚至注入脚本
 * - 两边都转义：`&` → `&amp;` 在两者里一致，匹配位置才不会错位
 * - 关键词再做一次正则转义：用户搜 `a(1)` 时 `(` 是正则元字符，不转义会直接抛 RegExp 错误
 * - 加 `i` 标志：SQLite 的 LIKE 对 ASCII 大小写不敏感，前端高亮要跟它对齐，
 *   否则搜 `IMG` 能搜到但不高亮
 */
function hlName(name: string): string {
  const kw = assets.query.keyword.trim()
  const safe = escHtml(name)
  if (!kw) return safe
  const needle = escHtml(kw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try {
    return safe.replace(new RegExp(needle, 'gi'), (m) => `<mark>${m}</mark>`)
  } catch {
    // 兜底：正则构造失败就退化成不高亮，至少不白屏
    return safe
  }
}

// —— 导入 ——
async function importFiles(): Promise<void> {
  const paths = await window.stash.dialog.pickFiles()
  if (!paths.length) return
  await window.stash.import.files({ paths, folderId: assets.query.folderId, mode: 'copy' })
}

// —— 卡片 ——
const TYPE_ICON: Record<string, string> = { image: '🖼', video: '🎬', audio: '🎵', text: '📄' }

/** 尺寸：仅宽×高 / 时长，取不到时留空（不再回落到文件大小，避免与「大小」重复） */
function dimsOnly(it: StashAssetRow): string {
  if (it.width && it.height) return `${it.width} × ${it.height}`
  if (it.duration_ms) return fmtDuration(it.duration_ms)
  return ''
}

/** 卡片下方常驻信息区的元数据行（按开关拼接，空项自动省略） */
function metaText(it: StashAssetRow): string {
  const parts: string[] = []
  if (assets.cardFields.dims) {
    const d = dimsOnly(it)
    if (d) parts.push(d)
  }
  if (assets.cardFields.size) parts.push(fmtSize(it.size))
  if (assets.cardFields.time) parts.push(fmtDate(it.imported_at))
  return parts.join(' · ')
}

// ==================== 瀑布视图布局 ====================
const MASONRY_GAP = 12
// .card 的内边距（缩略图内缩量），必须与 main.css .card 的 padding 一致
const CARD_PAD = 4
// 信息区高度常量，必须与 main.css 中 .card-info / .ci-name / .ci-meta 的行高一一对应，
// 卡片高度靠这里算出（而不是等 DOM 测量），布局才不会有抖动
const INFO_PAD_Y = 13 // padding 6 + 7
const INFO_NAME_H = 17 // .ci-name line-height
const INFO_META_H = 16 // .ci-meta line-height 15 + margin-top 1
const INFO_BORDER = 1 // .card-info border-top

const gridWrap = ref<HTMLElement | null>(null)
const containerW = ref(0)
let ro: ResizeObserver | null = null

onMounted(() => {
  const el = gridWrap.value
  if (el && typeof ResizeObserver !== 'undefined') {
    containerW.value = el.clientWidth
    ro = new ResizeObserver((entries) => {
      containerW.value = entries[0].contentRect.width
    })
    ro.observe(el)
  }
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('mousedown', onWindowMouseDown)
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
  stopDragTrack()
  document.body.classList.remove('drag-moving')
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('mousedown', onWindowMouseDown)
})

/** 列数：由滑块目标宽度决定，至少 1 列 */
const cols = computed(() => {
  const w = containerW.value
  if (w <= 0) return 1
  return Math.max(1, Math.floor((w + MASONRY_GAP) / (assets.viewZoom + MASONRY_GAP)))
})

/** 实际卡片宽度：容器宽度均分给各列（撑满，右侧不留白） */
const cardW = computed(() => {
  const w = containerW.value
  const c = cols.value
  if (w <= 0) return 0
  return (w - MASONRY_GAP * (c - 1)) / c
})

// 图片宽高比（h / w）：优先用索引里的尺寸，索引缺失时用图片实际加载尺寸兜底
const measuredRatio = reactive(new Map<number, number>())

function ratioOf(it: StashAssetRow): number {
  const m = measuredRatio.get(it.id)
  if (m) return m
  if (it.width && it.height) return it.height / it.width
  return 0.75 // 未知尺寸的默认比例（4:3）
}

/** 缩略图可视宽度 = 卡片宽度 - 两侧内边距 */
const thumbW = computed(() => Math.max(0, cardW.value - CARD_PAD * 2))

function thumbH(it: StashAssetRow): number {
  return Math.round(thumbW.value * ratioOf(it))
}

function infoH(it: StashAssetRow): number {
  let h = INFO_PAD_Y
  if (assets.cardFields.name) h += INFO_NAME_H
  if (metaText(it)) h += INFO_META_H
  return h
}

interface Placed {
  it: StashAssetRow
  x: number
  y: number
  w: number
  h: number
  thumb: number
}

/** 最短列优先装箱：每张卡片放进当前最矮的一列，得到绝对定位坐标 */
const placed = computed<Placed[]>(() => {
  const w = cardW.value
  const c = cols.value
  if (w <= 0) return []
  const heights = new Array<number>(c).fill(0)
  const out: Placed[] = []
  for (const it of assets.items) {
    let k = 0
    for (let i = 1; i < c; i++) if (heights[i] < heights[k]) k = i
    const th = thumbH(it)
    // 卡片总高 = 上下内边距 + 缩略图 + 信息区（含分隔线）
    const h = th + infoH(it) + INFO_BORDER + CARD_PAD * 2
    out.push({ it, x: Math.round(k * (w + MASONRY_GAP)), y: Math.round(heights[k]), w: Math.round(w), h, thumb: th })
    heights[k] += h + MASONRY_GAP
  }
  return out
})

/** 瀑布容器总高度 = 最长列的底部 */
const masonryHeight = computed(() => placed.value.reduce((m, p) => Math.max(m, p.y + p.h), 0))

function onImgErr(it: StashAssetRow, ev: Event): void {
  ;(ev.target as HTMLImageElement).style.opacity = '0'
  console.warn('IMG_ERR', it.name, it.content_hash)
}

/** 加载完成：恢复透明度；索引缺尺寸时用图片真实宽高补算比例，保证排布不歪 */
function onImgLoad(it: StashAssetRow, ev: Event): void {
  const el = ev.target as HTMLImageElement
  el.style.opacity = '1'
  if (!(it.width && it.height) && el.naturalWidth > 0 && el.naturalHeight > 0) {
    measuredRatio.set(it.id, el.naturalHeight / el.naturalWidth)
  }
}

function onScroll(e: Event): void {
  const el = e.target as HTMLElement
  if (el.scrollTop + el.clientHeight > el.scrollHeight - 800) assets.loadMore()
}

// ==================== 多选：Ctrl 点选 / 拖拽框选 / 点击空白取消 ====================
// 框选命中判定直接用 placed 里的几何数据（卡片坐标、尺寸都是算出来的），
// 不需要读 DOM，也不会因为图片未加载完而抖
const masonryEl = ref<HTMLElement | null>(null)

/** 拖拽框（坐标与卡片同一坐标系：.masonry 内容区原点） */
const band = ref<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
/** 拖拽过程中落在框内的卡片 id（实时高亮预览） */
const bandHits = ref<number[]>([])
const bandHitSet = computed(() => new Set(bandHits.value))

/** 拖拽判定阈值：小于它算点击而不是拖拽 */
const DRAG_THRESHOLD = 4
/** 拖拽模式：band = 框选，move = 把素材拖进侧栏文件夹 */
type DragMode = 'band' | 'move'
let dragStart: { x: number; y: number; additive: boolean; onCard: boolean; cardId: number | null } | null =
  null
let dragMode: DragMode | null = null
let dragging = false
/** 框选/拖拽结束后短暂屏蔽随后的 click —— 否则浏览器补发的 click 会把选区改成单选 */
let suppressClickUntil = 0

/** 视口坐标 → .masonry 内容坐标（getBoundingClientRect 已含滚动偏移，两者相减即可） */
function toLocal(x: number, y: number): { x: number; y: number } | null {
  const r = masonryEl.value?.getBoundingClientRect()
  if (!r) return null
  return { x: x - r.left, y: y - r.top }
}

function onGridPointerDown(e: MouseEvent): void {
  if (e.button !== 0) return
  // 右键菜单 / 弹窗内部的按下不算框选起点
  if ((e.target as HTMLElement).closest('.ctx-menu, .modal-mask')) return
  const cardEl = (e.target as HTMLElement).closest<HTMLElement>('.card, .list-row')
  dragStart = {
    x: e.clientX,
    y: e.clientY,
    additive: e.ctrlKey || e.metaKey,
    onCard: !!cardEl,
    cardId: cardEl?.dataset.id ? Number(cardEl.dataset.id) : null
  }
  window.addEventListener('mousemove', onGridPointerMove)
  window.addEventListener('mouseup', onGridPointerUp)
}

function stopDragTrack(): void {
  window.removeEventListener('mousemove', onGridPointerMove)
  window.removeEventListener('mouseup', onGridPointerUp)
}

function onGridPointerMove(e: MouseEvent): void {
  const st = dragStart
  if (!st) return
  // 鼠标移出窗口后松手收不到 mouseup：用 buttons 兜底，否则拖拽状态会卡住
  if (dragging && e.buttons === 0) return onGridPointerUp()

  if (!dragging) {
    if (Math.abs(e.clientX - st.x) < DRAG_THRESHOLD && Math.abs(e.clientY - st.y) < DRAG_THRESHOLD) return
    // 起点在卡片上、且没按 Ctrl → 拖素材去文件夹；
    // 其余情况（空白处拖动、Ctrl+拖动）仍是框选，与既有交互保持一致
    if (st.onCard && !st.additive && st.cardId != null) {
      dragMode = 'move'
      startMoveDrag(st.cardId)
    } else {
      // 框选只在瀑布视图做（列表视图行高固定，用 Ctrl 点选即可）
      if (view.value !== 'masonry') {
        dragStart = null
        stopDragTrack()
        return
      }
      dragMode = 'band'
    }
    dragging = true
  }

  if (dragMode === 'move') {
    ghostPos.value = { x: e.clientX, y: e.clientY }
    assets.setDragOver(folderIdAt(e.clientX, e.clientY))
    return
  }

  const a = toLocal(st.x, st.y)
  const b = toLocal(e.clientX, e.clientY)
  if (!a || !b) return
  const rect = { x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) }
  band.value = rect
  bandHits.value = placed.value
    .filter((p) => p.x < rect.x2 && rect.x1 < p.x + p.w && p.y < rect.y2 && rect.y1 < p.y + p.h)
    .map((p) => p.it.id)
}

function onGridPointerUp(): void {
  stopDragTrack()
  const st = dragStart
  const mode = dragMode
  dragStart = null
  dragMode = null
  if (!st) return

  if (dragging) {
    dragging = false
    suppressClickUntil = Date.now() + 200
    if (mode === 'move') {
      const target = assets.dragOverFolderId
      const ids = assets.dragIds.slice()
      endMoveDrag()
      if (target != null) void assets.bulkMove(target, ids)
      return
    }
    const ids = bandHits.value.slice()
    band.value = null
    bandHits.value = []
    // Ctrl 拖拽 = 追加选择；普通拖拽 = 替换选择
    void assets.selectMany(ids, st.additive)
    return
  }
  // 没有位移就是一次点击：起点在卡片上交给卡片处理，起点在空白处则取消选择
  if (!st.onCard && !st.additive) assets.clearSelection()
}

// ==================== 拖动素材到文件夹 ====================
/** ghost 跟随鼠标的位置（视口坐标） */
const ghostPos = ref<{ x: number; y: number } | null>(null)

/** ghost 上的缩略图取被拖的第一项 */
const ghostThumb = computed(() => {
  const first = assets.items.find((i) => i.id === assets.dragIds[0])
  return first?.content_hash ? assets.thumbUrl(first.content_hash) : ''
})

/**
 * 进入拖动状态。素材的「选中集合」与「本次要拖走的集合」不一定相同：
 * 拖的是已选中的一张 → 整批一起走；拖的是没选中的一张 → 只拖它自己（并让它成为唯一选中项，
 * 否则底部悬浮条显示的操作对象与眼前被拖走的图片对不上）。
 */
function startMoveDrag(cardId: number): void {
  const multi = assets.isSelected(cardId) && assets.selectedCount > 1
  const ids = multi ? assets.selectedIds.slice() : [cardId]
  if (!multi) void assets.select(cardId)
  // 全部来自同一个文件夹才算「原地」；跨目录多选时源不唯一，任何文件夹都是有效落点
  const folders = new Set(ids.map((id) => assets.items.find((i) => i.id === id)?.folder_id ?? -1))
  assets.beginDragMove(ids, folders.size === 1 ? [...folders][0] : null)
  ghostPos.value = { x: 0, y: 0 }
  document.body.classList.add('drag-moving')
}

function endMoveDrag(): void {
  ghostPos.value = null
  assets.endDragMove()
  document.body.classList.remove('drag-moving')
}

/** 视口坐标落在哪个侧栏文件夹上（ghost 已设 pointer-events: none，不会挡住命中） */
function folderIdAt(x: number, y: number): number | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null
  const raw = el?.closest<HTMLElement>('.side-item[data-folder-id]')?.dataset.folderId
  return raw ? Number(raw) : null
}

/** 卡片点击：Ctrl 切换单项，普通点击单选；框选/拖拽刚结束时忽略这一次 click */
function onCardClick(it: StashAssetRow, e: MouseEvent): void {
  if (Date.now() < suppressClickUntil) return
  if (e.ctrlKey || e.metaKey) void assets.toggleSelect(it.id)
  else void assets.select(it.id)
}

// ==================== 右键菜单 ====================
const menu = ref<{ x: number; y: number } | null>(null)
const menuConfirm = ref(false)
const menuHoverStar = ref(0)

/**
 * 右键菜单星标是否点亮：悬停预览优先，未悬停时用选中项的公共评分（0 = 全部未评分）。
 * 关态必须同时给出 stroke，否则 `fill: none` + 无描边 = 整颗星不可见（与详情页不一致）。
 */
const menuStarOn = (n: number): boolean => n <= (menuHoverStar.value || assets.selectedRating)

function onCardContext(e: MouseEvent, it: StashAssetRow): void {
  e.preventDefault()
  e.stopPropagation()
  menuConfirm.value = false
  menuHoverStar.value = 0
  // 右键的卡片若不在选中集合里 → 先把它单独选中；已在集合里 → 保持整批
  if (!assets.isSelected(it.id)) void assets.select(it.id)
  // 菜单靠近窗口右/下边缘时向内收，避免被裁掉；高度按「展开删除确认」后的最大态预留
  const w = 212
  const h = 336
  menu.value = {
    x: Math.max(6, Math.min(e.clientX, window.innerWidth - w - 6)),
    y: Math.max(6, Math.min(e.clientY, window.innerHeight - h - 6))
  }
}

function closeMenu(): void {
  menu.value = null
  menuConfirm.value = false
  menuHoverStar.value = 0
}

async function menuRate(n: number): Promise<void> {
  await assets.bulkRate(assets.selectedRating === n ? 0 : n)
  closeMenu()
}

async function menuFav(): Promise<void> {
  await assets.bulkFav(!assets.selectedAllFav)
  closeMenu()
}

// ==================== 移动 / 删除弹窗（右键菜单与底部悬浮条共用） ====================
const moveOpen = ref(false)
const moveTarget = ref<number | null>(null)
const deleteOpen = ref(false)

const moveRows = computed(() =>
  lib.folders
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => ({ ...f, indent: f.path.split('/').length - 1 }))
)

function openMoveDialog(): void {
  closeMenu()
  moveTarget.value = null
  moveOpen.value = true
}

function openDeleteDialog(): void {
  closeMenu()
  deleteOpen.value = true
}

async function confirmMove(): Promise<void> {
  const t = moveTarget.value
  if (t == null) return
  moveOpen.value = false
  await assets.bulkMove(t)
}

async function confirmDelete(): Promise<void> {
  deleteOpen.value = false
  await assets.bulkDelete()
}

// ==================== 全局按键 / 点击 ====================
function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  if (chipMenu.value) return void (chipMenu.value = null)
  if (menu.value) return closeMenu()
  if (moveOpen.value) return void (moveOpen.value = false)
  if (deleteOpen.value) return void (deleteOpen.value = false)
  assets.clearSelection()
}

/** 点击菜单以外的任何地方都关闭右键菜单 / 芯片下拉 */
function onWindowMouseDown(e: MouseEvent): void {
  const t = e.target as HTMLElement
  // 排除触发芯片本身：它有自己「再点一次收起」的 toggle 逻辑，
  // 若在 mousedown 就关掉，紧接着的 click 又会把它打开，看着像点了没反应。
  if (chipMenu.value && !t.closest('.chip-menu') && !t.closest('.chip-menu-trigger')) chipMenu.value = null
  if (menu.value && !t.closest('.ctx-menu')) closeMenu()
}
</script>

<template>
  <main class="gallery">
    <div class="toolbar">
      <div class="toolbar-head">
        <h1>{{ title }}</h1>
        <span class="total">
          <template v-if="filtering">{{ fmtCount(assets.total) }} / {{ fmtCount(scopeTotal) }} 个匹配</template>
          <template v-else>{{ fmtCount(assets.total) }} 个文件</template>
        </span>
        <div class="toolbar-actions">
          <button class="import-btn" title="导入文件到当前文件夹" @click="importFiles">
            <svg viewBox="0 0 12 12" fill="none"><path d="M6 1.8v6M3.4 5.4L6 8l2.6-2.6M2 10.4h8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
            导入
          </button>
          <div class="viewtoggle">
            <button :class="{ on: view === 'masonry' }" title="瀑布视图" @click="view = 'masonry'">
              <svg viewBox="0 0 14 14" fill="currentColor"><rect x="1.6" y="1.6" width="4.6" height="6.6" rx="1.2" /><rect x="7.8" y="1.6" width="4.6" height="4.2" rx="1.2" /><rect x="1.6" y="9.8" width="4.6" height="2.6" rx="1.2" /><rect x="7.8" y="7.4" width="4.6" height="5" rx="1.2" /></svg>
            </button>
            <button :class="{ on: view === 'list' }" title="列表视图" @click="view = 'list'">
              <svg viewBox="0 0 14 14" fill="none"><path d="M2 3.5h10M2 7h10M2 10.5h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
            </button>
          </div>
        </div>
      </div>
      <div class="chips">
        <button
          class="chip chip-ico chip-menu-trigger"
          data-chip="rating"
          :class="{ on: assets.query.rating > 0 || chipMenu?.key === 'rating' }"
          :title="ratingTitle"
          @click="openChipMenu('rating', $event)"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">
            <path
              d="M8 1.7l1.93 3.91 4.32.63-3.13 3.05.74 4.3L8 11.56l-3.86 2.03.74-4.3L1.75 6.24l4.32-.63L8 1.7z"
              :fill="assets.query.rating > 0 ? 'currentColor' : 'none'"
            />
          </svg>
        </button>
        <button class="chip chip-ico" data-chip="fav" :class="{ on: assets.query.fav }" :title="favTitle" @click="toggleFav">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">
            <path
              d="M8 13.3S2.2 9.8 2.2 5.9c0-1.9 1.5-3.4 3.3-3.4 1.2 0 2.1.7 2.5 1.5.4-.8 1.3-1.5 2.5-1.5 1.8 0 3.3 1.5 3.3 3.4 0 3.9-5.8 7.4-5.8 7.4z"
              :fill="assets.query.fav ? 'currentColor' : 'none'"
            />
          </svg>
        </button>
        <button
          class="chip chip-ico chip-menu-trigger"
          data-chip="type"
          :class="{ on: assets.query.type != null || chipMenu?.key === 'type' }"
          :title="typeTitle"
          @click="openChipMenu('type', $event)"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
            <g v-if="assets.query.type === 'image'" data-icon="image">
              <rect x="2.3" y="3" width="11.4" height="10" rx="1.9" />
              <circle cx="5.9" cy="6.4" r="1.1" fill="currentColor" stroke="none" />
              <path d="M4.3 11.8l2.3-2.8 1.9 2.2 1.5-1.6 2 2.2" />
            </g>
            <g v-else-if="assets.query.type === 'video'" data-icon="video">
              <rect x="2.3" y="3" width="11.4" height="10" rx="1.9" />
              <path d="M6.7 6.2l3.5 2.1-3.5 2.1z" fill="currentColor" stroke="none" />
            </g>
            <g v-else-if="assets.query.type === 'audio'" data-icon="audio">
              <path d="M2.7 6.9v2.2M5.3 4.5v7M8 2.7v10.6M10.7 5.1v5.8M13.3 6.9v2.2" />
            </g>
            <g v-else-if="assets.query.type === 'text'" data-icon="text">
              <path d="M4 2.7h5.1l3.2 3.2v7.4H4z" />
              <path d="M9.1 2.7v3.2h3.2M6.1 8.7h4M6.1 11h2.7" />
            </g>
            <g v-else data-icon="all" fill="currentColor" stroke="none">
              <rect x="2.3" y="2.3" width="4.9" height="4.9" rx="1.4" />
              <rect x="8.8" y="2.3" width="4.9" height="4.9" rx="1.4" />
              <rect x="2.3" y="8.8" width="4.9" height="4.9" rx="1.4" />
              <rect x="8.8" y="8.8" width="4.9" height="4.9" rx="1.4" />
            </g>
          </svg>
        </button>
        <button
          class="chip chip-ico chip-menu-trigger"
          data-chip="sort"
          :class="{ on: chipMenu?.key === 'sort' }"
          :title="sortTitle"
          @click="openChipMenu('sort', $event)"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
            <g v-if="assets.query.sort === 'imported_at'" data-icon="imported_at">
              <circle cx="8" cy="8" r="5.9" />
              <path d="M8 4.7V8l2.4 1.5" />
            </g>
            <g v-else-if="assets.query.sort === 'name'" data-icon="name">
              <path d="M3.2 11.9L6.2 4.3l3 7.6M4.4 9.6h3.6" />
            </g>
            <g v-else-if="assets.query.sort === 'size'" data-icon="size" fill="currentColor" stroke="none">
              <rect x="2.3" y="9.4" width="3.4" height="4.3" rx="1" />
              <rect x="6.3" y="6.6" width="3.4" height="7.1" rx="1" />
              <rect x="10.3" y="3.4" width="3.4" height="10.3" rx="1" />
            </g>
            <g v-else data-icon="rating">
              <path d="M8 2.6l1.6 3.25 3.59.52-2.6 2.53.62 3.57L8 10.75l-3.21 1.72.62-3.57-2.6-2.53 3.59-.52L8 2.6z" />
            </g>
          </svg>
        </button>
        <button
          class="chip chip-order"
          :title="assets.query.order === 'asc' ? '升序（点击切换）' : '降序（点击切换）'"
          :data-order="assets.query.order"
          @click="toggleOrder"
        >
          <svg viewBox="0 0 16 16" fill="none">
            <path
              :d="assets.query.order === 'asc' ? 'M8 13V3M4 7l4-4 4 4' : 'M8 3v10M4 9l4 4 4-4'"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <button
          v-if="assets.activeFilterCount > 0"
          class="chip chip-clear"
          :data-count="assets.activeFilterCount"
          title="清除全部筛选条件"
          @click="clearAllFilters"
        >
          清除筛选 {{ assets.activeFilterCount }}
        </button>

        <div class="field-toggles">
          <div class="zoom-ctrl" :title="`卡片宽度 ${assets.viewZoom}px`">
            <svg class="zoom-icon" viewBox="0 0 12 12" fill="currentColor"><rect x="1.4" y="1.6" width="2.5" height="3.6" rx="0.8" /><rect x="4.75" y="1.6" width="2.5" height="3.6" rx="0.8" /><rect x="8.1" y="1.6" width="2.5" height="3.6" rx="0.8" /><rect x="1.4" y="6.8" width="2.5" height="3.6" rx="0.8" /><rect x="4.75" y="6.8" width="2.5" height="3.6" rx="0.8" /><rect x="8.1" y="6.8" width="2.5" height="3.6" rx="0.8" /></svg>
            <input v-model.number="assets.viewZoom" type="range" :min="VIEW_ZOOM_MIN" :max="VIEW_ZOOM_MAX" step="5" aria-label="瀑布视图缩放" />
            <svg class="zoom-icon" viewBox="0 0 12 12" fill="currentColor"><rect x="1.4" y="2.2" width="3.9" height="7.6" rx="1" /><rect x="6.7" y="2.2" width="3.9" height="7.6" rx="1" /></svg>
          </div>
          <span class="ft-label">显示</span>
          <button
            v-for="f in CARD_FIELDS"
            :key="f.key"
            class="chip chip-ft"
            :class="{ on: assets.cardFields[f.key] }"
            :title="`${assets.cardFields[f.key] ? '隐藏' : '显示'}${f.label}`"
            @click="assets.toggleCardField(f.key)"
          >
            {{ f.label }}
          </button>
        </div>
      </div>
    </div>

    <div
      ref="gridWrap"
      class="grid-wrap"
      :class="{ 'has-batchbar': assets.selectedCount > 0 }"
      @scroll="onScroll"
      @mousedown="onGridPointerDown"
      @contextmenu.prevent
    >
      <!-- 瀑布视图 -->
      <div v-if="view === 'masonry'" ref="masonryEl" class="masonry" :style="{ height: masonryHeight + 'px' }">
        <div
          v-for="p in placed"
          :key="p.it.id"
          class="card masonry-card"
          :data-id="p.it.id"
          :class="{
            selected: assets.isSelected(p.it.id) || bandHitSet.has(p.it.id),
            missing: p.it.missing,
            dragging: assets.dragIds.includes(p.it.id)
          }"
          :style="{ transform: `translate(${p.x}px, ${p.y}px)`, width: `${p.w}px`, height: `${p.h}px` }"
          @click="onCardClick(p.it, $event)"
          @contextmenu="onCardContext($event, p.it)"
        >
          <div class="thumb" :style="{ height: `${p.thumb}px` }">
            <img
              v-if="p.it.content_hash"
              class="thumb-img"
              :src="assets.thumbUrl(p.it.content_hash)"
              loading="lazy"
              draggable="false"
              @error="onImgErr(p.it, $event)"
              @load="onImgLoad(p.it, $event)"
            />
            <span v-if="!p.it.content_hash" class="thumb-fallback">{{ TYPE_ICON[p.it.type] }}</span>
            <span v-if="p.it.is_fav" class="fav" v-html="heart"></span>
            <span v-if="p.it.type === 'video' && p.it.duration_ms" class="video-len">{{ fmtDuration(p.it.duration_ms) }}</span>
          </div>
          <div v-if="assets.cardFields.name || metaText(p.it)" class="card-info">
            <div v-if="assets.cardFields.name" class="ci-name" :title="p.it.name" v-html="hlName(p.it.name)"></div>
            <div v-if="metaText(p.it)" class="ci-meta">{{ metaText(p.it) }}</div>
          </div>
        </div>

        <!-- 框选选框 -->
        <div
          v-if="band"
          class="marquee"
          :style="{
            left: band.x1 + 'px',
            top: band.y1 + 'px',
            width: band.x2 - band.x1 + 'px',
            height: band.y2 - band.y1 + 'px'
          }"
        ></div>
      </div>

      <!-- 列表视图 -->
      <div v-else class="list">
        <div
          v-for="it in assets.items"
          :key="it.id"
          class="list-row"
          :data-id="it.id"
          :class="{ selected: assets.isSelected(it.id), dragging: assets.dragIds.includes(it.id) }"
          @click="onCardClick(it, $event)"
          @contextmenu="onCardContext($event, it)"
        >
          <span class="list-icon">{{ TYPE_ICON[it.type] }}</span>
          <span class="list-name" :title="it.name" v-html="hlName(it.name)"></span>
          <span v-if="assets.cardFields.dims" class="list-dim">{{ dimsOnly(it) || '—' }}</span>
          <span v-if="assets.cardFields.size" class="list-size">{{ fmtSize(it.size) }}</span>
          <span v-if="assets.cardFields.time" class="list-date">{{ fmtDate(it.imported_at) }}</span>
        </div>
      </div>

      <div v-if="!assets.items.length && !assets.loading" class="empty">
        <template v-if="filtering">
          <p>没有匹配的素材</p>
          <p class="empty-sub">已应用 {{ assets.activeFilterCount }} 个筛选条件，试试放宽或清除</p>
          <button class="w-btn small" @click="clearAllFilters">清除筛选</button>
        </template>
        <template v-else>
          <p>暂无素材</p>
          <p class="empty-sub">点击上方「导入」添加文件</p>
        </template>
      </div>
      <div v-if="assets.loading" class="loading-tip">加载中…</div>
    </div>

    <!-- 底部悬浮条 -->
    <BatchBar @move="openMoveDialog" @remove="openDeleteDialog" />

    <!-- 拖动素材时的跟随浮层（Teleport 到 body，避免被画廊的滚动容器裁掉） -->
    <Teleport to="body">
      <div
        v-if="ghostPos && assets.dragIds.length"
        class="drag-ghost"
        :style="{ left: ghostPos.x + 'px', top: ghostPos.y + 'px' }"
      >
        <img v-if="ghostThumb" :src="ghostThumb" draggable="false" alt="" />
        <span class="dg-count">{{ assets.dragIds.length }} 项</span>
      </div>
    </Teleport>

    <!-- 工具栏芯片下拉（类型 / 评分 / 排序共用一个骨架） -->
    <Teleport to="body">
      <div
        v-if="chipMenu"
        class="chip-menu"
        :data-menu="chipMenu.key"
        :style="{ left: chipMenu.x + 'px', top: chipMenu.y + 'px' }"
        @contextmenu.prevent
      >
        <template v-if="chipMenu.key === 'type'">
          <button
            v-for="o in TYPE_OPTS"
            :key="o.label"
            class="chip-menu-item"
            :class="{ on: assets.query.type === o.value }"
            :data-type="o.value ?? 'all'"
            @click="setType(o.value)"
          >
            {{ o.label }}
          </button>
        </template>

        <template v-else-if="chipMenu.key === 'rating'">
          <button
            v-for="o in RATING_OPTS"
            :key="o.value"
            class="chip-menu-item"
            :class="{ on: assets.query.rating === o.value }"
            :data-rating="o.value"
            :title="o.label"
            @click="setRating(o.value)"
          >
            <span v-if="o.value === 0" class="cmi-text">不限</span>
            <template v-else>
              <span class="cmi-stars">
                <svg
                  v-for="n in 5"
                  :key="n"
                  class="cmi-star"
                  :class="{ off: n > o.value }"
                  viewBox="0 0 12 12"
                  :fill="n <= o.value ? 'currentColor' : 'none'"
                  :stroke="n <= o.value ? 'none' : 'currentColor'"
                  stroke-width="1"
                  stroke-linejoin="round"
                >
                  <path d="M6 1.4l1.4 2.9 3.2.5-2.3 2.2.5 3.2L6 8.7l-2.8 1.5.5-3.2L1.4 4.8l3.2-.5L6 1.4z" />
                </svg>
              </span>
              <span class="cmi-text">及以上</span>
            </template>
          </button>
        </template>

        <template v-else>
          <button
            v-for="o in SORT_OPTS"
            :key="o.value"
            class="chip-menu-item"
            :class="{ on: assets.query.sort === o.value }"
            :data-sort="o.value"
            @click="setSort(o.value)"
          >
            <span class="cmi-text">{{ o.label }}</span>
            <span v-if="assets.query.sort === o.value" class="cmi-dir">{{ assets.query.order === 'asc' ? '↑' : '↓' }}</span>
          </button>
        </template>
      </div>
    </Teleport>

    <!-- 右键菜单 -->
    <Teleport to="body">
      <div
        v-if="menu"
        class="ctx-menu"
        :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
        @contextmenu.prevent
      >
        <div class="ctx-head">
          {{ assets.selectedCount > 1 ? `已选 ${assets.selectedCount} 项` : '素材操作' }}
        </div>

        <div class="ctx-row">
          <span class="ctx-label">评分</span>
          <div class="ctx-stars" @mouseleave="menuHoverStar = 0">
            <svg
              v-for="n in 5"
              :key="n"
              class="ctx-star"
              :class="{ on: menuStarOn(n) }"
              viewBox="0 0 12 12"
              :fill="menuStarOn(n) ? 'currentColor' : 'none'"
              :stroke="menuStarOn(n) ? 'none' : 'currentColor'"
              stroke-width="1"
              stroke-linejoin="round"
              @mouseenter="menuHoverStar = n"
              @click="menuRate(n)"
            >
              <path d="M6 1.2l1.45 2.95 3.25.5-2.35 2.3.55 3.25L6 8.7 3.1 10.2l.55-3.25L1.3 4.65l3.25-.5L6 1.2z" />
            </svg>
            <span v-if="assets.selectedRatingMixed" class="ctx-mixed" title="选中项评分不一致">混合</span>
          </div>
        </div>

        <button class="ctx-item" @click="menuFav">
          <svg viewBox="0 0 13 13" :fill="assets.selectedAllFav ? 'currentColor' : 'none'">
            <path d="M6.5 10.8S1.8 8.2 1.8 4.9c0-1.5 1.2-2.7 2.6-2.7 1 0 1.7.6 2.1 1.2.4-.6 1.1-1.2 2.1-1.2 1.4 0 2.6 1.2 2.6 2.7 0 3.3-4.7 5.9-4.7 5.9z" stroke="currentColor" stroke-width="1.1" />
          </svg>
          {{ assets.selectedAllFav ? '取消喜欢' : '设为喜欢' }}
        </button>
        <button class="ctx-item" @click="openMoveDialog">
          <svg viewBox="0 0 13 13" fill="none">
            <path d="M1.6 4.2h9.8v6.2H1.6z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
            <path d="M1.6 4.2V2.6h3.1l1.1 1.6" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
          </svg>
          移动到…
        </button>

        <template v-if="!menuConfirm">
          <div class="ctx-sep"></div>
          <button class="ctx-item danger" @click="menuConfirm = true">
            <svg viewBox="0 0 13 13" fill="none">
              <path d="M2.4 3.6h8.2M5.1 3.6V2.4h2.8v1.2M3.4 3.6l.5 7h5.2l.5-7" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            删除
          </button>
        </template>
        <div v-else class="ctx-confirm">
          <p class="ctx-confirm-text">删除选中的 {{ assets.selectedCount }} 项？</p>
          <p class="ctx-confirm-sub">直接从磁盘删除，不可恢复</p>
          <button class="ctx-confirm-btn danger-strong" @click="confirmDelete">删除</button>
          <button class="ctx-confirm-btn" @click="menuConfirm = false">取消</button>
        </div>
      </div>
    </Teleport>

    <!-- 移动到… 弹窗 -->
    <Teleport to="body">
      <div v-if="moveOpen" class="modal-mask" @click.self="moveOpen = false">
        <div class="modal">
          <div class="modal-title">移动 {{ assets.selectedCount }} 项到</div>
          <div class="modal-body">
            <div
              v-for="f in moveRows"
              :key="f.id"
              class="move-row"
              :class="{ on: moveTarget === f.id }"
              @click="moveTarget = f.id"
            >
              <span class="move-indent" :style="{ width: f.indent * 13 + 'px' }"></span>
              <span class="move-icon" v-html="folderIcon"></span>
              <span class="move-name">{{ f.name }}</span>
            </div>
            <div v-if="!moveRows.length" class="move-empty">库内还没有文件夹</div>
          </div>
          <div class="modal-foot">
            <button class="w-btn" @click="moveOpen = false">取消</button>
            <button class="w-btn primary" :disabled="moveTarget == null" @click="confirmMove">移动到此处</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 删除确认弹窗 -->
    <Teleport to="body">
      <div v-if="deleteOpen" class="modal-mask" @click.self="deleteOpen = false">
        <div class="modal">
          <div class="modal-title">删除 {{ assets.selectedCount }} 项素材？</div>
          <div class="modal-body">
            <p class="modal-text">
              将从磁盘上<b>直接删除</b>文件与索引记录，<b>没有回收站，无法恢复</b>。
            </p>
          </div>
          <div class="modal-foot">
            <button class="w-btn" @click="deleteOpen = false">取消</button>
            <button class="w-btn danger-strong" @click="confirmDelete">删除</button>
          </div>
        </div>
      </div>
    </Teleport>
  </main>
</template>
