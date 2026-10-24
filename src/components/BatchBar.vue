<script setup lang="ts">
// 底部悬浮批量操作条：选中 ≥1 项时出现
// 只做「批量该做的事」——打标按需求不提供，标签仍在右侧详情里单个编辑
import { ref, watch, onBeforeUnmount } from 'vue'
import { useAssetStore } from '../stores/assets'

const assets = useAssetStore()
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
    if (!el) return
    hostEl = el.parentElement
    // 首帧同步量一次：变量在挂载这帧就位，避免「先 84、下一帧才 118」的闪跳
    applyHeight(el.getBoundingClientRect().height)
    ro = new ResizeObserver(() => applyHeight(el.getBoundingClientRect().height))
    ro.observe(el)
  },
  { flush: 'post' }
)

onBeforeUnmount(detach)

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

      <!-- 压缩：四角向内的「收拢」图标，和删除/移动区分得开 -->
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
