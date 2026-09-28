<script setup lang="ts">
import { useAssetStore } from '../stores/assets'

// 窗口是无边框的（main.ts frame:false），最小化/最大化/关闭全靠自绘 ——
// 所以这个组件必须在**每一个**顶层视图里出现，漏掉哪个视图，那个视图就没法关窗口。
withDefaults(defineProps<{ showDetail?: boolean }>(), { showDetail: false })

const assets = useAssetStore()

function minimize(): void {
  window.stash.win.minimize()
}
function toggleMaximize(): void {
  window.stash.win.toggleMaximize()
}
function close(): void {
  window.stash.win.close()
}
</script>

<template>
  <div class="win-controls">
    <!-- 四个按钮统一是 28×28 的方形按钮 + 16px 图标：
         早先「最小化/最大化/关闭」写的是文字字符 ─ □ ✕，字形在行盒里不居中、
         与左边的 SVG 图标基线也对不上，看着就是「几个图标不平行」。
         「收起侧栏」只在素材库视图有意义，欢迎页不传 showDetail -->
    <button
      v-if="showDetail"
      class="wc-btn"
      :title="assets.detailCollapsed ? '展开侧栏' : '收起侧栏'"
      :data-collapsed="assets.detailCollapsed ? '1' : '0'"
      data-wc="detail"
      @click="assets.toggleDetail()"
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
        <rect x="1.7" y="2.5" width="12.6" height="11" rx="2" />
        <path d="M10.6 2.5v11" />
        <!-- 收起时箭头朝右（往边缘收），展开时朝左 -->
        <path :d="assets.detailCollapsed ? 'M6.9 6.3L5.3 8l1.6 1.7' : 'M5.3 6.3L6.9 8l-1.6 1.7'" />
      </svg>
    </button>
    <button class="wc-btn" title="最小化" data-wc="min" @click="minimize">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
        <path d="M3.4 8h9.2" />
      </svg>
    </button>
    <button class="wc-btn" title="最大化" data-wc="max" @click="toggleMaximize">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">
        <rect x="3.4" y="3.4" width="9.2" height="9.2" rx="1.4" />
      </svg>
    </button>
    <button class="wc-btn close" title="关闭" data-wc="close" @click="close">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
        <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />
      </svg>
    </button>
  </div>
</template>
