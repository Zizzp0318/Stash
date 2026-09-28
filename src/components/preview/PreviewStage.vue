<script setup lang="ts">
// 中栏放大预览浮层（用户拍板的「方案 A」）：
//   覆盖中栏、压暗网格；Esc / 点空白关闭；←/→ 在当前列表顺序里切换。
//
// 两条布局铁律：
// ① 它必须是 `.grid-wrap` 的**兄弟节点**（挂在 `.gallery` 上绝对定位）——
//    放进滚动容器会跟着内容滚走，也就盖不住网格了；
// ② 键盘用**捕获阶段**处理：GalleryGrid 自己也有全局 keydown（Esc 清空多选），
//    浮层开着时必须先把键吃掉，否则 Esc 会一层层落到网格上、把多选也一起清了。
//    ←/→ 只在非输入态生效：文本编辑器里方向键是移动光标，不能抢。
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useAssetStore } from '../../stores/assets'
import PreviewImage from './PreviewImage.vue'
import PreviewVideo from './PreviewVideo.vue'
import PreviewAudio from './PreviewAudio.vue'
import PreviewText from './PreviewText.vue'

const assets = useAssetStore()

/** 当前查看的素材行。只在已加载的 items 里找 —— 找不到（例如被删了）就当作已关闭 */
const row = computed(() => {
  const id = assets.previewId
  if (id == null) return null
  return assets.items.find((i) => i.id === id) ?? null
})

const KIND_LABEL: Record<string, string> = { image: '图片', video: '视频', audio: '音频', text: '文本' }

function indexOfCurrent(): number {
  const id = assets.previewId
  return assets.items.findIndex((i) => i.id === id)
}
const canPrev = computed(() => indexOfCurrent() > 0)
const canNext = computed(() => {
  const idx = indexOfCurrent()
  return idx >= 0 && idx < assets.items.length - 1
})

/** 关闭 / 切换前的「未保存」拦截。confirm 是原生的，同步、可靠（P4 的文本编辑器用得上） */
function guarded(action: () => void): void {
  if (assets.previewDirty && !window.confirm('文本有未保存的修改，确定放弃吗？')) return
  action()
}

function onKey(e: KeyboardEvent): void {
  const el = e.target as HTMLElement | null
  const typing = !!el?.closest?.('input, textarea, [contenteditable="true"]')
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    guarded(() => assets.closePreview())
    return
  }
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !typing) {
    e.preventDefault()
    e.stopPropagation()
    const delta = e.key === 'ArrowLeft' ? -1 : 1
    guarded(() => {
      assets.stepPreview(delta)
    })
  }
}
onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <div class="pv-wrap" data-pv-wrap @click.self="guarded(() => assets.closePreview())">
    <div class="pv-topbar">
      <span class="pv-kind">{{ row ? (KIND_LABEL[row.type] ?? row.type) : '' }}</span>
      <span class="pv-name" data-pv-name :title="row?.name">{{ row?.name }}</span>
      <span v-if="assets.previewDirty" class="pv-dirty">未保存</span>
      <button class="pv-close" data-pv-close type="button" title="关闭 (Esc)" @click="guarded(() => assets.closePreview())">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
          <path d="M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8" />
        </svg>
      </button>
    </div>

    <div class="pv-body" @click.self="guarded(() => assets.closePreview())">
      <button
        class="pv-side"
        data-pv-prev
        type="button"
        :disabled="!canPrev"
        title="上一张 (←)"
        @click="guarded(() => assets.stepPreview(-1))"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9.6 3.2L4.8 8l4.8 4.8" />
        </svg>
      </button>

      <!-- @click.stop：点在媒体上不算「点空白」，不能把浮层关掉 -->
      <div class="pv-main" @click.stop>
        <template v-if="row">
          <PreviewImage v-if="row.type === 'image'" :asset="row" />
          <PreviewVideo v-else-if="row.type === 'video'" :asset="row" />
          <PreviewAudio v-else-if="row.type === 'audio'" :asset="row" />
          <PreviewText v-else-if="row.type === 'text'" :asset="row" />
          <div v-else class="pv-wait">
            <span>{{ KIND_LABEL[row.type] ?? row.type }}暂不支持预览</span>
          </div>
        </template>
      </div>

      <button
        class="pv-side"
        data-pv-next
        type="button"
        :disabled="!canNext"
        title="下一张 (→)"
        @click="guarded(() => assets.stepPreview(1))"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6.4 3.2L11.2 8l-4.8 4.8" />
        </svg>
      </button>
    </div>
  </div>
</template>
