<script setup lang="ts">
// 图片放大预览：缩略图先垫底（LQIP）→ 大图加载完成后淡入替换 → panzoom 缩放平移。
//
// - **先垫缩略图**：派生大图（HEIC/TIFF 要现转）或超大原图可能要等一会儿，
//   先把已有的 800px `detail.webp` 放上去（模糊但有构图），大图 onload 后淡入替换，
//   不然用户面对的是一片黑。
// - **缩放平移用 @panzoom/panzoom**（~5KB、MIT）：滚轮缩放、拖拽平移、双击在「适配 / 1:1」间切。
//   刻意**不自己写 transform**：定位与缩放全交给它，避免和 contain 布局打架。
import { computed, onBeforeUnmount, ref, watch, type PropType } from 'vue'
import Panzoom from '@panzoom/panzoom'
import type { StashAssetRow } from '../../env'
import { useAssetStore } from '../../stores/assets'
import { usePreviewMedia } from './usePreviewMedia'

const props = defineProps({
  asset: { type: Object as PropType<StashAssetRow>, required: true }
})

const assets = useAssetStore()
const { info, status, url, progress, error } = usePreviewMedia(computed(() => props.asset))

const stage = ref<HTMLElement | null>(null)
const imgEl = ref<HTMLImageElement | null>(null)
const bigLoaded = ref(false)
let pz: ReturnType<typeof Panzoom> | null = null

/** 1:1 需要的缩放倍数：图片真实宽 ÷ 当前显示宽（每次现算，所以窗口缩放后也准） */
const fitScale = computed(() => {
  const el = imgEl.value
  if (!el || !el.naturalWidth) return 1
  return Math.max(1, el.naturalWidth / Math.max(1, el.clientWidth))
})

function destroyPz(): void {
  pz?.destroy()
  pz = null
}

function setupPz(): void {
  destroyPz()
  if (!stage.value) return
  pz = Panzoom(stage.value, {
    maxScale: 8,
    minScale: 1,
    step: 0.35,
    contain: 'outside',
    panOnlyWhenZoomed: true,
    cursor: 'grab'
  })
  // panzoom 文档要求 wheel 监听必须**非 passive**，否则 preventDefault 无效、页面会跟着滚
  stage.value.addEventListener('wheel', pz.zoomWithWheel, { passive: false })
}

watch(
  () => url.value,
  () => {
    bigLoaded.value = false
    // 等 <img> 挂载/换源之后再初始化：panzoom 要量元素尺寸，早了会量到 0
    requestAnimationFrame(() => setupPz())
  },
  { immediate: true }
)

function onBigLoad(ev: Event): void {
  bigLoaded.value = true
  ;(ev.target as HTMLImageElement).style.opacity = '1'
  requestAnimationFrame(() => setupPz())
}

/** 双击：适配 ↔ 1:1 */
function toggleZoom(): void {
  if (!pz) return
  if ((pz.getScale() ?? 1) > 1.02) pz.reset()
  else pz.zoom(fitScale.value, { animate: true })
}

onBeforeUnmount(destroyPz)
</script>

<template>
  <div class="pv-image">
    <div v-if="status === 'deriving'" class="pv-wait" data-pv-wait="deriving">
      <div class="pv-wait-bar"><i :style="{ width: Math.round(progress * 100) + '%' }"></i></div>
      <span>正在生成高清预览…{{ Math.round(progress * 100) }}%</span>
    </div>

    <div v-else-if="status === 'unsupported'" class="pv-wait" data-pv-wait="unsupported">
      <span>{{ info?.reason ?? '该格式无法在软件内预览' }}</span>
    </div>

    <div v-else-if="status === 'error'" class="pv-wait" data-pv-wait="error">
      <span>{{ error ?? '预览加载失败' }}</span>
    </div>

    <!-- 缩略图垫底：大图 onload 之前一直显示（大图挂上后把 opacity 置 1 盖上来） -->
    <img
      v-if="status === 'ready' && asset.content_hash && !bigLoaded"
      class="pv-thumb"
      :src="assets.thumbUrl(asset.content_hash, 'detail')"
      alt=""
      draggable="false"
    />

    <div v-show="status === 'ready'" ref="stage" class="pv-stage" data-pv-stage @dblclick="toggleZoom">
      <img
        v-if="url"
        ref="imgEl"
        class="pv-img"
        :src="url"
        alt=""
        draggable="false"
        :style="{ opacity: bigLoaded ? '1' : '0' }"
        @load="onBigLoad"
      />
    </div>

    <div v-if="status === 'ready'" class="pv-hint">滚轮缩放 · 拖拽平移 · 双击 1:1</div>
  </div>
</template>
