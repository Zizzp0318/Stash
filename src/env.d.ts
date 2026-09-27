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
}

export interface StashFolderApi {
  mkdir: (relPath: string) => Promise<{ ok: boolean; data?: { id: number; path: string }; error?: string }>
  /** 在指定父文件夹下新建子文件夹（parentPath 为空 = 库根目录） */
  mkdirChild: (parentPath: string, name: string) => Promise<{ ok: boolean; data?: { id: number; path: string }; error?: string }>
  /** 重命名文件夹：物理目录与索引（folders 子树 + assets.rel_path）一起同步 */
  rename: (id: number, name: string) => Promise<{ ok: boolean; data?: { id: number; path: string; folders: number; assets: number }; error?: string }>
  /** 删除整个文件夹：直接从磁盘删除，不可恢复（无回收站） */
  remove: (id: number) => Promise<{ ok: boolean; data?: { folders: number; assets: number; thumbsRemoved: number }; error?: string }>
  list: () => Promise<{ ok: boolean; data?: Array<{ id: number; parent_id: number | null; path: string; name: string }>; error?: string }>
}

export interface StashImportApi {
  files: (args: { paths: string[]; folderId?: number | null; mode?: 'copy' | 'move' }) => Promise<{ ok: boolean; data?: { importId: number }; error?: string }>
  onProgress: (cb: (d: { importId: number; done: number; total: number }) => void) => Unsub
  onDone: (cb: (d: { importId: number; added: number; skipped: number; failed: Array<{ path: string; error: string }> }) => void) => Unsub
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

export interface StashAssetApi {
  list: (q?: {
    folderId?: number | null
    tagId?: number | null
    type?: string
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
  update: (id: number, patch: { rating?: number; isFav?: boolean }) => Promise<{ ok: boolean; data?: null; error?: string }>
  /** 批量评分 / 喜欢 */
  bulkUpdate: (ids: number[], patch: { rating?: number; isFav?: boolean }) => Promise<{ ok: boolean; data?: { updated: number }; error?: string }>
  /** 批量移动到库内文件夹（物理文件 + 索引同步） */
  move: (ids: number[], folderId: number) => Promise<{ ok: boolean; data?: { moved: number; failed: StashBulkFail[] }; error?: string }>
  /** 批量删除：直接从磁盘删除，不可恢复（无回收站） */
  remove: (ids: number[]) => Promise<{
    ok: boolean
    data?: { deleted: number; failed: StashBulkFail[] }
    error?: string
  }>
  setTags: (id: number, tagIds: number[]) => Promise<{ ok: boolean; data?: null; error?: string }>
}

export interface StashTagApi {
  list: () => Promise<{ ok: boolean; data?: Array<{ id: number; name: string; color: string }>; error?: string }>
  create: (args: { name: string; color?: string }) => Promise<{ ok: boolean; data?: { id: number }; error?: string }>
}

export interface StashDialogApi {
  pickFolder: () => Promise<string | null>
  pickFiles: () => Promise<string[]>
}

export interface StashApi {
  win: StashWinApi
  library: StashLibraryApi
  folder: StashFolderApi
  import: StashImportApi
  thumb: StashThumbApi
  asset: StashAssetApi
  tag: StashTagApi
  dialog: StashDialogApi
}

declare global {
  interface Window {
    stash: StashApi
  }
}
