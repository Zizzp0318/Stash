/**
 * 虚拟滚动的**纯算法层**：布局索引、区间二分、锚点恢复。
 *
 * 设计依据见 `docs/virtual-scroll-design.md` §4（作者：架构师）。三条必须先记住的前提：
 *
 * 1. **严格零 Vue / 零 DOM 依赖**：本文件只用 `Int32Array` / `Map` 与算术。
 *    好处有两条 —— 可被任何组件复用；能在主进程的冒烟里**脱离 DOM 直接断言**
 *    （`--smoke-vscroll` 的 T01 段就是这么验的）。
 * 2. **唯一不变量：`tops` 与 `maxBottoms` 均非递减。**
 *    瀑布装箱里第 i 条的 y 只取决于前 i 条的列高，`y_i = min(列高)` 而列高只增不减；
 *    列表视图是等差序列。`maxBottoms` 是前缀最大值，天然非递减。
 *    ⇒ 「可能与视口相交的条目」必然是一段**连续区间**，这才可能只用两个二分定位（见 `findRange`）。
 * 3. **不估算高度**：本模块不做「估算 → 渲染 → 实测 → 校正」那套回路。
 *    调用方（`GalleryGrid`）手里已有精确的卡片高度，`total` 就是精确总高。
 */

/**
 * 一份布局的几何真相（内容坐标系：原点 = 内容容器 `.masonry` / `.list` 的 border-box 左上角）。
 *
 * @template P 瀑布视图的每张卡片（x/w/h/thumb）；列表视图传 `unknown`（`placed` 为空数组）。
 */
export interface LayoutIndex<P = unknown> {
  /** 条目数 */
  n: number
  /** `tops[i]` = 第 i 条的 y（**非递减**） */
  tops: Int32Array
  /** `maxBottoms[i]` = `max_{j<=i}(tops[j] + h[j])`（**非递减**，前缀最大值） */
  maxBottoms: Int32Array
  /** 内容总高（瀑布 = 最长列底边；列表 = 上下内边距 + n×行高） */
  total: number
  /** 仅瀑布视图需要：卡片几何（渲染定位与框选命中都用它） */
  placed: P[]
  /** 素材 id → 下标；锚点恢复用（跨视图切换时 id 是唯一稳定的锚） */
  indexById: Map<number, number>
  /** 最长卡片高度（诊断 / 自检用） */
  maxCardH: number
  /** 生成这份索引时的列数（诊断用；列数变化必然导致重排） */
  cols: number
  /** 生成这份索引时的卡片宽度（同上） */
  cardW: number
  /** 列表视图的行高（瀑布视图为 0；`__vsDebug()` 的自检需要按条目算底边） */
  rowH: number
}

/** `buildIndex` 的入参 */
export interface IndexBuildInput<P = unknown> {
  /** 每条顶边（必须非递减） */
  tops: ArrayLike<number>
  /** 每条高度（与 tops 等长） */
  heights: ArrayLike<number>
  /** 每条对应的素材 id（与 tops 等长，按下标一一对应） */
  ids: ArrayLike<number>
  /** 内容总高；缺省 = `max(tops[i] + heights[i])`（瀑布就是这么算的） */
  total?: number
  /** 瀑布卡片的几何数据；列表视图不传 */
  placed?: P[]
  cols?: number
  cardW?: number
  /** 列表视图行高；瀑布视图不传（0） */
  rowH?: number
}

/**
 * 空索引（`n === 0`）。
 * 抽成常量而不是到处 `buildIndex({tops:[],...})`：空态与「容器宽度还没量出来」两种情形
 * 都会走到它，反复分配没有意义。调用方**绝不允许修改**它。
 */
export const EMPTY_INDEX: LayoutIndex<never> = Object.freeze({
  n: 0,
  tops: new Int32Array(0),
  maxBottoms: new Int32Array(0),
  total: 0,
  placed: [],
  indexById: new Map<number, number>(),
  maxCardH: 0,
  cols: 0,
  cardW: 0,
  rowH: 0
}) as LayoutIndex<never>

/**
 * 首个满足 `a[i] > v` 的下标；不存在时返回 `a.length`。
 *
 * 为什么不用 `Array.prototype.findIndex`：`tops` / `maxBottoms` 是 `Int32Array`，
 * 二分是 O(log N)，而 findIndex 每次 O(N) —— 滚动时每帧都要算一次窗口，不能是线性的。
 */
export function firstGreater(a: Int32Array, v: number): number {
  let lo = 0
  let hi = a.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (a[mid] > v) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** 首个满足 `a[i] >= v` 的下标；不存在时返回 `a.length`（上界二分） */
export function lowerBound(a: Int32Array, v: number): number {
  let lo = 0
  let hi = a.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (a[mid] >= v) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** 数值钳制（`min > max` 时以 `max` 为准，不抛错 —— 调用点都是像素→条数的换算） */
export function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min
  if (v < min) return min
  if (v > max) return max
  return v
}

/**
 * 缓冲（overscan）像素：上下各一屏，夹在 `[minPx, maxPx]`。
 *
 * 为什么用**像素**而不是「固定 N 条」：滚动时一帧内新增的可见区域最多一屏
 * （惯性峰值约 50 px/帧，而一屏 700+ px），一屏缓冲足以覆盖「窗口更新落后一帧」的最坏情况；
 * 而用像素才能在缩放（列宽 140→280）与列数变化时行为一致。最小 240px 保证小窗口也有缓冲。
 */
export function overscanPx(clientHeight: number, minPx = 240, maxPx = 1200): number {
  return clamp(Math.round(clientHeight), minPx, maxPx)
}

/**
 * 由 `tops` / `heights` 构造一份 `LayoutIndex`（`maxBottoms` 在这里算，调用方不要重算）。
 *
 * 只做一次 O(n) 扫描；瀑布视图的 `placed` 由调用方在**同一个装箱循环**里顺手填好传进来，
 * 所以整条链路不新增遍历（设计 §4.1 的「不新增遍历」要求）。
 */
export function buildIndex<P = unknown>(input: IndexBuildInput<P>): LayoutIndex<P> {
  const n = input.tops.length
  const tops = new Int32Array(n)
  const maxBottoms = new Int32Array(n)
  const indexById = new Map<number, number>()
  let maxBottom = 0
  let maxCardH = 0
  for (let i = 0; i < n; i++) {
    const t = input.tops[i]
    const h = input.heights[i]
    tops[i] = t
    const bottom = t + h
    if (bottom > maxBottom) maxBottom = bottom
    maxBottoms[i] = maxBottom
    if (h > maxCardH) maxCardH = h
    indexById.set(input.ids[i], i)
  }
  return {
    n,
    tops,
    maxBottoms,
    total: input.total ?? maxBottom,
    placed: input.placed ?? [],
    indexById,
    maxCardH,
    cols: input.cols ?? 0,
    cardW: input.cardW ?? 0,
    rowH: input.rowH ?? 0
  }
}

/**
 * 求「需要渲染的条目区间」`[start, end)` —— **精确**，不是保守近似。
 *
 * - 下界：`start = 首个 maxBottoms[i] > vpTop - overscan`。
 *   对任意 `j < start` 有 `maxBottoms[j] <= vpTop - overscan`，
 *   而第 j 条自己的底边 `<= maxBottoms[j]`，所以它一定在缓冲上沿之上 ⇒ 必不可见。
 * - 上界：`end = 首个 tops[i] >= vpBottom + overscan`。
 *   对任意 `j >= end` 有 `tops[j] >= vpBottom + overscan` ⇒ 顶边已在缓冲下沿之下 ⇒ 必不可见。
 *
 * 边界（T01 自检覆盖）：`n === 0` 返回 `[0,0)`；视口整体位于内容之上；
 * 视口整体位于内容之下（此时至少保留最后一条，避免「明明有数据却一屏空白」）；
 * 单张超长卡片把 `maxBottoms` 顶得很高（靠 `maxNodes` 预算兜底）。
 *
 * @param maxNodes 硬上限。超预算时先把缓冲收掉（只留「刚好可视」）；
 *                 仍然超预算只能全渲染 —— 但 `viewZoom ∈ [140,280]` + 4K 窗口下不会发生。
 */
export function findRange(
  idx: LayoutIndex<unknown>,
  vpTop: number,
  vpBottom: number,
  overscan: number,
  maxNodes: number
): [number, number] {
  const n = idx.n
  if (n <= 0) return [0, 0]

  let start = firstGreater(idx.maxBottoms, vpTop - overscan)
  let end = lowerBound(idx.tops, vpBottom + overscan)
  if (end < start) end = start

  // 视口已经落在内容底之外（scrollTop 被夹前的瞬态 / 内容刚刚变矮）：
  // 至少保留最后一条。否则会渲染 0 个节点 —— 用户看到的是「有数据却一屏空白」，
  // 比多渲染一个节点糟糕得多。这是防御性兜底，不是估算。
  if (start >= n) return [n - 1, n]

  if (maxNodes > 0 && end - start > maxNodes) {
    const s2 = firstGreater(idx.maxBottoms, vpTop)
    const e2 = lowerBound(idx.tops, vpBottom)
    if (e2 - s2 <= maxNodes) {
      start = s2
      end = e2
    }
    // 连「刚好可视」都超预算：保持原区间。硬裁掉可视条目会让屏幕上出现空洞，
    // 而这在 `MAX_RENDER_NODES = 400` + 正常缩放下不会发生（设计 §4.2 / R15）。
  }
  if (end < start) end = start
  return [start, end]
}

/** `anchorRestore` 的结果：`ok:false` 时 `reason` 区分「压根没有锚」与「锚已不在新结果里」 */
export type AnchorRestoreResult =
  | { ok: true; scrollTop: number }
  | { ok: false; reason: 'no-anchor' | 'gone' }

/**
 * 按「锚点条目 id + 它在视口内的偏移」反推出新的 `scrollTop`。
 *
 * 这是窗口化后**唯一**在两种视图之间都成立的重排恢复方式（设计 D6）：
 * 比例回写、列数变化、字段开关、视图切换全都会改变锚点之前的高度，
 * 只有「同一个 id 的顶边仍落在视口内同一个 y」能让用户眼前的画面保持不动。
 *
 * @param anchorId     锚点素材 id（视口内第一条）
 * @param anchorOffset 锚点卡片顶边在视口内的 y（`tops[i] - vpTop` 的旧值）
 * @param padTop       内容容器相对滚动内容原点的偏移（`.grid-wrap` 的内边距）
 */
export function anchorRestore(
  idx: LayoutIndex<unknown>,
  anchorId: number | null,
  anchorOffset: number,
  padTop: number
): AnchorRestoreResult {
  if (anchorId == null) return { ok: false, reason: 'no-anchor' }
  const i = idx.indexById.get(anchorId)
  if (i == null) return { ok: false, reason: 'gone' }
  const next = idx.tops[i] - anchorOffset + padTop
  return { ok: true, scrollTop: next > 0 ? next : 0 }
}
