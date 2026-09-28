<script setup lang="ts">
// 视频预览：原生 <video> + 自绘控制条（浮在画面底部的胶囊）。
//
// 三条硬约束（都来自实测，别凭印象改）：
// ① **绝不用 canPlayType 做分支** —— 探针实测它对 hvc1 / quicktime 报「不支持」却真播成功、
//    对 matroska 报 maybe 也真播成功，完全不可信。能不能播只按扩展名白名单（主进程判）
//    + **真播失败后回退**。
// ② 回退靠 `error` 事件：只有 `MediaError.code === 4`（SRC_NOT_SUPPORTED）才认定
//    「这个容器/编码 Chromium 真解不了」，给出「用系统播放器打开」的出口。
// ③ 派生中（例如 avi 正在转码）先显示进度 —— 别让用户面对一块黑屏，那看起来就是卡死。
import { computed, ref, watch, type PropType } from 'vue'
import type { StashAssetRow } from '../../env'
import { useAssetStore } from '../../stores/assets'
import PreviewPlayerBar from './PreviewPlayerBar.vue'
import { usePreviewMedia } from './usePreviewMedia'

const props = defineProps({
  asset: { type: Object as PropType<StashAssetRow>, required: true },
  /** 右侧信息栏用：面板很窄，控制条压扁、去掉倍速与全屏 */
  compact: { type: Boolean, default: false }
})

const assets = useAssetStore()
const { info, status, url, progress, error } = usePreviewMedia(computed(() => props.asset))

const stageEl = ref<HTMLElement | null>(null)
const videoEl = ref<HTMLVideoElement | null>(null)
/** 真播失败（SRC_NOT_SUPPORTED）才置位，用来显示「用系统播放器打开」 */
const unsupported = ref(false)

// 换素材（换 url）时把失败态清掉，否则上一张的回退会留在新素材上
watch(() => url.value, () => { unsupported.value = false })

function onError(): void {
  if ((videoEl.value?.error?.code ?? null) === 4) unsupported.value = true
}

/**
 * 点画面任意处 = 播放 / 暂停（用户要求：不必非得点播放键）。
 * 控制条自己会 `@click.stop`，所以点播放键/进度条不会顺带触发这里。
 */
function togglePlay(): void {
  const el = videoEl.value
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
  <div class="pv-video" :class="{ compact }">
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

    <!-- 主进程判定「能直出/能派生」，但 Chromium 真播时仍然解不了：最后的回退出口 -->
    <div v-else-if="unsupported" class="pv-wait" data-pv-wait="codec">
      <span>这个文件的编码浏览器解不了</span>
      <button class="pv-btn" data-pv-open-external type="button" @click="openExternal">用系统播放器打开</button>
    </div>

    <div v-else ref="stageEl" class="pv-video-stage" data-pv-video-stage @click="togglePlay">
      <video
        ref="videoEl"
        class="pv-video-el"
        :src="url ?? undefined"
        playsinline
        preload="metadata"
        data-pv-video
        @error="onError"
      ></video>
      <!-- 全屏目标是整个舞台（连控制条一起进全屏），不是 <video> 本身 -->
      <PreviewPlayerBar
        class="pv-bar-floating"
        :el="videoEl"
        :fullscreen-target="compact ? null : stageEl"
        :show-rate="!compact"
        :compact="compact"
      />
    </div>
  </div>
</template>
