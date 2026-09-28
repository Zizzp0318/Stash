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
import { useSettingsStore } from '../stores/settings'
import { fmtSize } from '../utils/format'
import type { StashAppInfo, StashCacheStats, StashSettingsChoices } from '../env'

const settings = useSettingsStore()
const assets = useAssetStore()

type GroupKey = 'appearance' | 'preview' | 'cache' | 'about'
const GROUPS: Array<{ key: GroupKey; label: string }> = [
  { key: 'appearance', label: '外观与浏览' },
  { key: 'preview', label: '预览与播放' },
  { key: 'cache', label: '缩略图与缓存' },
  { key: 'about', label: '关于' }
]
const active = ref<GroupKey>('appearance')

const info = ref<StashAppInfo | null>(null)
const stats = ref<StashCacheStats | null>(null)
const choices = ref<StashSettingsChoices | null>(null)
/** 清理中的防重入 */
const busy = ref(false)
/** 危险动作的二次确认（点一下变文案，再点才真做） */
const arm = ref<'thumbs' | 'derived' | null>(null)
/** 重置的二次确认：点一下变「再点一次确认」，避免误触 */
const resetArmed = ref(false)

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
/** 切分组：顺手把这一组要的数据拉一下（缓存占用是会变的，别停在打开面板那一刻的旧数字） */
function pickGroup(k: GroupKey): void {
  active.value = k
  arm.value = null
  if (k === 'cache') void loadStats()
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
