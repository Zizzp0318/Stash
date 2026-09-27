// 库状态：当前库、文件夹树、标签、侧栏计数
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useAssetStore } from './assets'

export interface LibInfo {
  path: string
  name: string
}
export interface FolderRow {
  id: number
  parent_id: number | null
  path: string
  name: string
}
export interface TagRow {
  id: number
  name: string
  color: string
}

export const useLibraryStore = defineStore('library', () => {
  const info = ref<LibInfo | null>(null)
  const folders = ref<FolderRow[]>([])
  const tags = ref<TagRow[]>([])
  const counts = ref<{ total: number; byFolder: Record<string, number>; byTag: Record<string, number> }>({
    total: 0,
    byFolder: {},
    byTag: {}
  })
  const recent = ref<LibInfo[]>([])

  const folderById = computed(() => {
    const m = new Map<number, FolderRow>()
    for (const f of folders.value) m.set(f.id, f)
    return m
  })

  /** 文件夹子树素材数：自身 + 所有路径前缀子目录之和 */
  function subtreeCount(f: FolderRow): number {
    let n = counts.value.byFolder[String(f.id)] ?? 0
    const prefix = f.path + '/'
    for (const sub of folders.value) {
      if (sub.path.startsWith(prefix)) n += counts.value.byFolder[String(sub.id)] ?? 0
    }
    return n
  }

  async function loadMeta(): Promise<void> {
    const [f, t, c] = await Promise.all([
      window.stash.folder.list(),
      window.stash.tag.list(),
      window.stash.asset.counts()
    ])
    folders.value = f.data ?? []
    tags.value = t.data ?? []
    if (c.data) counts.value = c.data
  }

  async function loadRecent(): Promise<void> {
    const r = await window.stash.library.list()
    recent.value = r.data ?? []
  }

  async function bootstrap(): Promise<void> {
    const r = await window.stash.library.getInfo()
    if (r.data) {
      info.value = r.data
      await loadMeta()
      await loadRecent()
      return
    }
    // 启动时未开库：自动恢复最近一次打开的库；从未打开过则留在欢迎页
    await loadRecent()
    const last = recent.value[0]
    if (last) {
      const e = await openLibrary(last.path)
      if (e) {
        // 库目录可能已被移动/删除，从最近列表里剔除后留在欢迎页
        recent.value = recent.value.filter((x) => x.path !== last.path)
      }
    }
  }

  async function createLibrary(name: string, parentDir: string): Promise<string | null> {
    const r = await window.stash.library.create({ name, parentDir })
    if (!r.ok) return r.error ?? '创建失败'
    info.value = r.data ?? null
    useAssetStore().reset()
    await loadMeta()
    await loadRecent()
    return null
  }

  async function openLibrary(target: string): Promise<string | null> {
    const r = await window.stash.library.open(target)
    if (!r.ok) return r.error ?? '打开失败'
    info.value = r.data ?? null
    useAssetStore().reset()
    await loadMeta()
    await loadRecent()
    return null
  }

  async function closeLibrary(): Promise<void> {
    await window.stash.library.close()
    info.value = null
    folders.value = []
    tags.value = []
    counts.value = { total: 0, byFolder: {}, byTag: {} }
    await loadRecent()
  }

  /** 彻底删除库（库目录连素材一起从磁盘移除）。删的是当前库则回到欢迎页 */
  async function deleteLibrary(target: string): Promise<string | null> {
    const isCurrent = info.value?.path.toLowerCase() === target.toLowerCase()
    const r = await window.stash.library.delete(target)
    if (!r.ok) return r.error ?? '删除失败'
    if (isCurrent) {
      useAssetStore().reset()
      info.value = null
      folders.value = []
      tags.value = []
      counts.value = { total: 0, byFolder: {}, byTag: {} }
    }
    await loadRecent()
    return null
  }

  async function refreshCounts(): Promise<void> {
    const c = await window.stash.asset.counts()
    if (c.data) counts.value = c.data
  }

  return { info, folders, tags, counts, recent, folderById, subtreeCount, bootstrap, createLibrary, openLibrary, closeLibrary, deleteLibrary, refreshCounts, loadMeta }
})
