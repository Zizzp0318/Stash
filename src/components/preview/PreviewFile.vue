<script setup lang="ts">
// 未知格式预览（psd / ai / zip / pdf / exe …）：软件里打不开，但**文件是真的在库里**。
//
// 设计取舍：
// - 不做「猜内容的兜底渲染」。猜错的成本比不猜高 —— 用户看到一堆乱码会以为文件坏了；
// - 中间那个大图标**本身就是按钮**（点了就用系统默认应用打开），这是用户点开预览后
//   唯一的意图，不该再让他去别处找；
// - 不调 `preview:ensure`：这类素材没有任何派生可做（主进程 `analyze` 会直接给
//   `strategy: 'unsupported'`），发请求只是白跑一趟 IPC。
import { computed, type PropType } from 'vue'
import type { StashAssetRow } from '../../env'
import { useAssetStore } from '../../stores/assets'

const props = defineProps({
  asset: { type: Object as PropType<StashAssetRow>, required: true },
  /** 右侧信息栏用：面板窄，图标缩小、只留主按钮 */
  compact: { type: Boolean, default: false }
})

const assets = useAssetStore()

/** 角标上的格式：拿不到扩展名就说「未知格式」，不要显示成空白 */
const extLabel = computed(() => {
  const e = (props.asset.ext || '').trim().toUpperCase()
  return e || '未知格式'
})

/**
 * 交给系统打开。
 *
 * `shell:open` 在 Windows 上走 `shell.openPath`：没有关联程序时**不抛错**，而是回一段
 * 错误字符串（`opened: false`）。两种形态都要翻成人话，否则用户点完毫无反馈。
 */
async function openExternal(): Promise<void> {
  const r = await window.stash.shell.open(props.asset.id)
  if (!r.ok) {
    assets.notify('error', `打开失败：${r.error ?? '未知原因'}`)
    return
  }
  if (r.data && !r.data.opened) {
    assets.notify('error', `打开失败：${r.data.error ?? '系统里没有关联这个格式的应用'}`)
  }
}

async function reveal(): Promise<void> {
  const r = await window.stash.shell.reveal(props.asset.id)
  if (!r.ok) assets.notify('error', `定位失败：${r.error ?? '未知原因'}`)
}
</script>

<template>
  <div class="pv-file" :class="{ compact }" data-pv-file>
    <!-- 大图标即按钮：点它 = 用系统默认应用打开 -->
    <button
      class="pv-file-glyph"
      data-pv-open-external
      type="button"
      :title="`用系统默认应用打开 ${asset.name}`"
      @click="openExternal"
    >
      <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round">
        <path d="M16 8h22l12 12v36a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4z" />
        <path d="M38 8v12h12" />
      </svg>
      <span class="pv-file-ext">{{ extLabel }}</span>
    </button>

    <div class="pv-file-name" :title="asset.name">{{ asset.name }}</div>
    <div class="pv-file-hint">这个格式没有内置预览器</div>

    <div class="pv-file-actions">
      <button class="pv-btn pv-btn-primary" data-pv-open-external type="button" @click="openExternal">
        用系统默认应用打开
      </button>
      <button v-if="!compact" class="pv-btn" data-pv-reveal type="button" @click="reveal">
        在文件夹中显示
      </button>
    </div>
  </div>
</template>
