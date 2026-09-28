<script setup lang="ts">
// 音频预览：原生 <audio> + 自绘控制条（与视频同一套组件）。
//
// 与视频同一套约定（见 PreviewVideo.vue）：不用 canPlayType 分支，
// 只在 `error` 且 code === 4（SRC_NOT_SUPPORTED）时给「用系统播放器打开」的出口；
// 需要派生（wma / ape 等）时先显示转码进度。
import { computed, ref, watch, type PropType } from 'vue'
import type { StashAssetRow } from '../../env'
import { useAssetStore } from '../../stores/assets'
import PreviewPlayerBar from './PreviewPlayerBar.vue'
import { usePreviewMedia } from './usePreviewMedia'

const props = defineProps({
  asset: { type: Object as PropType<StashAssetRow>, required: true },
  /** 右侧信息栏用：面板很窄，字形缩小、控制条压扁 */
  compact: { type: Boolean, default: false }
})

const assets = useAssetStore()
const { info, status, url, progress, error } = usePreviewMedia(computed(() => props.asset))

const audioEl = ref<HTMLAudioElement | null>(null)
const unsupported = ref(false)

watch(() => url.value, () => { unsupported.value = false })

function onError(): void {
  if ((audioEl.value?.error?.code ?? null) === 4) unsupported.value = true
}

/** 点空白区域 = 播放 / 暂停（控制条自己 `@click.stop`，不会误触发） */
function togglePlay(): void {
  const el = audioEl.value
  if (!el) return
  if (el.paused || el.ended) void el.play().catch(() => { /* 自动播放被拦等，忽略 */ })
  else el.pause()
}

async function openExternal(): Promise<void> {
  const r = await window.stash.shell.open(props.asset.id)
  if (!r.ok) assets.notify('error', `打开失败：${r.error}`)
  else if (r.data && !r.data.opened) assets.notify('error', `打开失败：${r.data.error ?? '未知原因'}`)
}
</script>

<template>
  <div class="pv-audio" :class="{ compact }">
    <div v-if="status === 'loading'" class="pv-wait"><span>加载中…</span></div>

    <div v-else-if="status === 'deriving'" class="pv-wait" data-pv-wait="deriving">
      <div class="pv-wait-bar"><i :style="{ width: Math.round(progress * 100) + '%' }"></i></div>
      <span>{{ info?.reason ?? '正在准备播放…' }}{{ Math.round(progress * 100) }}%</span>
    </div>

    <div v-else-if="status === 'unsupported'" class="pv-wait" data-pv-wait="unsupported">
      <span>{{ info?.reason ?? '该格式无法在软件内预览' }}</span>
      <button class="pv-btn" data-pv-open-external type="button" @click="openExternal">用系统播放器打开</button>
    </div>

    <div v-else-if="status === 'error'" class="pv-wait" data-pv-wait="error">
      <span>{{ error ?? '预览加载失败' }}</span>
    </div>

    <div v-else-if="unsupported" class="pv-wait" data-pv-wait="codec">
      <span>这个文件的编码浏览器解不了</span>
      <button class="pv-btn" data-pv-open-external type="button" @click="openExternal">用系统播放器打开</button>
    </div>

    <div v-else class="pv-audio-body" data-pv-audio-body @click="togglePlay">
      <div class="pv-audio-glyph" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
          <path d="M9 18V6l10-2v12" />
          <circle cx="6.5" cy="18" r="2.5" />
          <circle cx="16.5" cy="16" r="2.5" />
        </svg>
      </div>
      <div class="pv-audio-name" :title="asset.name">{{ asset.name }}</div>

      <!-- 音频没有画面，元素本身不需要占位 -->
      <audio
        ref="audioEl"
        class="pv-audio-el"
        :src="url ?? undefined"
        preload="metadata"
        data-pv-audio
        @error="onError"
      ></audio>
      <PreviewPlayerBar class="pv-bar-inline" :el="audioEl" :compact="compact" />
    </div>
  </div>
</template>
