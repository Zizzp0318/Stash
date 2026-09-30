<script setup lang="ts">
import { ref } from 'vue'
import { useLibraryStore } from '../stores/library'
import { useAssetStore } from '../stores/assets'
import { libErrorText } from '../utils/format'
import WinControls from './WinControls.vue'

const lib = useLibraryStore()
const assets = useAssetStore()

const busy = ref(false)
const err = ref('')
const showNew = ref(false)
const libName = ref('我的素材库')

async function openExisting(target: string): Promise<void> {
  busy.value = true
  err.value = ''
  const e = await lib.openLibrary(target)
  busy.value = false
  // 打开失败可能是「库太新」（ERR_LIBRARY_TOO_NEW）等 → 统一映射成人话，别把裸错误码甩给用户
  if (e) err.value = libErrorText(e)
  else await assets.refresh()
}

async function pickAndOpen(): Promise<void> {
  const dir = await window.stash.dialog.pickFolder()
  if (dir) await openExisting(dir)
}

async function createNew(): Promise<void> {
  const dir = await window.stash.dialog.pickFolder()
  if (!dir) return
  busy.value = true
  err.value = ''
  const e = await lib.createLibrary(libName.value.trim() || '我的素材库', dir)
  busy.value = false
  if (e) {
    err.value = libErrorText(e)
  } else {
    showNew.value = false
    await assets.refresh()
  }
}
</script>

<template>
  <div class="welcome">
    <!-- 无边框窗口：欢迎页没有 TitleBar，控制按钮必须在这里自己挂一份，
         否则新建库/未开库时窗口既不能最小化也不能关闭 -->
    <WinControls class="welcome-controls" />

    <div class="w-card">
      <div class="w-logo">
        <svg viewBox="0 0 12 12" fill="none">
          <circle cx="6" cy="6" r="2.2" fill="#242629" />
          <path d="M6 0.5v2.4M6 9.1v2.4M0.5 6h2.4M9.1 6h2.4" stroke="#242629" stroke-width="1.3" stroke-linecap="round" />
        </svg>
      </div>
      <h1>Stash · 素材库</h1>
      <p class="w-sub">新建一个库，或打开已有的库目录开始管理素材</p>

      <div class="w-actions">
        <button class="w-btn primary" :disabled="busy" @click="showNew = true">新建库</button>
        <button class="w-btn" :disabled="busy" @click="pickAndOpen">打开库…</button>
      </div>

      <div v-if="showNew" class="w-new">
        <label>库名称</label>
        <input v-model="libName" maxlength="40" placeholder="我的素材库" @keyup.enter="createNew" />
        <button class="w-btn small primary" :disabled="busy" @click="createNew">选择位置并创建</button>
      </div>

      <!-- err = 本页操作（打开/新建）的报错；bootError = 启动时自动恢复最近库失败的原因
           （例如最近库是「太新」的库 → 已由 store 退回欢迎页，这里把原因说清楚） -->
      <div v-if="err || lib.bootError" class="w-err">{{ err || libErrorText(lib.bootError) }}</div>

      <div v-if="lib.recent.length" class="w-recent">
        <div class="w-label">最近打开</div>
        <button v-for="r in lib.recent" :key="r.path" class="w-recent-item" :disabled="busy" @click="openExisting(r.path)">
          <span class="w-recent-name">{{ r.name }}</span>
          <span class="w-recent-path">{{ r.path }}</span>
        </button>
      </div>
    </div>
  </div>
</template>
