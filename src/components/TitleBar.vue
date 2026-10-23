<script setup lang="ts">
import { watch, ref, onBeforeUnmount } from 'vue'
import { useLibraryStore } from '../stores/library'
import { useAssetStore } from '../stores/assets'
import { libErrorText } from '../utils/format'
import WinControls from './WinControls.vue'

const lib = useLibraryStore()
const assets = useAssetStore()

const keyword = ref('')
let timer: ReturnType<typeof setTimeout> | null = null

watch(keyword, (v) => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(async () => {
    const kw = v.trim()
    // 值没变就不重复请求（反向同步回写、或只敲了空格时都会走到这里）
    if (kw === assets.query.keyword) return
    assets.query.keyword = kw
    await assets.refresh()
  }, 300)
})

// 组件卸载时清掉待触发的 debounce —— 否则它会在卸载后仍然跑一次 `assets.refresh()`
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

/**
 * 反向同步：store 里的关键词被外部改动（工具栏「清除筛选」、切换库）时把输入框跟着清掉。
 *
 * 搜索词的唯一真相在 `assets.query.keyword`，输入框只是它的一个视图；
 * 少了这一条，用户点「清除筛选」后列表是全部素材、但搜索框里还留着上次的词，
 * 看起来像「筛选没清干净」。
 *
 * 比较用 `keyword.value.trim()` 而不是 `keyword.value`：输入 "abc " 时 store 存的是
 * trim 后的 "abc"，若拿原值比较会判定为「不一致」→ 回写成 "abc"，
 * 用户正在打字时空格被当场吃掉。
 */
watch(
  () => assets.query.keyword,
  (v) => {
    if (v !== keyword.value.trim()) {
      if (timer) clearTimeout(timer)
      keyword.value = v
    }
  }
)

// —— 库切换菜单 ——
const menuOpen = ref(false)
const newShow = ref(false)
const newName = ref('我的素材库')
const busy = ref(false)
const err = ref('')
// 管理库视图
const manageMode = ref(false)
const pendingDel = ref<string | null>(null)

function nameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** 打开/收起菜单；每次打开重置视图并拉取最新库列表（会话内新建的库也能立即出现） */
function toggleMenu(): void {
  menuOpen.value = !menuOpen.value
  if (menuOpen.value) {
    manageMode.value = false
    pendingDel.value = null
    err.value = ''
    void lib.loadRecent()
  }
}

/**
 * 从最近库列表移除。**只删软件里的记录，磁盘一个字节都不动** ——
 * 所以这里没有「不可恢复」的二次确认压力，但仍要点一次确认框（防手滑把库从列表里点没了，
 * 虽然重新「打开库…」指回目录就能加回来）。
 */
async function doForget(path: string): Promise<void> {
  busy.value = true
  err.value = ''
  const name = nameOf(path)
  const e = await lib.forgetLibrary(path)
  busy.value = false
  pendingDel.value = null
  if (e) {
    err.value = libErrorText(e)
    return
  }
  // 非破坏性操作也要给回执：用户点了「确认移除」后如果只是列表少了一行、没有任何提示，
  // 很容易以为「是不是连库都删了」。这句明确告诉他磁盘没动。
  assets.notify('info', `已从列表移除「${name}」，库目录未改动`)
  // 移除当前库后 lib.info 变 null，App 会自动切到欢迎页；否则留在菜单里
  if (!lib.info) menuOpen.value = false
}

async function switchTo(path: string): Promise<void> {
  if (path === lib.info?.path) {
    menuOpen.value = false
    return
  }
  busy.value = true
  err.value = ''
  const e = await lib.openLibrary(path)
  busy.value = false
  if (e) {
    // 切到「太新」的库会被拒（ERR_LIBRARY_TOO_NEW）等 → 映射成人话，别把裸错误码甩给用户
    err.value = libErrorText(e)
    return
  }
  menuOpen.value = false
  newShow.value = false
  keyword.value = ''
  await assets.refresh()
  window.stash.thumb.backfill('grid')
}

async function openOther(): Promise<void> {
  const dir = await window.stash.dialog.pickFolder()
  if (dir) await switchTo(dir)
}

async function createNew(): Promise<void> {
  const dir = await window.stash.dialog.pickFolder()
  if (!dir) return
  busy.value = true
  err.value = ''
  const e = await lib.createLibrary(newName.value.trim() || '我的素材库', dir)
  busy.value = false
  if (e) {
    err.value = libErrorText(e)
    return
  }
  menuOpen.value = false
  newShow.value = false
  keyword.value = ''
  await assets.refresh()
}

</script>

<template>
  <header class="titlebar">
    <div class="brand">
      <div class="brand-mark">
        <svg viewBox="0 0 12 12" fill="none">
          <circle cx="6" cy="6" r="2.2" fill="#242629" />
          <path d="M6 0.5v2.4M6 9.1v2.4M0.5 6h2.4M9.1 6h2.4" stroke="#242629" stroke-width="1.3" stroke-linecap="round" />
        </svg>
      </div>
      <span class="brand-name">Stash</span>
    </div>

    <nav class="tabs">
      <div class="tab active tab-select" title="点击切换 / 新建库" @click="toggleMenu()">
        {{ lib.info?.name || '素材库' }} <span class="count">{{ lib.counts.total }}</span>
        <span class="caret" :class="{ up: menuOpen }">▾</span>
      </div>

      <!-- 库切换下拉菜单 -->
      <div v-if="menuOpen" class="lib-menu-backdrop" @click="menuOpen = false"></div>
      <div v-if="menuOpen" class="lib-menu">
        <template v-if="!manageMode">
          <div class="lib-menu-label">切换库</div>
          <button
            v-for="r in lib.recent"
            :key="r.path"
            class="lib-menu-item"
            :class="{ current: r.path === lib.info?.path }"
            :disabled="busy"
            @click="switchTo(r.path)"
          >
            <span class="lm-name">{{ r.name }}<span v-if="r.path === lib.info?.path" class="lm-check"> ✓</span></span>
            <span class="lm-path">{{ r.path }}</span>
          </button>
          <div v-if="!lib.recent.length" class="lib-menu-empty">暂无其他库</div>
          <div class="lib-menu-sep"></div>
          <button class="lib-menu-item action" :disabled="busy" @click="manageMode = true">管理库…</button>
          <button class="lib-menu-item action" :disabled="busy" @click="openOther">打开库…</button>
          <button class="lib-menu-item action" :disabled="busy" @click="newShow = !newShow">新建库…</button>
          <div v-if="newShow" class="lib-menu-new" @click.stop>
            <input v-model="newName" maxlength="40" placeholder="库名称" spellcheck="false" @keyup.enter="createNew" />
            <button class="w-btn small primary" :disabled="busy" @click="createNew">选择位置并创建</button>
          </div>
        </template>

        <!-- 管理库视图：从列表移除库（不碰磁盘） -->
        <template v-else>
          <div class="lib-menu-label">管理库</div>
          <div v-for="r in lib.recent" :key="r.path" class="lib-manage-item">
            <div class="lm-info">
              <span class="lm-name">{{ r.name }}<span v-if="r.path === lib.info?.path" class="lm-cur">（当前）</span></span>
              <span class="lm-path">{{ r.path }}</span>
            </div>
            <button class="lm-del" :disabled="busy" @click="pendingDel = r.path">移除</button>
          </div>
          <div v-if="!lib.recent.length" class="lib-menu-empty">暂无库</div>
          <div v-if="pendingDel" class="lib-confirm" @click.stop>
            <div class="lc-text">
              从列表移除「{{ nameOf(pendingDel) }}」？只会删掉软件里的这条记录，<b>库目录和里面的素材不会被删除</b>，以后用「打开库…」指回该目录即可重新加回来。
            </div>
            <div class="lc-actions">
              <button class="w-btn small" :disabled="busy" @click="pendingDel = null">取消</button>
              <button class="w-btn small" :disabled="busy" @click="doForget(pendingDel)">确认移除</button>
            </div>
          </div>
          <div class="lib-menu-sep"></div>
          <button class="lib-menu-item action" :disabled="busy" @click="manageMode = false; pendingDel = null; err = ''">← 返回</button>
        </template>
        <div v-if="err" class="lib-menu-err">{{ err }}</div>
      </div>
    </nav>

    <div class="searchbox">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <circle cx="5.2" cy="5.2" r="3.7" stroke="currentColor" stroke-width="1.3" />
        <path d="M8.2 8.2L11 11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
      </svg>
      <input v-model="keyword" class="search-input" placeholder="搜索文件名、标签…" spellcheck="false" />
      <span v-if="keyword" class="search-clear" @click="keyword = ''">✕</span>
    </div>

    <!-- 窗口控制条与欢迎页共用一份组件（无边框窗口，按钮是唯一的关闭途径） -->
    <WinControls show-detail />
  </header>
</template>
