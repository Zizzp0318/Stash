import { app, BrowserWindow, ipcMain, dialog, protocol } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import * as librarySvc from './services/library'
import * as assetsSvc from './services/assets'
import * as importerSvc from './services/importer'
import { unwatchLibrary, watchLibrary } from './services/watcher'
import { runSmoke } from './services/smoke'
import { runSmokeM2 } from './services/smoke2'
import { runSmokeM3 } from './services/smoke3'
import { runSmokeM4 } from './services/smoke4'
import { runSmokeFolder } from './services/smoke-folder'
import { ensureThumb, ensureBatch, SIZES, type ThumbSize } from './services/thumbs'

// stash://thumb/{hash}/{size}.webp —— 缩略图自定义协议（需在 app ready 前注册）
protocol.registerSchemesAsPrivileged([
  { scheme: 'stash', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true, stream: true } }
])

// M1 冒烟测试模式：electron . --smoke-m1
if (process.argv.includes('--smoke-m1')) {
  app.whenReady().then(() => runSmoke())
} else if (process.argv.includes('--smoke-m2')) {
  app.whenReady().then(() => runSmokeM2())
} else if (process.argv.includes('--smoke-m3')) {
  app.whenReady().then(() => runSmokeM3())
} else if (process.argv.includes('--smoke-del')) {
  // 删除库冒烟：electron . --smoke-del <库路径>
  const idx = process.argv.indexOf('--smoke-del')
  const target = process.argv[idx + 1]
  app.whenReady().then(() => {
    try {
      librarySvc.deleteLibrary(target)
      console.log('SMOKE-DEL OK exists:', existsSync(target))
    } catch (e) {
      console.log('SMOKE-DEL FAIL:', String((e as Error).message ?? e))
    }
    app.exit(0)
  })
} else {
  bootstrap()
}

function bootstrap(): void {
  let win: BrowserWindow

  function createWindow(): BrowserWindow {
    const w = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 960,
      minHeight: 600,
      frame: false,
      backgroundColor: '#242629',
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    w.on('ready-to-show', () => w.show())

    // 临时诊断模式：--debug-lib <路径> 自动开库 + 渲染层日志透传到 stdout（只执行一次，避免 reload 循环）
    const debugLibIdx = process.argv.indexOf('--debug-lib')
    let debugRan = false
    if (debugLibIdx > 0) {
      const libPath = process.argv[debugLibIdx + 1]
      w.webContents.on('console-message', (_e, _lvl, message) => console.log('[renderer]', message))
      // 网络层真实错误码
      w.webContents.session.webRequest.onErrorOccurred({ urls: ['stash://*/*'] }, (details) => {
        console.log('[webRequest ERR]', details.error, details.url.slice(0, 80))
      })
      w.webContents.on('did-finish-load', () => {
        if (debugRan) return
        debugRan = true
        setTimeout(() => {
          w.webContents
            .executeJavaScript(
              `window.stash.library.open(${JSON.stringify(libPath)}).then(r => { console.log('OPEN_RESULT ' + JSON.stringify(r)); location.reload() })`
            )
            .catch((e) => console.log('[debug] execJS ERR', String(e)))
        }, 1200)
        // 8 秒后 dump 渲染层 <img> 真实状态
        setTimeout(() => {
          w.webContents
            .executeJavaScript(
              `(() => {
                 const imgs = [...document.querySelectorAll('.thumb-img')]
                 const out = { location: location.href, count: imgs.length, rows: [] }
                 for (const el of imgs.slice(0, 6)) {
                   const r = el.getBoundingClientRect()
                   const cs = getComputedStyle(el)
                   out.rows.push({ src: el.getAttribute('src'), currentSrc: el.currentSrc, complete: el.complete, nw: el.naturalWidth, nh: el.naturalHeight, op: cs.opacity, vis: cs.visibility, box: Math.round(r.width) + 'x' + Math.round(r.height) })
                 }
                 const cards = document.querySelectorAll('.card').length
                 const thumbDivs = [...document.querySelectorAll('.card .thumb')].slice(0,3).map(d => { const r = d.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height) + ' disp=' + getComputedStyle(d).display })
                 // 瀑布布局自检：列宽一致性、越界、重叠
                 const mas = document.querySelector('.masonry')
                 const mc = [...document.querySelectorAll('.masonry-card')]
                 const mr = mas?.getBoundingClientRect()
                 let overflow = 0, overlap = 0, maxBot = 0
                 const boxes = mc.map(c => { const r = c.getBoundingClientRect(); return { l: Math.round(r.left - mr.left), t: Math.round(r.top - mr.top), w: Math.round(r.width), h: Math.round(r.height) } })
                 for (const b of boxes) { if (b.l + b.w > mr.width + 1) overflow++; maxBot = Math.max(maxBot, b.t + b.h) }
                 for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
                   const a = boxes[i], b = boxes[j]
                   if (a.l < b.l + b.w && b.l < a.l + a.w && a.t < b.t + b.h && b.t < a.t + a.h) overlap++
                 }
                 const widths = [...new Set(boxes.map(b => b.w))]
                 const masonry = mas ? { containerW: Math.round(mr.width), height: Math.round(mr.height), maxBottom: Math.round(maxBot), cards: mc.length, distinctWidths: widths, overflow, overlap, sample: boxes.slice(0, 4).map(b => b.l + ',' + b.t + ' ' + b.w + 'x' + b.h) } : null
                 return JSON.stringify({ ...out, cards, thumbDivs, masonry })
               })()`
            )
            .then((s) => console.log('[imgdump]', s))
            .catch((e) => console.log('[imgdump ERR]', String(e)))
        }, 8000)
        // 开库 10 秒后截图，用来看渲染结果
        setTimeout(() => {
          w.webContents
            .capturePage()
            .then((img) => {
              require('fs').writeFileSync(join(process.cwd(), 'debug-shot.png'), img.toPNG())
              console.log('[debug] screenshot saved')
            })
            .catch((e) => console.log('[debug] capture ERR', String(e)))
        }, 12000)
      })
    }

    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl) {
      w.loadURL(devUrl)
    } else {
      w.loadFile(join(__dirname, '../renderer/index.html'))
    }

    return w
  }

  function wrap<T>(fn: () => T): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
    return Promise.resolve()
      .then(fn)
      .then((data) => ({ ok: true, data }))
      .catch((e) => ({ ok: false, error: String((e as Error).message ?? e) }))
  }

  function registerIpc(): void {
    // 窗口控制
    ipcMain.on('win:minimize', () => win.minimize())
    ipcMain.on('win:toggle-maximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()))
    ipcMain.on('win:close', () => win.close())
    ipcMain.handle('win:is-maximized', () => win.isMaximized())

    // 库
    ipcMain.handle('library:create', (_e, args) => wrap(() => librarySvc.createLibrary(args)))
    ipcMain.handle('library:delete', (_e, target: string) => wrap(() => librarySvc.deleteLibrary(target)))
    ipcMain.handle('library:open', (_e, target) =>
      wrap(() => {
        const info = librarySvc.openLibrary(target)
        watchLibrary(info.path, librarySvc.getDatabase())
        return info
      })
    )
    ipcMain.handle('library:list', () => wrap(() => librarySvc.listLibraries()))
    ipcMain.handle('library:info', () => wrap(() => librarySvc.getLibrary()))
    ipcMain.handle('library:close', () =>
      wrap(() => {
        unwatchLibrary()
        librarySvc.closeCurrent()
        return null
      })
    )

    // 文件夹
    ipcMain.handle('folder:mkdir', (_e, relPath) => wrap(() => librarySvc.mkdirRel(relPath)))
    ipcMain.handle('folder:mkdir-child', (_e, { parentPath, name }) => wrap(() => librarySvc.mkdirChild(parentPath, name)))
    ipcMain.handle('folder:rename', (_e, { id, name }) => wrap(() => librarySvc.renameFolder(id, name)))
    ipcMain.handle('folder:delete', (_e, id) => wrap(() => librarySvc.deleteFolder(id)))
    ipcMain.handle('folder:list', () => wrap(() => librarySvc.listFolders()))

    // 导入
    ipcMain.handle('import:files', (_e, args) => wrap(() => importerSvc.importFiles(args)))

    // 缩略图
    ipcMain.handle('thumb:ensure', (_e, { assetId, size }) =>
      wrap(() => ensureThumb(assetId, size in SIZES ? size : 'grid'))
    )
    ipcMain.handle('thumb:ensure-batch', (_e, { ids, size }) =>
      wrap(() => {
        const s: ThumbSize = size in SIZES ? size : 'grid'
        const rows = librarySvc.getDatabase()
          .prepare(`SELECT id, type, ext, content_hash, rel_path FROM assets WHERE id IN (${ids.map(() => '?').join(',')})`)
          .all(...ids) as Array<never>
        ensureBatch(rows, s)
        return { queued: rows.length }
      })
    )
    // 回填：为全库缺失的缩略图排队生成（导入后/开库后调用）
    ipcMain.handle('thumb:backfill', (_e, { size }) =>
      wrap(() => {
        const s: ThumbSize = size in SIZES ? size : 'grid'
        const rows = librarySvc.getDatabase()
          .prepare('SELECT id, type, ext, content_hash, rel_path FROM assets WHERE missing=0')
          .all() as Array<never>
        ensureBatch(rows, s)
        return { queued: rows.length }
      })
    )

    // 素材与标签
    ipcMain.handle('asset:list', (_e, q) => wrap(() => assetsSvc.listAssets(q ?? {})))
    ipcMain.handle('asset:counts', () => wrap(() => assetsSvc.counts()))
    ipcMain.handle('asset:get', (_e, id) => wrap(() => assetsSvc.getAsset(id)))
    ipcMain.handle('asset:update', (_e, { id, patch }) => wrap(() => assetsSvc.updateAsset(id, patch)))
    ipcMain.handle('asset:bulk-update', (_e, { ids, patch }) => wrap(() => assetsSvc.bulkUpdate(ids, patch)))
    ipcMain.handle('asset:move', (_e, { ids, folderId }) => wrap(() => assetsSvc.moveAssets(ids, folderId)))
    ipcMain.handle('asset:delete', (_e, { ids }) => wrap(() => assetsSvc.deleteAssets(ids)))
    ipcMain.handle('asset:setTags', (_e, { id, tagIds }) => wrap(() => assetsSvc.setTags(id, tagIds)))
    ipcMain.handle('tag:list', () => wrap(() => assetsSvc.listTags()))
    ipcMain.handle('tag:create', (_e, args) => wrap(() => assetsSvc.createTag(args)))

    // 系统对话框
    ipcMain.handle('dialog:pick-folder', async () => {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      return r.canceled ? null : r.filePaths[0]
    })
    ipcMain.handle('dialog:pick-files', async () => {
      const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })
      return r.canceled ? [] : r.filePaths
    })
  }

  app.whenReady().then(() => {
    // 缩略图协议：stash://thumb/{hash}/{grid|detail}.webp → 当前库 .thumbs 目录
    protocol.handle('stash', async (req) => {
      try {
        const url = new URL(req.url)
        const lib = librarySvc.getLibrary()
        if (process.argv.includes('--debug-lib')) {
          console.log('[stash-handler]', req.url, '| lib:', lib?.path ?? 'NULL')
        }
        if (url.host !== 'thumb' || !lib) return new Response('no library', { status: 404 })
        const segs = url.pathname.split('/').filter(Boolean)
        const hash = (segs[0] ?? '').toLowerCase().replace(/[^0-9a-f]/g, '')
        const size = (segs[1] ?? '').replace(/\.webp$/i, '')
        if (!/^[0-9a-f]{20}$/.test(hash) || !['grid', 'detail'].includes(size)) {
          return new Response('bad request', { status: 400 })
        }
        const file = join(lib.path, '.thumbs', hash, `${size}.webp`)
        if (!existsSync(file)) return new Response('not found', { status: 404 })
        // 直接读文件构造响应（protocol.handle 内嵌 net.fetch(file://) 处理渲染层请求时会死锁）
        const buf = readFileSync(file)
        return new Response(buf, {
          headers: {
            'content-type': 'image/webp',
            'content-length': String(buf.byteLength),
            // 缩略图可能因换库/重新生成而变更，禁用缓存，靠 URL 上的 ?v= 控制版本
            'cache-control': 'no-store'
          }
        })
      } catch (e) {
        console.log('[stash-handler ERR]', String(e))
        return new Response('error', { status: 500 })
      }
    })

    win = createWindow()
    registerIpc()

    // M4 冒烟：建临时库 → 导入 → 驱动渲染层跑完多选与批量操作 → 核对磁盘/数据库
    if (process.argv.includes('--smoke-m4')) {
      win.webContents.once('did-finish-load', () => {
        void runSmokeM4(win)
      })
    }

    // 文件夹管理冒烟：多级新建 / 重命名（子树 rel_path 同步）/ 物理删除，含 UI 右键菜单
    if (process.argv.includes('--smoke-folder')) {
      win.webContents.once('did-finish-load', () => {
        void runSmokeFolder(win)
      })
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) win = createWindow()
    })
  })

  app.on('window-all-closed', () => {
    unwatchLibrary()
    if (process.platform !== 'darwin') app.quit()
  })
}
