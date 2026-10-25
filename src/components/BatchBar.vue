<script setup lang="ts">
// 底部悬浮批量操作条：选中 ≥1 项时出现
// 只做「批量该做的事」——评分 / 喜欢 / 标签 / 压缩 / 移动 / 删除
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useAssetStore } from '../stores/assets'
import { useLibraryStore } from '../stores/library'

const assets = useAssetStore()
const lib = useLibraryStore()
const emit = defineEmits<{ (e: 'move'): void; (e: 'remove'): void; (e: 'compress'): void }>()

// 悬停时预览评分（不影响已选中的公共评分）
const hoverStar = ref(0)

/**
 * 单行高度（border-box，含 1px 边框与 7px 上下内边距）——
 * 必须与 `main.css` 里 `.batchbar` 的 `min-height` 保持一致；
 * 两个数一旦分叉，`--bb-extra` 就会在单行时算成非 0，底部留白整体漂移。
 */
const BB_SINGLE_H = 44

/**
 * 底部让位的实测来源。
 *
 * 背景：条子是 `flex-wrap` 的，窄窗会从单行（44）折成两行（78），
 * 而 `.grid-wrap` 的 `padding-bottom` 与 `.to-top` 的 `bottom` 都得跟着变，
 * 否则最后一行卡片会被条子压住、浮标会跟条子撞在一起。
 *
 * 旧实现用媒体查询按「内容宽 615 + 面板宽」硬推了一个换行点（1107px）。
 * 那是双重魔法数字：`@media (max-width:1200px)` 会把 `.bb-div` 隐掉，内容宽降到 596.8，
 * 真实换行点变成 ≈1089 —— 于是 1089~1107 这 18px 区间里「条子已是单行，留白却按两行给」，
 * 多出 34px 空白、浮标也偏高 34px；而文案一变长（「已选 12345 项」），换行点又整体挪走。
 *
 * 现在改成**量出多少算多少**：实测条高减去单行高度就是「多出来的那一截」，
 * 写进 CSS 变量 `--bb-extra`，`main.css` 里用 `calc()` 叠到 84 / 74 上。
 * 观察的是条子自己，改的是 `.grid-wrap` 的内边距 —— 条子是绝对定位、宽高都由内容决定，
 * 不受内边距影响，所以这个环不会自激。
 */
const barEl = ref<HTMLElement | null>(null)
/** CSS 变量挂在 `.batchbar` 的父节点（`.gallery`）上：它是 `.grid-wrap` 与 `.to-top` 的共同祖先 */
let hostEl: HTMLElement | null = null
let ro: ResizeObserver | null = null
/** 上次写进变量的值（px）。-1 表示「还没写过」，保证首次一定会写一遍 */
let lastExtra = -1

const setExtra = (extra: number): void => {
  if (extra === lastExtra) return
  lastExtra = extra
  hostEl?.style.setProperty('--bb-extra', `${extra}px`)
}

const applyHeight = (height: number): void => {
  // 先取整再相减：单行 44 必须稳稳落成 0，不能因为亚像素（43.99 / 44.01）变成 ±1，
  // 否则默认窗口的 padding-bottom 会从 84 漂成 83 或 85。
  setExtra(Math.max(0, Math.round(height) - BB_SINGLE_H))
}

const detach = (): void => {
  ro?.disconnect()
  ro = null
  // 条子撤了就把变量收回 0：留着上一轮的 34 会让「没量到」的那一帧凭空多让 34px
  hostEl?.style.setProperty('--bb-extra', '0px')
  hostEl = null
  lastExtra = -1
}

// 条子由内层 v-if 控制（选中数 > 0 才挂），所以要盯模板 ref 的出现/消失，不能只靠 onMounted
watch(
  barEl,
  (el) => {
    detach()
    // 条子撤了（取消选择 / 选中数归零）→ 标签浮层一并收起，别留一个悬空的操作面板
    if (!el) return closeTagPanel()
    hostEl = el.parentElement
    // 首帧同步量一次：变量在挂载这帧就位，避免「先 84、下一帧才 118」的闪跳
    applyHeight(el.getBoundingClientRect().height)
    ro = new ResizeObserver(() => applyHeight(el.getBoundingClientRect().height))
    ro.observe(el)
  },
  { flush: 'post' }
)

// ==================== 批量打标（标签浮层）====================
/**
 * 浮层贴条子（准确说是贴「标签」按钮）上方浮起，**必须 `position:absolute`、不进文档流**：
 * 条子的高度由 ResizeObserver 实测成 `--bb-extra` 驱动网格底部让位，
 * 浮层若参与 flex 布局会把条子撑高，让位量跟着整体漂移。
 * 这与详情页 `tag-menu` 是同一条约束（见开发文档 §6 标签 chips 行）。
 */
const tagPanelOpen = ref(false)
const tagQuery = ref('')
/** `.bb-tags` 容器：按钮 + 浮层，用来判定「点到浮层外面了」 */
const tagBoxEl = ref<HTMLElement | null>(null)
/**
 * `tagId → 选中项里挂了它的个数`。
 *
 * 打开浮层时实测一次（列表行不带 tags，见 store 的 `selectedTagCounts`），
 * 之后每次挂/摘只在本地维护这一个数，不必反复拉全部详情。
 */
const selTagCounts = ref<Record<number, number>>({})

/** 浮层列出的标签 = **全部**已有标签（后端 `tag:list` 已按名字排序），按输入做名字包含过滤 */
const tagRows = computed(() => {
  const q = tagQuery.value.trim().toLowerCase()
  return q ? lib.tags.filter((t) => t.name.toLowerCase().includes(q)) : lib.tags
})

const tagPanelHint = computed(() =>
  tagQuery.value.trim() ? `回车新建「${tagQuery.value.trim()}」并挂到选中项` : '还没有标签，输入名称回车新建'
)

/** 某标签在选中集合里的三态：全挂 / 部分挂 / 都没挂（决定点击是摘还是挂、以及行尾标记） */
function tagState(tagId: number): 'all' | 'some' | 'none' {
  const n = selTagCounts.value[tagId] ?? 0
  if (n <= 0) return 'none'
  return n >= assets.selectedCount ? 'all' : 'some'
}

function tagRowTitle(t: { id: number; name: string }): string {
  const s = tagState(t.id)
  if (s === 'all') return `从所有选中项上摘除「${t.name}」`
  if (s === 'some') return `部分选中项已挂「${t.name}」，点击挂到全部`
  return `把「${t.name}」挂到所有选中项`
}

function closeTagPanel(): void {
  tagPanelOpen.value = false
  tagQuery.value = ''
}

/** 点浮层外面就收起：用 document 的 mousedown，而不是靠输入框 blur 兜 */
const onDocMouseDown = (e: MouseEvent): void => {
  const el = tagBoxEl.value
  if (el && !el.contains(e.target as Node)) closeTagPanel()
}

/**
 * Esc 走**捕获阶段**并 `stopPropagation`：GalleryGrid 在 window 上挂了一份全局 keydown
 * （Esc = 取消多选）。浮层开着时按 Esc 只该收浮层，不该把整批选中一起清掉
 * —— 与 SettingsPanel / PreviewStage 同一套处理方式。
 */
const onEscCapture = (e: KeyboardEvent): void => {
  if (e.key !== 'Escape' || !tagPanelOpen.value) return
  e.stopPropagation()
  closeTagPanel()
}

window.addEventListener('keydown', onEscCapture, true)

// 浮层开着时才挂「点外面收起」的监听，收起即摘，避免常驻一个 document 级监听
watch(tagPanelOpen, (open) => {
  if (open) document.addEventListener('mousedown', onDocMouseDown, true)
  else document.removeEventListener('mousedown', onDocMouseDown, true)
})

/** 开/关浮层。打开时实测一次「每个标签挂了几个选中项」，用于三态显示 */
async function toggleTagPanel(): Promise<void> {
  if (tagPanelOpen.value) {
    closeTagPanel()
    return
  }
  tagPanelOpen.value = true
  tagQuery.value = ''
  selTagCounts.value = await assets.selectedTagCounts()
}

/** 点标签行：全挂 → 从所有选中项摘掉；其余（部分挂 / 没挂）→ 挂到全部 */
async function toggleTag(tagId: number): Promise<void> {
  const mode = tagState(tagId) === 'all' ? 'detach' : 'attach'
  const ok = await assets.bulkTag(tagId, mode)
  if (!ok) return
  selTagCounts.value = { ...selTagCounts.value, [tagId]: mode === 'attach' ? assets.selectedCount : 0 }
}

/**
 * 输入框回车：重名就用已有的，否则先新建，然后挂到所有选中项。
 * 顺序与详情页 `addTag` 一致（先查本地标签列表，减少一次注定失败的 IPC），
 * 重名最终由服务层兜底报 `ERR_TAG_EXISTS`（`createTag` 与 `renameTag` 同一条约定）。
 *
 * ⚠️ 刻意**不做** `@blur` 自动提交（详情页单张编辑是 blur 即保存）：
 * 多选场景下一失焦就把半截查询词建成标签并批量挂到几十项上，代价太大。
 */
async function createAndAttach(): Promise<void> {
  const name = tagQuery.value.trim()
  if (!name) return
  const existing = lib.tags.find((t) => t.name === name)
  let tagId = existing ? existing.id : null
  if (tagId == null) {
    const r = await window.stash.tag.create({ name })
    if (!r.ok || r.data?.id == null) {
      assets.notify(
        'error',
        r.error === 'ERR_TAG_EXISTS' ? `标签「${name}」已存在` : `新建标签失败：${r.error ?? '未知错误'}`
      )
      return
    }
    tagId = r.data.id
    // 新标签先进侧栏与浮层列表（此刻计数 0）；挂上之后 bulkTag 会再刷一次计数
    await lib.loadMeta()
  }
  tagQuery.value = ''
  const ok = await assets.bulkTag(tagId, 'attach')
  if (ok) selTagCounts.value = { ...selTagCounts.value, [tagId]: assets.selectedCount }
}

onBeforeUnmount(() => {
  detach()
  document.removeEventListener('mousedown', onDocMouseDown, true)
  window.removeEventListener('keydown', onEscCapture, true)
})

/**
 * 星标是否点亮：悬停预览优先，未悬停时用选中项的公共评分（0 = 全部未评分）。
 * 关态必须同时给出 stroke，否则 `fill: none` + 无描边 = 整颗星不可见，
 * 表现就是「只有鼠标移上去才看得见」。
 */
const starOn = (n: number): boolean => n <= (hoverStar.value || assets.selectedRating)
</script>

<template>
  <Transition name="raise">
    <div v-if="assets.selectedCount > 0" ref="barEl" class="batchbar">
      <span class="bb-count">已选 <b>{{ assets.selectedCount }}</b> 项</span>
      <span class="bb-div"></span>

      <div class="bb-rate">
        <span class="bb-mini">评分</span>
        <svg
          v-for="n in 5"
          :key="n"
          class="bb-star"
          :class="{ on: starOn(n) }"
          viewBox="0 0 12 12"
          :fill="starOn(n) ? 'currentColor' : 'none'"
          :stroke="starOn(n) ? 'none' : 'currentColor'"
          stroke-width="1"
          stroke-linejoin="round"
          :title="`设为 ${n} 星`"
          @mouseenter="hoverStar = n"
          @mouseleave="hoverStar = 0"
          @click="assets.bulkRate(assets.selectedRating === n ? 0 : n)"
        >
          <path d="M6 1.2l1.45 2.95 3.25.5-2.35 2.3.55 3.25L6 8.7 3.1 10.2l.55-3.25L1.3 4.65l3.25-.5L6 1.2z" />
        </svg>
        <span v-if="assets.selectedRatingMixed" class="bb-mixed" title="选中项评分不一致">混合</span>
      </div>

      <button class="bb-btn" :class="{ on: assets.selectedAllFav }" @click="assets.bulkFav(!assets.selectedAllFav)">
        <svg viewBox="0 0 13 13" :fill="assets.selectedAllFav ? 'currentColor' : 'none'">
          <path d="M6.5 10.8S1.8 8.2 1.8 4.9c0-1.5 1.2-2.7 2.6-2.7 1 0 1.7.6 2.1 1.2.4-.6 1.1-1.2 2.1-1.2 1.4 0 2.6 1.2 2.6 2.7 0 3.3-4.7 5.9-4.7 5.9z" stroke="currentColor" stroke-width="1.1" />
        </svg>
        {{ assets.selectedAllFav ? '取消喜欢' : '喜欢' }}
      </button>

      <!--
        标签：批量挂 / 摘。按钮 + 浮层同包在 .bb-tags 里（position:relative 的定位锚点）。
        浮层绝对定位、不进文档流，所以条子高度不受它影响（--bb-extra 不会跟着漂）。
        ⚠️ 按钮排在「喜欢」之后：--smoke-m4 用 `.bb-btn` 的索引 0 点「喜欢」，插到前面会让它点错按钮。
      -->
      <div ref="tagBoxEl" class="bb-tags">
        <button class="bb-btn" :class="{ on: tagPanelOpen }" data-bb-tags @click="toggleTagPanel">
          <svg viewBox="0 0 13 13" fill="none">
            <path d="M1.9 2.2h4.3l4.6 4.6-4.3 4.3-4.6-4.6V2.2z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
            <circle cx="4.5" cy="4.5" r="0.95" fill="currentColor" />
          </svg>
          标签
        </button>

        <div v-if="tagPanelOpen" class="bb-tag-panel" data-bb-tag-panel>
          <div class="bb-tag-input-row">
            <input
              v-model="tagQuery"
              data-bb-tag-input
              placeholder="搜索或新建标签…"
              spellcheck="false"
              @keyup.enter="createAndAttach"
            />
          </div>
          <div class="bb-tag-list">
            <span v-if="!tagRows.length" class="tag-menu-empty" data-bb-tag-empty>{{ tagPanelHint }}</span>
            <button
              v-for="t in tagRows"
              :key="t.id"
              class="tag-menu-item"
              :data-bb-tag-option-id="t.id"
              :title="tagRowTitle(t)"
              @mousedown.prevent
              @click="toggleTag(t.id)"
            >
              <span class="tag-dot" :style="{ background: t.color }"></span>
              <span class="tag-menu-name">{{ t.name }}</span>
              <!-- 三态标记：✓ 全部选中项都挂了；— 只有部分挂了；无标记 = 都没挂 -->
              <span class="bb-tag-state" :class="tagState(t.id)">
                <svg v-if="tagState(t.id) === 'all'" viewBox="0 0 12 12" fill="none">
                  <path d="M2.2 6.4l2.5 2.5 5.1-5.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <svg v-else-if="tagState(t.id) === 'some'" viewBox="0 0 12 12" fill="none">
                  <path d="M2.6 6h6.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                </svg>
              </span>
              <span class="tag-menu-count">{{ lib.tagCount(t.id) }}</span>
            </button>
          </div>
          <div class="bb-tag-foot">点标签行即挂/摘；✓ 已挂在全部选中项上</div>
        </div>
      </div>

      <button class="bb-btn" data-bb-compress @click="emit('compress')">
        <svg viewBox="0 0 13 13" fill="none">
          <path
            d="M3.2 5.4V3.2h2.2M7.6 3.2h2.2v2.2M9.8 7.6v2.2H7.6M5.4 9.8H3.2V7.6"
            stroke="currentColor"
            stroke-width="1.1"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        压缩
      </button>

      <button class="bb-btn" @click="emit('move')">
        <svg viewBox="0 0 13 13" fill="none">
          <path d="M1.6 4.2h9.8v6.2H1.6z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
          <path d="M1.6 4.2V2.6h3.1l1.1 1.6" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
        </svg>
        移动
      </button>

      <button class="bb-btn danger" @click="emit('remove')">
        <svg viewBox="0 0 13 13" fill="none">
          <path d="M2.4 3.6h8.2M5.1 3.6V2.4h2.8v1.2M3.4 3.6l.5 7h5.2l.5-7" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        删除
      </button>

      <span class="bb-div"></span>
      <button class="bb-btn ghost" @click="assets.clearSelection()">取消选择</button>
    </div>
  </Transition>
</template>
