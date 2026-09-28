<script setup lang="ts">
// 文本预览 + 编辑。
// - `.txt`：直接进编辑态
// - `.md`：默认渲染排版，可切回源码编辑
//
// 保存策略（用户拍板）：**Ctrl+S 手动保存**，不自动落盘 —— 库里是真实文件，
// 自动写会把半句话、误触改动直接写进去。未保存的改动上报到 store 的 `previewDirty`，
// 浮层在「关闭 / 左右切换」时会拦一下（见 PreviewStage 的 guarded）。
//
// 编码与冲突都由主进程负责：读是 UTF-8 严格解码失败退 GB18030；
// 写带 `baseMtime` 冲突检测（文件在软件外被改过会抛 ERR_MTIME_CONFLICT，
// 这里给「覆盖保存 / 放弃我的修改」两个选择，绝不静默覆盖别人的改动）。
import { computed, onBeforeUnmount, onMounted, ref, watch, type PropType } from 'vue'
import MarkdownIt from 'markdown-it'
import type { StashAssetRow } from '../../env'
import { useAssetStore } from '../../stores/assets'

const props = defineProps({
  asset: { type: Object as PropType<StashAssetRow>, required: true },
  /**
   * 只读视图（右侧信息栏用）：那里窄，而且**中栏浮层才是唯一编辑入口** ——
   * 两处同时改一个文件会出现「谁赢了」的困惑，干脆只留一个口。
   */
  viewOnly: { type: Boolean, default: false }
})

const assets = useAssetStore()
// html: false —— 即便 md 是用户自己的文件，也不该让它注入 HTML（顺带收掉 XSS 面）
const md = new MarkdownIt({ html: false, linkify: false, breaks: true })

/** 磁盘上的原文（保存成功后作为新的基准） */
const text = ref('')
/** 编辑中的草稿 */
const draft = ref('')
const baseMtime = ref<number | undefined>(undefined)
const loading = ref(true)
const readOnly = ref(false)
const readOnlyReason = ref<string | null>(null)
const encoding = ref('')
/** 0 = 干净；>0 = 有未保存改动 */
const pending = ref(0)
const saving = ref(false)
/** 文件在软件外被改过，正在等用户决定 */
const conflict = ref(false)
const isMd = computed(() => props.asset.ext.toLowerCase() === 'md')
const mode = ref<'view' | 'edit'>('edit')

const rendered = computed(() => (isMd.value ? md.render(draft.value) : ''))

function applyLoaded(d: {
  text: string
  encoding: string
  mtime: number
  readOnly: boolean
  readOnlyReason: string | null
}): void {
  text.value = d.text
  draft.value = d.text
  encoding.value = d.encoding
  baseMtime.value = d.mtime
  readOnly.value = d.readOnly
  readOnlyReason.value = d.readOnlyReason
  pending.value = 0
  assets.previewDirty = false
  // md 默认给「渲染预览」（只读观感）；txt 与只读文件直接进编辑/纯文本态
  mode.value = isMd.value && !d.readOnly ? 'view' : 'edit'
}

async function load(): Promise<void> {
  loading.value = true
  conflict.value = false
  assets.previewDirty = false
  const r = await window.stash.asset.text(props.asset.id)
  loading.value = false
  if (r.ok && r.data) {
    applyLoaded(r.data)
  } else {
    text.value = ''
    draft.value = ''
    readOnly.value = true
    readOnlyReason.value = r.error ?? '读取失败'
    pending.value = 0
  }
}
// 换素材重新读；immediate 保证首次挂载就读
watch(() => props.asset.id, () => void load(), { immediate: true })

function onInput(e: Event): void {
  draft.value = (e.target as HTMLTextAreaElement).value
  pending.value = draft.value === text.value ? 0 : 1
  assets.previewDirty = pending.value > 0
}

/** 保存。`force` = 明知有冲突也要覆盖（用户在冲突条上点了「覆盖保存」） */
async function save(force = false): Promise<void> {
  if (saving.value || readOnly.value) return
  if (pending.value === 0 && !force) return
  saving.value = true
  const r = await window.stash.asset.writeText(props.asset.id, draft.value, force ? undefined : baseMtime.value)
  saving.value = false
  if (r.ok && r.data) {
    conflict.value = false
    text.value = draft.value
    baseMtime.value = r.data.mtime
    pending.value = 0
    assets.previewDirty = false
    // 文件大小与内容哈希都变了：刷新列表，让卡片上的信息同步（缩略图主进程那边已重生成）
    await assets.refresh()
    if (isMd.value) mode.value = 'view'
    assets.notify('info', '已保存')
    return
  }
  if (r.error === 'ERR_MTIME_CONFLICT') {
    // 不报错弹窗，给一条可操作的选择条
    conflict.value = true
    return
  }
  assets.notify('error', `保存失败：${r.error}`)
}

/** 放弃我的改动，回到磁盘上的内容 */
function giveUp(): void {
  conflict.value = false
  draft.value = text.value
  pending.value = 0
  assets.previewDirty = false
}

/** Ctrl+S 只在编辑器有焦点、且确实有未保存内容（或正在冲突）时接管 */
function onKey(e: KeyboardEvent): void {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return
  const inEditor = (e.target as HTMLElement | null)?.closest?.('.ptext-editor') != null
  if (inEditor && (pending.value > 0 || conflict.value)) {
    e.preventDefault()
    e.stopPropagation()
    void save(conflict.value)
  }
}

onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, true)
  // 组件没了就别再拦着浮层关闭
  assets.previewDirty = false
})

/** md 渲染结果里的链接不允许真的跳转（会把整个窗口导航走） */
function blockLinks(e: MouseEvent): void {
  if ((e.target as HTMLElement | null)?.closest?.('a')) e.preventDefault()
}
</script>

<template>
  <div class="pv-text" :class="{ compact: viewOnly }">
    <div v-if="loading" class="pv-wait"><span>读取中…</span></div>

    <template v-else>
      <div
        class="ptext-toolbar"
        data-ptext-toolbar
        :data-saving="saving ? '1' : '0'"
        :data-pending="String(pending)"
        :data-conflict="conflict ? '1' : '0'"
      >
        <span class="ptext-enc" data-ptext-encoding>{{ encoding }}</span>
        <span v-if="readOnly" class="ptext-ro" :title="readOnlyReason ?? ''">只读</span>
        <template v-else-if="!viewOnly">
          <span v-if="isMd" class="ptext-toggle" data-ptext-toggle @click="mode = mode === 'view' ? 'edit' : 'view'">
            {{ mode === 'view' ? '编辑源码' : '渲染预览' }}
          </span>
          <span class="ptext-dirty" :class="{ on: pending > 0 }">
            {{ pending > 0 ? '未保存 · Ctrl+S' : '已保存' }}
          </span>
        </template>
        <span v-else class="ptext-ro" data-ptext-viewonly>双击卡片可在中栏编辑</span>
      </div>

      <div v-if="conflict" class="ptext-conflict" data-ptext-conflict>
        <span>文件在软件外被修改过，覆盖会丢掉那些改动。</span>
        <button class="pv-btn" data-ptext-force type="button" @click="() => save(true)">覆盖保存</button>
        <button class="pv-btn" data-ptext-giveup type="button" @click="giveUp">放弃我的修改</button>
      </div>

      <textarea
        v-if="mode === 'edit' && !readOnly && !viewOnly"
        class="ptext-editor"
        data-ptext-editor
        :value="draft"
        spellcheck="false"
        @input="onInput"
      ></textarea>

      <div v-else-if="isMd" class="ptext-md" data-ptext-md @click="blockLinks" v-html="rendered"></div>

      <pre v-else class="ptext-plain" data-ptext-plain>{{ draft }}</pre>
    </template>
  </div>
</template>
