<script setup lang="ts">
// 设置面板（居中模态）：左分组导航 + 右内容区。
//
// 两条刻意的取舍：
// ① **只渲染已经实现的分组**，不放「待实现」占位项 —— 点不动的菜单项等于骗人，
//    用户点了没反应只会以为软件坏了。后续分组只要往 GROUPS 里补一项。
// ② 设置项**一律不给「需要重启」**：每个开关都要当场看得见效果（改视图立刻换排布、
//    改字段立刻换卡片），否则用户不知道到底生效没有。
//
// Esc 用**捕获阶段**吃掉并 stopPropagation：GalleryGrid 也有全局 keydown（Esc 清空多选），
// 不吃掉的话关设置会顺带把网格的选中一起清了。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useAssetStore, CARD_FIELDS, VIEW_ZOOM_MIN, VIEW_ZOOM_MAX } from '../stores/assets'
import { useLibraryStore } from '../stores/library'
import { useSettingsStore } from '../stores/settings'
import { fmtCount, fmtSize } from '../utils/format'
import type {
  StashAppInfo,
  StashCacheStats,
  StashLibraryStats,
  StashScanResult,
  StashSettingsChoices
} from '../env'

const settings = useSettingsStore()
const assets = useAssetStore()
const lib = useLibraryStore()

type GroupKey = 'appearance' | 'preview' | 'importing' | 'cache' | 'library' | 'shortcuts' | 'about'
const GROUPS: Array<{ key: GroupKey; label: string }> = [
  { key: 'appearance', label: '外观与浏览' },
  { key: 'preview', label: '预览与播放' },
  { key: 'importing', label: '导入' },
  { key: 'cache', label: '缩略图与缓存' },
  { key: 'library', label: '库与存储' },
  { key: 'shortcuts', label: '快捷键' },
  { key: 'about', label: '关于' }
]
const active = ref<GroupKey>('appearance')

/**
 * 快捷键清单。**必须是真实存在的键位** —— 这张表是给用户看的说明书，
 * 写进去一个不存在的键等于骗人。改键位时这里要一起改。
 * 自定义键位还没做，所以这一组是**只读**的（不做「假设置」）。
 */
const SHORTCUTS: Array<{ keys: string; what: string; where: string }> = [
  { keys: '双击卡片', what: '打开中栏浮层预览', where: '网格' },
  { keys: 'Esc', what: '关闭浮层 / 取消多选 / 关掉当前小面板', where: '全局' },
  { keys: '← / →', what: '上一张 / 下一张', where: '浮层预览' },
  { keys: 'Ctrl/⌘ + C', what: '复制选中素材的文件（可直接粘到资源管理器）', where: '网格' },
  { keys: 'Ctrl/⌘ + V', what: '粘贴到当前文件夹（库内生成副本，库外的走导入）', where: '网格' },
  { keys: 'Ctrl + Enter', what: '保存提示词修改', where: '详情栏' },
  { keys: 'Enter / Esc', what: '确认 / 取消重命名', where: '重命名输入框' },
  { keys: '滚轮', what: '缩放图片', where: '图片预览' },
  { keys: '拖拽', what: '平移图片（放大之后才生效）', where: '图片预览' },
  { keys: '双击图片', what: '在「适配画面 / 1:1」之间切换', where: '图片预览' }
]

const info = ref<StashAppInfo | null>(null)
const stats = ref<StashCacheStats | null>(null)
const choices = ref<StashSettingsChoices | null>(null)
/** 清理中的防重入 */
const busy = ref(false)
/** 危险动作的二次确认（点一下变文案，再点才真做） */
const arm = ref<'thumbs' | 'derived' | null>(null)
/** 重置的二次确认：点一下变「再点一次确认」，避免误触 */
const resetArmed = ref(false)

/** 库与存储：快照（纯查库）、体检结果（跑一次才有）、各自的二次确认 */
const libStats = ref<StashLibraryStats | null>(null)
const scan = ref<StashScanResult | null>(null)
const scanning = ref(false)
const libBusy = ref(false)
const cleanArmed = ref(false)
const deleteLibArmed = ref(false)

const s = computed(() => settings.settings)
const densityLabel = computed(() => (s.value.viewZoom <= 165 ? '紧凑' : s.value.viewZoom <= 225 ? '适中' : '放大'))

async function loadInfo(): Promise<void> {
  const r = await window.stash.app.info()
  if (r.ok && r.data) info.value = r.data
}
async function loadStats(): Promise<void> {
  const r = await window.stash.cache.stats()
  if (r.ok && r.data) stats.value = r.data
}
async function loadLibStats(): Promise<void> {
  const r = await window.stash.health.stats()
  if (r.ok && r.data) libStats.value = r.data
}
/** 切分组：顺手把这一组要的数据拉一下（缓存占用是会变的，别停在打开面板那一刻的旧数字） */
function pickGroup(k: GroupKey): void {
  active.value = k
  arm.value = null
  // 离开分组就把二次确认收掉：举着「再点一次确认」的状态换到别处再回来，
  // 会让人以为自己已经点过一次了
  cleanArmed.value = false
  deleteLibArmed.value = false
  if (k === 'cache') void loadStats()
  if (k === 'library') {
    void loadLibStats()
    scan.value = null // 上次的体检结果只对上次那一刻负责，进来就让它作废
  }
  // 「预览与播放」和「缩略图与缓存」的档位都来自主进程（校验与 UI 同源），一次拉好共用
  if ((k === 'cache' || k === 'preview') && !choices.value) {
    void window.stash.settings.choices().then((r) => {
      if (r.ok && r.data) choices.value = r.data
    })
  }
  if (k === 'about') void loadInfo()
}

/** 缩略图重建完成 → 刷新占用（否则还显示清理前的数字） */
let offThumbDone: (() => void) | null = null
onMounted(async () => {
  window.addEventListener('keydown', onKey, true)
  offThumbDone = window.stash.thumb.onDone(() => void loadStats())
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, true)
  offThumbDone?.()
})

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  e.preventDefault()
  e.stopPropagation() // 别让网格的 Esc（清空多选）跟着跑
  close()
}
function close(): void {
  resetArmed.value = false
  settings.closePanel()
}

function pickIdle(ms: number): void {
  void settings.patch({ preview: { idleHideMs: ms } })
}
function idleLabel(ms: number): string {
  return ms === 0 ? '不隐藏' : `${ms / 1000}s`
}
function onVolume(e: Event): void {
  void settings.patch({ preview: { volume: Number((e.target as HTMLInputElement).value) / 100 } })
}
function toggleAutoPlay(): void {
  void settings.patch({ preview: { autoPlay: !s.value.preview.autoPlay } })
}
function pickMaxPx(px: number): void {
  void settings.patch({ preview: { maxImagePx: px } })
}
function pickTextMb(mb: number): void {
  void settings.patch({ preview: { textMaxBytes: mb * 1024 * 1024 } })
}

function onConc(e: Event): void {
  void settings.patch({ thumbs: { concurrency: Number((e.target as HTMLInputElement).value) } })
}
function pickQuality(q: number): void {
  void settings.patch({ thumbs: { quality: q } })
}

async function doClear(kind: 'thumbs' | 'derived'): Promise<void> {
  if (arm.value !== kind) {
    arm.value = kind
    return
  }
  arm.value = null
  busy.value = true
  const r = await window.stash.cache.clear(kind)
  busy.value = false
  if (!r.ok) {
    assets.notify('error', `清理失败：${r.error ?? '未知原因'}`)
    return
  }
  const removed = r.data?.removed ?? 0
  const freed = fmtSize(r.data?.freed ?? 0)
  if (kind === 'thumbs') {
    // ⚠️ 清完必须立刻重新排队生成：否则网格里的 <img> 指向已删文件会一片 404。
    // 这里**不要**手动 bumpThumbs —— 那会让所有图立刻重发请求、而这批文件还没生成；
    // 生成完成时主进程会广播 thumb:done（App.vue 收到后 bump），那时再换 URL 才稳。
    window.stash.thumb.backfill('grid')
    // 只发一条提示：分两条的话后一条会把「删了几个」这个信息顶掉
    assets.notify('info', `已清理 ${removed} 个文件（${freed}），正在按当前质量重新生成…`)
  } else {
    assets.notify('info', `已清理 ${removed} 个派生预览（${freed}），下次打开会重新转码`)
  }
  await loadStats()
}

function pickImportMode(m: 'copy' | 'move'): void {
  void settings.patch({ importing: { mode: m } })
}
function toggleDedupe(): void {
  void settings.patch({ importing: { dedupe: !s.value.importing.dedupe } })
}
function togglePalette(): void {
  void settings.patch({ importing: { palette: !s.value.importing.palette } })
}

/** 体检：逐个核对磁盘。**只在用户点的时候跑** —— 大库是几千次 statSync，不该在开面板时自动跑 */
async function runScan(): Promise<void> {
  scanning.value = true
  const r = await window.stash.health.scan()
  scanning.value = false
  if (!r.ok || !r.data) {
    assets.notify('error', `体检失败：${r.error ?? '未知原因'}`)
    return
  }
  scan.value = r.data
  await loadLibStats() // 体检会顺手修正 missing 标记，快照要跟着更新
  assets.notify(
    'info',
    r.data.missing === 0
      ? `体检完成：${fmtCount(r.data.checked)} 个素材的文件都在`
      : `体检完成：${r.data.missing} 个素材的文件已不在磁盘上`
  )
}

async function cleanMissing(): Promise<void> {
  if (!cleanArmed.value) {
    cleanArmed.value = true
    return
  }
  cleanArmed.value = false
  libBusy.value = true
  const r = await window.stash.health.clean()
  libBusy.value = false
  if (!r.ok || !r.data) {
    assets.notify('error', `清理失败：${r.error ?? '未知原因'}`)
    return
  }
  const parts = [`已清掉 ${r.data.removed} 条失效记录`]
  if (r.data.pruned.length) parts.push(`${r.data.pruned.length} 个空标签`)
  if (r.data.freed) parts.push(`释放 ${fmtSize(r.data.freed)}`)
  assets.notify('info', parts.join('、'))
  scan.value = null
  await loadLibStats()
  await assets.refresh()
  await lib.refreshCounts()
}

async function revealLibrary(): Promise<void> {
  const r = await window.stash.library.reveal()
  if (!r.ok || !r.data?.opened) assets.notify('error', `打开失败：${r.data?.error ?? r.error ?? '未知原因'}`)
}

/**
 * 删除当前库。**不可恢复**，所以要点两次，且删除的是「当前这个库的目录」，
 * 不接受任意路径 —— 主进程那边还会再确认它确实在最近列表里（见 deleteLibrary）。
 */
async function doDeleteLibrary(): Promise<void> {
  if (!deleteLibArmed.value) {
    deleteLibArmed.value = true
    return
  }
  deleteLibArmed.value = false
  const target = lib.info?.path
  if (!target) return
  libBusy.value = true
  const err = await lib.deleteLibrary(target)
  libBusy.value = false
  if (err) {
    assets.notify('error', `删除失败：${err}`)
    return
  }
  // 库已经没了，面板也别留着 —— 对着欢迎页开一个「库与存储」很怪
  settings.closePanel()
  assets.notify('info', '库已删除')
}

async function openCacheDir(): Promise<void> {
  const r = await window.stash.cache.reveal()
  if (!r.ok || !r.data?.opened) assets.notify('error', `打开失败：${r.data?.error ?? r.error ?? '未知原因'}`)
}

function pickView(v: 'masonry' | 'list'): void {
  void settings.patch({ defaultView: v })
}
function onZoom(e: Event): void {
  void settings.patch({ viewZoom: Number((e.target as HTMLInputElement).value) })
}
function toggleBadge(): void {
  void settings.patch({ cardFields: { typeBadge: !s.value.cardFields.typeBadge } })
}
function toggleAiBadge(): void {
  void settings.patch({ cardFields: { aiBadge: !s.value.cardFields.aiBadge } })
}
function toggleExtractMeta(): void {
  void settings.patch({ importing: { extractMeta: !s.value.importing.extractMeta } })
}
function toggleDetectAi(): void {
  void settings.patch({ importing: { detectAi: !s.value.importing.detectAi } })
}

function toggleDetailCollapsed(): void {
  void settings.patch({ detailCollapsed: !s.value.detailCollapsed })
}

async function onReset(): Promise<void> {
  if (!resetArmed.value) {
    resetArmed.value = true
    return
  }
  resetArmed.value = false
  await settings.resetAppearance()
  assets.notify('info', '外观设置已恢复默认')
}

async function openDataDir(): Promise<void> {
  const r = await window.stash.app.openUserData()
  if (!r.ok || !r.data?.opened) assets.notify('error', `打开失败：${r.data?.error ?? r.error ?? '未知原因'}`)
}

/** 诊断信息：出问题时让用户直接粘给开发者，省掉「你版本多少」的来回 */
async function copyDiagnostics(): Promise<void> {
  const t = info.value
  const text = [
    `Stash ${t?.version ?? '?'}`,
    `Electron ${t?.electron ?? '?'} / Chromium ${t?.chrome ?? '?'} / Node ${t?.node ?? '?'}`,
    `数据目录 ${t?.userData ?? '?'}`,
    `视图 ${s.value.defaultView} · 卡片宽 ${s.value.viewZoom}px`,
    `字段 ${CARD_FIELDS.filter((f) => s.value.cardFields[f.key]).map((f) => f.label).join('/') || '无'}` +
      (s.value.cardFields.typeBadge ? ' + 类型角标' : '')
  ].join('\n')
  const r = await window.stash.clipboard.writeText(text)
  if (r.ok) assets.notify('info', '诊断信息已复制')
  else assets.notify('error', `复制失败：${r.error ?? '未知原因'}`)
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-mask" data-settings-mask @mousedown.self="close">
      <div class="settings-panel" data-settings-panel>
        <div class="sp-nav">
          <div class="sp-nav-title">设置</div>
          <button
            v-for="g in GROUPS"
            :key="g.key"
            class="sp-nav-item"
            :class="{ on: active === g.key }"
            type="button"
            :data-sp-group="g.key"
            @click="pickGroup(g.key)"
          >
            {{ g.label }}
          </button>
        </div>

        <div class="sp-body">
          <button class="pv-close sp-close" data-sp-close type="button" title="关闭 (Esc)" @click="close">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
              <path d="M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8" />
            </svg>
          </button>

          <!-- ============ 外观与浏览 ============ -->
          <template v-if="active === 'appearance'">
            <h3 class="sp-h">外观与浏览</h3>
            <p class="sp-sub">改动立即生效，不需要重启</p>

            <div class="sp-row">
              <div class="sp-label">
                <div class="sp-name">默认视图</div>
                <div class="sp-tip">以前每次启动都会重置回瀑布，现在会记住</div>
              </div>
              <div class="sp-seg" data-sp-view>
                <button type="button" :class="{ on: s.defaultView === 'masonry' }" @click="pickView('masonry')">
                  瀑布
                </button>
                <button type="button" :class="{ on: s.defaultView === 'list' }" @click="pickView('list')">列表</button>
              </div>
            </div>

            <div class="sp-row">
              <div class="sp-label">
                <div class="sp-name">卡片大小</div>
                <div class="sp-tip">等价于网格工具栏上那根缩放滑杆</div>
              </div>
              <div class="sp-slider">
                <input
                  type="range"
                  data-sp-zoom
                  :min="VIEW_ZOOM_MIN"
                  :max="VIEW_ZOOM_MAX"
                  step="5"
                  :value="s.viewZoom"
                  aria-label="卡片大小"
                  @input="onZoom"
                />
                <span class="sp-num" data-sp-zoom-val>{{ s.viewZoom }} px</span>
                <span class="sp-tag">{{ densityLabel }}</span>
              </div>
            </div>

            <div class="sp-row">
              <div class="sp-label">
                <div class="sp-name">卡片显示字段</div>
                <div class="sp-tip">卡片下方那行信息，点一下立刻切换</div>
              </div>
              <div class="sp-chips" data-sp-fields>
                <button
                  v-for="f in CARD_FIELDS"
                  :key="f.key"
                  type="button"
                  class="sp-chip"
                  :class="{ on: s.cardFields[f.key] }"
                  :data-sp-field="f.key"
                  @click="assets.toggleCardField(f.key)"
                >
                  {{ f.label }}
                </button>
              </div>
            </div>

            <div class="sp-row">
              <div class="sp-label">
                <div class="sp-name">缩略图类型角标</div>
                <div class="sp-tip">在缩略图右上角标出图片 / 视频 / 音频 / 文本</div>
              </div>
              <button
                class="sp-sw"
                :class="{ on: s.cardFields.typeBadge }"
                type="button"
                role="switch"
                data-sp-badge
                :aria-checked="s.cardFields.typeBadge"
                @click="toggleBadge"
              >
                <i></i>
              </button>
            </div>

            <div class="sp-row">
              <div class="sp-label">
                <div class="sp-name">AI 来源角标</div>
                <div class="sp-tip">在缩略图左下角标出「有 AI 生成信息」的图（悬停可看来源）</div>
              </div>
              <button
                class="sp-sw"
                :class="{ on: s.cardFields.aiBadge }"
                type="button"
                role="switch"
                data-sp-ai-badge
                :aria-checked="s.cardFields.aiBadge"
                @click="toggleAiBadge"
              >
                <i></i>
              </button>
            </div>

            <div class="sp-row">
              <div class="sp-label">
                <div class="sp-name">详情栏默认收起</div>
                <div class="sp-tip">只看素材、不需要右侧信息时省出宽度</div>
              </div>
              <button
                class="sp-sw"
                :class="{ on: s.detailCollapsed }"
                type="button"
                role="switch"
                data-sp-detail
                :aria-checked="s.detailCollapsed"
                @click="toggleDetailCollapsed"
              >
                <i></i>
              </button>
            </div>

            <div class="sp-danger">
              <div class="sp-label">
                <div class="sp-name">恢复默认外观</div>
                <div class="sp-tip">只重置以上外观项；库列表、标签、素材都不动</div>
              </div>
              <button
                class="sp-btn danger"
                :class="{ armed: resetArmed }"
                type="button"
                data-sp-reset
                @click="onReset"
              >
                {{ resetArmed ? '再点一次确认' : '恢复默认' }}
              </button>
            </div>
          </template>

          <!-- ============ 预览与播放 ============ -->
          <template v-else-if="active === 'preview'">
            <h3 class="sp-h">预览与播放</h3>
            <p class="sp-sub">中栏双击打开的播放器与图片预览的行为</p>

            <div class="sp-row">
              <div class="sp-label">
                <div class="sp-name">播放条自动隐藏</div>
                <div class="sp-tip">指针静止或离开画面这么久就淡出；调成「不隐藏」则常驻</div>
              </div>
              <div class="sp-seg" data-sp-idle>
                <button
                  v-for="ms in choices?.idleHideMs ?? [2600]"
                  :key="ms"
                  type="button"
                  :class="{ on: s.preview.idleHideMs === ms }"
                  @click="pickIdle(ms)"
                >
                  {{ idleLabel(ms) }}
                </button>
              </div>
            </div>

            <div class="sp-row">
              <div class="sp-label">
                <div class="sp-name">打开中栏就自动播放</div>
                <div class="sp-tip">只影响双击打开的中栏浮层；右侧信息栏不会自动播</div>
              </div>
              <button
                class="sp-sw"
                :class="{ on: s.preview.autoPlay }"
                type="button"
                role="switch"
                data-sp-autoplay
                :aria-checked="s.preview.autoPlay"
                @click="toggleAutoPlay"
              >
                <i></i>
              </button>
            </div>

            <div class="sp-row">
              <div class="sp-label">
                <div class="sp-name">播放器初始音量</div>
                <div class="sp-tip">每次打开播放器的起始音量；当场拖动的音量不会被记住</div>
              </div>
              <div class="sp-slider">
                <input
                  type="range"
                  data-sp-volume
                  min="0"
                  max="100"
                  step="5"
                  :value="Math.round(s.preview.volume * 100)"
                  aria-label="初始音量"
                  @input="onVolume"
                />
                <span class="sp-num" data-sp-volume-val>{{ Math.round(s.preview.volume * 100) }}%</span>
              </div>
            </div>

            <div class="sp-row">
              <div class="sp-label">
                <div class="sp-name">高清预览上限</div>
                <div class="sp-tip">HEIC / TIFF / 超大图转成预览图时的长边上限，越大越清晰也越占空间</div>
              </div>
              <div class="sp-seg" data-sp-maxpx>
                <button
                  v-for="px in choices?.maxImagePx ?? [2560]"
                  :key="px"
                  type="button"
                  :class="{ on: s.preview.maxImagePx === px }"
                  @click="pickMaxPx(px)"
                >
                  {{ px }}
                </button>
              </div>
            </div>

            <div class="sp-row">
              <div class="sp-label">
                <div class="sp-name">文本预览上限</div>
                <div class="sp-tip">超过就不在软件内打开（直接读会卡），保存时也按这个上限拦</div>
              </div>
              <div class="sp-seg" data-sp-textmb>
                <button
                  v-for="mb in choices?.textMaxMb ?? [2]"
                  :key="mb"
                  type="button"
                  :class="{ on: Math.round(s.preview.textMaxBytes / 1024 / 1024) === mb }"
                  @click="pickTextMb(mb)"
                >
                  {{ mb }} MB
                </button>
              </div>
            </div>
          </template>

          <!-- ============ 缩略图与缓存 ============ -->
          <template v-else-if="active === 'cache'">
            <h3 class="sp-h">缩略图与缓存</h3>
            <p class="sp-sub">缓存都在素材库的 .thumbs 目录里，随库一起走</p>

            <div class="sp-cards" data-sp-cache>
              <div class="sp-card">
                <span class="sp-card-label">缩略图</span>
                <b class="sp-card-num" data-sp-cache-thumbs>{{ stats ? fmtSize(stats.thumbs.bytes) : '—' }}</b>
                <span class="sp-card-sub">{{ stats?.thumbs.files ?? 0 }} 个文件</span>
              </div>
              <div class="sp-card">
                <span class="sp-card-label">派生预览</span>
                <b class="sp-card-num" data-sp-cache-derived>{{ stats ? fmtSize(stats.derived.bytes) : '—' }}</b>
                <span class="sp-card-sub">{{ stats?.derived.files ?? 0 }} 个文件</span>
              </div>
              <div class="sp-card">
                <span class="sp-card-label">合计占用</span>
                <b class="sp-card-num" data-sp-cache-total>{{ stats ? fmtSize(stats.total.bytes) : '—' }}</b>
                <span class="sp-card-sub">{{ stats?.total.files ?? 0 }} 个文件</span>
              </div>
            </div>

            <div class="sp-row">
              <div class="sp-label">
                <div class="sp-name">清理并重建缩略图</div>
                <div class="sp-tip">删掉后立刻按当前质量重新生成，卡片不会变空</div>
              </div>
              <button
                class="sp-btn danger"
                :class="{ armed: arm === 'thumbs' }"
                type="button"
                data-sp-clear-thumbs
                :disabled="busy"
                @click="doClear('thumbs')"
              >
                {{ arm === 'thumbs' ? '再点一次确认' : '清理并重建' }}
              </button>
            </div>

            <div class="sp-row">
              <div class="sp-label">
                <div class="sp-name">清理派生预览</div>
                <div class="sp-tip">HEIC / TIFF 大图与老视频的转码结果 —— 删掉后下次打开要重新转码</div>
              </div>
              <button
                class="sp-btn danger"
                :class="{ armed: arm === 'derived' }"
                type="button"
                data-sp-clear-derived
                :disabled="busy"
                @click="doClear('derived')"
              >
                {{ arm === 'derived' ? '再点一次确认' : '清理' }}
              </button>
            </div>

            <div class="sp-row">
              <div class="sp-label">
                <div class="sp-name">生成并发数</div>
                <div class="sp-tip">同时跑几个缩略图任务；机器吃力就调小，SSD 快可以调大</div>
              </div>
              <div class="sp-slider">
                <input
                  type="range"
                  data-sp-conc
                  :min="choices?.concurrency.min ?? 1"
                  :max="choices?.concurrency.max ?? 8"
                  step="1"
                  :value="s.thumbs.concurrency"
                  aria-label="缩略图生成并发数"
                  @input="onConc"
                />
                <span class="sp-num" data-sp-conc-val>{{ s.thumbs.concurrency }}</span>
              </div>
            </div>

            <div class="sp-row">
              <div class="sp-label">
                <div class="sp-name">缩略图质量</div>
                <div class="sp-tip">只影响之后新生成的缩略图；已缓存的要清理重建才会重算</div>
              </div>
              <div class="sp-seg" data-sp-quality>
                <button
                  v-for="q in choices?.quality ?? [82]"
                  :key="q"
                  type="button"
                  :class="{ on: s.thumbs.quality === q }"
                  @click="pickQuality(q)"
                >
                  {{ q }}
                </button>
              </div>
            </div>

            <div class="sp-actions">
              <button class="sp-btn" type="button" data-sp-open-cache @click="openCacheDir">打开缓存目录</button>
            </div>
          </template>

          <!-- ============ 导入 ============ -->
          <template v-else-if="active === 'importing'">
            <h3 class="sp-h">导入</h3>
            <p class="sp-sub">工具栏的「导入」按钮与拖文件进窗口，都按这里的设置走</p>

            <div class="sp-row">
              <div class="sp-label">
                <div class="sp-name">默认导入方式</div>
                <div class="sp-tip">「移动」会把原文件从原位置搬进库（源目录里就没有了），不是复制一份</div>
              </div>
              <div class="sp-seg" data-sp-import-mode>
                <button
                  type="button"
                  :class="{ on: s.importing.mode === 'copy' }"
                  @click="pickImportMode('copy')"
                >
                  复制
                </button>
                <button
                  type="button"
                  :class="{ on: s.importing.mode === 'move' }"
                  @click="pickImportMode('move')"
                >
                  移动
                </button>
              </div>
            </div>

            <div class="sp-row">
              <div class="sp-label">
                <div class="sp-name">按内容去重</div>
                <div class="sp-tip">同内容的文件再导一次会跳过；关掉则照样导入（重名自动改名，不覆盖）</div>
              </div>
              <button
                class="sp-sw"
                :class="{ on: s.importing.dedupe }"
                type="button"
                role="switch"
                data-sp-dedupe
                :aria-checked="s.importing.dedupe"
                @click="toggleDedupe"
              >
                <i></i>
              </button>
            </div>

            <div class="sp-row">
              <div class="sp-label">
                <div class="sp-name">生成主色板</div>
                <div class="sp-tip">导入图片时顺带提取配色（详情栏那些色块）。关掉省一点 CPU，已有的不受影响</div>
              </div>
              <button
                class="sp-sw"
                :class="{ on: s.importing.palette }"
                type="button"
                role="switch"
                data-sp-palette
                :aria-checked="s.importing.palette"
                @click="togglePalette"
              >
                <i></i>
              </button>
            </div>

            <div class="sp-row">
              <div class="sp-label">
                <div class="sp-name">提取提示词</div>
                <div class="sp-tip">
                  导入时把图片里自带的提示词自动填进「提示词」字段（只填空的，不覆盖你写过的）。
                  支持 ComfyUI、A1111·Forge、Fooocus、InvokeAI、NovelAI、Midjourney
                </div>
              </div>
              <button
                class="sp-sw"
                :class="{ on: s.importing.extractMeta }"
                type="button"
                role="switch"
                data-sp-extract-meta
                :aria-checked="s.importing.extractMeta"
                @click="toggleExtractMeta"
              >
                <i></i>
              </button>
            </div>

            <div class="sp-row">
              <div class="sp-label">
                <div class="sp-name">识别 AI 来源</div>
                <div class="sp-tip">
                  认 C2PA 内容凭据、国内 AIGC 隐式标识与 EXIF·XMP 痕迹。⚠️ GPT-image / DALL·E
                  这类图里**只有来源、没有提示词**，开了也提不出提示词
                </div>
              </div>
              <button
                class="sp-sw"
                :class="{ on: s.importing.detectAi }"
                type="button"
                role="switch"
                data-sp-detect-ai
                :aria-checked="s.importing.detectAi"
                @click="toggleDetectAi"
              >
                <i></i>
              </button>
            </div>

            <div class="sp-note">
              <b>重名规则是固定的</b>：目标目录已有同名文件时自动改成「名字 (1).ext」，绝不覆盖、也绝不清空；
              文件类型不支持则整体跳过。导入 / 移动 / 复制 / 重命名共用同一套规则，避免各写一份后出现分叉。
            </div>
          </template>

          <!-- ============ 库与存储 ============ -->
          <template v-else-if="active === 'library'">
            <h3 class="sp-h">库与存储</h3>
            <p class="sp-sub">库是自包含的：素材文件 + .stash 索引 + .thumbs 缓存，全在库目录里</p>

            <div class="sp-kv">
              <span>库名称</span><b data-sp-lib-name>{{ libStats?.name || lib.info?.name || '—' }}</b>
              <span>位置</span>
              <b class="sp-path" :title="libStats?.path">{{ libStats?.path ?? '—' }}</b>
              <span>素材</span>
              <b data-sp-lib-assets>
                {{ fmtCount(libStats?.assets ?? 0) }} 个 · {{ libStats ? fmtSize(libStats.bytes) : '—' }}
              </b>
              <span>失效记录</span>
              <b data-sp-lib-missing>{{ libStats?.missingFlagged ?? 0 }} 条</b>
            </div>

            <div class="sp-row">
              <div class="sp-label">
                <div class="sp-name">库体检</div>
                <div class="sp-tip">逐个核对磁盘，找出「索引里还留着、文件已经不在」的素材</div>
              </div>
              <button class="sp-btn" type="button" data-sp-scan :disabled="scanning" @click="runScan">
                {{ scanning ? '核对中…' : '开始体检' }}
              </button>
            </div>

            <div v-if="scan" class="sp-note" data-sp-scan-result>
              <template v-if="scan.missing === 0">
                核对了 {{ fmtCount(scan.checked) }} 个素材，文件都在。
              </template>
              <template v-else>
                核对了 {{ fmtCount(scan.checked) }} 个素材，其中 <b>{{ scan.missing }} 个</b>
                的文件已经不在磁盘上：{{ scan.samples.join('、')
                }}{{ scan.missing > scan.samples.length ? ' 等' : '' }}
              </template>
            </div>

            <div v-if="scan && scan.missing > 0" class="sp-danger">
              <div class="sp-label">
                <div class="sp-name">清理失效记录</div>
                <div class="sp-tip">只删索引行与对应缓存，磁盘上的用户文件一个都不碰</div>
              </div>
              <button
                class="sp-btn danger"
                :class="{ armed: cleanArmed }"
                type="button"
                data-sp-clean-missing
                :disabled="libBusy"
                @click="cleanMissing"
              >
                {{ cleanArmed ? '再点一次确认' : `清理 ${scan.missing} 条` }}
              </button>
            </div>

            <div class="sp-actions">
              <button class="sp-btn" type="button" data-sp-open-lib @click="revealLibrary">在资源管理器打开库目录</button>
              <button class="sp-btn" type="button" data-sp-lib-data-dir @click="openDataDir">打开数据目录</button>
            </div>

            <div class="sp-danger">
              <div class="sp-label">
                <div class="sp-name">删除此库</div>
                <div class="sp-tip">库目录连同里面的素材一起从磁盘物理删除，不进回收站、无法恢复</div>
              </div>
              <button
                class="sp-btn danger"
                :class="{ armed: deleteLibArmed }"
                type="button"
                data-sp-delete-lib
                :disabled="libBusy"
                @click="doDeleteLibrary"
              >
                {{ deleteLibArmed ? '再点一次确认' : '删除此库' }}
              </button>
            </div>
          </template>

          <!-- ============ 快捷键（只读） ============ -->
          <template v-else-if="active === 'shortcuts'">
            <h3 class="sp-h">快捷键</h3>
            <p class="sp-sub">目前支持的键位一览；自定义键位还没做，这里只读</p>

            <div class="sp-keys" data-sp-shortcuts>
              <div v-for="k in SHORTCUTS" :key="k.keys" class="sp-key-row">
                <kbd class="sp-kbd">{{ k.keys }}</kbd>
                <span class="sp-key-what">{{ k.what }}</span>
                <span class="sp-key-where">{{ k.where }}</span>
              </div>
            </div>

            <div class="sp-note">
              另有两处不用键盘的习惯性操作：把文件<b>拖进窗口</b>即导入到当前文件夹；
              中栏浮层里<b>点画面</b>即播放 / 暂停。
            </div>
          </template>

          <!-- ============ 关于 ============ -->
          <template v-else>
            <h3 class="sp-h">关于</h3>
            <p class="sp-sub">本地素材库 · 所有数据都在你自己的磁盘上</p>

            <div class="sp-kv">
              <span>版本</span><b data-sp-version>{{ info?.version ?? '—' }}</b>
              <span>Electron</span><b>{{ info?.electron ?? '—' }}</b>
              <span>Chromium</span><b>{{ info?.chrome ?? '—' }}</b>
              <span>Node</span><b>{{ info?.node ?? '—' }}</b>
              <span>数据目录</span>
              <b class="sp-path" :title="info?.userData">{{ info?.userData ?? '—' }}</b>
            </div>

            <div class="sp-note">
              <b>第三方组件许可</b>：缩略图与转码用 sharp（Apache-2.0）与 ffmpeg-static 附带的 FFmpeg
              （<b>GPL-3.0</b>，按需调用外部可执行文件）。字体与图标均为本地资源，不联网。
            </div>

            <div class="sp-actions">
              <button class="sp-btn" type="button" data-sp-open-data @click="openDataDir">打开数据目录</button>
              <button class="sp-btn" type="button" data-sp-copy-diag @click="copyDiagnostics">复制诊断信息</button>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>
