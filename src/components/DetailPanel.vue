<script setup lang="ts">
import { computed, ref, watch } from 'vue'
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

// —— 标签：点击已有标签移除；输入新建或复用后挂上 ——
const addingTag = ref(false)
const newTag = ref('')

async function addTag(): Promise<void> {
  const a = asset.value
  const name = newTag.value.trim()
  if (!a || !name) {
    addingTag.value = false
    return
  }
  const existing = lib.tags.find((t) => t.name === name)
  const tagId = existing ? existing.id : (await window.stash.tag.create({ name })).data?.id
  if (tagId) {
    await window.stash.asset.setTags(a.id, [...a.tags.map((t) => t.id), tagId])
    await lib.loadMeta()
    await assets.select(a.id)
  }
  addingTag.value = false
  newTag.value = ''
}

async function removeTag(tagId: number): Promise<void> {
  const a = asset.value
  if (!a) return
  await window.stash.asset.setTags(a.id, a.tags.filter((t) => t.id !== tagId).map((t) => t.id))
  await lib.loadMeta()
  await assets.select(a.id)
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
            <span v-for="t in asset.tags" :key="t.id" class="tag-chip" :title="`点击移除「${t.name}」`" @click="removeTag(t.id)">
              <span class="tag-dot" :style="{ background: t.color }"></span>{{ t.name }}
            </span>
            <span v-if="!asset.tags.length" class="d-hint">暂无标签</span>
            <span class="tag-chip" @click="addingTag = true">＋</span>
          </div>
          <div v-if="addingTag" class="inline-form">
            <input v-model="newTag" placeholder="输入标签名（回车确认）" autofocus @keyup.enter="addTag" @blur="addTag" @keyup.esc="addingTag = false; newTag = ''" />
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
          <div class="d-label">色板</div>
          <div class="palette">
            <div v-for="(c, i) in paletteColors" :key="i" :style="{ background: c }"></div>
          </div>
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
