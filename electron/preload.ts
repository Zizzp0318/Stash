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
    setTags: (id: number, tagIds: number[]) => ipcRenderer.invoke('asset:setTags', { id, tagIds })
  },
  tag: {
    list: () => ipcRenderer.invoke('tag:list'),
    create: (args: { name: string; color?: string }) => ipcRenderer.invoke('tag:create', args)
  },
  dialog: {
    pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
    pickFiles: () => ipcRenderer.invoke('dialog:pick-files')
  }
})
