<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import { folderIcon } from '@/data/mock'
import { useLibraryStore, type FolderRow } from '../stores/library'
import { useAssetStore } from '../stores/assets'
import { fmtCount } from '../utils/format'

const lib = useLibraryStore()
const assets = useAssetStore()

// —— 文件夹树（按路径深度缩进）——
const folderRows = computed(() =>
  lib.folders
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => ({ ...f, indent: f.path.split('/').length - 1, count: lib.subtreeCount(f) }))
)

const noFilter = computed(() => assets.query.folderId == null && assets.query.tagId == null)

async function pickFolder(f: FolderRow): Promise<void> {
  assets.query.folderId = f.id
  assets.query.tagId = null
  await assets.refresh()
}

async function pickAll(): Promise<void> {
  assets.query.folderId = null
  assets.query.tagId = null
  await assets.refresh()
}

async function pickTag(id: number): Promise<void> {
  assets.query.tagId = id
  assets.query.folderId = null
  await assets.refresh()
}

// —— 内联新建输入（文件夹 / 标签共用模式）——
const creatingFolder = ref(false)
const newFolderName = ref('')
const creatingTag = ref(false)
const newTagName = ref('')
const folderInput = ref<HTMLInputElement | null>(null)
const tagInput = ref<HTMLInputElement | null>(null)

function fail(msg: string): void {
  assets.importNotice = { kind: 'error', text: msg }
}

/** 打开内联输入框并立即聚焦（autofocus 对动态插入的元素不生效） */
function openFolderInput(): void {
  creatingFolder.value = true
  nextTick(() => folderInput.value?.focus())
}
function openTagInput(): void {
  creatingTag.value = true
  nextTick(() => tagInput.value?.focus())
}

/** IME 兼容：输入法组词时的回车（isComposing）不触发提交 */
function onFolderEnter(e: KeyboardEvent): void {
  if (e.isComposing) return
  void confirmFolder()
}
function onTagEnter(e: KeyboardEvent): void {
  if (e.isComposing) return
  void confirmTag()
}

async function confirmFolder(): Promise<void> {
  const name = newFolderName.value.trim()
  if (!name) {
    creatingFolder.value = false
    return
  }
  try {
    // 统一建在库根目录（与「未分类」同级）；子级嵌套后续通过右键菜单创建
    const r = await window.stash.folder.mkdir(name)
    if (!r.ok) throw new Error(r.error ?? '创建失败')
    await lib.loadMeta()
    creatingFolder.value = false
    newFolderName.value = ''
  } catch (e) {
    fail(`新建文件夹失败：${String((e as Error).message ?? e)}`)
  }
}

async function confirmTag(): Promise<void> {
  const name = newTagName.value.trim()
  if (!name) {
    creatingTag.value = false
    return
  }
  try {
    const r = await window.stash.tag.create({ name })
    if (!r.ok) throw new Error(r.error ?? '创建失败')
    await lib.loadMeta()
    creatingTag.value = false
    newTagName.value = ''
  } catch (e) {
    fail(`新建标签失败：${String((e as Error).message ?? e)}`)
  }
}
</script>

<template>
  <aside class="sidebar">
    <div class="side-scroll">
      <div class="side-section">
        <div class="side-item" :class="{ active: noFilter }" @click="pickAll">
          <svg viewBox="0 0 14 14" fill="none">
            <rect x="1.4" y="1.4" width="11.2" height="11.2" rx="2.4" stroke="currentColor" stroke-width="1.2" />
            <path d="M1.4 5h11.2" stroke="currentColor" stroke-width="1.2" />
          </svg>
          所有素材 <span class="n">{{ fmtCount(lib.counts.total) }}</span>
        </div>
      </div>

      <div class="side-section">
        <div class="side-label">
          文件夹
          <span class="action" title="新建文件夹" @click="openFolderInput">＋</span>
        </div>
        <div v-if="creatingFolder" class="inline-form">
          <input
            ref="folderInput"
            v-model="newFolderName"
            placeholder="文件夹名称"
            spellcheck="false"
            @keydown.enter="onFolderEnter"
            @blur="confirmFolder"
            @keydown.esc="creatingFolder = false; newFolderName = ''"
          />
          <div class="inline-hint">将创建在库根目录（顶层）</div>
        </div>
        <div
          v-for="f in folderRows"
          :key="f.id"
          class="side-item"
          :class="{ active: assets.query.folderId === f.id }"
          @click="pickFolder(f)"
        >
          <span v-if="f.indent === 1" class="indent-1"></span>
          <span v-else-if="f.indent >= 2" class="indent-2"></span>
          <span v-html="folderIcon"></span>
          {{ f.name }} <span class="n">{{ fmtCount(f.count) }}</span>
        </div>
      </div>

      <div class="side-section">
        <div class="side-label">
          标签
          <span class="action" title="新建标签" @click="openTagInput">＋</span>
        </div>
        <div v-if="creatingTag" class="inline-form">
          <input
            ref="tagInput"
            v-model="newTagName"
            placeholder="标签名称"
            spellcheck="false"
            @keydown.enter="onTagEnter"
            @blur="confirmTag"
            @keydown.esc="creatingTag = false; newTagName = ''"
          />
        </div>
        <div
          v-for="t in lib.tags"
          :key="t.id"
          class="side-item"
          :class="{ active: assets.query.tagId === t.id }"
          @click="pickTag(t.id)"
        >
          <span class="tag-dot" :style="{ background: t.color }"></span>
          {{ t.name }} <span class="n">{{ fmtCount(lib.counts.byTag[String(t.id)] ?? 0) }}</span>
        </div>
      </div>
    </div>

    <div class="side-footer">
      <div class="side-item">
        <svg viewBox="0 0 14 14" fill="none">
          <circle cx="7" cy="7" r="2.1" stroke="currentColor" stroke-width="1.2" />
          <path d="M7 1.4v1.7M7 10.9v1.7M1.4 7h1.7M10.9 7h1.7M3.2 3.2l1.2 1.2M9.6 9.6l1.2 1.2M10.8 3.2L9.6 4.4M4.4 9.6l-1.2 1.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        </svg>
        设置
      </div>
    </div>
  </aside>
</template>
