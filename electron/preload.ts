import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

function subscribe(channel: string, cb: (data: unknown) => void): () => void {
  const handler = (_e: IpcRendererEvent, data: unknown) => cb(data)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('stash', {
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    close: () => ipcRenderer.send('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:is-maximized')
  },
  library: {
    create: (args: { name: string; parentDir: string }) => ipcRenderer.invoke('library:create', args),
    delete: (target: string) => ipcRenderer.invoke('library:delete', target),
    open: (target: string) => ipcRenderer.invoke('library:open', target),
    list: () => ipcRenderer.invoke('library:list'),
    close: () => ipcRenderer.invoke('library:close'),
    getInfo: () => ipcRenderer.invoke('library:info')
  },
  folder: {
    mkdir: (relPath: string) => ipcRenderer.invoke('folder:mkdir', relPath),
    /** 在指定父文件夹下新建子文件夹（parentPath 为空 = 库根目录） */
    mkdirChild: (parentPath: string, name: string) => ipcRenderer.invoke('folder:mkdir-child', { parentPath, name }),
    /** 重命名：物理目录 + folders 子树 path + assets.rel_path 一并同步 */
    rename: (id: number, name: string) => ipcRenderer.invoke('folder:rename', { id, name }),
    /** 删除整个文件夹：物理删除，不可恢复（无回收站） */
    remove: (id: number) => ipcRenderer.invoke('folder:delete', id),
    list: () => ipcRenderer.invoke('folder:list')
  },
  import: {
    files: (args: { paths: string[]; folderId?: number | null; mode?: 'copy' | 'move' }) =>
      ipcRenderer.invoke('import:files', args),
    onProgress: (cb: (d: unknown) => void) => subscribe('import:progress', cb),
    onDone: (cb: (d: unknown) => void) => subscribe('import:done', cb)
  },
  thumb: {
    ensure: (assetId: number, size: 'grid' | 'detail') => ipcRenderer.invoke('thumb:ensure', { assetId, size }),
    ensureBatch: (ids: number[], size: 'grid' | 'detail') => ipcRenderer.invoke('thumb:ensure-batch', { ids, size }),
    backfill: (size: 'grid' | 'detail') => ipcRenderer.invoke('thumb:backfill', { size }),
    onProgress: (cb: (d: unknown) => void) => subscribe('thumb:progress', cb),
    onDone: (cb: (d: unknown) => void) => subscribe('thumb:done', cb)
  },
  asset: {
    list: (q?: unknown) => ipcRenderer.invoke('asset:list', q),
    counts: () => ipcRenderer.invoke('asset:counts'),
    get: (id: number) => ipcRenderer.invoke('asset:get', id),
    update: (id: number, patch: unknown) => ipcRenderer.invoke('asset:update', { id, patch }),
    bulkUpdate: (ids: number[], patch: unknown) => ipcRenderer.invoke('asset:bulk-update', { ids, patch }),
    move: (ids: number[], folderId: number) => ipcRenderer.invoke('asset:move', { ids, folderId }),
    remove: (ids: number[]) => ipcRenderer.invoke('asset:delete', { ids }),
    setTags: (id: number, tagIds: number[]) => ipcRenderer.invoke('asset:setTags', { id, tagIds })
  },
  tag: {
    list: () => ipcRenderer.invoke('tag:list'),
    create: (args: { name: string; color?: string }) => ipcRenderer.invoke('tag:create', args),
    remove: (id: number) => ipcRenderer.invoke('tag:delete', { id })
  },
  dialog: {
    pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
    pickFiles: () => ipcRenderer.invoke('dialog:pick-files')
  }
})
