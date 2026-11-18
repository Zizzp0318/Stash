<script setup lang="ts">
/**
 * 开库加载浮层（`lib.booting` 期间盖在中栏上）。
 *
 * 2026-11 第二版：用户否掉了第一版的「三栏骨架屏」——要的是**中栏虚化 + 中间一条悬浮加载条**。
 * 这版就是按这个做的，并且保留第一版用血换来的四条硬约束：
 *
 *   1. **只盖中栏**（`.gallery-wrap` 内 `inset: 0`），标题栏与左右栏都露在外面：
 *      标题栏能拖/能最小化 —— 用户判断「卡死」的第一依据就是窗口拖不动。
 *   2. **`pointer-events: none`**（卡片上的按钮除外）：浮层不吃事件，数据一到撤掉时背后
 *      已经是真实内容，不卸载、不重排、不跳动。
 *   3. **不依赖进场动画获得可见性**：第一版用 `<Transition>` 的 `enter-from{opacity:0}`，
 *      窗口在后台时 rAF 不推进 → DOM 全绿、`opacity` 恒为 0、屏幕上什么都没有。
 *      这里整层的可见性**只由 `v-if` 与静态样式决定**；只有「不确定进度」那条小滑块用动画
 *      —— 它不动也只是不好看，不会让整个浮层消失。
 *   4. **进度不编**：有 `thumb:progress` 就用 `done/total` 画确定进度；没有就是不确定态。
 *      超过 `bootStuckAfterMs`（默认 8s）给「先浏览」出口，后台继续补。
 */
import { computed } from 'vue'

const props = defineProps<{
  stage: 'index' | 'meta' | 'grid'
  /** 缩略图生成进度（有就画确定进度条，没有就画不确定态的滑块） */
  thumb: { done: number; total: number } | null
  /** 超过阈值还没好：给「先浏览」出口 */
  stuck: boolean
}>()

const emit = defineEmits<{ skip: [] }>()

const label = computed(() => {
  if (props.stage === 'index') return '正在打开素材库…'
  if (props.stage === 'meta') return '正在读取索引…'
  if (props.thumb && props.thumb.total > 0) return `正在准备缩略图 ${props.thumb.done}/${props.thumb.total}`
  return '正在准备首屏…'
})

/** 有真实数字才画确定进度；否则 `null` = 不确定态（滑块动画） */
const ratio = computed<number | null>(() => {
  const t = props.thumb
  if (!t || !Number.isFinite(t.total) || t.total <= 0) return null
  return Math.max(0, Math.min(1, t.done / t.total))
})

const hint = computed(() => (props.stuck ? '打开较慢，可以先浏览，缩略图会在后台补齐' : ''))
</script>

<template>
  <!-- data-boot-layer 是冒烟的锚点：断言「出现了 / 只盖中栏 / 虚化生效 / 不吃事件 / 到点收掉」 -->
  <div class="boot-veil" data-boot-layer>
    <div class="boot-card" role="status" aria-live="polite" data-boot-pill>
      <div class="boot-row">
        <span class="boot-dot" aria-hidden="true"></span>
        <span class="boot-label" data-boot-label>{{ label }}</span>
      </div>

      <!-- 进度：确定态给宽度；不确定态给一条来回滑的滑块（动画被节流也只是不动，不会隐形） -->
      <div class="boot-track" :class="{ 'boot-track--indeterminate': ratio === null }">
        <div
          class="boot-fill"
          :style="ratio === null ? undefined : { width: `${Math.round(ratio * 100)}%` }"
          :data-boot-ratio="ratio === null ? 'indeterminate' : String(ratio)"
        ></div>
      </div>

      <div v-if="hint" class="boot-hint" data-boot-hint>{{ hint }}</div>
      <button v-if="stuck" class="boot-skip" type="button" data-boot-skip @click="emit('skip')">先浏览</button>
    </div>
  </div>
</template>

<style scoped>
/*
 * 虚化层：只覆盖中栏（父容器 `.gallery-wrap` 是 position:relative）。
 * ⚠️ 可见性**不依赖任何动画** —— 见 App.vue 里那段注释（第一版在这上面翻过车）。
 */
.boot-veil {
  position: absolute;
  inset: 0;
  z-index: 30; /* 在中栏内容之上、导入浮层(100)之下 */
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none; /* 不吃事件：背后三栏照常可交互 */

  /*
   * 虚化：backdrop-filter 把背后的内容糊掉，再压一层半透明底色（浅色/深色各自取自己的画布色）。
   * 不用 filter: blur —— 那会把浮层自己（含文字）一起糊掉。
   */
  backdrop-filter: blur(10px) saturate(1.05);
  background: color-mix(in srgb, var(--bg-canvas) 62%, transparent);
}

/* 卡片：唯一吃事件的区域（「先浏览」按钮要能点） */
.boot-card {
  pointer-events: auto;
  min-width: 260px;
  max-width: min(420px, 80%);
  padding: 16px 18px;
  border-radius: 12px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  box-shadow: 0 10px 30px rgb(0 0 0 / 28%);
}

.boot-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.boot-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  flex: none;
}

.boot-label {
  color: var(--text-1);
  font-size: 13px;
  line-height: 1.4;
}

/* 轨道：细条，不做成「百分比数字」那种压迫感 */
.boot-track {
  position: relative;
  height: 4px;
  border-radius: 999px;
  background: var(--bg-input);
  overflow: hidden;
}

.boot-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width 0.2s ease-out;
}

/* 不确定态：一条 35% 宽的滑块来回走（transform 动画，不参与布局） */
.boot-track--indeterminate .boot-fill {
  width: 35%;
  animation: boot-slide 1.1s ease-in-out infinite;
}

@keyframes boot-slide {
  0% {
    transform: translateX(-40%);
  }
  100% {
    transform: translateX(300%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .boot-track--indeterminate .boot-fill {
    animation: none;
    width: 100%;
    opacity: 0.45;
  }
}

.boot-hint {
  margin-top: 10px;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.5;
}

.boot-skip {
  margin-top: 10px;
  height: 24px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-input);
  color: var(--text-1);
  font-size: 12px;
  cursor: pointer;
}

.boot-skip:hover {
  background: var(--bg-hover);
}
</style>
