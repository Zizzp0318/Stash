<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import TitleBar from './components/TitleBar.vue'
import SideBar from './components/SideBar.vue'
import ColumnResizer from './components/ColumnResizer.vue'
import GalleryGrid from './components/GalleryGrid.vue'
import DetailPanel from './components/DetailPanel.vue'
import Welcome from './components/Welcome.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import ThumbProgress from './components/ThumbProgress.vue'
import { useLibraryStore } from './stores/library'
import { useAssetStore } from './stores/assets'
import { useSettingsStore } from './stores/settings'
import { importFailedText } from './utils/format'
import { PREFERS_LIGHT_QUERY } from './utils/theme'

const lib = useLibraryStore()
const assets = useAssetStore()
const settings = useSettingsStore()

// ==================== 主题（深色 / 浅色 / 跟随系统）====================
//
// 顺序很重要，分三段：
//  ① main.ts 在挂载前按「上一次的有效主题」铺了首帧（那时代码还拿不到配置，只有缓存）；
//  ② 这里 `await settings.init()` 之后立刻 applyTheme() —— **以配置为准**把它纠正过来
//     （缓存可能过期：用户在另一个窗口改过；也可能是第一次跑，压根没有缓存）；
//  ③ 之后所有变化都由 store 里的 watch(effectiveTheme) 自动落 DOM，这里不用再管。
//
// 第 ② 步不能省：hint 写的是 light、配置是 dark 时，effectiveTheme 从 'dark' 到 'dark'
// 根本没变，watch 不会触发 —— 那一下界面就会停在缓存里的浅色上。
//
// matchMedia 监听由**本组件**持有而不是 store：store 是单例、永不卸载，
// 监听挂在那里就没有「摘掉」的时机；放这里才能跟着组件生命周期收尾。
const prefersLight = window.matchMedia(PREFERS_LIGHT_QUERY)
function onSystemThemeChange(): void {
  // 只有 `theme === 'system'` 时它才真的改变渲染（其它两态 effectiveTheme 不看 systemLight）
  settings.refreshSystemTheme()
}

/**
 * 缩略图生成进度（`thumb:progress` 的载荷）。`null` = 不显示。
 *
 * 为什么放在 App 而不是某个面板里：生成是**全局后台任务**（开库、导入后都会触发），
 * 与当前停在哪一栏、滚到哪一页都无关 —— 挂在 App 上，切视图 / 切筛选都不会把它弄丢。
 */
const thumbProgress = ref<{ done: number; total: number } | null>(null)

/**
 * 完成后的淡出定时器。**必须留着句柄**：
 * ① 下一批生成开始时要把「隐藏计划」撤掉，否则新进度条会在 800ms 后被上一批的定时器抹掉；
 * ② 组件卸载时清掉（App 实际不会卸载，但不能留悬挂 timer 让测试/热重载出鬼）。
 */
let thumbHideTimer: ReturnType<typeof setTimeout> | null = null

/** 撤销「完成后延迟隐藏」的计划（进度还在推进 / 组件卸载时调） */
function clearThumbHideTimer(): void {
  if (thumbHideTimer !== null) {
    clearTimeout(thumbHideTimer)
    thumbHideTimer = null
  }
}

// ⚠️ 这里**不再自带一份 `setNotice`**：它与 `assets.notify` 写的是同一个槽位
// （`assets.importNotice`）却各持一个 timer —— 于是「本地提示刚弹出、紧接着 store 又弹一条」时，
// 前者的 timer 不会被后者清掉，会提前把提示抹掉（`assets.notify` 只清它自己那个 timer）。
// 统一走 store 的单槽位 timer，见 stores/assets.ts 的 notify。
onMounted(async () => {
  // 偏好先读：网格首帧就该是用户选的视图与卡片大小，否则会先按默认排一遍再跳一下
  await settings.init()
  // 主题以配置为准再铺一次（首帧那一下是 main.ts 用缓存铺的，可能已过期）
  settings.applyTheme()
  prefersLight.addEventListener('change', onSystemThemeChange)
  await assets.loadAiLabels()
  await lib.bootstrap()
  if (lib.info) {
    await assets.refresh()
    // 打开已有库：回填缺失缩略图（已存在的会跳过，只生成缺的）
    window.stash.thumb.backfill('grid')
  }

  // 缩略图批量生成完成 → bump 版本号，让所有 <img> 重新加载
  window.stash.thumb.onDone((d) => {
    assets.bumpThumbs()
    /*
     * 进度条收尾：先把进度**置满**（100%）再延迟 ~800ms 隐藏 ——
     * 最后一格的 done 常常是「差 1 个就满」的中间值（每 10 个才广播一次），
     * 直接按它算会停在 97% 然后消失，看起来像「没跑完就被掐了」。
     * 800ms 是给用户看清「已经满了」的时间，之后由 ThumbProgress 自己淡出 200ms。
     */
    const total = d && Number.isFinite(d.total) && d.total > 0 ? d.total : thumbProgress.value?.total ?? 0
    if (total > 0) {
      thumbProgress.value = { done: total, total }
      clearThumbHideTimer()
      thumbHideTimer = setTimeout(() => {
        thumbHideTimer = null
        thumbProgress.value = null
      }, 800)
    }
  })

  /*
   * 缩略图生成进度（标题栏下方那条细条）。
   *
   * 主进程 `thumbs.ts` 的 `settleBatch` 每 10 个（以及最后一个）广播一次 `thumb:progress`，
   * 预加载层早就暴露了 `onProgress` —— 之前渲染层只订阅了 onDone，
   * 于是「几百上千张图在后台慢慢生」这段时间界面毫无反馈，用户以为软件没反应。
   */
  window.stash.thumb.onProgress((d) => {
    // total <= 0 的广播没有意义（空批次），忽略 —— 否则会出现一条 0/0 的常驻条
    if (!d || !Number.isFinite(d.total) || d.total <= 0) return
    clearThumbHideTimer() // 还在生成：撤掉上一批的「延迟隐藏」
    thumbProgress.value = { done: d.done, total: d.total }
  })

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
  //
  // ⚠️ 必须 `keepDepth`：这是**纯粹的后台完成事件**，用户没换查询条件。
  // 大库的补扫可能跑几分钟，用户早就滚到第 N 屏了 —— 不带 keepDepth 会把列表整体换成
  // 只有 200 条（`PAGE`），锚点一丢，Grid 的布局 watcher 直接 `scrollTop = 0` 把人弹回顶部。
  // 同文件里 `library:external` 那条路径早就这么写了（见上面 onExternal），这里是漏改。
  window.stash.meta.onDone(async () => {
    await assets.refresh({ keepDepth: true })
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
      // ⚠️ `skipped` 是**混装**的：内容重复与「扩展名不在 EXT_TYPE（如 HEIC）」共用同一个计数器
      // （见 `importer.ts` 的 `if (!type) { skipped++; continue }`）。所以这里绝不能只说「跳过重复」——
      // 拖进一张 HEIC 会被说成"库里已经有了"，纯属误导。
      assets.notify('info', `导入完成：新增 ${r.added} 个${renamedNote}${r.skipped ? `，跳过 ${r.skipped} 个（重复或格式不支持）` : ''}`)
    }
  })
})

// 组件卸载时清掉「完成后延迟隐藏」的定时器（App 不会卸载，但别留悬挂 timer）
onBeforeUnmount(() => {
  clearThumbHideTimer()
  prefersLight.removeEventListener('change', onSystemThemeChange)
})
</script>

<template>
  <Welcome v-if="!lib.info" />
  <div v-else class="app">
    <TitleBar />
    <!--
      缩略图生成进度：标题栏正下方一条 2px 细条（fixed 定位，不进文档流 → 不会顶动面板）。
      只有当主进程真的在跑生成（total > 0）时才渲染；完成后延迟隐藏，靠 Transition 淡出 200ms。
      包在 <Transition> 里而不是直接 v-if：硬切会「闪一下」。
    -->
    <Transition name="thumb-prog">
      <ThumbProgress
        v-if="thumbProgress"
        :done="thumbProgress.done"
        :total="thumbProgress.total"
      />
    </Transition>
    <div class="body">
      <SideBar />
      <!--
        左栏宽度拖拽条：盖在「侧栏 ↔ 中栏」的 8px 缝隙上。
        **绝对定位**，所以它虽然排在 .body 里，却不参与 flex 排版 ——
        不会像加普通子元素那样凭空多出两条缝（改成 static 就会）。
      -->
      <ColumnResizer />
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
