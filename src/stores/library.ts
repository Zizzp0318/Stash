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
  /** glyph 的具体值：emoji 字符 或 图标 key；null = 默认文件夹图标 */
  icon: string | null
  /** 'emoji' | 'icon' | null —— 决定 icon 列怎么解释 */
  glyph_kind: string | null
  /** 语义色 ID（blue/indigo/…）；null = 不染色 */
  color: string | null
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

  // ==================== 开库引导态（骨架屏的数据源，2026-11）====================
  //
  // 为什么需要：用户报「库一大，打开软件卡一会、点不动滚不动」。根因（`library:usage` 同步遍历
  // `.thumbs`）已在 §5.5 修掉 —— 本机 2 万条库开库路径 5.5ms。但**别的机器/别的盘**上仍可能慢：
  // 库在移动硬盘/网络盘、5 万条以上、首屏缩略图要现场生成。这时界面需要明说「在装东西」，
  // 而不是让用户对着一块空白面板猜。
  //
  // 设计取舍（都与「别骗用户」有关）：
  //   · 只在 > 100ms 时才显示骨架（`App.vue` 里定时器控制）—— 热开库 5ms，闪一下骨架反而是噪音；
  //   · 不整页遮罩、不锁交互：骨架层 `pointer-events: none`，标题栏仍可拖动/最小化；骨架下面
  //     是真实（此时还空着的）三栏，数据一到原地变内容，不跳动；
  //   · 文案按阶段走真实状态（打开索引 → 读索引 → 首屏缩略图），不编假进度；
  //   · 超过 `bootStuckAfterMs`（默认 8s）给「先浏览」出口 —— 后台继续补，别把人锁在引导页。
  const booting = ref(false)
  const bootStage = ref<'index' | 'meta' | 'grid'>('index')
  /**
   * 这次开库是**冷启动**还是**用户在切库**。
   *
   * App 用它决定骨架要不要立刻亮：冷启动时窗口刚出现、页面上还是首屏兜底，
   * 200ms 空白也会被看成白屏；切库时库已经在眼前，闪一下骨架反而像卡了。
   * 光看「第几次 booting」判断不了 —— 测试和用户都可能在启动后手动切库。
   */
  const bootKind = ref<'startup' | 'switch'>('switch')
  /** 慢到什么程度才提示「可以先浏览」（可被测试缝改小，便于冒烟覆盖） */
  const bootStuckAfterMs = ref(8000)
  /**
   * 骨架的**最小展示窗口**（毫秒）。不是「必须等满」的固定开场 —— 它只做一件事：
   * 防闪（数据几十毫秒就绪时，不至于亮一下就消失）。
   *
   * 之后完全由探针决定：快库约 0.5 秒就撤，慢库停在真的能操作为止（上限 30 秒）。
   * 冒烟环境置 0（否则每个套件都被这几百毫秒拖慢）。
   */
  const bootMinMs = ref(window.stash.isSmoke ? 0 : 500)

  /**
   * 开库流程的兜底闸门：必须大于 App 侧探针上限（30 秒）+ 淡出，
   * 否则慢库的骨架会被它提前掐掉。见 openLibrary / createLibrary 的 finally。
   */
  const BOOT_GUARD_MS = 35000
  let bootDepth = 0

  /**
   * 测试缝：模拟「慢开库」。生产恒 0。
   * 冒烟拿不到用户的几万条大库，只能把等待注进去 —— 否则骨架屏的时间线（100ms 显示 / 数据到就收）
   * 在测试机上永远看不到（开库 5ms，骨架还没亮就结束了）。
   */
  let bootDelayMs = 0
  function __testSlowBoot(delayMs = 0, stuckMs = 0): { delayMs: number; stuckMs: number } {
    bootDelayMs = Math.max(0, Number(delayMs) || 0)
    if (stuckMs > 0) bootStuckAfterMs.value = Math.max(1, Number(stuckMs))
    return { delayMs: bootDelayMs, stuckMs: bootStuckAfterMs.value }
  }

  /**
   * 测试缝：改最小展示窗口（生产 500）。
   * 冒烟用它压到几百毫秒，验证「窗口内不撤、之后由探针决定」。
   */
  function __testBootMin(ms: number): number {
    const prev = bootMinMs.value
    bootMinMs.value = Math.max(0, Number(ms) || 0)
    return prev
  }
  ;(window as unknown as Record<string, unknown>).__testBootMin = __testBootMin

  function beginBoot(): void {
    bootDepth++
    booting.value = true
    bootStage.value = 'index'
  }

  /** 收尾（计数式：嵌套调用只有最外层真的关掉） */
  function endBoot(): void {
    bootDepth = Math.max(0, bootDepth - 1)
    if (bootDepth === 0) booting.value = false
  }

  /**
   * 强制收尾：忽略嵌套计数，直接归零。
   *
   * App 在「固定开场窗口结束」时用这个，而不是 endBoot()：
   * 启动自动恢复最近库（bootstrap）+ 用户手动切库会叠两层 beginBoot，
   * 计数式只减一次 → booting 仍是 true → 骨架永远退不掉。
   * App 是整条流程的最终收尾方，它说结束就是结束。
   */
  function finishBoot(): void {
    bootDepth = 0
    booting.value = false
  }

  /** 阶段推进 + 测试缝的延迟（延迟期间界面就是「卡在某一阶段」的样子） */
  async function bootStep(stage: 'index' | 'meta' | 'grid'): Promise<void> {
    bootStage.value = stage
    if (bootDelayMs > 0) await new Promise<void>((r) => setTimeout(r, bootDelayMs))
  }

  /**
   * 测试缝：让冒烟能从渲染层触发一次**真实的**打开库流程（含骨架屏）。
   * 不走这个缝的话，冒烟只能靠「最近库自动恢复」那条路，而那要求库在窗口加载**之前**就写进配置 ——
   * 冒烟进程做不到（窗口已经加载完了）。
   */
  ;(window as unknown as Record<string, unknown>).__stashOpenLibrary = (p: string): Promise<string | null> =>
    openLibrary(p)
  /**
   * 测试缝：**按真实切换库的顺序**再走一遍（`TitleBar.switchTo` 就是这么调的：
   * `lib.openLibrary()` → `assets.refresh()` → `thumb.backfill()`）。
   *
   * 为什么要这条而不是只用上面那条：`openLibrary` 本身**不**刷新网格（它只管索引与元信息），
   * 刷新是调用方的责任。只开不刷的话，骨架屏会一直等到 `loadedOnce` 的兜底超时 ——
   * 那是测不出「内容接上」的。这里把调用方的动作也补上，让缝与真实路径同形。
   */
  ;(window as unknown as Record<string, unknown>).__stashSwitchLibrary = async (p: string): Promise<string | null> => {
    const e = await openLibrary(p)
    if (!e) {
      await useAssetStore().refresh()
      window.stash.thumb.backfill('grid')
    }
    return e
  }
  /** 测试缝：把「慢开库」注进去（骨架屏只有在真的慢时才看得见，见 `__testSlowBoot`） */
  ;(window as unknown as Record<string, unknown>).__testSlowBoot = __testSlowBoot
  /** 测试缝：骨架屏状态快照（冒烟用它定位「为什么没出现 / 为什么没消失」） */
  ;(window as unknown as Record<string, unknown>).__bootState = (): Record<string, unknown> => ({
    booting: booting.value,
    stage: bootStage.value,
    stuckAfter: bootStuckAfterMs.value,
    minMs: bootMinMs.value
  })


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
    /*
     * ⚠️ 先起骨架，再去问主进程「当前有没有库」。
     *
     * 冷启动时 `getInfo()` 要等主进程把库真正打开（8000 张 + 冷盘，实测数秒），
     * 这期间 Vue 已经挂载、界面只是一个空壳 —— 用户看到的就是「只有黑色框框，
     * 等很久才出现骨架」。先把骨架顶上去，主进程再慢也有一层可见的反馈。
     */
    bootKind.value = 'startup'
    beginBoot()
    const r = await window.stash.library.getInfo()
    if (r.data) {
      try {
        info.value = r.data
        await bootStep('index')
        bootStage.value = 'meta'
        await loadMeta()
        await bootStep('grid')
      } finally {
        await loadRecent()
        // 这里**不** endBoot：首屏数据还没到，收尾由 App 在「固定窗口结束」后做
      }
      return
    }
    // ---------- 主进程没有当前库（从没开过，或启动时没恢复）----------
    await loadRecent()
    const last = recent.value[0]
    if (last) {
      // 有最近库：直接开。openLibrary 内部会再 beginBoot 一层，收尾同样交给 App 统一做
      const e = await openLibrary(last.path, 'startup')
      if (e) {
        // 库目录可能已被移动/删除，或该库由更新版本的 Stash 升级过（ERR_LIBRARY_TOO_NEW）。
        // 两种情况都从最近列表里剔除并**留在欢迎页**，同时把原因记下来给欢迎页展示 ——
        // 绝不把异常往上抛（onMounted 里没人接，会变成未捕获异常/白屏），也绝不停在加载态。
        recent.value = recent.value.filter((x) => x.path !== last.path)
        bootError.value = e
        console.warn(`[stash] 自动打开最近的库失败，已退回欢迎页：${last.path} —— ${e}`)
        // openLibrary 失败时自己已经 endBoot 了一层，这里把 bootstrap 这层也收掉
        endBoot()
      }
      return
    }
    // 从没打开过任何库 → 收掉骨架，留在欢迎页
    endBoot()
  }

  async function createLibrary(name: string, parentDir: string): Promise<string | null> {
    beginBoot()
    try {
      await bootStep('index')
      const r = await window.stash.library.create({ name, parentDir })
      if (!r.ok) {
        endBoot()
        return r.error ?? '创建失败'
      }
      // 成功进入一个库 → 之前那条「启动时最近库打不开」的理由已经与用户当下所见无关，清掉，
      // 否则回到欢迎页时 `.w-err` 会弹出一条早已过期的错误（见 openLibrary/closeLibrary 同款注释）。
      bootError.value = ''
      info.value = r.data ?? null
      useAssetStore().reset()
      await bootStep('meta')
      await loadMeta()
      await loadRecent()
      await bootStep('grid')
      return null
    } finally {
      /*
       * 兜底：防止流程异常把人永远按在引导态。
       *
       * ⚠️ 必须长于**探针上限**（App 的 BOOT_MAX_VISIBLE_MS = 30 秒），不是「最小窗口 + 5 秒」——
       * 最小窗口只有 0.5 秒，加 5 秒就成了 5.5 秒的硬闸，慢库的骨架会在探针还在等的时候被掐掉
       * （用户看到的就是「骨架没了但界面还卡」）。
       */
      setTimeout(() => {
        if (booting.value) {
          bootDepth = 0
          booting.value = false
        }
      }, BOOT_GUARD_MS)
    }
  }

  async function openLibrary(
    target: string,
    kind: 'startup' | 'switch' = 'switch'
  ): Promise<string | null> {
    bootKind.value = kind
    beginBoot()
    try {
      await bootStep('index')
      const r = await window.stash.library.open(target)
      if (!r.ok) {
        endBoot()
        return r.error ?? '打开失败'
      }
      // 成功打开一个库 → 清掉启动失败时留下的 bootError。
      // 场景：启动时最近库是「太新」的库 → bootError='ERR_LIBRARY_TOO_NEW' → 用户手动打开一个正常库，
      // 若不在这里清，之后关掉该库回到欢迎页时，那条与当前无关的旧错误又会冒出来（I5 带出的低危 UI 缺陷）。
      bootError.value = ''
      info.value = r.data ?? null
      useAssetStore().reset()
      await bootStep('meta')
      await loadMeta()
      await loadRecent()
      await bootStep('grid')
      return null
    } finally {
      // 成功分支由 App 在「首屏数据到位 + 一帧绘制」后收尾；这里留兜底：
      // 3s 后无论如何都关掉引导态 —— 用户不该被永远按在骨架屏上。
      setTimeout(() => {
        if (booting.value) {
          bootDepth = 0
          booting.value = false
        }
      }, BOOT_GUARD_MS)
    }
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

  /**
   * 从最近库列表移除（**只删记录，不删磁盘**）。移除的是当前库则回到欢迎页。
   *
   * 语义与 `closeLibrary` 的区别：close 只是「这次不看了」，记录还在列表里；
   * forget 是「这个库别再出现在我的列表里」，但**库目录、.stash、.thumbs、素材全部原样保留**，
   * 以后用「打开库…」指回该目录即可重新加回来。
   */
  async function forgetLibrary(target: string): Promise<string | null> {
    // ⚠️ isCurrent 必须在 IPC **之前**取：forget 成功后主进程已把当前库关掉（getInfo 变 null），
    // 事后再比较就永远拿到 false，欢迎页那套状态清理会被整段跳过。
    const isCurrent = info.value?.path.toLowerCase() === target.toLowerCase()
    const r = await window.stash.library.forget(target)
    if (!r.ok) return r.error ?? '移除失败'
    // forget 与 open/create/close 同属「库生命周期成功动作」，成功时一并清掉 bootError：
    // 移除的是当前库时用户直接回到欢迎页（与 closeLibrary 同一情形），留着陈旧文案一样会误导；
    // 移除的是别的库时，用户的操作上下文也已改变，那条启动理由同样不再代表当下。
    bootError.value = ''
    if (isCurrent) {
      useAssetStore().reset()
      info.value = null
      folders.value = []
      tags.value = []
      counts.value = { total: 0, byFolder: {}, byTag: {} }
      collapsed.value = []
    }
    await loadRecent()
    return null
  }

  async function refreshCounts(): Promise<void> {
    const c = await window.stash.asset.counts()
    if (c.data) counts.value = c.data
  }

  /**
   * 「占用空间」的重算信号（侧栏底部那一行）。
   *
   * 为什么需要它：那个数字是「素材字节 + 缓存字节」，侧栏只 watch `counts.total` 来触发重算。
   * 而**压缩**（原地替换、体积大降）与**文本保存**（内容变长变短）都只改 `size`、不改条数 ——
   * 条数没变 → 不触发 → 数字停在操作前，和刚弹出的「已压缩 N 张，省下 X MB」自相矛盾，
   * 用户只能手动点那一行才会更新。凡改了文件体积但不改条数的路径，收尾调一次 `bumpUsage()`。
   */
  const usageRev = ref(0)
  function bumpUsage(): void {
    usageRev.value++
  }

  return { info, folders, tags, counts, recent, bootError, folderById, subtreeCount, recentTags, tagCount, bootstrap, createLibrary, openLibrary, closeLibrary, forgetLibrary, refreshCounts, usageRev, bumpUsage, loadMeta,
    collapsed, isCollapsed, toggleCollapse, expandTo,
    // 开库引导态（骨架屏）：`booting` 期间 App 渲染骨架层；阶段文案看 `bootStage`
    booting, bootStage, bootKind, bootStuckAfterMs, bootMinMs, endBoot, finishBoot, __testSlowBoot }
})
