<script setup lang="ts">
// 播放控制条（视频 / 音频共用）—— **手写，不依赖播放器库**。
//
// 为什么不引库：媒体播放器库（media-chrome / Plyr / Vidstack）都只是套在原生
// `<video>` / `<audio>` 外面的控制层，**不改变解码能力**（能不能播由 Chromium 的解码器决定，
// 见 `preview.ts` 的说明）。但它们会把控件塞进 shadow DOM —— 想改个轨道颜色都得挖内部结构：
// 实测为了找一条「横贯整条的亮线」，最后靠 dump shadow DOM 才定位到 `#buffered`
// （本地文件瞬间缓冲完，那条 40% 白的指示器永远铺满整条）。
// 手写之后进度条、轨道、拇指全在自己手里，也不用背一个 283KB 的依赖。
//
// 边界：这里只做**控制**，不碰播放策略 —— 能不能播由主进程判定 + 原生 `error` 兜底。
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useIdleHide } from './useIdleHide'

const props = defineProps({
  /** 被控制的媒体元素（由父组件持有，src 也由父组件设） */
  el: { type: Object as () => HTMLMediaElement | null, default: null },
  /** 全屏按钮的目标元素；不给就不渲染全屏按钮 */
  fullscreenTarget: { type: Object as () => HTMLElement | null, default: null },
  /** 倍速按钮：在 1× / 1.5× / 2× 之间循环 */
  showRate: { type: Boolean, default: false },
  /** 自动隐藏（视频浮层用）：静止/离开画面就淡出，别长期挡住画面。音频那条在流内，不需要 */
  autoHide: { type: Boolean, default: false },
  /** 悬停判定区，一般传「画面」（舞台元素）；不给就退回本节点的父级 */
  hoverTarget: { type: Object as () => HTMLElement | null, default: null }
})

const playing = ref(false)
const current = ref(0)
const duration = ref(0)
const muted = ref(false)
const volume = ref(1)
const rate = ref(1)
const fullscreen = ref(false)
/** 正在拖进度条：此时不要被 timeupdate 拉回去，否则拇指会跟指针打架 */
const scrubbing = ref(false)

/* ---- 自动隐藏（只给视频浮层开）----
   规则与踩过的坑见 `useIdleHide.ts`。这里只补两条本组件专有的「绝不隐藏」：
   ① 拖进度条中（`scrubbing`）—— 拇指跟着指针跑，条没了就没法看进度；
   ② 指针正停在控制条上（`overBar`）—— 正要点播放键它自己没了最恼人。
   `overBar` 用 enter/leave 判决（这俩不冒泡，只会因为真的进出而变），不依赖 mousemove：
   指针在条上停着不动时也必须算「在用」。 */
const barEl = ref<HTMLElement | null>(null)
let overBar = false
const { shown, reveal, reschedule } = useIdleHide({
  enabled: () => props.autoHide,
  root: () => barEl.value,
  target: () => props.hoverTarget,
  hold: () => scrubbing.value || overBar
})

function onBarEnter(): void {
  overBar = true
  reveal()
}
function onBarLeave(): void {
  overBar = false
  reschedule()
}

function sync(): void {
  const el = props.el
  if (!el) return
  playing.value = !el.paused && !el.ended
  if (!scrubbing.value) current.value = el.currentTime || 0
  duration.value = Number.isFinite(el.duration) ? el.duration : 0
  muted.value = el.muted
  volume.value = el.volume
  rate.value = el.playbackRate
}

let detach: Array<() => void> = []
function attach(): void {
  for (const off of detach) off()
  detach = []
  const el = props.el
  if (!el) return
  const events = [
    'play', 'pause', 'ended', 'timeupdate', 'durationchange', 'loadedmetadata',
    'volumechange', 'ratechange', 'seeking', 'seeked', 'progress'
  ]
  for (const t of events) {
    const fn = (): void => sync()
    el.addEventListener(t, fn)
    detach.push(() => el.removeEventListener(t, fn))
  }
  sync()
}
watch(() => props.el, attach, { immediate: true })
onBeforeUnmount(() => {
  for (const off of detach) off()
  detach = []
  document.removeEventListener('fullscreenchange', onFsChange)
})

function togglePlay(): void {
  const el = props.el
  if (!el) return
  // 自动播放被拦、解码失败等都在这里吞掉：真正的失败由父组件的 error 事件兜底
  if (el.paused || el.ended) void el.play().catch(() => { /* ignore */ })
  else el.pause()
}

const pct = computed(() => (duration.value > 0 ? Math.min(100, (current.value / duration.value) * 100) : 0))

function seekTo(clientX: number, track: HTMLElement): void {
  const el = props.el
  if (!el || duration.value <= 0) return
  const r = track.getBoundingClientRect()
  if (r.width <= 0) return
  const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
  current.value = ratio * duration.value
  el.currentTime = current.value
}

/** 按下即定位，然后按住拖动持续定位（pointer capture，松手自动结束） */
function onTrackDown(e: PointerEvent): void {
  const track = e.currentTarget as HTMLElement
  scrubbing.value = true
  reveal()
  seekTo(e.clientX, track)
  // 先定位再尝试捕获指针：合成事件（自动化测试）没有活动指针，setPointerCapture 会抛，
  // 放在 seekTo 后面就不会把定位也一起带崩。
  try {
    track.setPointerCapture(e.pointerId)
  } catch { /* 合成事件没有活动指针，忽略 */ }
}
function onTrackMove(e: PointerEvent): void {
  if (!scrubbing.value) return
  seekTo(e.clientX, e.currentTarget as HTMLElement)
}
function onTrackUp(e: PointerEvent): void {
  if (!scrubbing.value) return
  scrubbing.value = false
  const track = e.currentTarget as HTMLElement
  if (track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId)
  sync()
  reschedule() // 松手后重新开始静止计时（拖拽期间是锁住的）
}

function toggleMute(): void {
  if (props.el) props.el.muted = !props.el.muted
}
function onVolumeInput(e: Event): void {
  const v = Number((e.target as HTMLInputElement).value)
  const el = props.el
  if (el) {
    el.volume = v
    // 拉到 0 顺带静音，往上拉则自动取消静音 —— 与系统播放器的手感一致
    el.muted = v === 0
  }
  volume.value = v
}

function cycleRate(): void {
  const next = rate.value < 1.25 ? 1.5 : rate.value < 1.75 ? 2 : 1
  if (props.el) props.el.playbackRate = next
  rate.value = next
}

function onFsChange(): void {
  fullscreen.value = document.fullscreenElement === props.fullscreenTarget
}
function toggleFullscreen(): void {
  const target = props.fullscreenTarget
  if (!target) return
  if (document.fullscreenElement === target) void document.exitFullscreen()
  else {
    document.addEventListener('fullscreenchange', onFsChange)
    void target.requestFullscreen().catch(() => { /* 用户拒绝 / 不支持，忽略 */ })
  }
}

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const s = Math.floor(sec % 60)
  const m = Math.floor(sec / 60) % 60
  const h = Math.floor(sec / 3600)
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return (h > 0 ? `${h}:` : '') + `${mm}:${String(s).padStart(2, '0')}`
}
</script>

<template>
  <!-- @click.stop：控制条浮在画面里（视频那条是绝对定位在舞台上的），
       不拦住冒泡的话，点播放键/进度条会顺带触发外层的「点画面播放/暂停」。 -->
  <div
    ref="barEl"
    class="pp-bar"
    data-pp-bar
    :class="{ 'is-hidden': !shown }"
    @click.stop
    @pointerenter="onBarEnter"
    @pointerleave="onBarLeave"
  >
    <button class="pp-btn" data-pp-play type="button" :title="playing ? '暂停' : '播放'" @click="togglePlay">
      <svg v-if="!playing" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M8 5.4v13.2L19 12z" />
      </svg>
      <svg v-else viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <rect x="7" y="5.4" width="3.6" height="13.2" rx="1" />
        <rect x="13.4" y="5.4" width="3.6" height="13.2" rx="1" />
      </svg>
    </button>

    <span class="pp-time" data-pp-current>{{ fmt(current) }}</span>

    <!-- 可点区域 14px 高（好点），可见轨道只有 4px（好看）—— Serpent 同款做法 -->
    <div
      class="pp-track"
      data-pp-track
      @pointerdown="onTrackDown"
      @pointermove="onTrackMove"
      @pointerup="onTrackUp"
      @pointercancel="onTrackUp"
    >
      <div class="pp-track-fill" :style="{ width: pct + '%' }"></div>
      <div class="pp-track-thumb" :style="{ left: pct + '%' }"></div>
    </div>

    <span class="pp-time" data-pp-duration>{{ fmt(duration) }}</span>

    <button v-if="showRate" class="pp-btn pp-rate" data-pp-rate type="button" title="播放速度" @click="cycleRate">
      {{ rate }}×
    </button>

    <button class="pp-btn" data-pp-mute type="button" :title="muted ? '取消静音' : '静音'" @click="toggleMute">
      <svg v-if="muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
        <path d="M11 5.5 6.8 9H3.5v6h3.3L11 18.5z" />
        <path d="M16 9.5l4 5M20 9.5l-4 5" />
      </svg>
      <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
        <path d="M11 5.5 6.8 9H3.5v6h3.3L11 18.5z" />
        <path d="M15.5 9.2a4 4 0 0 1 0 5.6M18 7a7.5 7.5 0 0 1 0 10" />
      </svg>
    </button>
    <input
      class="pp-volume"
      data-pp-volume
      type="range"
      min="0"
      max="1"
      step="0.01"
      :value="muted ? 0 : volume"
      title="音量"
      @input="onVolumeInput"
    />

    <button
      v-if="fullscreenTarget"
      class="pp-btn"
      data-pp-fullscreen
      type="button"
      :title="fullscreen ? '退出全屏' : '全屏'"
      @click="toggleFullscreen"
    >
      <svg v-if="fullscreen" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9 4.5v4.5H4.5M15 4.5v4.5H19.5M9 19.5V15H4.5M15 19.5V15H19.5" />
      </svg>
      <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4.5 9V4.5H9M19.5 9V4.5H15M4.5 15v4.5H9M19.5 15v4.5H15" />
      </svg>
    </button>
  </div>
</template>
