import { contextBridge, ipcRenderer, webUtils } from 'electron'
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
    /** 重命名文件名（物理文件 + name/rel_path 同步；扩展名不可改） */
    rename: (id: number, name: string) => ipcRenderer.invoke('asset:rename', { id, name }),
    /** 库内复制：在目标文件夹生成一份带评分/喜欢/备注/标签的副本 */
    copy: (ids: number[], folderId?: number | null) => ipcRenderer.invoke('asset:copy', { ids, folderId }),
    /** 粘贴剪贴板里的文件：库内的生成副本，库外的走导入管线 */
    paste: (paths: string[], folderId?: number | null) => ipcRenderer.invoke('asset:paste', { paths, folderId }),
    setTags: (id: number, tagIds: number[]) => ipcRenderer.invoke('asset:setTags', { id, tagIds }),
    /** 读文本素材内容（主进程负责编码兜底与大小上限，回传 encoding / readOnly） */
    text: (id: number) => ipcRenderer.invoke('asset:text', { id }),
    /**
     * 写文本素材（**写的是库里的真文件**）。
     * `baseMtime` 是读的时候拿到的 mtime：主进程会拿它比对磁盘现状，
     * 不一致说明文件在软件外被改过，会抛 ERR_MTIME_CONFLICT 让 UI 去问用户，而不是静默覆盖。
     */
    writeText: (id: number, text: string, baseMtime?: number) =>
      ipcRenderer.invoke('asset:writeText', { id, text, baseMtime })
  },
  /** 放大预览：策略查询 + 派生（转码 / 高清大图）生成，进度与结果走事件 */
  preview: {
    /** 先问「这张该怎么给」：original 直出 / derived 需派生 / unsupported */
    info: (id: number) => ipcRenderer.invoke('preview:info', { id }),
    /** 显式发起派生。长任务，立即返回 previewId，进度看下面两个订阅 */
    ensure: (id: number) => ipcRenderer.invoke('preview:ensure', { id }),
    onProgress: (cb: (d: unknown) => void) => subscribe('preview:progress', cb),
    onDone: (cb: (d: unknown) => void) => subscribe('preview:done', cb)
  },
  /** 交给系统处理（Chromium 真解不了的格式的兜底出口 / 在文件夹中显示） */
  shell: {
    open: (id: number) => ipcRenderer.invoke('shell:open', { id }),
    reveal: (id: number) => ipcRenderer.invoke('shell:reveal', { id })
  },
  /** 系统剪贴板里的「文件列表」（uri-list ↔ CF_HDROP，资源管理器可直接互粘） */
  clipboard: {
    writeFiles: (paths: string[]) => ipcRenderer.invoke('clipboard:write-files', paths),
    /** 剪贴板里不是文件时返回空数组 */
    readFiles: () => ipcRenderer.invoke('clipboard:read-files'),
    writeText: (text: string) => ipcRenderer.invoke('clipboard:write-text', text)
  },
  /**
   * 拖拽进来的 File 对象 → 磁盘绝对路径。
   * Electron 32 起已移除 `File.path`，必须走 `webUtils.getPathForFile`，
   * 且要在 drop 事件里**同步**调用（事件结束后 File 就失效了）。
   */
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  tag: {
    list: () => ipcRenderer.invoke('tag:list'),
    create: (args: { name: string; color?: string }) => ipcRenderer.invoke('tag:create', args),
    rename: (id: number, name: string) => ipcRenderer.invoke('tag:rename', { id, name }),
    remove: (id: number) => ipcRenderer.invoke('tag:delete', { id })
  },
  dialog: {
    pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
    pickFiles: () => ipcRenderer.invoke('dialog:pick-files')
  }
})
