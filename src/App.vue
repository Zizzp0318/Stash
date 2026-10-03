<script setup lang="ts">
import { onMounted } from 'vue'
import TitleBar from './components/TitleBar.vue'
import SideBar from './components/SideBar.vue'
import GalleryGrid from './components/GalleryGrid.vue'
import DetailPanel from './components/DetailPanel.vue'
import Welcome from './components/Welcome.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import { useLibraryStore } from './stores/library'
import { useAssetStore } from './stores/assets'
import { useSettingsStore } from './stores/settings'
import { importFailedText } from './utils/format'

const lib = useLibraryStore()
const assets = useAssetStore()
const settings = useSettingsStore()

// ⚠️ 这里**不再自带一份 `setNotice`**：它与 `assets.notify` 写的是同一个槽位
// （`assets.importNotice`）却各持一个 timer —— 于是「本地提示刚弹出、紧接着 store 又弹一条」时，
// 前者的 timer 不会被后者清掉，会提前把提示抹掉（`assets.notify` 只清它自己那个 timer）。
// 统一走 store 的单槽位 timer，见 stores/assets.ts 的 notify。
onMounted(async () => {
  // 偏好先读：网格首帧就该是用户选的视图与卡片大小，否则会先按默认排一遍再跳一下
  await settings.init()
  await assets.loadAiLabels()
  await lib.bootstrap()
  if (lib.info) {
    await assets.refresh()
    // 打开已有库：回填缺失缩略图（已存在的会跳过，只生成缺的）
    window.stash.thumb.backfill('grid')
  }

  // 缩略图批量生成完成 → bump 版本号，让所有 <img> 重新加载
  window.stash.thumb.onDone(() => assets.bumpThumbs())

  // 外部（资源管理器）改动 → 主进程 watcher 同步完索引后广播过来。
  // 界面因此**不必重开库**就能看到外部新增/改写/删除的素材。
  window.stash.library.onExternal(async (d) => {
    // 欢迎页（没有打开的库）不该被搅动：没有任何东西需要刷新
    if (!lib.info) return
    const n = d.added + d.changed + d.removed
    // 空的**中途**事件（partial）没有可刷新的内容 → 忽略；
    // 空的**收尾**事件（partial=false, n=0）保留：它是「流已结束」的纯信号，仍要做收尾动作。
    if (!n && d.partial) return
    await lib.refreshCounts()
    // keepDepth：保住用户已加载的深度，别把人弹回第一页（见 stores/assets.ts 的 refresh）
    await assets.refresh({ keepDepth: true })
    await assets.reloadDetail()
    // —— 到这里为止，中途与收尾都做（否则又回到「拷贝期间界面不动」，正是 maxWait 要解决的问题）——
    // —— 下面两件「贵且打扰」的事，**只在收尾**（!d.partial）做 ——
    if (d.partial) return
    // 让所有 <img> 的 ?v= 前进，强制重新拉缩略图。
    // 这一条正是「卡片变 404 破图」的解：内容被外部改写后 hash 变了，旧 URL 已指向被删的缓存目录，
    // bump 后 <img> 换成新 hash，网格的自愈逻辑（GalleryGrid 的 thumbRetried）随后会请求 thumb:ensure。
    // 为什么只在收尾 bump：新增素材与新 hash 的 URL 本来就是全新的，不 bump 也会正常加载；
    // bump 的作用是强制**已缓存**的旧 URL 重取 —— 那件事收尾做一次即可。
    // 若中途也 bump，maxWait 会把「全网格重拉缩略图」从「每批一次」放大成「长拷贝期间每 ~1.4s 一次」。
    assets.bumpThumbs()
    // 提示只在收尾弹一次（统一走 assets.notify 单槽位 timer；本组件已不再自带重复的 setNotice）。
    // 为什么不在中途弹：每次 notify 都会把 5s 自动消失的计时重置 → 提示条整段拷贝期间常驻、数字乱跳。
    if (n) assets.notify('info', `库在外部被改动了：新增 ${d.added} 个 / 修改 ${d.changed} 个 / 删除 ${d.removed} 个`)
  })

  // 生成参数是**后台异步**扫的（导入后/开库时补扫）。扫完必须把列表与详情重拉一次，
  // 否则卡片角标与详情栏会一直停在「没有 AI 信息」那一版 —— 用户会以为功能没生效。
  window.stash.meta.onDone(async () => {
    await assets.refresh()
    await assets.reloadDetail()
  })

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
      // 文案统一交给 importFailedText：它会按 batch 标记区分「整批提交失败」与「逐文件失败」，
      // 不再出现「1 个文件导入失败（…本批 41 个…）」这种把整批说成单个文件的自相矛盾措辞。
      assets.notify('error', importFailedText(r.failed) ?? '导入失败')
    } else if (r.added === 0 && r.skipped === 0) {
      assets.notify('info', '没有可导入的文件（格式不支持或无有效文件）')
    } else {
      // 重名被自动改名也要说出来 —— 不说的话用户只知道「新增 1 个」，
      // 却在瀑布里找不到自己那个文件名，会以为导入错了。
      const renamedNote = r.renamed ? `，${r.renamed} 个因重名已自动改名` : ''
      assets.notify('info', `导入完成：新增 ${r.added} 个${renamedNote}${r.skipped ? `，跳过重复 ${r.skipped} 个` : ''}`)
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

    <!-- 设置面板：全局单例，只渲染已实现的分组；入口在侧栏底部 -->
    <SettingsPanel v-if="settings.panelOpen" />
  </div>
</template>
