<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { folderIcon } from '@/data/mock'
import { useLibraryStore, type FolderRow, type TagRow } from '../stores/library'
import { useAssetStore } from '../stores/assets'
import { fmtCount } from '../utils/format'

const lib = useLibraryStore()
const assets = useAssetStore()

// —— 文件夹树（按路径深度缩进）——
/** 有子级的文件夹 path 集合（决定是否显示折叠箭头） */const parentPaths = computed(() => {
  const s = new Set<string>()
  for (const f of lib.folders) {
    const i = f.path.lastIndexOf('/')
    if (i > 0) s.add(f.path.slice(0, i))
  }
  return s
})

/** 被某个已折叠的祖先藏起来的行不渲染 */
function hiddenByCollapse(path: string): boolean {
  for (const c of lib.collapsed) if (path.startsWith(c + '/')) return true
  return false
}

/**
 * count 用 `subtreeCount`（含子文件夹），与点进去列表里实际会看到的卡片数一致：
 * 后端 `folderDeep` 会按 folders.path 前缀把整棵子树的 `folder_id` 一起匹配。
 * 用直属数会让父文件夹显示 0、点进去却有一屏卡片（数字与列表对不上）。
 */
const folderRows = computed(() =>
  lib.folders
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .filter((f) => !hiddenByCollapse(f.path))
    .map((f) => ({
      ...f,
      indent: f.path.split('/').length - 1,
      count: lib.subtreeCount(f),
      /** 只算本层：仅在悬停提示里用来解释「数字里有多少是子文件夹贡献的」 */
      own: lib.counts.byFolder[String(f.id)] ?? 0,
      hasChildren: parentPaths.value.has(f.path),
      folded: lib.isCollapsed(f.path)
    }))
)

const noFilter = computed(() => assets.query.folderId == null && assets.query.tagId == null)

/**
 * 文件夹计数的悬停解释。
 *
 * 数字含子文件夹，所以父文件夹的数字常常大于「本层肉眼能数到的张数」——
 * 不说清楚就会被当成数错了。本层就是全部时不啰嗦（绝大多数叶子文件夹走这一支）。
 */
function folderCountTitle(f: { count: number; own: number }): string {
  return f.count > f.own ? `含子文件夹（本层 ${f.own} 张）` : '本文件夹内的素材'
}

async function pickFolder(f: FolderRow): Promise<void> {
  assets.query.folderId = f.id
  assets.query.tagId = null
  await assets.refresh()
}

async function pickAll(): Promise<void> {
  assets.query.folderId = null
  assets.query.tagId = null
  await assets.refresh()
}

async function pickTag(id: number): Promise<void> {
  assets.query.tagId = id
  assets.query.folderId = null
  await assets.refresh()
}

// —— 内联新建输入（文件夹 / 标签共用模式）——
const creatingFolder = ref(false)
const newFolderName = ref('')
const creatingTag = ref(false)
const newTagName = ref('')
const folderInput = ref<HTMLInputElement | null>(null)
const tagInput = ref<HTMLInputElement | null>(null)

/** 后端错误码 → 人话（直接抛 ERR_XXX 给用户看不懂） */
const FOLDER_ERR: Record<string, string> = {
  ERR_EMPTY_NAME: '名称不能为空',
  ERR_INVALID_NAME: '名称含非法字符（\\ / : * ? " < > |）或为系统保留名，也不能以点或空格结尾',
  ERR_FOLDER_EXISTS: '同级下已存在同名文件夹',
  ERR_FOLDER_NOT_FOUND: '文件夹不存在（可能已被外部删除）',
  ERR_FOLDER_MISSING: '磁盘上找不到该目录，请重新打开库以同步',
  ERR_PROTECTED_FOLDER: '该目录受保护，不能操作',
  ERR_OUTSIDE_LIBRARY: '路径超出库目录',
  ERR_NO_LIBRARY: '未打开任何库'
}
function errText(code: string | undefined): string {
  return FOLDER_ERR[code ?? ''] ?? String(code ?? '未知错误')
}

function fail(msg: string): void {
  assets.notify('error', msg)
}

/** 打开内联输入框并立即聚焦（autofocus 对动态插入的元素不生效） */
function openFolderInput(): void {
  creatingFolder.value = true
  nextTick(() => folderInput.value?.focus())
}
function openTagInput(): void {
  creatingTag.value = true
  nextTick(() => tagInput.value?.focus())
}

/** IME 兼容：输入法组词时的回车（isComposing）不触发提交 */
function onFolderEnter(e: KeyboardEvent): void {
  if (e.isComposing) return
  void confirmFolder()
}
function onTagEnter(e: KeyboardEvent): void {
  if (e.isComposing) return
  void confirmTag()
}

async function confirmFolder(): Promise<void> {
  const name = newFolderName.value.trim()
  if (!name) {
    creatingFolder.value = false
    return
  }
  try {
    // 顶部 ＋ 统一建在库根目录；子级嵌套走文件夹右键菜单
    const r = await window.stash.folder.mkdirChild('', name)
    if (!r.ok) throw new Error(r.error ?? '创建失败')
    await lib.loadMeta()
    creatingFolder.value = false
    newFolderName.value = ''
  } catch (e) {
    fail(`新建文件夹失败：${errText((e as Error).message)}`)
  }
}

async function confirmTag(): Promise<void> {
  const name = newTagName.value.trim()
  if (!name) {
    creatingTag.value = false
    return
  }
  try {
    const r = await window.stash.tag.create({ name })
    if (!r.ok) throw new Error(r.error ?? '创建失败')
    await lib.loadMeta()
    creatingTag.value = false
    newTagName.value = ''
  } catch (e) {
    fail(`新建标签失败：${String((e as Error).message ?? e)}`)
  }
}

// ==================== 文件夹右键菜单 ====================
const menu = ref<{ x: number; y: number; folder: FolderRow } | null>(null)

function openMenu(e: MouseEvent, f: FolderRow): void {
  e.preventDefault()
  e.stopPropagation()
  // 靠近窗口右/下边缘时向内收，避免被裁掉
  const w = 184
  const h = 140
  menu.value = {
    folder: f,
    x: Math.max(6, Math.min(e.clientX, window.innerWidth - w - 6)),
    y: Math.max(6, Math.min(e.clientY, window.innerHeight - h - 6))
  }
}
function closeMenu(): void {
  menu.value = null
}

// ==================== 草稿编辑（新建子级 / 重命名 共用一套内联输入）====================
const creatingIn = ref<number | null>(null) // 在哪个文件夹下新建子级
const renamingId = ref<number | null>(null) // 正在重命名的文件夹
const draftName = ref('')
const draftInput = ref<HTMLInputElement | null>(null)

/**
 * 草稿序号：blur 提交是异步的（要等 IPC），而用户可能在提交完成前就发起了新的编辑
 * （典型：正在重命名 A，鼠标点到菜单里的「重命名 B」）。没有这个序号的话，
 * A 的异步提交返回后会把 B 的输入框一起清掉。每次进入/退出编辑都自增，异步回调只认自己的号。
 */
let draftSeq = 0

/** 动态插入的输入框用函数 ref 抓 DOM（v-for 里写字符串 ref 会拿到数组） */
function setDraftInput(el: unknown): void {
  if (el) draftInput.value = el as HTMLInputElement
}

function beginDraft(patch: { creatingIn?: number | null; renamingId?: number | null; name: string }): void {
  draftSeq++
  creatingIn.value = patch.creatingIn ?? null
  renamingId.value = patch.renamingId ?? null
  draftName.value = patch.name
}

function clearDraft(seq: number): void {
  if (seq !== draftSeq) return // 已被新的编辑接管，别动它的状态
  draftSeq++
  creatingIn.value = null
  renamingId.value = null
  draftName.value = ''
}

function cancelDraft(): void {
  clearDraft(draftSeq)
}

function startCreateChild(): void {
  const f = menu.value?.folder
  closeMenu()
  if (!f) return
  beginDraft({ creatingIn: f.id, name: '' })
  nextTick(() => draftInput.value?.focus())
}

function startRename(): void {
  const f = menu.value?.folder
  closeMenu()
  if (!f) return
  beginDraft({ renamingId: f.id, name: f.name })
  nextTick(() => {
    draftInput.value?.focus()
    draftInput.value?.select() // 预填原名并全选，便于直接覆盖
  })
}

function onDraftEnter(e: KeyboardEvent): void {
  if (e.isComposing) return
  void commitDraft()
}

async function commitDraft(): Promise<void> {
  const seq = draftSeq
  const name = draftName.value.trim()
  const renameId = renamingId.value
  const parentId = creatingIn.value
  if (!name || (renameId == null && parentId == null)) return cancelDraft()

  try {
    if (renameId != null) {
      const target = lib.folderById.get(renameId)
      if (!target) return cancelDraft()
      if (target.name === name) return clearDraft(seq) // 名字没变，什么都不做
      const r = await window.stash.folder.rename(renameId, name)
      if (!r.ok) throw new Error(r.error ?? '重命名失败')
      clearDraft(seq)
      // 重命名会改动该子树的 rel_path，列表刷新一次拿新路径
      await lib.loadMeta()
      await assets.refresh()
      assets.notify('info', `已重命名为「${name}」`)
    } else if (parentId != null) {
      const parent = lib.folderById.get(parentId)
      if (!parent) return cancelDraft()
      const r = await window.stash.folder.mkdirChild(parent.path, name)
      if (!r.ok) throw new Error(r.error ?? '新建失败')
      clearDraft(seq)
      // 父级若是收起的，新子级会被折叠规则藏起来 —— 顺手把父级展开，让用户看到结果
      lib.expandTo(`${parent.path}/${name}`)
      await lib.loadMeta()
      assets.notify('info', `已在「${parent.name}」下新建「${name}」`)
    }
  } catch (e) {
    // 失败时保留输入内容，让用户改完再回车（否则白打一遍）
    fail(`操作失败：${errText((e as Error).message)}`)
    nextTick(() => draftInput.value?.focus())
  }
}

// ==================== 删除文件夹 ====================
const pendingDelete = ref<FolderRow | null>(null)
const busy = ref(false)

/** 待删文件夹的规模：子文件夹数 + 素材数（含整棵子树） */
const deleteInfo = computed(() => {
  const f = pendingDelete.value
  if (!f) return { subs: 0, assets: 0 }
  const prefix = f.path + '/'
  return {
    subs: lib.folders.filter((x) => x.path.startsWith(prefix)).length,
    assets: lib.subtreeCount(f)
  }
})

function askDelete(): void {
  const f = menu.value?.folder
  closeMenu()
  pendingDelete.value = f ?? null
}

async function confirmDeleteFolder(): Promise<void> {
  const f = pendingDelete.value
  if (!f || busy.value) return
  busy.value = true
  try {
    const r = await window.stash.folder.remove(f.id)
    if (!r.ok) throw new Error(r.error ?? '删除失败')
    pendingDelete.value = null
    cancelDraft()
    // 当前筛选正指向被删的子树 → 回到「所有素材」，否则会停在空列表上
    const sel = assets.query.folderId
    if (sel != null && isUnder(sel, f)) assets.query.folderId = null
    // 连带删掉的素材可能让某些标签一个素材都不剩（服务层已自动清除它们），
    // 指向这些标签的筛选也要一起清掉
    const pruned = r.data?.pruned
    assets.dropPrunedTagFilter(pruned)
    await lib.loadMeta()
    await assets.refresh()
    const note = assets.prunedNote(pruned)
    assets.notify('info', `已删除文件夹「${f.name}」（${r.data?.assets ?? 0} 个素材已从磁盘移除）${note ? `；${note}` : ''}`)
  } catch (e) {
    fail(`删除文件夹失败：${errText((e as Error).message)}`)
  } finally {
    busy.value = false
  }
}

/** targetId 是否就是 root 或位于 root 子树内（需在 loadMeta 之前调用） */
function isUnder(targetId: number, root: FolderRow): boolean {
  if (targetId === root.id) return true
  const t = lib.folderById.get(targetId)
  return !!t && t.path.startsWith(root.path + '/')
}

// ==================== 标签右键菜单 / 删除标签 ====================
/**
 * 标签有两层「删除」，语义不同，别混：
 *  - 详情页点标签 chip = 从**这个素材**上摘掉（`asset.setTags`，标签本体还在，其它素材照旧）
 *  - 这里右键删除 = 删掉**标签本体**（`tag.remove`，所有素材一并解绑）
 */
const tagMenu = ref<{ x: number; y: number; tag: TagRow } | null>(null)

function openTagMenu(e: MouseEvent, t: TagRow): void {
  e.preventDefault()
  e.stopPropagation()
  const w = 168
  const h = 132
  tagMenu.value = {
    tag: t,
    x: Math.max(6, Math.min(e.clientX, window.innerWidth - w - 6)),
    y: Math.max(6, Math.min(e.clientY, window.innerHeight - h - 6))
  }
}
function closeTagMenu(): void {
  tagMenu.value = null
}

// ==================== 标签重命名（内联输入，复用与文件夹相同的草稿序号保护）====================
const renamingTagId = ref<number | null>(null)
const tagDraftName = ref('')
const tagDraftInput = ref<HTMLInputElement | null>(null)
/** 与 folder 那套 `draftSeq` 同理：blur 提交是异步的，防新编辑被旧回调清掉 */
let tagDraftSeq = 0

const TAG_ERR: Record<string, string> = {
  ERR_EMPTY_NAME: '标签名不能为空',
  ERR_TAG_EXISTS: '已存在同名标签',
  ERR_TAG_NOT_FOUND: '标签不存在（可能已被删除）'
}
function tagErrText(code?: string): string {
  return TAG_ERR[code ?? ''] ?? String(code ?? '未知错误')
}

function setTagDraftInput(el: unknown): void {
  if (el) tagDraftInput.value = el as HTMLInputElement
}

function startRenameTag(): void {
  const t = tagMenu.value?.tag
  closeTagMenu()
  if (!t) return
  tagDraftSeq++
  renamingTagId.value = t.id
  tagDraftName.value = t.name
  nextTick(() => {
    tagDraftInput.value?.focus()
    tagDraftInput.value?.select() // 预填原名并全选，便于直接覆盖
  })
}

function cancelTagRename(): void {
  tagDraftSeq++
  renamingTagId.value = null
  tagDraftName.value = ''
}

function onTagDraftEnter(e: KeyboardEvent): void {
  if (e.isComposing) return
  void commitTagRename()
}

async function commitTagRename(): Promise<void> {
  const seq = tagDraftSeq
  const id = renamingTagId.value
  if (id == null) return
  const name = tagDraftName.value.trim()
  const cur = lib.tags.find((t) => t.id === id)
  if (!cur) return cancelTagRename()
  if (!name || name === cur.name) return cancelTagRename()

  try {
    const r = await window.stash.tag.rename(id, name)
    if (!r.ok) throw new Error(r.error ?? '重命名失败')
    if (seq === tagDraftSeq) {
      tagDraftSeq++
      renamingTagId.value = null
      tagDraftName.value = ''
    }
    await lib.loadMeta()
    // 详情面板里挂着这个标签的话，chip 上的名字也要跟着变
    const openId = assets.selectedId
    if (openId != null) await assets.loadDetail(openId)
    assets.notify('info', `标签已重命名为「${name}」`)
  } catch (e) {
    // 失败保留输入内容，让用户改完再回车
    fail(`重命名标签失败：${tagErrText((e as Error).message)}`)
    nextTick(() => tagDraftInput.value?.focus())
  }
}

const pendingTagDelete = ref<TagRow | null>(null)
/** 删这个标签会影响多少个素材（用后端计数，不是当前列表长度） */
const tagDeleteInfo = computed(() => {
  const t = pendingTagDelete.value
  return { assets: t ? (lib.counts.byTag[String(t.id)] ?? 0) : 0 }
})

function askDeleteTag(): void {
  const t = tagMenu.value?.tag
  closeTagMenu()
  pendingTagDelete.value = t ?? null
}

async function confirmDeleteTag(): Promise<void> {
  const t = pendingTagDelete.value
  if (!t || busy.value) return
  busy.value = true
  try {
    const r = await window.stash.tag.remove(t.id)
    if (!r.ok) throw new Error(r.error ?? '删除失败')
    pendingTagDelete.value = null
    // 当前正按这个标签筛选 → 回到「所有素材」，否则会停在空列表上
    if (assets.query.tagId === t.id) assets.query.tagId = null
    await lib.loadMeta()
    await assets.refresh()
    // 详情面板里可能正挂着这个标签 —— 重新拉一次详情，否则 chip 会赖在界面上
    // （用 loadDetail 而不是 select：后者会把用户的多选状态清成单个）
    const openId = assets.selectedId
    if (openId != null) await assets.loadDetail(openId)
    assets.notify('info', `已删除标签「${t.name}」（从 ${r.data?.unlinked ?? 0} 个素材上移除）`)
  } catch (e) {
    fail(`删除标签失败：${String((e as Error).message ?? e)}`)
  } finally {
    busy.value = false
  }
}

// ==================== 全局按键 / 点击 ====================
function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  if (renamingTagId.value != null) return cancelTagRename()
  if (tagMenu.value) return closeTagMenu()
  if (menu.value) return closeMenu()
  if (pendingTagDelete.value) return void (pendingTagDelete.value = null)
  if (pendingDelete.value) return void (pendingDelete.value = null)
  cancelDraft()
}

/** 点击菜单以外的任何地方都关闭右键菜单 */
function onWindowMouseDown(e: MouseEvent): void {
  const t = e.target as HTMLElement
  if (menu.value && !t.closest('.ctx-menu')) closeMenu()
  if (tagMenu.value && !t.closest('.ctx-menu')) closeTagMenu()
}

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('mousedown', onWindowMouseDown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('mousedown', onWindowMouseDown)
})
</script>

<template>
  <aside class="sidebar">
    <div class="side-scroll">
      <div class="side-section">
        <div class="side-item" :class="{ active: noFilter }" @click="pickAll">
          <svg viewBox="0 0 14 14" fill="none">
            <rect x="1.4" y="1.4" width="11.2" height="11.2" rx="2.4" stroke="currentColor" stroke-width="1.2" />
            <path d="M1.4 5h11.2" stroke="currentColor" stroke-width="1.2" />
          </svg>
          所有素材 <span class="n">{{ fmtCount(lib.counts.total) }}</span>
        </div>
      </div>

      <div class="side-section">
        <div class="side-label">
          文件夹
          <span class="action" title="新建文件夹（库根目录）" @click="openFolderInput">＋</span>
        </div>
        <div v-if="creatingFolder" class="inline-form">
          <input
            ref="folderInput"
            v-model="newFolderName"
            placeholder="文件夹名称"
            spellcheck="false"
            @keydown.enter="onFolderEnter"
            @blur="confirmFolder"
            @keydown.esc="creatingFolder = false; newFolderName = ''"
          />
          <div class="inline-hint">将创建在库根目录（顶层）· 右键文件夹可建子级</div>
        </div>

        <template v-for="f in folderRows" :key="f.id">
          <div
            class="side-item"
            :class="{ active: assets.query.folderId === f.id, 'drop-on': assets.dragOverFolderId === f.id }"
            :data-folder-id="f.id"
            :data-folder-path="f.path"
            :style="{ paddingLeft: 8 + f.indent * 13 + 'px' }"
            @click="pickFolder(f)"
            @contextmenu="openMenu($event, f)"
          >
            <span
              class="fold-toggle"
              :class="{ folded: f.folded, leaf: !f.hasChildren }"
              :data-fold-path="f.path"
              :title="f.hasChildren ? (f.folded ? '展开' : '收起') : ''"
              @click.stop="lib.toggleCollapse(f.path)"
            >
              <svg viewBox="0 0 8 8" fill="none">
                <path d="M2.7 1.3L5.7 4l-3 2.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
            <span v-html="folderIcon"></span>
            <input
              v-if="renamingId === f.id"
              :ref="setDraftInput"
              v-model="draftName"
              class="side-rename"
              spellcheck="false"
              @click.stop
              @keydown.enter="onDraftEnter"
              @keydown.esc="cancelDraft"
              @blur="commitDraft"
            />
            <template v-else>{{ f.name }} <span class="n" :title="folderCountTitle(f)">{{ fmtCount(f.count) }}</span></template>
          </div>
          <div
            v-if="creatingIn === f.id"
            class="inline-form"
            :style="{ paddingLeft: 8 + (f.indent + 1) * 13 + 'px' }"
          >
            <input
              :ref="setDraftInput"
              v-model="draftName"
              placeholder="子文件夹名称"
              spellcheck="false"
              @keydown.enter="onDraftEnter"
              @keydown.esc="cancelDraft"
              @blur="commitDraft"
            />
            <div class="inline-hint">将创建在「{{ f.name }}」内</div>
          </div>
        </template>
      </div>

      <div class="side-section">
        <div class="side-label">
          标签
          <span class="action" title="新建标签" @click="openTagInput">＋</span>
        </div>
        <div v-if="creatingTag" class="inline-form">
          <input
            ref="tagInput"
            v-model="newTagName"
            placeholder="标签名称"
            spellcheck="false"
            @keydown.enter="onTagEnter"
            @blur="confirmTag"
            @keydown.esc="creatingTag = false; newTagName = ''"
          />
        </div>
        <div
          v-for="t in lib.tags"
          :key="t.id"
          class="side-item"
          :class="{ active: assets.query.tagId === t.id }"
          :data-tag-id="t.id"
          :title="`点击按「${t.name}」筛选，右键管理`"
          @click="pickTag(t.id)"
          @contextmenu.prevent.stop="openTagMenu($event, t)"
        >
          <span class="tag-dot" :style="{ background: t.color }"></span>
          <input
            v-if="renamingTagId === t.id"
            :ref="setTagDraftInput"
            v-model="tagDraftName"
            class="side-rename"
            spellcheck="false"
            @click.stop
            @keydown.enter="onTagDraftEnter"
            @keydown.esc="cancelTagRename"
            @blur="commitTagRename"
          />
          <template v-else>{{ t.name }} <span class="n">{{ fmtCount(lib.counts.byTag[String(t.id)] ?? 0) }}</span></template>
        </div>
      </div>
    </div>

    <div class="side-footer">
      <div class="side-item">
        <svg viewBox="0 0 14 14" fill="none">
          <circle cx="7" cy="7" r="2.1" stroke="currentColor" stroke-width="1.2" />
          <path d="M7 1.4v1.7M7 10.9v1.7M1.4 7h1.7M10.9 7h1.7M3.2 3.2l1.2 1.2M9.6 9.6l1.2 1.2M10.8 3.2L9.6 4.4M4.4 9.6l-1.2 1.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        </svg>
        设置
      </div>
    </div>

    <!-- 文件夹右键菜单 -->
    <Teleport to="body">
      <div
        v-if="menu"
        class="ctx-menu folder-ctx"
        :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
        @mousedown.stop
      >
        <div class="ctx-head">{{ menu.folder.path }}</div>
        <button class="ctx-item" @click="startCreateChild">
          <svg viewBox="0 0 13 13" fill="none">
            <path d="M1.6 4.2h9.8v6.2H1.6z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
            <path d="M1.6 4.2V2.6h3.1l1.1 1.6" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
            <path d="M6.5 6.2v3.2M4.9 7.8h3.2" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" />
          </svg>
          新建子文件夹
        </button>
        <button class="ctx-item" @click="startRename">
          <svg viewBox="0 0 13 13" fill="none">
            <path d="M8.4 1.9l2.7 2.7-6.6 6.6-3.2.5.5-3.2 6.6-6.6z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
          </svg>
          重命名
        </button>
        <div class="ctx-sep"></div>
        <button class="ctx-item danger" @click="askDelete">
          <svg viewBox="0 0 13 13" fill="none">
            <path d="M2.4 3.6h8.2M5.1 3.6V2.4h2.8v1.2M3.4 3.6l.5 7h5.2l.5-7" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          删除文件夹
        </button>
      </div>
    </Teleport>

    <!-- 删除文件夹确认（物理删除，没有回收站） -->
    <Teleport to="body">
      <div v-if="pendingDelete" class="modal-mask" @click.self="pendingDelete = null">
        <div class="modal">
          <div class="modal-title">删除文件夹「{{ pendingDelete.name }}」？</div>
          <div class="modal-body">
            <p class="modal-text">
              该文件夹及其 <b>{{ deleteInfo.subs }}</b> 个子文件夹、<b>{{ deleteInfo.assets }}</b> 个素材
              将从磁盘上<b>直接删除</b>，<b>没有回收站，无法恢复</b>。
            </p>
          </div>
          <div class="modal-foot">
            <button class="w-btn" :disabled="busy" @click="pendingDelete = null">取消</button>
            <button class="w-btn danger-strong" :disabled="busy" @click="confirmDeleteFolder">删除</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 标签右键菜单 -->
    <Teleport to="body">
      <div
        v-if="tagMenu"
        class="ctx-menu tag-ctx"
        :style="{ left: tagMenu.x + 'px', top: tagMenu.y + 'px' }"
        @mousedown.stop
      >
        <div class="ctx-head">{{ tagMenu.tag.name }}</div>
        <button class="ctx-item" data-ctx="rename-tag" @click="startRenameTag">
          <svg viewBox="0 0 13 13" fill="none">
            <path d="M8.4 1.9l2.7 2.7-6.6 6.6-3.2.5.5-3.2 6.6-6.6z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
          </svg>
          重命名标签
        </button>
        <div class="ctx-sep"></div>
        <button class="ctx-item danger" @click="askDeleteTag">
          <svg viewBox="0 0 13 13" fill="none">
            <path d="M2.4 3.6h8.2M5.1 3.6V2.4h2.8v1.2M3.4 3.6l.5 7h5.2l.5-7" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          删除标签
        </button>
      </div>
    </Teleport>

    <!-- 删除标签确认（只解绑素材，不删文件） -->
    <Teleport to="body">
      <div v-if="pendingTagDelete" class="modal-mask" @click.self="pendingTagDelete = null">
        <div class="modal">
          <div class="modal-title">删除标签「{{ pendingTagDelete.name }}」？</div>
          <div class="modal-body">
            <p class="modal-text">
              该标签会从 <b>{{ tagDeleteInfo.assets }}</b> 个素材上移除。
              <b>素材文件本身不受影响</b>，只是不再带这个标签。
            </p>
          </div>
          <div class="modal-foot">
            <button class="w-btn" :disabled="busy" @click="pendingTagDelete = null">取消</button>
            <button class="w-btn danger-strong" :disabled="busy" @click="confirmDeleteTag">删除</button>
          </div>
        </div>
      </div>
    </Teleport>
  </aside>
</template>
