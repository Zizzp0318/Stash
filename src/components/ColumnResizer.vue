<script setup lang="ts">
/**
 * 左侧栏宽度拖拽条。
 *
 * 它盖在 `.body` 的 8px 缝隙上（绝对定位），**不参与 flex 排版** ——
 * 所以往 `.body` 里插它不会像加普通子元素那样多造出两条缝。
 *
 * 三个关键设计（都是踩过的坑，别随手改）：
 *
 * 1. **宽度不经过 Vue 响应式**。拖动中直接改 `.body` 上的 CSS 变量 `--sidebar-w`，
 *    由 `.sidebar { width: var(--sidebar-w, 198px) }` 吃掉。若改成 ref 驱动，
 *    每帧都会触发 App → SideBar / GalleryGrid / DetailPanel 整棵树 diff；
 *    而中栏本来就会因为容器变宽被 ResizeObserver 重排一次 —— 等于一帧干两遍重活。
 *
 * 2. **只在松手 / 松键时落盘**。主进程 `patchSettings` 是同步 `writeFileSync`，
 *    拖动中每帧 patch 一下就是几百次写盘 + 几百次 IPC。
 *
 * 3. **「意图宽度」与「生效宽度」分开**。
 *    `settings.settings.sidebarWidth` 存的是**用户意图**（拖动/键盘改出来的值），
 *    真正渲染的宽度是 `clamp(意图, MIN, maxForWindow())`。
 *    窗口缩小时生效宽度自动收窄（不会因为存了 420 就把中栏挤没）；
 *    窗口放大回来又自动恢复意图值（而不是把用户的 420 永久改写成窄窗口下的上限）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAssetStore } from '../stores/assets'
import {
  SIDEBAR_W_DEFAULT,
  SIDEBAR_W_MAX,
  SIDEBAR_W_MIN,
  useSettingsStore
} from '../stores/settings'

/**
 * 中栏（画廊）至少要保留的宽度。
 * 360 的依据：瀑布在默认缩放（170px 目标列宽）下是「两列 + 两条 12px 缝 + 左右 16px 内边距」
 * ≈ 2×170 + 12 + 32 = 384；360 是再不济也要留出「一列半」的下限 ——
 * 比这更窄，卡片会缩成一列且工具条上的筛选芯片全折成竖排，那个状态下拖侧栏就没意义了。
 */
const GALLERY_MIN_W = 360

/** 键盘步进：一下一格；按住 Shift 走大步 */
const KEY_STEP = 8
const KEY_STEP_LARGE = 32

const assets = useAssetStore()
const settings = useSettingsStore()

const railEl = ref<HTMLElement | null>(null)
/** 定位/测量的宿主：`.body`（本组件的父元素）。C 变量写在它身上，`.sidebar` 继承下去 */
const hostEl = ref<HTMLElement | null>(null)

/** 当前窗口下允许的左侧栏上限（不是常量 420 —— 还要给中栏留 360） */
const maxW = ref(SIDEBAR_W_MAX)

/** 用户意图宽度（持久化在 config.json） */
const intent = computed<number>(() => settings.settings.sidebarWidth)

/**
 * 实际生效宽度 = 意图宽度钳进 [MIN, 当前窗口上限]。
 * 窗口 resize 或详情栏收放导致 `maxW` 变化时，这个 computed 会自己收窄 / 恢复。
 */
const effective = computed<number>(() => clampW(intent.value))

/** 把任意数字钳成合法的渲染宽度 */
function clampW(n: number): number {
  if (!Number.isFinite(n)) return SIDEBAR_W_DEFAULT
  // 窗口极窄时可能出现 hi < MIN：此时以 MIN 为准，宁可挤中栏也不能把侧栏压成负数
  const hi = Math.max(SIDEBAR_W_MIN, maxW.value)
  return Math.min(Math.max(Math.round(n), SIDEBAR_W_MIN), hi)
}

/**
 * 当前窗口下左侧栏能占的最大宽度。
 *
 * 推导（全部按实际盒模型量，不写死窗口宽度）：
 *   可用宽 = `.body` 的 clientWidth（= 内容宽 + 左右 padding，本元素无边框/无滚动条）
 *          − 左右 padding                      ← `.body { padding: 8px }` → 8 + 8 = 16
 *          − 缝隙总宽（8px × 缝隙条数）        ← `.body { gap: 8px }`
 *            缝隙条数 = 参与 flex 的元素数 − 1，即「侧栏+中栏」1 条、再挂详情栏 2 条
 *            （拖拽条自己是 position:absolute，必须先排除，否则会多算一条缝）
 *          − 详情栏实际占位                    ← 直接量 `.detail` 的 offsetWidth（收起时元素都不存在 → 0）
 *          − 中栏要保留的最小宽 GALLERY_MIN_W
 *   左侧栏上限 = min(SIDEBAR_W_MAX, 上面剩下的)
 *
 * 代入验证：
 *   窗口 1280 / 详情栏展开：1280 − 16 − (8×2) − 238 − 360 = 650 → 取 420（上限才是瓶颈）
 *   窗口  962 / 详情栏展开： 962 − 16 − (8×2) − 238 − 360 = 332 → 上限 332（动态上限生效）
 *   窗口  962 / 详情栏收起： 962 − 16 − (8×1) −   0 − 360 = 578 → 取 420
 *   （窗口最小 960 —— 见 electron/main.ts 的 minWidth，所以侧栏永远拿不到 420 全宽也正常）
 */
function computeMaxW(): number {
  const host = hostEl.value
  if (!host) return SIDEBAR_W_MAX
  const cs = getComputedStyle(host)
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
  const gap = parseFloat(cs.columnGap) || 0
  // 只数参与 flex 排版的子元素：绝对定位的（就是本组件）和 display:none 的都不占位
  const items = Array.from(host.children).filter((el) => {
    const s = getComputedStyle(el)
    return s.position !== 'absolute' && s.display !== 'none'
  })
  const gaps = gap * Math.max(0, items.length - 1)
  let detailW = 0
  for (const el of items) {
    if (el.classList.contains('detail')) detailW = (el as HTMLElement).offsetWidth
  }
  const avail = host.clientWidth - padX - gaps - detailW
  return Math.min(SIDEBAR_W_MAX, avail - GALLERY_MIN_W)
}

/** 重新测量窗口上限（只在 resize / 详情栏收放时调用，不进拖动循环） */
function measure(): void {
  maxW.value = computeMaxW()
}

/**
 * 把宽度写进 DOM（唯一的热路径）。
 * 同时就地更新 aria-valuenow —— 拖动中不走响应式，否则每帧都会触发本组件重渲染。
 */
function paint(w: number): void {
  hostEl.value?.style.setProperty('--sidebar-w', `${w}px`)
  railEl.value?.setAttribute('aria-valuenow', String(w))
}

/** 落盘：值没变就不发 IPC（拖动没挪动、双击回默认值时经常命中） */
function commit(w: number): void {
  const v = clampW(w)
  if (v === settings.settings.sidebarWidth) return
  void settings.patch({ sidebarWidth: v })
}

// ==================== 指针拖动 ====================
let dragging = false
let dragPointerId = -1
let startX = 0
let startW = 0
/** 本帧待写入的宽度（rAF 合并用） */
let pendingW = 0
let rafId = 0

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return
  dragging = true
  dragPointerId = e.pointerId
  startX = e.clientX
  // 从**当前生效宽度**起算：窗口收窄过的话，起算点不是 config 里的意图值
  startW = effective.value
  pendingW = startW
  // 捕获指针：指针移出这 8px 缝隙（甚至移出窗口）也要继续收到 move / up
  railEl.value?.setPointerCapture?.(e.pointerId)
  // 全局 cursor + 禁止选中：不然拖到图片上会出现「禁止」光标，或者顺手选中侧栏里的文字
  document.body.classList.add('col-resizing')
  e.preventDefault()
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging || e.pointerId !== dragPointerId) return
  pendingW = clampW(startW + (e.clientX - startX))
  // rAF 合并：一帧内多个 pointermove 只写一次样式（写一次就会触发一次中栏重排，不能浪费）
  if (rafId) return
  rafId = requestAnimationFrame(() => {
    rafId = 0
    paint(pendingW)
  })
}

function endDrag(e: PointerEvent): void {
  if (!dragging || e.pointerId !== dragPointerId) return
  dragging = false
  dragPointerId = -1
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
  const rail = railEl.value
  if (rail?.hasPointerCapture?.(e.pointerId)) rail.releasePointerCapture(e.pointerId)
  document.body.classList.remove('col-resizing')
  // 收尾对齐到最终值（最后一帧可能还没刷出去），然后**只在这里**落一次盘。
  // 位置没动就不落盘：`pointerdown` + `pointerup` 而没有 `pointermove`（单纯点一下缝隙）
  // 会把 startW 原样写回去 —— 而 startW 是**生效宽度**，在窄窗口里它比意图宽度小
  // （例如意图 420、窗口只允许 332），照写就会把用户的 420 永久压成 332。
  paint(pendingW)
  if (pendingW !== startW) commit(pendingW)
}

// ==================== 键盘 ====================
/** 键盘连续按期间累积的宽度；松键才落盘（与拖动同理：不每下写盘） */
let keyW = SIDEBAR_W_DEFAULT
let keyDirty = false

function onKeyDown(e: KeyboardEvent): void {
  const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP
  let delta = 0
  if (e.key === 'ArrowLeft') delta = -step
  else if (e.key === 'ArrowRight') delta = step
  else return
  e.preventDefault()
  // 首次按下从"当前生效宽度"起算，后续按累积值走（否则长按会被下一次 computed 覆盖）
  const base = keyDirty ? keyW : effective.value
  keyW = clampW(base + delta)
  keyDirty = true
  paint(keyW)
}

function onKeyUp(e: KeyboardEvent): void {
  if (!keyDirty) return
  // 松 Shift 不算一次操作结束（用户常常是「按住 Shift 连按几下」再一起松）
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  keyDirty = false
  commit(keyW)
}

/** 焦点离开时补一次落盘：keyup 可能发生在元素失焦之后（被别处抢走焦点） */
function onBlur(): void {
  if (!keyDirty) return
  keyDirty = false
  commit(keyW)
}

// ==================== 双击恢复默认 ====================
function onDblClick(): void {
  // 走 clampW：理论上 minWidth 960 的窗口放得下 198，但不给"永远放得下"这种假设兜底
  const w = clampW(SIDEBAR_W_DEFAULT)
  paint(w)
  commit(w)
}

// ==================== 生命周期 ====================
let ro: ResizeObserver | null = null

onMounted(() => {
  hostEl.value = (railEl.value?.closest('.body') as HTMLElement | null) ?? null
  measure()
  paint(effective.value)

  // 窗口宽度变化（`.body` 撑满窗口，所以它变宽就等于窗口变宽）。
  // 用 ResizeObserver 而不是 window.onresize：缩放级别 / 侧栏自身宽度变化都能覆盖到，
  // 而且 `.body` 的宽度**不受侧栏宽度影响**（flex:1），不会形成「改宽度 → 重新测量 → 再改宽度」的回环。
  if (hostEl.value && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => measure())
    ro.observe(hostEl.value)
  }
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
  document.body.classList.remove('col-resizing')
})

/** 意图宽度变化（含设置从主进程异步读到、另一个窗口广播过来）→ 重新落值 */
watch(effective, (w) => paint(w))

/**
 * 详情栏收放会改变「缝隙条数」与详情栏占位 → 窗口上限要重算。
 * flush: 'post' 是必须的：默认 'pre' 时 `.detail` 还在 DOM 里，量到的还是旧值。
 */
watch(
  () => assets.detailCollapsed,
  () => measure(),
  { flush: 'post' }
)
</script>

<template>
  <div
    ref="railEl"
    class="col-resizer"
    role="separator"
    aria-orientation="vertical"
    aria-label="调整左侧栏宽度"
    :aria-valuemin="SIDEBAR_W_MIN"
    :aria-valuemax="Math.max(SIDEBAR_W_MIN, maxW)"
    :aria-valuenow="effective"
    tabindex="0"
    title="拖动调整左侧栏宽度（双击恢复默认，聚焦后可用 ←/→ 微调）"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="endDrag"
    @pointercancel="endDrag"
    @dblclick="onDblClick"
    @keydown="onKeyDown"
    @keyup="onKeyUp"
    @blur="onBlur"
  ></div>
</template>
