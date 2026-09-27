<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useLibraryStore } from '../stores/library'
import { useAssetStore } from '../stores/assets'
import { fmtSize, fmtDate, fmtDuration } from '../utils/format'

const lib = useLibraryStore()
const assets = useAssetStore()

const asset = computed(() => assets.detail)

// 选中素材时确保 detail 尺寸缩略图存在，再刷新预览
const detailReady = ref(0)
// 索引缺尺寸时用图片实际加载尺寸兜底
const natRatio = ref<string | null>(null)

watch(
  () => asset.value?.id,
  async (id) => {
    natRatio.value = null
    // 换素材时退出编辑态，否则会把上一张的草稿带到下一张上
    editingNote.value = false
    noteDraft.value = ''
    noteCopied.value = false
    // 色板的「已复制」高亮同理：换了素材就不该还亮着上一张的某个色块
    copiedColor.value = null
    if (id && asset.value?.content_hash) {
      await window.stash.thumb.ensure(id, 'detail')
      detailReady.value++
    }
  }
)

/** 预览容器按素材真实宽高比撑开，高度由宽度推出；超长图由 CSS max-height 兜底 */
const previewStyle = computed(() => {
  const a = asset.value
  if (a?.width && a?.height) return { aspectRatio: `${a.width} / ${a.height}` }
  if (natRatio.value) return { aspectRatio: natRatio.value }
  return { aspectRatio: '4 / 3.6' }
})

/** 加载完成：淡入；索引缺宽高时用图片真实尺寸补出比例 */
function onPreviewLoad(ev: Event): void {
  const el = ev.target as HTMLImageElement
  el.style.opacity = '1'
  if (!(asset.value?.width && asset.value?.height) && el.naturalWidth && el.naturalHeight) {
    natRatio.value = `${el.naturalWidth} / ${el.naturalHeight}`
  }
}

const ext = computed(() => asset.value?.ext.toUpperCase() ?? '')
const pathText = computed(() => (asset.value && lib.info ? `${lib.info.path}\\${asset.value.rel_path.replace(/\//g, '\\')}` : ''))

const paletteColors = computed<string[]>(() => {
  if (!asset.value?.palette) return []
  try {
    return JSON.parse(asset.value.palette) as string[]
  } catch {
    return []
  }
})

// —— 色板：点一下复制该颜色的十六进制 ——
const copiedColor = ref<string | null>(null)
let colorTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 统一成大写 `#RRGGBB`。
 * 色板数据本来就是 `#rrggbb`（见 `thumbs.computePalette`），这里只是兜住将来可能
 * 换成简写 `#rgb` 或 `rgb()` 写法的情况 —— 复制出去的东西必须是能直接粘进代码/设计稿的。
 */
function hexOf(c: string): string {
  const s = (c ?? '').trim()
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toUpperCase()
  if (/^#[0-9a-f]{3}$/i.test(s)) {
    const [r, g, b] = s.slice(1).split('')
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase()
  }
  const m = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(s)
  if (m) {
    return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`.toUpperCase()
  }
  return s
}

async function copyColor(c: string): Promise<void> {
  const hex = hexOf(c)
  const r = await window.stash.clipboard.writeText(hex)
  if (!r.ok) return void assets.notify('error', `复制颜色失败：${r.error}`)
  // 反馈落在被点的那个色块上（对勾），比只弹一条远处的提示更直观
  copiedColor.value = c
  if (colorTimer) clearTimeout(colorTimer)
  colorTimer = setTimeout(() => (copiedColor.value = null), 1200)
  assets.notify('info', `已复制颜色 ${hex}`)
}

onBeforeUnmount(() => {
  if (colorTimer) clearTimeout(colorTimer)
})

const dimsText = computed(() => {
  const a = asset.value
  if (!a) return ''
  if (a.width && a.height) return `${a.width} × ${a.height}`
  if (a.duration_ms) return fmtDuration(a.duration_ms)
  return '—'
})

// —— 评分 / 喜欢 ——
// 悬停预览到第 n 星，点第 n 星即为设为 n 星；再点当前星级则清零
const hoverStar = ref(0)
async function setRating(n: number): Promise<void> {
  if (!asset.value) return
  const next = asset.value.rating === n ? 0 : n
  await assets.patchLocal(asset.value.id, { rating: next })
}
async function toggleFav(): Promise<void> {
  if (!asset.value) return
  // 传 DB 列名 is_fav（0/1），patchLocal 会把它翻成 IPC 的 isFav 并就地更新本地行
  await assets.patchLocal(asset.value.id, { is_fav: asset.value.is_fav ? 0 : 1 })
}

// —— 标签：点击已有标签移除；输入搜索或新建后挂上 ——
const addingTag = ref(false)
const newTag = ref('')

/** 悬浮下拉最多 4 行：详情栏是窄条，再多就把下面的评分区盖住了 */
const RECENT_LIMIT = 4

/** 已挂在本素材上的标签不进下拉（上方 chip 已经能看到） */
const attachedTagIds = computed(() => asset.value?.tags.map((t) => t.id) ?? [])

/**
 * 下拉内容：没输入 = 最近添加的 4 个标签；输着字 = 名字含输入的（同样 4 行封顶）。
 * 两种情况都排除当前素材已挂的标签。
 */
const tagOptions = computed(() => lib.recentTags(attachedTagIds.value, RECENT_LIMIT, newTag.value))

/** 下拉一行都没有时的说明：区分「库里还没标签」「近期标签都已挂上」「输完回车会新建一个」 */
const menuHint = computed(() => {
  const q = newTag.value.trim()
  if (q) return `回车创建「${q}」`
  return lib.tags.length ? '近期标签都已添加' : '输入名称新建第一个标签'
})

function closeTagInput(): void {
  addingTag.value = false
  newTag.value = ''
}

/**
 * 把某个标签挂到当前素材上（只管挂，不碰输入框）。
 * 已经挂过就直接返回，避免 setTags 原样重写一遍。
 */
async function attachTag(tagId: number): Promise<boolean> {
  const a = asset.value
  if (!a) return false
  if (a.tags.some((t) => t.id === tagId)) return true
  const r = await window.stash.asset.setTags(a.id, [...a.tags.map((t) => t.id), tagId])
  if (!r.ok) {
    assets.notify('error', `添加标签失败：${r.error ?? '未知错误'}`)
    return false
  }
  // 标签数量变了，侧栏计数与标签列表都要跟着刷新，再重拉当前素材
  await lib.loadMeta()
  await assets.select(a.id)
  return true
}

async function addTag(): Promise<void> {
  const name = newTag.value.trim()
  if (!asset.value || !name) {
    addingTag.value = false
    return
  }
  const existing = lib.tags.find((t) => t.name === name)
  const created = existing ? null : await window.stash.tag.create({ name })
  if (created && !created.ok) {
    addingTag.value = false
    newTag.value = ''
    return void assets.notify('error', `新建标签失败：${created.error ?? '未知错误'}`)
  }
  const tagId = existing ? existing.id : created?.data?.id
  if (tagId) await attachTag(tagId)
  addingTag.value = false
  newTag.value = ''
}

/** 点下拉里的标签：挂上后**不关输入框**，方便连着加好几个 */
async function pickRecent(tagId: number): Promise<void> {
  await attachTag(tagId)
  newTag.value = ''
}

/** 从当前素材上摘掉某个标签（标签还有别的素材挂着就保留，挂了 0 个会被服务层自动删掉） */
async function removeTag(tagId: number): Promise<void> {
  const a = asset.value
  if (!a) return
  const r = await window.stash.asset.setTags(a.id, a.tags.filter((t) => t.id !== tagId).map((t) => t.id))
  // 必须检查返回：IPC 失败时上面那行是静默的，界面看着像「点了没反应」
  if (!r.ok) return void assets.notify('error', `移除标签失败：${r.error ?? '未知错误'}`)
  // 摘掉的标签若一个素材都不剩，会被服务层自动删除。先清掉指向它的筛选再刷新，
  // 否则列表会停在一个永远查不到东西的条件上（看着像「标签删了，列表也空了」）
  const pruned = r.data?.pruned
  const filterReset = assets.dropPrunedTagFilter(pruned)
  await lib.loadMeta()
  if (filterReset) await assets.refresh()
  await assets.select(a.id)
  const note = assets.prunedNote(pruned)
  if (note) assets.notify('info', `已从该素材上移除标签；${note}`)
}

// —— 提示词 / 备注 ——
// 平时只读预览（双击才进编辑），避免误触改内容；右上角提供一键复制。
const editingNote = ref(false)
const noteDraft = ref('')
const noteCopied = ref(false)
const noteInput = ref<HTMLTextAreaElement | null>(null)

function beginEditNote(): void {
  if (!asset.value) return
  noteDraft.value = asset.value.note ?? ''
  editingNote.value = true
  nextTick(() => noteInput.value?.focus())
}

/** 提交：内容没变就不发 IPC，避免无谓的写库 */
async function commitNote(): Promise<void> {
  if (!editingNote.value) return
  const a = asset.value
  editingNote.value = false
  if (!a) return
  if ((a.note ?? '') === noteDraft.value) return
  await assets.saveNote(a.id, noteDraft.value)
}

function cancelNote(): void {
  editingNote.value = false
  noteDraft.value = ''
}

/** 复制提示词到系统剪贴板（剪贴板 API 不可用时退回 textarea + execCommand） */
async function copyNote(): Promise<void> {
  const text = asset.value?.note ?? ''
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
    } catch {
      /* 彻底失败就只给个 toast，别静默 */
      assets.notify('error', '复制失败，请手动选中文本复制')
      ta.remove()
      return
    }
    ta.remove()
  }
  noteCopied.value = true
  window.setTimeout(() => (noteCopied.value = false), 1500)
}
</script>

<template>
  <aside class="detail">
    <template v-if="asset">
      <div class="detail-preview" :style="previewStyle">
        <img
          v-if="asset.content_hash"
          :key="detailReady"
          class="detail-img"
          :src="assets.thumbUrl(asset.content_hash, 'detail')"
          @error="($event.target as HTMLImageElement).style.opacity = '0'"
          @load="onPreviewLoad"
        />
        <span v-else class="detail-fallback">无预览</span>
      </div>
      <div class="detail-body">
        <div class="d-name">
          <svg viewBox="0 0 13 13" fill="currentColor"><path d="M6.5 1l1.2 3.6 3.6 1.2-3.6 1.2L6.5 10.6 5.3 7 1.7 5.8l3.6-1.2L6.5 1z" /></svg>
          <span>{{ asset.name }}</span>
        </div>
        <div class="d-meta">{{ ext }} · {{ dimsText }} · {{ fmtSize(asset.size) }} · {{ fmtDate(asset.imported_at) }}</div>

        <div class="d-section">
          <div class="d-label">标签</div>
          <div class="tag-chips">
            <span
              v-for="t in asset.tags"
              :key="t.id"
              class="tag-chip"
              :data-tag-id="t.id"
              :title="`点击移除「${t.name}」`"
              @click="removeTag(t.id)"
            >
              <span class="tag-dot" :style="{ background: t.color }"></span>{{ t.name }}<span class="tag-x" aria-hidden="true">×</span>
            </span>
            <span v-if="!asset.tags.length" class="d-hint">暂无标签</span>
            <span class="tag-chip tag-add" data-add-tag @click="addingTag = true">＋</span>
          </div>
          <div v-if="addingTag" class="inline-form">
            <svg class="tag-search-ico" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" aria-hidden="true">
              <path d="M1.7 2.4c0-.4.3-.7.7-.7h3.2c.2 0 .4.1.5.2l3.9 3.9c.3.3.3.7 0 1l-3 3c-.3.3-.7.3-1 0L2 5.9a.7.7 0 0 1-.2-.5V2.4z" />
              <circle cx="4.1" cy="4.1" r=".85" fill="currentColor" stroke="none" />
            </svg>
            <input
              v-model="newTag"
              placeholder="搜索或创建标签…"
              autofocus
              @keyup.enter="addTag"
              @blur="addTag"
              @keyup.esc="closeTagInput"
            />
            <!-- 悬浮下拉：absolute 定位浮在输入框下方，不占文档流（下方评分区不会被推下去） -->
            <div class="tag-menu" data-tag-menu>
              <span v-if="!tagOptions.length" class="tag-menu-empty" data-tag-menu-empty>{{ menuHint }}</span>
              <button
                v-for="t in tagOptions"
                :key="t.id"
                type="button"
                class="tag-menu-item"
                :data-tag-option-id="t.id"
                :title="`添加标签「${t.name}」`"
                @mousedown.prevent
                @click="pickRecent(t.id)"
              >
                <span class="tag-dot" :style="{ background: t.color }"></span><span class="tag-menu-name">{{ t.name }}</span><span class="tag-menu-count">{{ lib.tagCount(t.id) }}</span>
              </button>
            </div>
          </div>
          <div class="rate-row">
            <div class="stars" @mouseleave="hoverStar = 0">
              <svg
                v-for="n in 5"
                :key="n"
                class="star"
                :class="{ on: n <= (hoverStar || asset.rating) }"
                viewBox="0 0 12 12"
                :fill="n <= (hoverStar || asset.rating) ? 'currentColor' : 'none'"
                :stroke="n <= (hoverStar || asset.rating) ? 'none' : 'currentColor'"
                :title="asset.rating === n ? '点击清除评分' : `设为 ${n} 星`"
                @mouseenter="hoverStar = n"
                @click="setRating(n)"
              >
                <path d="M6 1.2l1.45 2.95 3.25.5-2.35 2.3.55 3.25L6 8.7 3.1 10.2l.55-3.25L1.3 4.65l3.25-.5L6 1.2z" stroke-width="1" stroke-linejoin="round" />
              </svg>
            </div>
            <button class="heart-btn" :class="{ on: asset.is_fav }" :title="asset.is_fav ? '取消喜欢' : '喜欢'" @click="toggleFav">
              <svg viewBox="0 0 13 13" :fill="asset.is_fav ? 'currentColor' : 'none'"><path d="M6.5 10.8S1.8 8.2 1.8 4.9c0-1.5 1.2-2.7 2.6-2.7 1 0 1.7.6 2.1 1.2.4-.6 1.1-1.2 2.1-1.2 1.4 0 2.6 1.2 2.6 2.7 0 3.3-4.7 5.9-4.7 5.9z" stroke="currentColor" stroke-width="1.1" /></svg>
            </button>
          </div>
        </div>

        <div v-if="paletteColors.length" class="d-section">
          <div class="d-label">
            色板<span class="d-label-hint">点击色块复制十六进制</span>
          </div>
          <div class="palette">
            <button
              v-for="(c, i) in paletteColors"
              :key="i"
              type="button"
              class="swatch"
              :class="{ copied: copiedColor === c }"
              :style="{ background: c }"
              :title="`复制 ${hexOf(c)}`"
              :data-color="hexOf(c)"
              @click="copyColor(c)"
            >
              <svg v-if="copiedColor === c" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M2.3 6.2l2.4 2.4 5-5.3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          </div>
        </div>

        <!-- 提示词 / 备注：平时只读，双击进入编辑；右上角一键复制 -->
        <div class="d-section">
          <div class="d-label d-label-row">
            <span>提示词</span>
            <button
              class="note-copy"
              :class="{ ok: noteCopied }"
              :disabled="!asset.note"
              :title="asset.note ? '复制提示词' : '暂无提示词'"
              data-note-copy
              @click="copyNote"
            >
              <svg v-if="!noteCopied" viewBox="0 0 13 13" fill="none">
                <rect x="4.4" y="1.6" width="7" height="7.8" rx="1.3" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
                <path d="M8.6 11.4H3.3a1.3 1.3 0 0 1-1.3-1.3V4.6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <svg v-else viewBox="0 0 13 13" fill="none">
                <path d="M2.4 6.9l2.6 2.6 5.6-5.9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          </div>
          <textarea
            v-if="editingNote"
            ref="noteInput"
            v-model="noteDraft"
            class="note-input"
            data-note-input
            placeholder="写下提示词 / 备注…"
            spellcheck="false"
            @blur="commitNote"
            @keydown.esc="cancelNote"
            @keydown.ctrl.enter="commitNote"
          ></textarea>
          <div
            v-else
            class="note-view"
            :class="{ empty: !asset.note }"
            data-note-view
            title="双击编辑提示词"
            @dblclick="beginEditNote"
          >{{ asset.note || '双击添加提示词 / 备注' }}</div>
        </div>

        <div class="d-section">
          <div class="d-label">基本信息</div>
          <div class="kv"><span class="k">类型</span><span class="v">{{ { image: '图片', video: '视频', audio: '音频', text: '文本' }[asset.type] }}</span></div>
          <div class="kv"><span class="k">格式</span><span class="v">{{ ext }}</span></div>
          <div class="kv"><span class="k">尺寸/时长</span><span class="v">{{ dimsText }}</span></div>
          <div class="kv"><span class="k">文件大小</span><span class="v">{{ fmtSize(asset.size) }}</span></div>
          <div class="kv"><span class="k">导入时间</span><span class="v">{{ fmtDate(asset.imported_at) }}</span></div>
        </div>

        <div class="d-section">
          <div class="kv"><span class="k">存储位置</span><span class="v path" :title="pathText">{{ pathText }}</span></div>
        </div>
      </div>
    </template>
    <div v-else class="detail-empty">
      <p>未选中素材</p>
      <p class="empty-sub">在中间画廊点击卡片查看详情</p>
    </div>
  </aside>
</template>
