<script setup lang="ts">
import { ref, computed, reactive, onMounted, onBeforeUnmount } from 'vue'
import { heart } from '@/data/mock'
import { useLibraryStore } from '../stores/library'
import { useAssetStore, CARD_FIELDS, VIEW_ZOOM_MIN, VIEW_ZOOM_MAX } from '../stores/assets'
import { fmtSize, fmtDate, fmtCount, fmtDuration } from '../utils/format'
import type { StashAssetRow } from '../env'

const lib = useLibraryStore()
const assets = useAssetStore()

const view = ref<'masonry' | 'list'>('masonry')

// 上下文标题
const title = computed(() => {
  if (assets.query.tagId != null) {
    return lib.tags.find((t) => t.id === assets.query.tagId)?.name ?? '标签'
  }
  if (assets.query.folderId != null) {
    // Pinia setup store 的 computed 在实例上已解包，直接 .get()
    return lib.folderById.get(assets.query.folderId)?.name ?? '文件夹'
  }
  return '所有素材'
})

// —— 筛选芯片 ——
const sortLabel = computed(
  () => ({ imported_at: '导入时间', name: '名称', size: '大小', rating: '评分' })[assets.query.sort] ?? '排序'
)

async function cycleRating(): Promise<void> {
  assets.query.rating = (assets.query.rating + 1) % 6
  await assets.refresh()
}
async function toggleFav(): Promise<void> {
  assets.query.fav = !assets.query.fav
  await assets.refresh()
}
async function cycleSort(): Promise<void> {
  const order = ['imported_at', 'name', 'size', 'rating']
  const next = order[(order.indexOf(assets.query.sort) + 1) % order.length]
  assets.query.sort = next
  assets.query.order = next === 'name' ? 'asc' : 'desc'
  await assets.refresh()
}

// —— 导入 ——
async function importFiles(): Promise<void> {
  const paths = await window.stash.dialog.pickFiles()
  if (!paths.length) return
  await window.stash.import.files({ paths, folderId: assets.query.folderId, mode: 'copy' })
}

// —— 卡片 ——
const TYPE_ICON: Record<string, string> = { image: '🖼', video: '🎬', audio: '🎵', text: '📄' }

/** 尺寸：仅宽×高 / 时长，取不到时留空（不再回落到文件大小，避免与「大小」重复） */
function dimsOnly(it: StashAssetRow): string {
  if (it.width && it.height) return `${it.width} × ${it.height}`
  if (it.duration_ms) return fmtDuration(it.duration_ms)
  return ''
}

/** 卡片下方常驻信息区的元数据行（按开关拼接，空项自动省略） */
function metaText(it: StashAssetRow): string {
  const parts: string[] = []
  if (assets.cardFields.dims) {
    const d = dimsOnly(it)
    if (d) parts.push(d)
  }
  if (assets.cardFields.size) parts.push(fmtSize(it.size))
  if (assets.cardFields.time) parts.push(fmtDate(it.imported_at))
  return parts.join(' · ')
}

// ==================== 瀑布视图布局 ====================
const MASONRY_GAP = 12
// .card 的内边距（缩略图内缩量），必须与 main.css .card 的 padding 一致
const CARD_PAD = 4
// 信息区高度常量，必须与 main.css 中 .card-info / .ci-name / .ci-meta 的行高一一对应，
// 卡片高度靠这里算出（而不是等 DOM 测量），布局才不会有抖动
const INFO_PAD_Y = 13 // padding 6 + 7
const INFO_NAME_H = 17 // .ci-name line-height
const INFO_META_H = 16 // .ci-meta line-height 15 + margin-top 1
const INFO_BORDER = 1 // .card-info border-top

const gridWrap = ref<HTMLElement | null>(null)
const containerW = ref(0)
let ro: ResizeObserver | null = null

onMounted(() => {
  const el = gridWrap.value
  if (!el || typeof ResizeObserver === 'undefined') return
  containerW.value = el.clientWidth
  ro = new ResizeObserver((entries) => {
    containerW.value = entries[0].contentRect.width
  })
  ro.observe(el)
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
})

/** 列数：由滑块目标宽度决定，至少 1 列 */
const cols = computed(() => {
  const w = containerW.value
  if (w <= 0) return 1
  return Math.max(1, Math.floor((w + MASONRY_GAP) / (assets.viewZoom + MASONRY_GAP)))
})

/** 实际卡片宽度：容器宽度均分给各列（撑满，右侧不留白） */
const cardW = computed(() => {
  const w = containerW.value
  const c = cols.value
  if (w <= 0) return 0
  return (w - MASONRY_GAP * (c - 1)) / c
})

// 图片宽高比（h / w）：优先用索引里的尺寸，索引缺失时用图片实际加载尺寸兜底
const measuredRatio = reactive(new Map<number, number>())

function ratioOf(it: StashAssetRow): number {
  const m = measuredRatio.get(it.id)
  if (m) return m
  if (it.width && it.height) return it.height / it.width
  return 0.75 // 未知尺寸的默认比例（4:3）
}

/** 缩略图可视宽度 = 卡片宽度 - 两侧内边距 */
const thumbW = computed(() => Math.max(0, cardW.value - CARD_PAD * 2))

function thumbH(it: StashAssetRow): number {
  return Math.round(thumbW.value * ratioOf(it))
}

function infoH(it: StashAssetRow): number {
  let h = INFO_PAD_Y
  if (assets.cardFields.name) h += INFO_NAME_H
  if (metaText(it)) h += INFO_META_H
  return h
}

interface Placed {
  it: StashAssetRow
  x: number
  y: number
  w: number
  h: number
  thumb: number
}

/** 最短列优先装箱：每张卡片放进当前最矮的一列，得到绝对定位坐标 */
const placed = computed<Placed[]>(() => {
  const w = cardW.value
  const c = cols.value
  if (w <= 0) return []
  const heights = new Array<number>(c).fill(0)
  const out: Placed[] = []
  for (const it of assets.items) {
    let k = 0
    for (let i = 1; i < c; i++) if (heights[i] < heights[k]) k = i
    const th = thumbH(it)
    // 卡片总高 = 上下内边距 + 缩略图 + 信息区（含分隔线）
    const h = th + infoH(it) + INFO_BORDER + CARD_PAD * 2
    out.push({ it, x: Math.round(k * (w + MASONRY_GAP)), y: Math.round(heights[k]), w: Math.round(w), h, thumb: th })
    heights[k] += h + MASONRY_GAP
  }
  return out
})

/** 瀑布容器总高度 = 最长列的底部 */
const masonryHeight = computed(() => placed.value.reduce((m, p) => Math.max(m, p.y + p.h), 0))

function onImgErr(it: StashAssetRow, ev: Event): void {
  ;(ev.target as HTMLImageElement).style.opacity = '0'
  console.warn('IMG_ERR', it.name, it.content_hash)
}

/** 加载完成：恢复透明度；索引缺尺寸时用图片真实宽高补算比例，保证排布不歪 */
function onImgLoad(it: StashAssetRow, ev: Event): void {
  const el = ev.target as HTMLImageElement
  el.style.opacity = '1'
  if (!(it.width && it.height) && el.naturalWidth > 0 && el.naturalHeight > 0) {
    measuredRatio.set(it.id, el.naturalHeight / el.naturalWidth)
  }
}

function onScroll(e: Event): void {
  const el = e.target as HTMLElement
  if (el.scrollTop + el.clientHeight > el.scrollHeight - 800) assets.loadMore()
}
</script>

<template>
  <main class="gallery">
    <div class="toolbar">
      <div class="toolbar-head">
        <h1>{{ title }}</h1>
        <span class="total">{{ fmtCount(assets.total) }} 个文件</span>
        <div class="toolbar-actions">
          <button class="import-btn" title="导入文件到当前文件夹" @click="importFiles">
            <svg viewBox="0 0 12 12" fill="none"><path d="M6 1.8v6M3.4 5.4L6 8l2.6-2.6M2 10.4h8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
            导入
          </button>
          <div class="viewtoggle">
            <button :class="{ on: view === 'masonry' }" title="瀑布视图" @click="view = 'masonry'">
              <svg viewBox="0 0 14 14" fill="currentColor"><rect x="1.6" y="1.6" width="4.6" height="6.6" rx="1.2" /><rect x="7.8" y="1.6" width="4.6" height="4.2" rx="1.2" /><rect x="1.6" y="9.8" width="4.6" height="2.6" rx="1.2" /><rect x="7.8" y="7.4" width="4.6" height="5" rx="1.2" /></svg>
            </button>
            <button :class="{ on: view === 'list' }" title="列表视图" @click="view = 'list'">
              <svg viewBox="0 0 14 14" fill="none"><path d="M2 3.5h10M2 7h10M2 10.5h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
            </button>
          </div>
        </div>
      </div>
      <div class="chips">
        <button class="chip" :class="{ on: assets.query.rating > 0 }" @click="cycleRating">
          <svg viewBox="0 0 12 12" fill="none"><path d="M6 1.4l1.4 2.9 3.2.5-2.3 2.2.5 3.2L6 8.7l-2.8 1.5.5-3.2L1.4 4.8l3.2-.5L6 1.4z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" /></svg>
          评分{{ assets.query.rating > 0 ? ` ≥${assets.query.rating}` : '' }}
        </button>
        <button class="chip" :class="{ on: assets.query.fav }" @click="toggleFav">
          <svg viewBox="0 0 12 12" fill="none"><path d="M6 10.2S1.4 7.5 1.4 4.3c0-1.5 1.2-2.7 2.6-2.7 1 0 1.7.6 2 1.2.3-.6 1-1.2 2-1.2 1.4 0 2.6 1.2 2.6 2.7 0 3.2-4.6 5.9-4.6 5.9z" stroke="currentColor" stroke-width="1.1" /></svg>
          喜欢
        </button>
        <button class="chip" @click="cycleSort">
          <svg viewBox="0 0 12 12" fill="none"><path d="M2 2.8h8M3.8 6h4.4M5.4 9.2h1.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" /></svg>
          {{ sortLabel }}
        </button>

        <div class="field-toggles">
          <div class="zoom-ctrl" :title="`卡片宽度 ${assets.viewZoom}px`">
            <svg class="zoom-icon" viewBox="0 0 12 12" fill="currentColor"><rect x="1.4" y="1.6" width="2.5" height="3.6" rx="0.8" /><rect x="4.75" y="1.6" width="2.5" height="3.6" rx="0.8" /><rect x="8.1" y="1.6" width="2.5" height="3.6" rx="0.8" /><rect x="1.4" y="6.8" width="2.5" height="3.6" rx="0.8" /><rect x="4.75" y="6.8" width="2.5" height="3.6" rx="0.8" /><rect x="8.1" y="6.8" width="2.5" height="3.6" rx="0.8" /></svg>
            <input v-model.number="assets.viewZoom" type="range" :min="VIEW_ZOOM_MIN" :max="VIEW_ZOOM_MAX" step="5" aria-label="瀑布视图缩放" />
            <svg class="zoom-icon" viewBox="0 0 12 12" fill="currentColor"><rect x="1.4" y="2.2" width="3.9" height="7.6" rx="1" /><rect x="6.7" y="2.2" width="3.9" height="7.6" rx="1" /></svg>
          </div>
          <span class="ft-label">显示</span>
          <button
            v-for="f in CARD_FIELDS"
            :key="f.key"
            class="chip chip-ft"
            :class="{ on: assets.cardFields[f.key] }"
            :title="`${assets.cardFields[f.key] ? '隐藏' : '显示'}${f.label}`"
            @click="assets.toggleCardField(f.key)"
          >
            {{ f.label }}
          </button>
        </div>
      </div>
    </div>

    <div ref="gridWrap" class="grid-wrap" @scroll="onScroll">
      <!-- 瀑布视图 -->
      <div v-if="view === 'masonry'" class="masonry" :style="{ height: masonryHeight + 'px' }">
        <div
          v-for="p in placed"
          :key="p.it.id"
          class="card masonry-card"
          :class="{ selected: p.it.id === assets.selectedId, missing: p.it.missing }"
          :style="{ transform: `translate(${p.x}px, ${p.y}px)`, width: `${p.w}px`, height: `${p.h}px` }"
          @click="assets.select(p.it.id)"
        >
          <div class="thumb" :style="{ height: `${p.thumb}px` }">
            <img
              v-if="p.it.content_hash"
              class="thumb-img"
              :src="assets.thumbUrl(p.it.content_hash)"
              loading="lazy"
              @error="onImgErr(p.it, $event)"
              @load="onImgLoad(p.it, $event)"
            />
            <span v-if="!p.it.content_hash" class="thumb-fallback">{{ TYPE_ICON[p.it.type] }}</span>
            <span v-if="p.it.is_fav" class="fav" v-html="heart"></span>
            <span v-if="p.it.type === 'video' && p.it.duration_ms" class="video-len">{{ fmtDuration(p.it.duration_ms) }}</span>
          </div>
          <div v-if="assets.cardFields.name || metaText(p.it)" class="card-info">
            <div v-if="assets.cardFields.name" class="ci-name" :title="p.it.name">{{ p.it.name }}</div>
            <div v-if="metaText(p.it)" class="ci-meta">{{ metaText(p.it) }}</div>
          </div>
        </div>
      </div>

      <!-- 列表视图 -->
      <div v-else class="list">
        <div
          v-for="it in assets.items"
          :key="it.id"
          class="list-row"
          :class="{ selected: it.id === assets.selectedId }"
          @click="assets.select(it.id)"
        >
          <span class="list-icon">{{ TYPE_ICON[it.type] }}</span>
          <span class="list-name" :title="it.name">{{ it.name }}</span>
          <span v-if="assets.cardFields.dims" class="list-dim">{{ dimsOnly(it) || '—' }}</span>
          <span v-if="assets.cardFields.size" class="list-size">{{ fmtSize(it.size) }}</span>
          <span v-if="assets.cardFields.time" class="list-date">{{ fmtDate(it.imported_at) }}</span>
        </div>
      </div>

      <div v-if="!assets.items.length && !assets.loading" class="empty">
        <p>暂无素材</p>
        <p class="empty-sub">点击上方「导入」添加文件</p>
      </div>
      <div v-if="assets.loading" class="loading-tip">加载中…</div>
    </div>
  </main>
</template>
