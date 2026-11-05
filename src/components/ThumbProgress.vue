<script setup lang="ts">
/**
 * 缩略图生成进度条（标题栏下方一条 2px + 右侧小字）。
 *
 * 为什么需要它：开库 / 导入后主进程会为缺失的缩略图排队生成（几千个素材要跑几十秒）。
 * 这件事**完全在后台**：界面能操作，但卡片是一块块灰的，用户看不出「在干活」还是「卡死了」。
 * 主进程（`services/thumbs.ts` 的 `settleBatch`）每 10 个就广播一次 `thumb:progress`，
 * 预加载层也早就暴露了 `thumb.onProgress` —— 渲染层一直没用上，这里补上。
 *
 * 为什么固定定位、不进文档流：.body 里的三块面板是 flex 排的，
 * 进度条只要参与布局，它出现 / 消失的瞬间就会把整个网格上下顶一下（用户看到界面自己抖）。
 * `position: fixed` + `pointer-events: none`：不挤内容，也**绝不抢走任何点击**。
 *
 * 位置推算（见 main.css）：`.titlebar` 高 36px，`.body` 上内边距 8px，面板内边距 10px ——
 * `top: 36px` 的 2px 细条正好压在「标题栏 ↔ 面板」那条 8px 缝的上沿，
 * 下方那枚小字（约 14px）落在面板自己的上内边距里，**盖不到任何文字**。
 */
import { computed } from 'vue'

const props = defineProps<{
  /** 已完成数（主进程广播的 done） */
  done: number
  /** 本批总数（主进程广播的 total） */
  total: number
}>()

/** 完成百分比（0–100）。total 为 0 时给 0，避免出现 NaN / Infinity 宽度 */
const percent = computed(() => {
  if (!Number.isFinite(props.total) || props.total <= 0) return 0
  const d = Number.isFinite(props.done) ? props.done : 0
  return Math.min(100, Math.max(0, (d / props.total) * 100))
})
</script>

<template>
  <!-- aria-* 给读屏用：这条进度纯视觉，语义上仍是一个 progressbar -->
  <div
    class="thumb-progress"
    role="progressbar"
    aria-label="生成缩略图"
    aria-valuemin="0"
    :aria-valuemax="total"
    :aria-valuenow="done"
  >
    <div class="tp-track">
      <div class="tp-fill" :style="{ width: percent + '%' }"></div>
    </div>
    <div class="tp-label">生成缩略图 {{ done }}/{{ total }}</div>
  </div>
</template>

<style scoped>
.thumb-progress {
  position: fixed;
  top: 36px; /* = .titlebar 的高度，压在面板上方那条 8px 缝里 */
  left: 0;
  right: 0;
  height: 2px;
  z-index: 50; /* 面板之上、各种菜单/弹窗遮罩（90+）之下 */
  pointer-events: none; /* 绝不能挡住点击 */
}

/* 轨道：进度条全长的那条底，用 --bg-media（比面板更暗，不抢眼） */
.tp-track {
  position: absolute;
  inset: 0;
  background: var(--bg-media);
  overflow: hidden;
}

/*
 * 填充：--accent（「进行中」用它，不用语义色）。
 * 宽度由 inline style 给，这里只负责过渡 —— 主进程每 10 个广播一次，
 * 不加过渡会一格一格地跳；transition 让它在两次广播之间平滑爬过去。
 */
.tp-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.18s linear;
}

/*
 * 小字贴在细条下沿（挂在面板的上内边距里，盖不到任何内容）。
 * 数字用 tabular-nums：否则 320/3000 → 999/3000 这类变化会让文字左右抖。
 */
.tp-label {
  position: absolute;
  top: 2px;
  right: 12px;
  padding: 1px 6px 2px;
  font-size: 10.5px;
  line-height: 13px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  background: var(--bg-app);
  border: 1px solid var(--border-soft);
  border-top: none;
  border-radius: 0 0 4px 4px;
}

/*
 * 淡出（由 App.vue 的 <Transition name="thumb-prog"> 触发）。
 * 完成后**不能瞬删**：一条进行中的东西「原地消失」会闪一下，200ms 淡出才不刺眼。
 */
.thumb-prog-leave-active {
  transition: opacity 0.2s ease;
}
.thumb-prog-leave-to {
  opacity: 0;
}
.thumb-prog-enter-active {
  transition: opacity 0.15s ease;
}
.thumb-prog-enter-from {
  opacity: 0;
}
</style>
