# Stash · 虚拟滚动设计（瀑布 + 列表）

> 版本：设计定稿 v1（2026-10-25）｜对应代码：v0.1.6（`GalleryGrid.vue` 1577 行）
> 作者：架构师 高见远｜读者：实现工程师
> 冲突时以代码为准；本文档落地后，§0.2 的维护义务同样适用（见 §11）。

---

## 0. 一句话结论

**不做「估算高度 + 事后校正」那套虚拟滚动。** 本项目已经有全部几何数据：`placed` 是按列绝对定位算出来的，卡片高度由常量算出（`thumbW × ratio + infoH + 常量`），不依赖 DOM 测量。
所以正确的做法是：

> **布局仍然对「已加载的全部条目」算（纯算术，1 万条 ≈ 1–3 ms，且只在数据/尺寸变化时算）；
> 只把 DOM 渲染切成窗口（约 60–120 个节点）；
> `masonryHeight` 用布局算出来的精确值，不估算、不读 DOM。**

这样滚动条天然稳定、没有「估算 → 校正 → 跳动」的闭环，也就没有回滚错位问题。唯一会二次变化的只有「索引缺 width/height 时，靠 `<img>` 加载回写的比例」，它靠**锚点校正**兜住（§4.4）。

---

## 1. 现状拆解：到底慢在哪

| 事实（已核验） | 位置 | 结论 |
|---|---|---|
| `placed` 对 `assets.items` 全量装箱（最短列优先） | `GalleryGrid.vue:438` | 布局是 O(N) 算术，**不是瓶颈**（1 万条实测量级 1–3 ms） |
| 模板 `v-for="p in placed"` 渲染全部 | `GalleryGrid.vue:1175` | **真正的瓶颈**：DOM 节点 + 每个节点 8 个绑定 + `assets.isSelected()` 每卡一次 |
| 分页 `PAGE=200`，滚到距底 800px 追加 | `stores/assets.ts:8`、`GalleryGrid.vue:522` | 后端分页本身是对的，**不要动**；要动的是「已加载 = 已渲染」这个隐含前提 |
| 卡片高度 = `thumbH + infoH + INFO_BORDER + CARD_PAD*2 + CARD_BORDER*2` | `GalleryGrid.vue:449` | 高度**完全可算**，不必等 DOM —— 这是本设计成立的地基 |
| `ratioOf()` 索引优先，缺尺寸时用 `measuredRatio`（`onImgLoad` 回写） | `GalleryGrid.vue:378/491` | 唯一的二次变化源；缺尺寸属少数情况，但不能忽略 |
| 单一滚动容器 `.grid-wrap`，两视图共用 | `GalleryGrid.vue:1164` | 窗口逻辑必须**一份**，两视图共用（§4.5） |
| 框选命中直接对 `placed` 做矩形相交 | `GalleryGrid.vue:626` | **已经是几何命中**，这是优点，必须保住（§4.7） |

滚动到 3000 条时，现在约有 3000 个 `.card` 节点、3000 个 `<img>`、每次选中变化要重算 3000 次 `isSelected`。虚拟滚动把这三项全部变成与已加载条数无关。

---

## 2. 七个核心决策（附理由）

| # | 决策 | 为什么 |
|---|---|---|
| D1 | **布局全量算，DOM 窗口化** | 变量高度瀑布无法「跳过」前面条目的布局（第 i 条的 y 依赖前 i 条的列高），想省布局就得增量维护列高 + 支持任意位置校正，复杂度暴涨而收益只有几毫秒。全量算术是这里最简单也最快的方案 |
| D2 | **`masonryHeight` 用精确值，不用估算** | 估算要维护「估算 → 渲染 → 实测 → 修正 scrollTop」回路，是滚动条抖动的经典来源。我们有精确值，就不该引入估算 |
| D3 | **窗口区间用二分（前缀最大底边）** | 装箱保证 `y_i` 单调不减 → 上界二分；`maxBottom_i = max(maxBottom_{i-1}, y_i+h_i)` 也单调不减 → 下界二分。O(log N)，且**精确**（不是保守近似），见 §4.2 |
| D4 | **列表视图共用同一套窗口算法，只换「布局提供者」** | 两套窗口实现必然各偏一次（本项目历史上「导入两条路径各写一份」踩过）。列表只是 `tops[i] = 8 + i*34` 的特例 |
| D5 | **框选命中继续对「已加载数据」做几何判定，绝不改成只看已渲染 DOM** | 用户框选时框比一屏大是常态，必须能选中尚未渲染但已加载的卡片；几何判定还天生不受图片加载影响 |
| D6 | **重排一律按「锚点条目 id + 视口内偏移」恢复 scrollTop** | 窗口化后，任何一次重排（比例回写 / 列数变化 / 视图切换 / 字段开关）都可能改变当前条目之前的高度。按 id 锚定是唯一在两种视图之间都成立的锚 |
| D7 | **零新增依赖** | 需求本身只要两个二分 + 一次 O(N) 循环；引 `vue-virtual-scroller` 反而要改写成它的 `RecycleScroller` 数据接口，静态瀑布与二次测量都不被支持，且违背项目「依赖极简」（§3.3）与 §0.2 的依赖变更维护义务 |

**明确不做（本期）**：

- 数据层窗口化（卸载远离视口的 `items`）。理由：`items` 是选中集、详情栏、预览翻页、拖拽 ghost、`Ctrl+C` 的共同数据源，改成「分页窗口 + 未加载区」会连带动 `stores/assets.ts` 的 10 个函数与 6 套冒烟；而按 §3 的指标，DOM 才是当前的主要成本。内存另立指标（M5）与后续任务，见 §10 待明确 1。
- 框选时自动滚动（drag 到容器边缘继续滚）。
- 卡片进出的过渡动画（会与节点复用打架，且滚动时闪）。

---

## 3. 目标与验收指标（可测量）

窗口基线：`win.setContentSize(1280, 800)`、`viewZoom = 170`（默认值）、左栏 160px、详情栏展开，除非另行注明。
测试数据：`assets` 表直接插 10 000 行（`content_hash = NULL`、`width/height` 固定、`folder_id` 指向当前库的「未分类」），见 §8.1 —— 这样没有图片加载、高度完全确定，测的是滚动与布局本身。

| 编号 | 指标 | 阈值 | 怎么测（可在现有冒烟体系里做） |
|---|---|---|---|
| **M1** | 渲染的卡片 DOM 数 | 默认条件下 **≤ 120**；任意条件下 **≤ 400**（硬上限）；滚动 10 屏前后差值 **≤ 10%** | `document.querySelectorAll('.masonry-card').length` / `.list-row` 同理 |
| **M2** | 1 万条已加载、连续滚动 240 帧 | **p95 ≤ 33 ms**、平均 **≤ 16 ms**、单帧最长 **≤ 80 ms** | 页面内 rAF 采样帧间隔，见 §8.2 |
| **M3** | 进入 1 万条库首屏 | `library.open` resolve → 首个 `.masonry-card` 出现 **≤ 1500 ms**（并记录基线，后续不得比基线慢 20%） | `waitUntil("document.querySelector('.masonry-card')")` + `performance.now()` |
| **M4** | 滚动到底的加载行为 | 距已加载内容底 < 800px 时**恰好追加一页（200 条）**；`items.length === total` 后继续滚到底 5 秒，`scrollHeight` 不再增长、无重复 id | 见 §8.3 |
| **M5** | 内存不随已浏览条目线性膨胀 | 已加载 6000 条（无图）后：渲染进程 `private bytes` 增量 **≤ 40 MB**；DOM 数仍满足 M1 | `webContents.getProcessMemoryInfo()`（主进程侧） |
| **M6** | 视图切换一致性 | masonry → list → masonry 往返后**首个可见条目 id 不变**；`scrollHeight` 在 list 下按 34px/行精确可算 | 见 §8.4 |
| **M7** | `scrollHeight` 单调性 | 连续加载前 10 页，`scrollHeight` **严格不减**；最后一页允许收缩 **≤ 40px**（加载条收起） | 逐页读取 |
| **M8** | 布局不变量 | `tops` 与 `maxBottoms` 均**非递减**；`masonryHeight === max(y_i + h_i)` **误差 0**；窗口区间 `[start,end)` 覆盖全部与视口相交的条目 | 在冒烟里读 `window.__vsDebug`（见 §4.8） |

> 为什么不写「10 万条 < 16ms/帧」：那条验收从没被验证过，且「10 万条」需要 500 页、100 MB 级的夹具，在冒烟里不可复现。M1/M2 用的是**可复现的 1 万条**，并且是**能失败的**指标（改造前必定红）。

**注入验证**（§10.3 纪律 3 要求）：把 `placedWindow` 临时改成直接返回 `placed`（即关闭窗口化），M1 必须红（数量 ≈ 10000）、M2 必须红（p95 > 100ms）。

---

## 4. 数据结构与算法

### 4.1 布局索引 `LayoutIndex`（唯一的几何真相）

```ts
// 内容坐标：原点 = 内容容器（.masonry / .list）的 border-box 左上角
interface LayoutIndex {
  n: number                 // 条目数
  tops: Int32Array          // tops[i] = 第 i 条的 y（单调不减）
  maxBottoms: Int32Array    // maxBottoms[i] = max_{j<=i}(tops[j] + h[j])（单调不减）
  total: number             // = maxBottoms[n-1]（+ 列表视图的底部内边距），即内容总高
  placed: Placed[]          // 仅瀑布视图需要（x/w/h/thumb 供渲染与框选几何）
  indexById: Map<number, number>  // 素材 id → i，锚点恢复用
  maxCardH: number          // 最长卡片高度（诊断/自检用）
}
```

瀑布：在现有那个 `for (const it of assets.items)` 循环里顺手填数组（**不新增遍历**）。
列表：`tops[i] = LIST_PAD_TOP + i * LIST_ROW_H`、`maxBottoms` 同法，`total = LIST_PAD_TOP*2 + n*LIST_ROW_H`。

内存：1 万条 ≈ 2 × 40 KB 数组 + 1 万个小对象，可忽略。

### 4.2 窗口区间 `findRange`（精确，不是保守近似）

```ts
// firstGreater(a, v)  = 首个 a[i] >  v 的下标（不存在返回 n）
// lowerBound(a, v)    = 首个 a[i] >= v 的下标
function findRange(idx: LayoutIndex, vpTop: number, vpBottom: number,
                   overscan: number, maxNodes: number): [number, number] {
  // 下界：所有 j < start 的条目底边都 ≤ vpTop - overscan ⇒ 一定不可见
  let start = firstGreater(idx.maxBottoms, vpTop - overscan)
  // 上界：所有 j >= end 的条目顶边都 ≥ vpBottom + overscan ⇒ 一定不可见（tops 单调）
  let end = lowerBound(idx.tops, vpBottom + overscan)
  if (end < start) end = start
  // 预算兜底：极端情况（一张超长卡片把 maxBottoms 顶得很高）收缩到「刚好可视」
  if (end - start > maxNodes) {
    const s2 = firstGreater(idx.maxBottoms, vpTop)
    const e2 = lowerBound(idx.tops, vpBottom)
    if (e2 - s2 <= maxNodes) { start = s2; end = e2 }
    // 仍然超预算：说明一屏本身就要超过 maxNodes 个节点 —— 只能全渲染，
    // 但这在 viewZoom ∈ [140,280] + 4K 窗口下不可能发生（见 §3 M1 推导）
  }
  return [start, end]
}
```

**为什么这两个二分是精确的、够不着要「保守扩一屏」**：

- `y_i` 单调：`y_i = min(heights)`，而 `heights` 只增不减 ⇒ 最小值单调不减（`Math.round` 保序）。
- `maxBottoms` 是前缀最大值，天然单调。
- 于是「可能可见的条目」必然是**连续区间**（这是能只用两个二分的根本原因）。

**可见区坐标换算**（`padTop` 与滚动无关，缓存即可）：

```
vpTop  = scrollTop - padTop
vpBottom = vpTop + clientHeight
padTop = masonryRect.top - wrapRect.top + wrap.scrollTop   // 在 ResizeObserver 里测一次
```
（`.grid-wrap` 现为 `padding: 16px 7px 24px 16px`；`has-totop` / `has-batchbar` 只改 `padding-bottom`，不影响 `padTop`。列表视图的 `LIST_PAD_TOP = 8` 是 `.list` 自己的内边距，另算。）

### 4.3 缓冲（overscan）与预算

```
OVERSCAN = clamp(clientHeight, 240, 1200)   // 上下各一屏；最小 240 保证小窗口也有缓冲
MAX_NODES = 400                              // 硬上限
```
**为什么是「一屏」而不是「固定 N 条」**：滚动时新增的可见区域最多在 1 帧内移动 ~1 屏（惯性滚动峰值约 3000 px/s ≈ 50 px/帧，而一屏 700px），一屏缓冲足以覆盖「窗口更新落后一帧」的最坏情况。用像素而不是条数，才能在缩放（列宽 140→280）与列数变化时行为一致。

**为什么窗口在 scroll 事件里同步更新（不用 rAF 延后）**：Vue 的更新走微任务、在绘制前 flush，同步赋值 `scrollTopPx` 不会出现「先画空白再补」。rAF 延后反而会稳定地慢一帧，必须靠更大的 overscan 兜。读取 `el.scrollTop` 不是布局读取（不触发 reflow），成本可忽略。

### 4.4 二次测量（比例回写）与锚点校正 ★最容易写错的地方

现状：`onImgLoad` 在索引缺 `width/height` 时把实测比例写进 `measuredRatio`（`reactive(new Map())`），于是 `placed` 全量重算 → 上方的卡片高度变化 → **用户眼前的内容整体位移**（这就是「回滚错位」的来源）。

两处修改：

1. **合并重算**：`measuredRatio` 改成**普通 `Map`**（不参与响应式）+ 一个 `ratioRev = ref(0)`。写比例时不直接动响应式，而是丢进一个「本帧待刷新」集合，用 `requestAnimationFrame` 合并成**一次** `ratioRev++`。布局依赖 `ratioRev` 显式失效。
   - 为什么：一屏 60 张图几乎同帧加载完，逐个触发就是 60 次 × 1 万条重排 = 几百毫秒卡顿；合并后是 1 次。
2. **锚点校正**：布局变化后用「锚点条目 id + 卡片顶到视口顶的距离」反推新的 `scrollTop`：

```
// onScroll 里顺手维护（多一次 O(log N) 二分，可忽略）
visibleStart = firstGreater(maxBottoms, vpTop)
anchorId     = placed[visibleStart]?.it.id
anchorOffset = tops[visibleStart] - vpTop        // 卡片顶边在视口内的 y

// 布局变化后（flush: 'post'，此时 DOM 已是新高度，scrollTop 才不会被旧 scrollHeight 夹住）
if (newIdx.n === oldIdx.n && newIdx.total !== oldIdx.total) {   // 只处理「重排」，不处理「追加」
  const i = newIdx.indexById.get(anchorId)
  if (i != null) gridWrap.scrollTop = newIdx.tops[i] - anchorOffset + padTop
}
```

同一段逻辑同时覆盖：比例回写、**列数变化（窗口 resize）**、`cardFields` 开关（信息区高度变化）、**视图切换**（masonry ↔ list，因为锚是 id）。追加/删除条目（`n` 变化）**不做**校正 —— 追加发生在下方，不该动 scrollTop；删除/筛选由 §4.6 的重置策略负责。

> ⚠️ 必须在 `.grid-wrap` 上加 `overflow-anchor: none`。Chromium 的滚动锚定会和我们手写的校正叠加，出现「校正过头」的双倍位移。

### 4.5 列表视图：共用窗口，只换布局提供者

`.list` 是 `display:flex; flex-direction:column`，行高固定 34px、无 gap。窗口化用**上下两个占位块**，行本身仍走正常流：

```
<ListSpacerTop :h="tops[start]" />
rows: items[start .. end)
<ListSpacerBottom :h="total - (tops[end-1] + ROW_H)" />
```
- 好处：`.list-row` 的 flex 横排、hover、选中底色**一行 CSS 都不用改**，也没有坐标系变化的风险。
- `.list` 加 `position: relative`（给加载条定位用），对现有子元素无影响（当前没有绝对定位子节点）。
- 常量 `LIST_ROW_H = 34`、`LIST_PAD_TOP = 8` 必须与 `main.css` 的 `.list-row{height}` / `.list{padding}` 一一对应，并写注释说明（沿用 `INFO_NAME_H` 那套「常量必须与 CSS 一致」的既有纪律）。

### 4.6 分页与虚拟化共存

**触发点不用 DOM 高度猜**，直接读布局：

```
function maybeLoadMore(): void {
  if (assets.loading || assets.items.length >= assets.total) return
  const remaining = idx.total - (vpTop + clientHeight)   // 已加载内容底到视口底的距离
  if (remaining < LOAD_MORE_AHEAD /* 800 */) void assets.loadMore()
}
```
- 调用时机：`onScroll` 末尾；**每次布局变化后**（`flush:'post'` watcher）—— 后者是新增的关键：如果第一页就没填满视口（筛选后只剩 100 条，但 total 更大 / 窗口特别高），永远不会有 scroll 事件，`loadMore` 就永远不触发。这是现存缺陷，窗口化后必须一起修。
- `assets.loadMore()` 已有 `if (loading || items.length >= total) return` 的串行保护，保留；但**追加结果要按 id 去重**（已有 `seen` 集合），保留。
- **加载占位**：`.load-strip`（高度 26px，`display:flex` 居中，「加载中…」/「继续滚动加载」）**绝对定位在内容底**（`top: idx.total`），**不计入 `masonryHeight` / `total`**。
  - 为什么不计入：占位一旦进入布局，`scrollHeight` 会随「是否正在加载」变化，滚动条来回抖；而绝对定位的溢出只影响 `scrollHeight` 的瞬时值，且发生在用户视口**下方**，视觉上无位移。

### 4.7 坐标与交互

| 交互 | 结论 | 理由 |
|---|---|---|
| **框选命中** | **对已加载的 `LayoutIndex.placed` 做几何判定**（现状已是如此，继续） | 框比一屏大是常态；未渲染但已加载的条目必须能被选中。且几何判定不受图片加载/复用影响 |
| 框选候选集 | 用 `findRange(idx, rect.y1, rect.y2, 0, ∞)` 先取垂直候选区间，再逐个比 `x` | 否则每次 mousemove 都要遍历 1 万条（≈1–3ms/次 + GC）。二分让成本变成 O(log N + 命中数) |
| 框选坐标原点 | 不变：`.masonry` 内容区原点（`getBoundingClientRect` 相减） | 与卡片坐标系一致，绝对定位不受窗口影响 |
| **拖拽源** | 拖拽一定从**已渲染**卡片开始（mousedown 打在 DOM 上），无需额外约束；`.card.dragging` 的变暗只作用于已渲染节点（未渲染的看不见，无需处理） | 拖拽数据来自 `assets.dragIds`，与 DOM 无关，移动到未渲染区域也正常 |
| ghost 缩略图 | 不变（`assets.items.find`） | `items` 仍是全量已加载 |
| **右键菜单** | 不变：`Teleport to="body"` + `position: fixed`（用 `clientX/clientY` + 窗口边缘内收） | 与滚动容器无关，窗口化不影响锚点 |
| 各弹窗（移动/删除/重命名/压缩） | 不变 | 同上 |
| `Ctrl+C/V`、`Esc`、`hlName` 高亮 | 不变 | 依赖 `assets` 与 `assets.query`，与渲染子集无关 |
| 详情栏联动 / 选中态持久 | 不变 | `selectedIds` 是数据层，未渲染的选中项天然保持 |
| **回到顶部浮标** | 阈值 `scrollTop > 240` 不变；`syncTopBtn()` 的调用点保留（RO / 布局变化 / scroll） | 它读的是滚动容器，与窗口无关。注意 `has-totop` 只改 `padding-bottom`，不影响 `vpTop` |

**一个必须知道的取舍**：`assets.isSelected(id)` 现在是 `selectedIds.includes(id)`，每次渲染每卡一次。窗口化后调用次数降到 ~100/帧，但框选几千条时 `includes` 仍在 100×5000 量级。建议在 store 内部加 `const selectedSet = computed(() => new Set(selectedIds.value))`，`isSelected` 改查 Set（对外 API 与 `selectedIds` 类型不变）。这条是**可选优化**，放在 T02 里顺手做。

### 4.8 调试出口（供冒烟读，必须保留）

组件在 `onMounted` 里挂一个只读快照（仅开发/冒烟需要，随组件卸载删除）：

```
window.__vsDebug = () => ({
  n, total, start, end, rendered: end - start,
  vpTop, vpBottom, scrollTop, clientHeight, cols, cardW,
  anchorId, monotonic: tops 与 maxBottoms 是否非递减,
  maxDiff: |masonryHeight - max(y+h)|
})
```
M1/M6/M8 全部从它取数（比反复 querySelector 更稳、更快）。生产构建保留也无害（一个纯函数）。

---

## 5. 文件改动清单

| 文件（相对路径） | 动作 | 内容 |
|---|---|---|
| `src/utils/virtual.ts` | **新建** | 纯函数：`LayoutIndex` 类型、`firstGreater` / `lowerBound` / `buildIndexFromTops` / `findRange` / `anchorRestore`。**零 Vue 依赖**，可被任何组件复用 |
| `src/components/GalleryGrid.vue` | 改（主要工作量） | 布局索引化、窗口渲染、锚点校正、分页触发、框选候选区间、调试出口 |
| `src/assets/styles/main.css` | 改 | `.load-strip` 样式（固定 26px 高）、`.list{position:relative}`、`.grid-wrap{overflow-anchor:none}` |
| `src/stores/assets.ts` | 改 | `isSelected` 走 Set（可选优化）；`refresh({keepDepth})` 的 `limit` 钳到服务端上限 1000（见 R6） |
| `electron/services/smoke-vscroll.ts` | **新建** | `--smoke-vscroll`：M1–M8 全部断言 |
| `electron/main.ts` | 改 | 注册 `--smoke-vscroll` 分支（照抄现有 15 个入口的写法） |
| `electron/services/smoke-util.ts` | 改（可能） | 需要时补一个 `waitForFrames(js, n)` 小工具；不新增第二个 `waitUntil` |
| `开发文档.md` | 改 | §6「素材网格/列表」行、§9.2 缺口 1、§10.2 套件表、§11.2「无虚拟滚动」行 |

**不新建** `useVirtualGrid.ts` composable。理由：窗口化的状态与 `GalleryGrid` 的滚动容器、ResizeObserver、`placed`、`band`、`anchor` 深度耦合，抽 composable 会造出 7 个参数和一堆 `ref` 转发，收益是负的；而**纯算法**（二分、区间、锚点）抽到 `utils/virtual.ts` 收益是正的（可被将来的列表/标签页复用，且能脱 DOM 验证）。这是「抽什么」的边界。

---

## 6. 与现有代码的接缝点（精确到名字）

### 6.1 常量区（`GalleryGrid.vue` 276–287）

| 现在 | 改成 |
|---|---|
| `MASONRY_GAP / CARD_PAD / CARD_BORDER / INFO_*` | 保留不动 |
| — | 新增 `LIST_ROW_H = 34`、`LIST_PAD_TOP = 8`（注释写明必须与 `main.css` 一致） |
| — | 新增 `OVERSCAN_MIN/MAX = 240/1200`、`MAX_RENDER_NODES = 400`、`LOAD_MORE_AHEAD = 800`、`LOAD_STRIP_H = 26` |

### 6.2 响应式状态（289–303）

| 现在 | 改成 |
|---|---|
| `gridWrap` / `containerW` / `ro` | 保留；RO 里补 `viewportH = contentRect.height`、重测 `padTop`，并调用 `syncTopBtn()`（已有）与 `syncWindow()` |
| — | 新增 `scrollTopPx = ref(0)`、`padTop = ref(16)`、`viewportH = ref(0)` |

### 6.3 布局（438–457）★ 核心

| 现在 | 改成 |
|---|---|
| `const placed = computed<Placed[]>(...)` | `const layout = computed<LayoutIndex>(...)`：同一个循环，额外填 `tops` / `maxBottoms` / `total` / `indexById` / `maxCardH`；依赖里显式加 `ratioRev.value` |
| `const masonryHeight = computed(() => placed.reduce(...))` | `const masonryHeight = computed(() => layout.value.total)`（值完全等价，但不再二次遍历） |
| `ratioOf()` 读 `measuredRatio.get()` | 读普通 `Map`（同名变量改成非响应式 `const measuredRatio = new Map<string, number>()`） |
| `onImgLoad` 里 `measuredRatio.set(...)` | 改成 `queueRatio(key, ratio)`：本帧合并 + `ratioRev++` |

### 6.4 窗口（新增）

```
placedWindow  = computed(() => layout.value.placed.slice(start, end))
listWindow    = computed(() => assets.items.slice(start, end))
start/end     = computed(() => findRange(layout.value, vpTop, vpBottom, OVERSCAN, MAX_RENDER_NODES))
vpTop         = computed(() => scrollTopPx.value - padTop.value)
```
> ⚠️ 列表视图与瀑布**用同一个 `start/end`**，只是布局提供者不同（`layout` 在两视图下都是同一份 `LayoutIndex` 结构，切换视图时重建）。

### 6.5 滚动（519–538）

| 现在 | 改成 |
|---|---|
| `onScroll` 里 `assets.loadMore()`（DOM 高度判断） | `onScroll` 里：① `syncTopBtn(el)` ② `scrollTopPx.value = el.scrollTop` ③ 维护 `anchorId/anchorOffset` ④ `maybeLoadMore()`（布局判定） |
| `watch([view, () => assets.items.length], ...syncTopBtn)` | 保留 `syncTopBtn` 部分；视图切换另加「切换前记录锚点 → `nextTick` 后恢复」；布局变化统一交给 §6.6 的 post watcher |
| `TOP_BTN_AFTER = 240` | 不变 |

### 6.6 新增一个 `flush:'post'` watcher（锚点 + 填充检查 + 浮标）

```
watch([layout, scrollTopPx], ..., { flush: 'post' })
  → 若 layout.n 未变但 total 变了：按 anchorId 恢复 scrollTop（§4.4）
  → maybeLoadMore()（首屏填充检查）
  → syncTopBtn()
```

### 6.7 框选命中（621–629）

| 现在 | 改成 |
|---|---|
| `placed.value.filter(rect 相交)` | 先 `findRange(layout, rect.y1, rect.y2, 0, Infinity)` 取垂直候选，再在区间内按 `x` 过滤。**语义完全等价**，只是加了区间剪枝 |

### 6.8 模板

| 现在 | 改成 |
|---|---|
| `v-for="p in placed"`（1175） | `v-for="p in placedWindow"`，`:key="p.it.id"` **不变**（复用 DOM 是本设计的关键） |
| `:style="{ height: masonryHeight + 'px' }"`（1173） | 不变（现在是精确值） |
| `v-for="it in assets.items"`（1240） | `v-for="it in listWindow"` + 上下占位块 |
| `<div v-if="assets.loading" class="loading-tip">加载中…</div>`（1269） | 换成 `.load-strip`，绝对定位在内容底、不计入布局高度 |
| `.empty`（1258） | 不变（`items.length === 0` 时窗口为空，空态照旧） |

---

## 7. 风险清单与逐项对策

| 编号 | 风险 | 触发场景 | 对策 |
|---|---|---|---|
| **R1** | 滚动条抖动 | 比例回写改变总高 | 合并重算（一帧一次）+ 精确 `total` + 锚点校正（§4.4）。**绝不引入估算高度** |
| **R2** | 回滚错位 | 列数变化 / 视图切换 / 字段开关后当前条目跳到别处 | 统一按 `anchorId + anchorOffset` 恢复（D6） |
| **R3** | 快速滚动出现空白条 | 惯性滚动一帧位移 > 缓冲 | overscan ≥ 1 屏；窗口在 scroll 事件里同步更新（不用 rAF 延后） |
| **R4** | 框选漏选未渲染条目 | 只判定已渲染 DOM | 几何判定 + 二分剪枝（D5 / §4.7） |
| **R5** | 分页触发失效或连发 | 用 DOM 高度猜、首屏没填满 | 布局判定 + `loading` 串行 + 布局变化后复查（§4.6） |
| **R6** | `refresh({keepDepth:true})` 把深滚动弹回顶部 | 服务端 `limit` 上限 1000（`services/assets.ts:92`），而 `keepDepth` 传的是 `items.length`；滚到 3000 条时外部一改 → 静默截断到 1000 条 + scrollTop 被夹 | 这是个**现存 bug**，窗口化后会被频繁触发。对策：`keepDepth` 的 limit 钳到 ≤1000，并在 `refresh` 后按 `anchorId` 恢复；锚点不在新结果里就退回顶部 |
| **R7** | 新窗口「渲染数 ≠ 总数」破坏既有冒烟 | 见 §8 影响清单 | 见 §8 |
| **R8** | 加载条影响 `scrollHeight` | 占位进入布局 | 绝对定位 + 不计入 `total`（§4.6） |
| **R9** | 选中集合 O(n) | 框选几千条 | `selectedSet`（§4.7 末尾） |
| **R10** | 缩略图 404 风暴 | 大库首次打开 | 窗口化把并发从 N 降到 ~100，天然缓解；`thumbRetried` latch 语义**不许改**（`GalleryGrid.vue:376/412` 的两条「重新武装」逻辑） |
| **R11** | `hlName` 高亮失效 | 搜索命中但卡片未渲染 | 无需处理：高亮在渲染时计算（`v-html="hlName(...)"` 读 `assets.query.keyword` 是响应式的） |
| **R12** | 空态 / 首屏 | `items.length === 0`、`layout.n === 0` | `findRange` 返回 `[0,0)`，`:empty` 正常；`layout.n === 0` 时 `firstGreater` 必须安全返回 0（**边界用例要写进 T01 的自检**） |
| **R13** | 详情栏/预览翻页被窗口影响 | `stepPreview` 只在 `items` 内走 | 不受影响（`items` 仍是全量已加载）；但**不要**顺手改成「只翻已渲染」，那会让 ←/→ 走到窗口边界就停 |
| **R14** | `getBoundingClientRect` 在 scroll 里抖动 | 每帧读 rect | `padTop` 缓存（RO 里测一次），scroll 里只读 `el.scrollTop` |
| **R15** | 4K / 超宽窗口下节点超预算 | 列数可达 17 | `MAX_RENDER_NODES=400` 兜底：优先缩减缓冲，绝不裁掉可视条目（§4.2） |

---

## 8. 冒烟体系：新增套件 + 既有断言影响

### 8.1 新增 `--smoke-vscroll`（`electron/services/smoke-vscroll.ts`）

夹具（**关键：不落 1 万个真文件**）：

```
createLibrary('vscroll-lib') → 取「未分类」folder_id → 一个事务里
INSERT INTO assets (folder_id,name,rel_path,type,ext,size,width,height,content_hash,
                    rating,is_fav,file_mtime,imported_at)
       VALUES (?, ?, ?, 'image', 'png', 1024, 1600, 1200, NULL, 0, 0, ?, ?)
循环 10000 次；rel_path 唯一（v/00000.png …），imported_at 递增
```
- `content_hash = NULL` ⇒ 模板走 `thumb-fallback`（emoji），**不产生 `<img>`、不发 404、不触发 `thumb.ensure`**，测的是布局与滚动本身（也让 M5 的内存数字不被解码后的位图污染）。
- `width/height` 都有值 ⇒ `ratioOf` 走索引分支，**布局完全确定**，M8 可以断言「误差 0」。
- **必须在 `library.open` 之后再插**，插完 `location.reload()`（或 `assets.refresh()`）。不要在打开前插：开库的后台体检/对账可能把这些「索引有、磁盘无」的行标 `missing`（虽然不影响列表，但 `.card.missing` 会让截图和断言口径变脏）。
- 断言前先 `win.setContentSize(1280, 800)` + 把 `viewZoom` 打到 170（`settings:patch`），保证 M1 可复现。

### 8.2 帧率采样（M2，页面内 rAF）

```
await js(`(() => {
  const w = document.querySelector('.grid-wrap')
  const s = window.__vsProbe = { d: [], done: false }
  let last = performance.now(), n = 0
  const tick = (t) => {
    s.d.push(t - last); last = t
    w.scrollTop += 60                       // 每帧 60px ≈ 3.6 屏/秒的持续滚动
    if (++n < 240) requestAnimationFrame(tick); else s.done = true
  }
  requestAnimationFrame(tick)
})()`)
await waitUntil('window.__vsProbe.done', 30000)     // 返回值必须并入断言（§10.3 纪律 2）
// 主进程侧算 p95 / mean / max
```
`scrollTop += 60` 是**同步赋值**，页面的 Vue 更新在微任务里 flush，帧间隔里就包含了「窗口重算 + patch」，采到的正是我们要的数字。

### 8.3 分页断言（M4）

1. 首屏 `items.length === 200`、`assets.total === 10000`、`.masonry-card` 数满足 M1。
2. 反复 `scrollTop = scrollHeight`（每次等 `items.length` 变化，用 `waitUntil`，**不用固定 sleep**）直到 `items.length === 400`：断言恰好 +200、无重复 id。
3. 滚到底 5 秒后：`scrollHeight` 不再增长、`.load-strip` 不出现。
   —— 「不再发 IPC」这一点，优先在 `main.ts` 的 `wrap()` 里加一个只在 `isSmokeRun` 时生效的计数器（3 行），则断言可以直读 `asset:list` 调用次数；若工程师认为侵入过大，退化用上面的「高度不再增长」间接断言，并在报告里写明这是间接口径。

### 8.4 视图切换与重排（M6）

- `masonry → list → masonry`：每次切换后读 `__vsDebug().anchorId`，断言与切换前相同（允许 ±1 条，因为「首个可见」在两套布局里定义可能差 1 行）。
- `win.setContentSize(1000, 800)` 触发列数变化：断言 `anchorId` 不变、`cols` 变了、`scrollHeight` 变了。
- 把 `viewZoom` 从 170 打到 280：同上。

### 8.5 既有冒烟的影响清单（逐条，附「现在为什么能过」）

**先说结论：现有 15 套冒烟里的 DOM 断言，全部跑在 ≤ 42 条素材的小库上**（m4≈13、tag≈10、search=11、edit=12+30=42、folder≈15、preview≈12、meta≈10、compress≈12）。窗口在 1280×800 下渲染 60–120 条，**都大于这些库的总量**，所以「所有条目都渲染」这一前提在这些套件里依然成立 —— 唯一的硬要求是：**当 `items.length ≤ 窗口容量` 时必须全渲染**（这由 `findRange` 的语义自然满足，但 T04 要专门断言它）。

| 文件:行 | 现有写法 | 会不会红 | 口径处理 |
|---|---|---|---|
| `smoke4.ts:73` `cards()` | 全量 `.masonry-card` 的 rect 地图 | 否（13 项） | 保持；**不要**在这个函数上再加「等于 total」的断言 |
| `smoke4.ts:88` `elPoint(sel, idx)` + `scrollIntoView` | 按索引取第 index 个已渲染节点 | 否 | 保持 |
| `smoke4.ts:449` `h13_geom` | 批量条 / notice-toast 几何 | 否 | 与网格无关 |
| `smoke-search.ts:588` `gSe.cards` | 11 项名字集合 | 否 | 保持 |
| `smoke-edit.ts:140` 全量名字 | 12 项 | 否 | 保持 |
| `smoke-edit.ts:768` `scrollHeight - clientHeight > 300` | 依赖总高 | 否，但**变成关键契约** | 这条现在依赖「已渲染 = 总高」，窗口化后依赖「`total` 精确」。**必须保留**，它是 M8 的天然回归网 |
| `smoke-edit.ts:876` `.list-row` 计数 | 仅诊断字段，未并入断言 | 否 | 若将来并入断言，口径必须改成「≥ 可视行数」而不是「= 总数」 |
| `smoke-folder.ts:570/625/711` 全量卡片 id 映射 | J 段子树集合断言（15 项） | 否 | 保持。**注意**：同一文件 `1501 行` 有 `BIG_N=2000` 的压测，但那是主进程对账段、无 DOM 断言；若日后把 J 段挪到 2000 条库上跑，这条会立刻失效 |
| `smoke-preview.ts:478/484/521` | `.card` 全量顺序 + 角标遍历 | 否 | 保持（`wantType` 只对已渲染卡构造，天生窗口无关） |
| `smoke-tag.ts:477/595/638/677`、`smoke-meta.ts:543/562`、`smoke-compress.ts:346` | 按 `data-id` 取卡 | 否 —— **但依赖「目标条目在首屏窗口内」** | 这些 id 都是「刚导入的新素材」，而排序是 `imported_at desc` ⇒ 必在前几条。**如果将来新增「按 id 点很靠后的卡片」的断言，必须先 `scrollIntoView` 或先用文件夹/关键词把范围收进一屏** —— 这条要写进 §10.3 的测试纪律备注 |
| `smoke-*.ts` 里任何 `querySelectorAll('.masonry-card').length === N` | **既有 3 处**（`smoke-search.ts:284`、`smoke-search.ts:341`、`smoke-settings.ts:1228`），**待按 §10.3 纪律 4 改口径**（由 QA 统一处理） | 这 3 处目前都跑在「结果数 ≤ 窗口容量」的小库上（1 项 / 11 项 / 设置面板的小库），所以仍成立；但口径本身是错的。新增断言一律禁用此写法：要断「列表内容」请读 `assets.total` 或 `__vsDebug().n` / `dataTotal` |


**新增断言口径约定**（写进 §10 的纪律）：

> DOM 基数 ≠ 数据基数。断言「列表里有什么」用 `assets.total` / `__vsDebug()`；
> 断言「看得见什么」用 `.masonry-card` / `.list-row` 且**必须带上界**（M1）。

---

## 9. 任务分解（按依赖顺序，每条可独立验证）

> 只列改动点与验收；每个任务结束都要能 `npm run typecheck` 通过 + 跑通至少一套相关冒烟。

### T01 基座：纯窗口算法 + 样式常量 + 组件接缝（P0）

- **文件**：`src/utils/virtual.ts`（新建）、`src/assets/styles/main.css`（`.grid-wrap{overflow-anchor:none}`、`.load-strip`、`.list{position:relative}`）、`src/components/GalleryGrid.vue`（只加常量与 import，**不改变任何行为**）
- **内容**：`LayoutIndex` 类型；`firstGreater` / `lowerBound` / `buildIndexFromTops` / `findRange` / `anchorRestore`；`utils/virtual.ts` 顶部以内联注释写明「不变量：tops、maxBottoms 非递减」。
- **验收**：`findRange` 的边界用例（n=0、窗口在顶部之上、窗口在底部之下、单张超长卡片、`maxNodes` 兜底）在 `--smoke-vscroll` 里直接调用并断言（纯函数，不需要 DOM，先写这一批断言可让 T02 有安全网）。
- **依赖**：无。

### T02 瀑布窗口化 + 框选几何剪枝 + 选中集合优化（P0）

- **文件**：`GalleryGrid.vue`、`src/utils/virtual.ts`（如需微调）、`src/stores/assets.ts`（`selectedSet`）
- **内容**：`placed` → `layout`（含 `tops/maxBottoms/total/indexById`）、`masonryHeight` 取 `layout.total`、`placedWindow` + 模板 `v-for` 切换、`scrollTopPx/viewportH/padTop`、`onScroll` 重写、`maybeLoadMore`、`measuredRatio` 改普通 Map + `ratioRev` 合并、`flush:'post'` watcher（锚点 + 填充检查）、框选候选区间、`__vsDebug()`。
- **验收**：M1、M7、M8 通过；`--smoke-m4`、`--smoke-search`、`--smoke-edit` 全绿。人工检查：滚到 5000 条后拖动框选跨越整屏，能选中未渲染条目（`selectedCount` > 渲染数）。
- **依赖**：T01。

### T03 列表视图共用窗口 + 视图切换/重排锚点 + 加载占位（P0）

- **文件**：`GalleryGrid.vue`、`src/assets/styles/main.css`（占位块/加载条微调）、`src/stores/assets.ts`（`refresh({keepDepth})` 的 limit 钳到 1000 + 锚点兜底）
- **内容**：列表 `LayoutIndex`（`LIST_ROW_H/LIST_PAD_TOP`）、上下占位块、`listWindow`、视图切换锚点、resize/缩放锚点、（`query` 变化 → `scrollTop = 0`，显式）、`keepDepth` 截断修复。
- **验收**：M6 通过；`--smoke-edit` 的 U8 段（回到顶部浮标 + 列表视图）全绿；`--smoke-settings`（缩放滑块）全绿。
- **依赖**：T02。

### T04 新增 `--smoke-vscroll` 套件（P0）

- **文件**：`electron/services/smoke-vscroll.ts`（新建）、`electron/main.ts`（注册分支）、`electron/services/smoke-util.ts`（如需 `waitForFrames`）
- **内容**：夹具（1 万行直插）+ M1–M8 全部断言 + 帧率采样 + 收尾（`unwatchLibrary()` → `rmSync` → `win.destroy()` → `app.exit(0)`，照 §10.1 的退出链）。
- **验收**：`env -u ELECTRON_RUN_AS_NODE npx electron . --no-sandbox --disable-gpu --smoke-vscroll` 全绿；**做注入验证**：临时把 `placedWindow` 改回 `placed`，M1/M2 必须变红。
- **依赖**：T02、T03。

### T05 既有冒烟口径复核 + 文档同步（P1）

- **文件**：`开发文档.md`（§6 素材网格行、§9.2、§10.2、§11.2）、`electron/services/smoke-edit.ts` / `smoke-folder.ts`（按 §8.5 只在必要时改口径/加注释）、`README.md`（若提到"12 套冒烟"与性能限制）
- **内容**：按 §8.5 逐条复核；把「DOM 基数 ≠ 数据基数」写进 §10.3 纪律；把 M1–M8 的实测数字写进 §11.2（替换「10 万条 <16ms/帧 从未验证」那行）。
- **验收**：全 16 套冒烟一次性全绿（`npm run build` 之后）。
- **依赖**：T04。

**依赖图**：`T01 → T02 → T03 → T04 → T05`

---

## 10. 待明确事项与默认取舍（不阻塞，按默认执行）

1. **数据层窗口化（内存随已浏览条数增长）** —— 默认**本期不做**。已加载 `items` 仍随分页增长（1 万条 ≈ 8–12 MB 行对象 + 代理）。M5 只约束「DOM 恒定 + 增量 ≤ 40MB」。若后续要做，路径是：`items` 改成「分页槽位表 `Map<pageIndex, rows>` + `loadedRanges`」，并同步改选中集/详情/预览翻页/拖拽 4 处读取点 + 6 套冒烟 —— 属于独立迭代，不在本期。
2. **框选时自动滚动** —— 默认不做（现状也没有）。用户跨屏框选仍靠先滚动再框。
3. **已加载条数上限** —— 不设硬上限（否则「滚到底」语义被破坏）；M5 用内存指标兜。
4. **`refresh({keepDepth})` 的 1000 上限** —— 默认按 R6 修（钳 limit + 锚点兜底）。若工程师认为改动面偏大，**最低要求**是加一行注释 + 在文档 §11.2 记一条，不能让「外部改动后列表被截断」变成新 bug。
5. **首屏时间基线（M3）** —— 仓库里没有历史数据，先用 1500 ms 作上限，并在 T04 首次运行时把实测值记进文档，之后按「不慢于基线 20%」回归。
6. **`.load-strip` 的文案** —— 默认「加载中…」（与现有 `.loading-tip` 文案一致）；不引入「已全部加载」的尾部提示。
7. **`__vsDebug()` 是否保留到生产** —— 默认保留（纯函数、无副作用），因为它让冒烟断言稳定且不依赖 DOM 细节。
8. **窗口化粒度是否要按「列」对齐** —— 不需要。按条目索引切已经连续（§4.2 的单调性保证），按列对齐反而要处理「同一行不同列的条目索引不相邻」的问题。

---

## 11. 文档维护义务（§0.2 的落地清单）

本次改动必须**在同一个提交里**同步 `开发文档.md`：

| 章节 | 改什么 |
|---|---|
| §6「素材网格 / 列表」行 | 删掉「没有虚拟滚动」，改写为：布局全量算 / DOM 窗口化 / 精确 `masonryHeight` / 窗口区间二分 / `padTop` 与 `overflow-anchor:none` / 加载条绝对定位。/ 并把「`.grid-wrap` 是唯一滚动容器」这条前提保留加粗 |
| §6「回到顶部浮标」行 | 补充「阈值仍为 240px，与窗口化无关；`has-totop` 只改 `padding-bottom`，不影响 `vpTop`」 |
| §9.2 | 删除缺口 1（虚拟滚动），或改成「已实现，指标见 §11.2」 |
| §10.2 | 增加 `--smoke-vscroll` 一行（覆盖 M1–M8） |
| §10.3 | 增加第四条纪律：**DOM 基数 ≠ 数据基数** |
| §11.2 | 「无虚拟滚动」与「`GalleryGrid.vue` 1577 行」两行重写：给出 M1–M8 实测数字；文件行数会涨到 ~1900，写清新的一屏三责（布局 / 窗口 / 交互）与 `utils/virtual.ts` 的边界 |
