<script setup lang="ts">
import { onMounted } from 'vue'
import TitleBar from './components/TitleBar.vue'
import SideBar from './components/SideBar.vue'
import GalleryGrid from './components/GalleryGrid.vue'
import DetailPanel from './components/DetailPanel.vue'
import Welcome from './components/Welcome.vue'
import { useLibraryStore } from './stores/library'
import { useAssetStore } from './stores/assets'

const lib = useLibraryStore()
const assets = useAssetStore()

let noticeTimer: ReturnType<typeof setTimeout> | null = null
function setNotice(n: { kind: 'error' | 'info'; text: string }): void {
  assets.importNotice = n
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => (assets.importNotice = null), n.kind === 'error' ? 10000 : 5000)
}

onMounted(async () => {
  await lib.bootstrap()
  if (lib.info) {
    await assets.refresh()
    // 打开已有库：回填缺失缩略图（已存在的会跳过，只生成缺的）
    window.stash.thumb.backfill('grid')
  }

  // 缩略图批量生成完成 → bump 版本号，让所有 <img> 重新加载
  window.stash.thumb.onDone(() => assets.bumpThumbs())

  // 导入进度事件（全局一份）
  window.stash.import.onProgress((d) => {
    assets.importing = { done: d.done, total: d.total }
  })
  window.stash.import.onDone(async (r) => {
    assets.importing = null
    await lib.loadMeta()
    await lib.refreshCounts()
    await assets.refresh()
    // 导入后为新素材排队生成缩略图
    window.stash.thumb.backfill('grid')
    if (r.failed.length) {
      const first = r.failed[0]
      const name = first.path.split(/[\\/]/).pop()
      setNotice({
        kind: 'error',
        text: `${r.failed.length} 个文件导入失败（首个：${name}：${first.error}）`
      })
    } else if (r.added === 0 && r.skipped === 0) {
      setNotice({ kind: 'info', text: '没有可导入的文件（格式不支持或无有效文件）' })
    } else {
      // 重名被自动改名也要说出来 —— 不说的话用户只知道「新增 1 个」，
      // 却在瀑布里找不到自己那个文件名，会以为导入错了。
      const renamedNote = r.renamed ? `，${r.renamed} 个因重名已自动改名` : ''
      setNotice({
        kind: 'info',
        text: `导入完成：新增 ${r.added} 个${renamedNote}${r.skipped ? `，跳过重复 ${r.skipped} 个` : ''}`
      })
    }
  })
})
</script>

<template>
  <Welcome v-if="!lib.info" />
  <div v-else class="app">
    <TitleBar />
    <div class="body">
      <SideBar />
      <GalleryGrid />
      <!-- 收纳状态由标题栏右上角的按钮控制（见 TitleBar 的 .wc-btn）。
           收起后整个面板不渲染，点素材也不会把它带回来 —— 状态是显式的，不派生自「有没有选中」 -->
      <DetailPanel v-if="!assets.detailCollapsed" />
    </div>
    <!-- 导入进度浮层 -->
    <div v-if="assets.importing" class="import-overlay">
      <div class="import-box">
        <div class="import-title">正在导入素材…</div>
        <div class="import-bar">
          <div class="import-fill" :style="{ width: (assets.importing.total ? (assets.importing.done / assets.importing.total) * 100 : 0) + '%' }"></div>
        </div>
        <div class="import-meta">{{ assets.importing.done }} / {{ assets.importing.total }}</div>
      </div>
    </div>
    <!-- 轻提示条（导入结果 / 批量操作回执）实际渲染在 GalleryGrid 的工具栏标题行里，
         浮在「所有素材 … 导入」那一行的中段 —— 详见该组件里的 .notice-toast -->
  </div>
</template>
