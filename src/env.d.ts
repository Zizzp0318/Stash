/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const component: DefineComponent<{}, {}, any>
  export default component
}

// 与 electron/preload.ts 保持同构
export interface StashWinApi {
  minimize: () => void
  toggleMaximize: () => void
  close: () => void
  isMaximized: () => Promise<boolean>
}

export interface Unsub {
  (): void
}

export interface StashLibraryApi {
  create: (args: { name: string; parentDir: string }) => Promise<{ ok: boolean; data?: { path: string; name: string }; error?: string }>
  delete: (target: string) => Promise<{ ok: boolean; data?: null; error?: string }>
  open: (target: string) => Promise<{ ok: boolean; data?: { path: string; name: string }; error?: string }>
  list: () => Promise<{ ok: boolean; data?: Array<{ path: string; name: string }>; error?: string }>
  close: () => Promise<{ ok: boolean; data?: null; error?: string }>
  getInfo: () => Promise<{ ok: boolean; data?: { path: string; name: string } | null; error?: string }>
  /** 库占用空间：素材（索引 size 之和）+ `.thumbs` 缓存实际占用 */
  usage: () => Promise<{
    ok: boolean
    data?: { assetsBytes: number; thumbsBytes: number; totalBytes: number }
    error?: string
  }>
  /** 在资源管理器里打开库目录 */
  reveal: () => Promise<{ ok: boolean; data?: { opened: boolean; error: string | null }; error?: string }>
}

export interface StashFolderApi {
  mkdir: (relPath: string) => Promise<{ ok: boolean; data?: { id: number; path: string }; error?: string }>
  /** 在指定父文件夹下新建子文件夹（parentPath 为空 = 库根目录） */
  mkdirChild: (parentPath: string, name: string) => Promise<{ ok: boolean; data?: { id: number; path: string }; error?: string }>
  /** 重命名文件夹：物理目录与索引（folders 子树 + assets.rel_path）一起同步 */
  rename: (id: number, name: string) => Promise<{ ok: boolean; data?: { id: number; path: string; folders: number; assets: number }; error?: string }>
  /** 删除整个文件夹：直接从磁盘删除，不可恢复（无回收站）。`pruned` = 连带失去全部素材的标签 */
  remove: (id: number) => Promise<{ ok: boolean; data?: { folders: number; assets: number; thumbsRemoved: number; pruned: StashPrunedTag[] }; error?: string }>
  list: () => Promise<{ ok: boolean; data?: Array<{ id: number; parent_id: number | null; path: string; name: string }>; error?: string }>
}

export interface StashImportApi {
  files: (args: { paths: string[]; folderId?: number | null; mode?: 'copy' | 'move' }) => Promise<{ ok: boolean; data?: { importId: number }; error?: string }>
  onProgress: (cb: (d: { importId: number; done: number; total: number }) => void) => Unsub
  onDone: (cb: (d: { importId: number; added: number; skipped: number; renamed: number; failed: Array<{ path: string; error: string }> }) => void) => Unsub
}

export interface StashThumbApi {
  ensure: (assetId: number, size: 'grid' | 'detail') => Promise<{ ok: boolean; data?: { url: string | null; generated: boolean }; error?: string }>
  ensureBatch: (ids: number[], size: 'grid' | 'detail') => Promise<{ ok: boolean; data?: { queued: number }; error?: string }>
  backfill: (size: 'grid' | 'detail') => Promise<{ ok: boolean; data?: { queued: number }; error?: string }>
  onProgress: (cb: (d: { done: number; total: number }) => void) => Unsub
  onDone: (cb: (d: { done: number; total: number }) => void) => Unsub
}

export interface StashAssetRow {
  id: number
  folder_id: number
  name: string
  rel_path: string
  type: 'image' | 'video' | 'audio' | 'text'
  ext: string
  size: number
  width: number | null
  height: number | null
  duration_ms: number | null
  content_hash: string | null
  rating: number
  is_fav: number
  palette: string | null
  /** 提示词 / 备注（详情栏色板下方那块，双击编辑） */
  note: string | null
  /** 从图片里提取到的生成参数（JSON 字符串；null = 没有或还没扫） */
  gen_meta: string | null
  /** 已扫过的类别位标记：1=生成参数 2=AI 来源。0 = 还没扫 */
  gen_state: number | null
  /** AI 来源标识（comfyui / c2aa:openai / aigc-cn …），卡片角标用 */
  ai_source: string | null
  file_mtime: number
  imported_at: number
  missing: number
}

export interface StashAssetDetail extends StashAssetRow {
  tags: Array<{ id: number; name: string; color: string }>
}

export interface StashBulkFail {
  id: number
  name: string
  error: string
}

/**
 * 因「一个素材都不挂」而被自动删除的标签。
 * 标签归零就失去意义，服务层各删除路径收尾会清掉它，并把清单回传给 UI 做提示。
 */
export interface StashPrunedTag {
  id: number
  name: string
}

export interface StashAssetApi {
  list: (q?: {
    folderId?: number | null
    /**
     * 点文件夹时是否把子文件夹的素材一起取出来（递归）。
     * 侧栏一律传 `true`：数字口径、列表内容、「N / 共 M」分母三处必须一致。
     */
    folderDeep?: boolean
    tagId?: number | null
    /** null = 不限类型（与 folderId / tagId 同样用 null 表示「不筛选」） */
    type?: string | null
    rating?: number
    fav?: boolean
    keyword?: string
    sort?: string
    order?: string
    offset?: number
    limit?: number
  }) => Promise<{ ok: boolean; data?: { total: number; items: StashAssetRow[] }; error?: string }>
  counts: () => Promise<{ ok: boolean; data?: { total: number; byFolder: Record<string, number>; byTag: Record<string, number> }; error?: string }>
  get: (id: number) => Promise<{ ok: boolean; data?: StashAssetDetail; error?: string }>
  update: (id: number, patch: { rating?: number; isFav?: boolean; note?: string }) => Promise<{ ok: boolean; data?: null; error?: string }>
  /** 批量评分 / 喜欢 */
  bulkUpdate: (ids: number[], patch: { rating?: number; isFav?: boolean }) => Promise<{ ok: boolean; data?: { updated: number }; error?: string }>
  /** 批量移动到库内文件夹（物理文件 + 索引同步）；`renamed` = 因目标目录重名被自动改名的数量 */
  move: (ids: number[], folderId: number) => Promise<{
    ok: boolean
    data?: { moved: number; renamed: number; failed: StashBulkFail[] }
    error?: string
  }>
  /** 批量删除：直接从磁盘删除，不可恢复（无回收站）。`pruned` = 连带失去全部素材的标签 */
  remove: (ids: number[]) => Promise<{
    ok: boolean
    data?: { deleted: number; failed: StashBulkFail[]; pruned: StashPrunedTag[] }
    error?: string
  }>
  /** 重写素材的标签集合；摘空的标签会被自动删除，清单见 `pruned` */
  setTags: (id: number, tagIds: number[]) => Promise<{ ok: boolean; data?: { pruned: StashPrunedTag[] }; error?: string }>
  /** 重命名素材文件名（物理文件 + 索引同步；扩展名不可修改）。
   *  `name` 是最终生效的名字；`renamedFrom` 非空表示原名被占用、已自动改名 */
  rename: (id: number, name: string) => Promise<{
    ok: boolean
    data?: { id: number; name: string; rel_path: string; renamedFrom: string | null }
    error?: string
  }>
  /** 库内复制：在目标文件夹生成一份带评分/喜欢/备注/标签的副本（重名自动加 (n)） */
  copy: (ids: number[], folderId?: number | null) => Promise<{
    ok: boolean
    data?: { copied: number; renamed: number; failed: StashBulkFail[] }
    error?: string
  }>
  /** 粘贴剪贴板里的文件：库内的生成副本，库外的走导入管线（进度复用 import 事件） */
  paste: (paths: string[], folderId?: number | null) => Promise<{
    ok: boolean
    data?: { copied: number; renamed: number; failed: StashBulkFail[]; importing: number }
    error?: string
  }>
  /**
   * 读文本素材内容。主进程负责编码兜底（UTF-8 严格解码失败退 GB18030）与大小上限，
   * `readOnly` 为真时 UI 只给预览、不给编辑。
   */
  text: (id: number) => Promise<{
    ok: boolean
    data?: {
      text: string
      encoding: string
      bytes: number
      mtime: number
      readOnly: boolean
      readOnlyReason: string | null
    }
    error?: string
  }>
  /**
   * 写文本素材（**写的是库内真文件**）。
   * `baseMtime` 与磁盘现状不符时抛 `ERR_MTIME_CONFLICT`（文件在软件外被改过），由 UI 决定是否覆盖。
   */
  writeText: (id: number, text: string, baseMtime?: number) => Promise<{
    ok: boolean
    data?: { bytes: number; mtime: number; hash: string; name: string }
    error?: string
  }>
}

/** 放大预览：策略查询 + 派生生成（进度走事件，IPC 不等长任务） */
export interface StashPreviewApi {
  /** 先问「这张该怎么给」：original 直出 / derived 需派生 / unsupported */
  info: (id: number) => Promise<{ ok: boolean; data?: StashPreviewInfo; error?: string }>
  /** 显式发起派生（长任务，立即返回 previewId，进度看下面两个订阅） */
  ensure: (id: number) => Promise<{ ok: boolean; data?: { previewId: number }; error?: string }>
  onProgress: (cb: (d: { previewId: number; assetId: number; ratio: number }) => void) => Unsub
  onDone: (cb: (d: { previewId: number; assetId: number; ok: boolean; derive?: string | null; error?: string }) => void) => Unsub
}

/**
 * 「这张素材该怎么给渲染层」的答复。
 * - `original`：原文件直出（Chromium 自己解得开）
 * - `derived`：得先产出派生文件（转码 / 高清大图），`ready` 为假时渲染层要发起 `preview.ensure`
 * - `unsupported`：本项目打不开，UI 显示 `reason`
 */
export interface StashPreviewInfo {
  id: number
  kind: 'image' | 'video' | 'audio' | 'text'
  strategy: 'original' | 'derived' | 'unsupported'
  ready: boolean
  derive: 'image' | 'remux' | 'transcode' | 'audio' | null
  mime: string | null
  reason: string | null
  bytes: number
  editable: boolean
  width: number | null
  height: number | null
  durationMs: number | null
}

/** 交给系统处理（Chromium 真解不了的格式的兜底出口 / 在文件夹中显示） */
export interface StashShellApi {
  /** 用系统默认程序打开素材。`opened` 为假时 `error` 说明原因 */
  open: (id: number) => Promise<{ ok: boolean; data?: { opened: boolean; error?: string }; error?: string }>
  reveal: (id: number) => Promise<{ ok: boolean; data?: { revealed: boolean }; error?: string }>
}

/** 系统剪贴板里的「文件列表」（uri-list ↔ CF_HDROP，资源管理器可直接互粘） */
export interface StashClipboardApi {
  /** 把库内文件的绝对路径写进系统剪贴板 */
  writeFiles: (paths: string[]) => Promise<{ ok: boolean; data?: { count: number }; error?: string }>
  /** 读系统剪贴板里的文件列表；不是文件时返回空数组 */
  readFiles: () => Promise<{ ok: boolean; data?: string[]; error?: string }>
  writeText: (text: string) => Promise<{ ok: boolean; data?: { ok: true }; error?: string }>
}

export interface StashTagApi {
  list: () => Promise<{ ok: boolean; data?: Array<{ id: number; name: string; color: string }>; error?: string }>
  create: (args: { name: string; color?: string }) => Promise<{ ok: boolean; data?: { id: number }; error?: string }>
  /** 重命名标签本体（素材关联不受影响） */
  rename: (id: number, name: string) => Promise<{ ok: boolean; data?: { id: number; name: string }; error?: string }>
  /** 彻底删除标签（不是从素材上摘掉），返回被解绑的素材数 */
  remove: (id: number) => Promise<{ ok: boolean; data?: { unlinked: number }; error?: string }>
}

export interface StashDialogApi {
  pickFolder: () => Promise<string | null>
  pickFiles: () => Promise<string[]>
}

/** 卡片下方常驻显示的字段开关（typeBadge = 缩略图右上角的类型角标） */
export interface StashCardFields {
  name: boolean
  dims: boolean
  size: boolean
  time: boolean
  typeBadge: boolean
  /** 缩略图左下角的「AI 生成」角标 */
  aiBadge: boolean
}

/** 缩略图管线偏好 */
export interface StashThumbSettings {
  concurrency: number
  quality: number
}

/** 预览与播放偏好 */
export interface StashPreviewSettings {
  idleHideMs: number
  maxImagePx: number
  textMaxBytes: number
  volume: number
  autoPlay: boolean
}

/** 导入偏好 */
export interface StashImportSettings {
  /** move 会把原文件从原位置搬走（源目录里就没有了） */
  mode: 'copy' | 'move'
  dedupe: boolean
  palette: boolean
  /** 提取 AI 生成参数（提示词/模型/采样器/种子） */
  extractMeta: boolean
  /** 识别 AI 来源标识（C2PA / 国内 AIGC 标识 / EXIF·XMP） */
  detectAi: boolean
}

/** 生成参数（services/genmeta.ts 的解析结果，存在 assets.gen_meta） */
export interface StashGenMeta {
  generator: string
  prompt: string
  negativePrompt: string
  model: string
  sampler: string
  scheduler: string
  steps: number | null
  cfg: number | null
  seed: string | null
  width: number | null
  height: number | null
  loras: string[]
  hasWorkflow: boolean
  rawKeys: string[]
}

/** 按需压缩偏好 */
export interface StashCompressSettings {
  format: 'jpeg' | 'webp'
  quality: number
  /** 长边上限；0 = 不限制 */
  maxEdge: number
  /** 也重新压缩已经是 JPG 的图（二次有损编码） */
  alsoJpeg: boolean
}

/** 全局偏好（存在 userData/config.json，跨库一份） */
export interface StashSettings {
  defaultView: 'masonry' | 'list'
  viewZoom: number
  cardFields: StashCardFields
  detailCollapsed: boolean
  thumbs: StashThumbSettings
  preview: StashPreviewSettings
  importing: StashImportSettings
  compress: StashCompressSettings
}

/** 深可选补丁：Partial<StashSettings> 只让顶层可选，嵌套对象得单独放开 */
export type StashSettingsPatch = Partial<
  Omit<StashSettings, 'cardFields' | 'thumbs' | 'preview' | 'importing' | 'compress'>
> & {
  cardFields?: Partial<StashCardFields>
  thumbs?: Partial<StashThumbSettings>
  preview?: Partial<StashPreviewSettings>
  importing?: Partial<StashImportSettings>
  compress?: Partial<StashCompressSettings>
}

export interface StashSettingsChoices {
  quality: number[]
  concurrency: { min: number; max: number }
  idleHideMs: number[]
  maxImagePx: number[]
  textMaxMb: number[]
  compressQuality: number[]
  compressMaxEdge: number[]
}

export interface StashSettingsApi {
  get: () => Promise<{ ok: boolean; data?: StashSettings; error?: string }>
  choices: () => Promise<{ ok: boolean; data?: StashSettingsChoices; error?: string }>
  /** 只覆盖传进来的字段 */
  patch: (patch: StashSettingsPatch) => Promise<{ ok: boolean; data?: StashSettings; error?: string }>
  onChanged: (cb: (s: StashSettings) => void) => Unsub
}

export interface StashAppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  userData: string
}

export interface StashCacheBucket {
  files: number
  bytes: number
}

export interface StashCacheStats {
  dir: string
  total: StashCacheBucket
  thumbs: StashCacheBucket
  derived: StashCacheBucket
  other: StashCacheBucket
}

export interface StashLibraryStats {
  name: string
  path: string
  assets: number
  missingFlagged: number
  bytes: number
}

export interface StashScanResult {
  checked: number
  missing: number
  samples: string[]
  flagFixed: number
}

export interface StashCleanMissingResult {
  removed: number
  freed: number
  pruned: Array<{ id: number; name: string }>
}

export interface StashCompressItem {
  id: number
  name: string
  status: 'done' | 'skipped' | 'failed'
  reason: string
  before: number
  after: number
  newName?: string
}

export interface StashCompressSummary {
  total: number
  done: number
  skipped: number
  failed: number
  beforeBytes: number
  afterBytes: number
  savedBytes: number
  items: StashCompressItem[]
}

export interface StashCompressApi {
  /** 把选中的图转码并**原地替换**（原文件会被删除，不可恢复） */
  run: (
    ids: number[],
    opts: Partial<StashCompressSettings>
  ) => Promise<{ ok: boolean; data?: StashCompressSummary; error?: string }>
  onProgress: (cb: (d: { done: number; total: number; name: string; status: string; savedBytes: number }) => void) => Unsub
  onDone: (cb: (d: { summary: StashCompressSummary }) => void) => Unsub
}

export interface StashMetaApi {
  /** 把「该扫但还没扫」的图片入队（开库与导入后都会自动跑） */
  backfill: () => Promise<{ ok: boolean; data?: { queued: number }; error?: string }>
  /** 清掉「已扫过」状态位后全库重扫（解析器升级后用，用户显式触发） */
  rescan: () => Promise<{ ok: boolean; data?: { queued: number }; error?: string }>
  /** 来源标识 id → 中文名（卡片角标的悬停说明用） */
  labels: () => Promise<{ ok: boolean; data?: Record<string, string>; error?: string }>
  onDone: (cb: (d: unknown) => void) => Unsub
}

export interface StashHealthApi {
  stats: () => Promise<{ ok: boolean; data?: StashLibraryStats; error?: string }>
  /** 逐个核对磁盘（慢，用户显式点才跑） */
  scan: () => Promise<{ ok: boolean; data?: StashScanResult; error?: string }>
  /** 清理失效索引行（只动索引与缓存，不碰磁盘上的用户文件） */
  clean: () => Promise<{ ok: boolean; data?: StashCleanMissingResult; error?: string }>
}

export interface StashCacheApi {
  stats: () => Promise<{ ok: boolean; data?: StashCacheStats; error?: string }>
  /** kind=thumbs 只清缩略图（可秒级重建）；derived 清派生预览（下次打开要重新转码） */
  clear: (kind: 'thumbs' | 'derived' | 'all') => Promise<{ ok: boolean; data?: { removed: number; freed: number }; error?: string }>
  reveal: () => Promise<{ ok: boolean; data?: { opened: boolean; error: string | null }; error?: string }>
}

export interface StashAppApi {
  info: () => Promise<{ ok: boolean; data?: StashAppInfo; error?: string }>
  openUserData: () => Promise<{ ok: boolean; data?: { opened: boolean; error: string | null }; error?: string }>
}

export interface StashApi {
  win: StashWinApi
  library: StashLibraryApi
  folder: StashFolderApi
  import: StashImportApi
  thumb: StashThumbApi
  asset: StashAssetApi
  preview: StashPreviewApi
  shell: StashShellApi
  clipboard: StashClipboardApi
  /** 拖拽进来的 File → 磁盘绝对路径（Electron 32+ 必须用 webUtils） */
  pathForFile: (file: File) => string
  tag: StashTagApi
  dialog: StashDialogApi
  settings: StashSettingsApi
  cache: StashCacheApi
  health: StashHealthApi
  meta: StashMetaApi
  compress: StashCompressApi
  app: StashAppApi
}

declare global {
  interface Window {
    stash: StashApi
  }
}
