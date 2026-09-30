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

  /**
   * 启动时自动恢复最近库失败的**原因**（原始错误码，展示时经 libErrorText 映射成人话）。
   *
   * 场景：最近打开的库是「太新」的库（由更新版本的 Stash 升级过）或被移动/删除了。
   * 期望行为是**优雅退回欢迎页**并说清原因，而不是白屏/卡在加载态。
   * 空串 = 没有失败。
   */
  const bootError = ref('')

  const folderById = computed(() => {
    const m = new Map<number, FolderRow>()
    for (const f of folders.value) m.set(f.id, f)
    return m
  })

  // ==================== 文件夹折叠 ====================
  // 存 path 而不是 id：id 是库内自增，同一个文件夹在不同库里 id 不同，
  // 而且这两点在重启后都可能变（重建索引）。path 在库里唯一且稳定（重命名后失效，属预期）。
  const collapsed = ref<string[]>([])

  /** 折叠状态按库隔离，否则「测试1」里折叠的『素材』会连带「测试2」的同名文件夹一起折起来 */
  function collapsedKey(): string {
    return info.value ? `stash.collapsed:${info.value.path}` : 'stash.collapsed'
  }

  /** 切换库后重新装载折叠状态（在 info 赋值之后调用） */
  function loadCollapsed(): void {
    try {
      const raw = localStorage.getItem(collapsedKey())
      const parsed: unknown = raw ? JSON.parse(raw) : []
      collapsed.value = Array.isArray(parsed) ? (parsed.filter((x) => typeof x === 'string') as string[]) : []
    } catch {
      collapsed.value = []
    }
  }

  function saveCollapsed(): void {
    try {
      localStorage.setItem(collapsedKey(), JSON.stringify(collapsed.value))
    } catch {
      /* 写入失败忽略，仅本次会话生效 */
    }
  }

  function isCollapsed(path: string): boolean {
    return collapsed.value.includes(path)
  }

  function toggleCollapse(path: string): void {
    collapsed.value = isCollapsed(path)
      ? collapsed.value.filter((p) => p !== path)
      : [...collapsed.value, path]
    saveCollapsed()
  }

  /** 展开 path 的所有祖先层级（拖拽移动完成、新建子级后确保目标可见） */
  function expandTo(path: string): void {
    const parts = path.split('/')
    const ancestors: string[] = []
    for (let i = 1; i < parts.length; i++) ancestors.push(parts.slice(0, i).join('/'))
    if (!ancestors.length) return
    const next = collapsed.value.filter((p) => !ancestors.includes(p))
    if (next.length !== collapsed.value.length) {
      collapsed.value = next
      saveCollapsed()
    }
  }

  /** 丢弃已不存在的折叠项（文件夹被删或改名后）。loadMeta 之后调用 */
  function pruneCollapsed(): void {
    const paths = new Set(folders.value.map((f) => f.path))
    const next = collapsed.value.filter((p) => paths.has(p))
    if (next.length !== collapsed.value.length) {
      collapsed.value = next
      saveCollapsed()
    }
  }

  /**
   * 文件夹素材数 = **自身 + 整棵子树**（子文件夹里的也算）。
   *
   * 与列表语义严格一致：点文件夹时后端走 `folderDeep`（`folder_id IN 子树`），
   * 所以「侧栏显示 12」点进去就该看到 12 张卡片。三个地方共用这一个口径：
   * 侧栏文件夹行、画廊「N / 共 M」的分母、删除确认弹窗。
   *
   * 别改回「只算直属」：那样父文件夹会显示 0，点进去却有一屏卡片（本项目踩过）。
   */
  function subtreeCount(f: FolderRow): number {
    let n = counts.value.byFolder[String(f.id)] ?? 0
    const prefix = f.path + '/'
    for (const sub of folders.value) {
      if (sub.path.startsWith(prefix)) n += counts.value.byFolder[String(sub.id)] ?? 0
    }
    return n
  }

  /**
   * 最近添加的标签（新的在前），详情页「＋」下方的悬浮下拉用它。
   *
   * 时间序直接用 `id` 倒序：`tags.id` 是库内自增主键，插入越晚 id 越大，
   * 等价于创建时间倒序 —— 不必额外加 `created_at` 列（也不必给老库做迁移）。
   * 若哪天要做「最近**使用**过的标签」，那就真得存时间了（现有表结构推不出来）。
   *
   * @param excludeIds 当前素材已经挂上的标签，不该出现在下拉里（上方 chip 已经展示了）
   * @param limit      下拉最多几行：详情栏是窄条，超过 4 行就盖住下面的评分区了
   * @param query      输入框里已经打的字：非空时按名字做包含匹配（「搜索或创建」里搜的那一半）
   */
  function recentTags(excludeIds: number[] = [], limit = 4, query = ''): TagRow[] {
    const skip = new Set(excludeIds)
    const q = query.trim().toLowerCase()
    // filter 已经产出新数组，后面的 sort 不会污染 store 里的原始顺序
    return tags.value
      .filter((t) => !skip.has(t.id) && (!q || t.name.toLowerCase().includes(q)))
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
  }

  /** 标签挂了多少个素材（详情页下拉行尾那个数字，与侧栏标签行同源） */
  function tagCount(tagId: number): number {
    return counts.value.byTag[String(tagId)] ?? 0
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
    // 折叠状态按当前库重装（切库后不能沿用上一个库的），再清掉本库中已不存在的路径
    loadCollapsed()
    pruneCollapsed()
  }

  async function loadRecent(): Promise<void> {
    const r = await window.stash.library.list()
    recent.value = r.data ?? []
  }

  async function bootstrap(): Promise<void> {
    bootError.value = ''
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
        // 库目录可能已被移动/删除，或该库由更新版本的 Stash 升级过（ERR_LIBRARY_TOO_NEW）。
        // 两种情况都从最近列表里剔除并**留在欢迎页**，同时把原因记下来给欢迎页展示 ——
        // 绝不把异常往上抛（onMounted 里没人接，会变成未捕获异常/白屏），也绝不停在加载态。
        recent.value = recent.value.filter((x) => x.path !== last.path)
        bootError.value = e
        console.warn(`[stash] 自动打开最近的库失败，已退回欢迎页：${last.path} —— ${e}`)
      }
    }
  }

  async function createLibrary(name: string, parentDir: string): Promise<string | null> {
    const r = await window.stash.library.create({ name, parentDir })
    if (!r.ok) return r.error ?? '创建失败'
    // 成功进入一个库 → 之前那条「启动时最近库打不开」的理由已经与用户当下所见无关，清掉，
    // 否则回到欢迎页时 `.w-err` 会弹出一条早已过期的错误（见 openLibrary/closeLibrary 同款注释）。
    bootError.value = ''
    info.value = r.data ?? null
    useAssetStore().reset()
    await loadMeta()
    await loadRecent()
    return null
  }

  async function openLibrary(target: string): Promise<string | null> {
    const r = await window.stash.library.open(target)
    if (!r.ok) return r.error ?? '打开失败'
    // 成功打开一个库 → 清掉启动失败时留下的 bootError。
    // 场景：启动时最近库是「太新」的库 → bootError='ERR_LIBRARY_TOO_NEW' → 用户手动打开一个正常库，
    // 若不在这里清，之后关掉该库回到欢迎页时，那条与当前无关的旧错误又会冒出来（I5 带出的低危 UI 缺陷）。
    bootError.value = ''
    info.value = r.data ?? null
    useAssetStore().reset()
    await loadMeta()
    await loadRecent()
    return null
  }

  async function closeLibrary(): Promise<void> {
    await window.stash.library.close()
    // 关库回到欢迎页 → 同样清掉陈旧的启动失败理由（否则它在欢迎页上「复活」）。
    bootError.value = ''
    info.value = null
    folders.value = []
    tags.value = []
    counts.value = { total: 0, byFolder: {}, byTag: {} }
    collapsed.value = []
    await loadRecent()
  }

  /** 彻底删除库（库目录连素材一起从磁盘移除）。删的是当前库则回到欢迎页 */
  async function deleteLibrary(target: string): Promise<string | null> {
    const isCurrent = info.value?.path.toLowerCase() === target.toLowerCase()
    const r = await window.stash.library.delete(target)
    if (!r.ok) return r.error ?? '删除失败'
    // delete 与 open/create/close 同属「库生命周期成功动作」，成功时一并清掉 bootError：
    // 删的是当前库时用户直接回到欢迎页（与 closeLibrary 同一情形），留着陈旧文案一样会误导；
    // 删的是别的库时，用户的操作上下文也已改变，那条启动理由同样不再代表当下。
    bootError.value = ''
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

  return { info, folders, tags, counts, recent, bootError, folderById, subtreeCount, recentTags, tagCount, bootstrap, createLibrary, openLibrary, closeLibrary, deleteLibrary, refreshCounts, loadMeta,
    collapsed, isCollapsed, toggleCollapse, expandTo }
})
