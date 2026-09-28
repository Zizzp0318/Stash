import { app, BrowserWindow, ipcMain, dialog, protocol, shell } from 'electron'
import { spawn } from 'child_process'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import * as librarySvc from './services/library'
import * as assetsSvc from './services/assets'
import * as importerSvc from './services/importer'
import * as clipboardSvc from './services/clipboard'
import * as previewSvc from './services/preview'
import { unwatchLibrary, watchLibrary } from './services/watcher'
import * as configSvc from './services/config'
import * as cacheSvc from './services/cache'
import * as healthSvc from './services/health'
import * as genmetaSvc from './services/genmeta'
import * as compressSvc from './services/compress'
import { runSmoke } from './services/smoke'
import { runSmokeM2 } from './services/smoke2'
import { runSmokeM3 } from './services/smoke3'
import { runSmokeM4 } from './services/smoke4'
import { runSmokeFolder } from './services/smoke-folder'
import { runSmokeSearch } from './services/smoke-search'
import { runSmokeTag } from './services/smoke-tag'
import { runSmokeEdit } from './services/smoke-edit'
import { runSmokePreview } from './services/smoke-preview'
import { runSmokeSettings } from './services/smoke-settings'
import { runSmokeMeta } from './services/smoke-meta'
import { runSmokeCompress } from './services/smoke-compress'
import { ensureThumb, ensureBatch, SIZES, type ThumbSize } from './services/thumbs'

// stash://thumb/{hash}/{size}.webp —— 缩略图自定义协议（需在 app ready 前注册）
protocol.registerSchemesAsPrivileged([
  { scheme: 'stash', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true, stream: true } }
])

// ==================== GPU 进程起不来时的自救 ====================
//
// 背景（实测，别凭印象改）：某些机器上（虚拟机 / 远程会话 / 显卡驱动异常），GPU 进程会以
// 0xC0000005 反复崩溃，而 Chromium 的策略是**连崩几次就 FATAL 退出整个应用**
// （`gpu_data_manager_impl_private.cc: GPU process isn't usable. Goodbye.`）。
// 用户看到的现象是「双击了没反应」，连个错误提示都没有 —— 对一个要分发的桌面应用来说这是硬伤。
//
// 实测数据（Electron 44 / 本机）：
//   · `--disable-gpu` **完全没用**：Chromium 照样起 GPU 进程，照样崩（6 次后 FATAL）
//   · `--disable-gpu-process-crash-limit` 只是把「放弃」改成「无限重试」：9 秒崩 264 次，更糟
//   · `--disable-gpu-sandbox` / `--in-process-gpu` 才真正有效（前者 0 崩溃，后者不起独立进程）
//   · 应用层**收得到** `child-process-gone`：第一次在 +110ms，而 FATAL 在 +500ms —— 来得及自救
const GPU_FALLBACK_FLAG = '--gpu-fallback'

/** 冒烟/自动化跑在受限环境里，而且本来就不需要渲染 —— 直接预先降级，省掉一次自救重启 */
const isSmokeRun = process.argv.some((a) => a.startsWith('--smoke-'))
if (isSmokeRun) app.commandLine.appendSwitch('disable-gpu-sandbox')

/**
 * 正常启动时的兜底：GPU 进程连续崩溃就自己拉起一个带降级开关的新实例。
 *
 * 三条实测出来的细节：
 * ① **只崩 1 次不动手**：单次崩溃多半是驱动重置，Chromium 自己重启 GPU 进程就好了；
 *    连续 2 次才说明是真起不来。
 * ② **用 detached spawn，不要用 `app.relaunch()`**：实测 `app.relaunch()` 拉起的子进程
 *    在父进程退出后约 90ms 就没了（连 `exit` 事件都不触发，是被硬杀的）；
 *    换成 `spawn(..., { detached: true, stdio: 'ignore' }).unref()` 后子进程能正常跑完。
 * ③ **必须一次性**：带上 `--gpu-fallback` 标记，新实例里不再自救，否则会无限重启。
 */
if (!isSmokeRun && !process.argv.includes(GPU_FALLBACK_FLAG)) {
  let gpuCrashes = 0
  app.on('child-process-gone', (_e, details) => {
    if (details?.type !== 'GPU') return
    gpuCrashes++
    if (gpuCrashes < 2) return
    console.warn('[gpu] GPU 进程连续崩溃，将以禁用 GPU 沙箱的方式重启一次')
    const args = process.argv.slice(1).concat([GPU_FALLBACK_FLAG, '--disable-gpu-sandbox'])
    try {
      spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    } catch (e) {
      console.error('[gpu] 自救重启失败：' + String((e as Error).message ?? e))
    }
    app.exit(0)
  })
}

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

    // 把文件拖进窗口时，Chromium 默认会「导航到该文件」——整个应用会被替换成一张图片。
    // 渲染层已经 preventDefault 了 drop，这里再兜一层：任何非本应用页面的跳转直接拦掉。
    w.webContents.on('will-navigate', (e, url) => {
      const devUrl = process.env['ELECTRON_RENDERER_URL']
      const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith('file://')
      if (!allowed) e.preventDefault()
    })

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

  /**
   * IPC 统一回执包装：`{ ok, data | error }`（项目铁律之一）。
   * 入参允许返回 Promise —— 服务层现在有 async 函数了（如预览的策略判定要 spawn ffmpeg），
   * 所以成功分支必须写成 `Awaited<T>`，否则 `data` 会变成一个 Promise 对象穿到渲染层。
   */
  function wrap<T>(fn: () => T | Promise<T>): Promise<{ ok: true; data: Awaited<T> } | { ok: false; error: string }> {
    return Promise.resolve()
      .then(fn)
      .then((data): { ok: true; data: Awaited<T> } => ({ ok: true, data: data as Awaited<T> }))
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
        // 顺带补扫「该扫还没扫」的生成参数。挂在 backfill 上而不是缩略图队列内部，
        // 是因为队列会按「缩略图是否已存在」过滤掉缓存命中的素材 —— 那些素材永远进不了队列，
        // 于是「先关着用、后来才打开提取」的用户永远补不上（见 genmeta.ts 的位标记设计）。
        genmetaSvc.backfillMeta()
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
    ipcMain.handle('asset:rename', (_e, { id, name }) => wrap(() => assetsSvc.renameAsset(id, name)))
    /** 库内复制：在目标文件夹生成一份保留评分/喜欢/备注/标签的副本 */
    ipcMain.handle('asset:copy', (_e, { ids, folderId }) => wrap(() => assetsSvc.copyAssets(ids ?? [], folderId ?? null)))
    /** 粘贴剪贴板里的文件：库内的生成副本，库外的走导入管线（分流在服务层） */
    ipcMain.handle('asset:paste', (_e, { paths, folderId }) => wrap(() => assetsSvc.pastePaths(paths ?? [], folderId ?? null)))
    ipcMain.handle('asset:setTags', (_e, { id, tagIds }) => wrap(() => assetsSvc.setTags(id, tagIds)))

    // 放大预览：先问「这张该怎么给」（原文件直出 / 要派生 / 不支持），需要派生时再显式发起生成。
    // 生成是长任务，IPC 不等它 —— 进度与结果走 preview:progress / preview:done 事件。
    ipcMain.handle('preview:info', (_e, { id }) => wrap(() => previewSvc.previewInfo(id)))
    ipcMain.handle('preview:ensure', (_e, { id }) => wrap(() => previewSvc.ensureDerived(id)))

    // 文本素材的读写。走 IPC 而不是协议：需要编码兜底、大小上限、mtime 冲突检测，
    // 以及「能不能编辑」这类元信息 —— 这些都不是「给一段字节」能表达的。
    ipcMain.handle('asset:text', (_e, { id }) => wrap(() => previewSvc.readText(id)))
    ipcMain.handle('asset:writeText', (_e, { id, text, baseMtime }) =>
      wrap(() => previewSvc.writeText(id, text, baseMtime)))

    // 交给系统：浏览器真解不了的格式（avi 等）的兜底出口，以及「在文件夹中显示」
    ipcMain.handle('shell:open', (_e, { id }) => wrap(() => assetsSvc.openAsset(id)))
    ipcMain.handle('shell:reveal', (_e, { id }) => wrap(() => assetsSvc.revealAsset(id)))

    ipcMain.handle('tag:list', () => wrap(() => assetsSvc.listTags()))
    ipcMain.handle('tag:create', (_e, args) => wrap(() => assetsSvc.createTag(args)))
    ipcMain.handle('tag:rename', (_e, { id, name }) => wrap(() => assetsSvc.renameTag(id, name)))
    ipcMain.handle('tag:delete', (_e, { id }) => wrap(() => assetsSvc.deleteTag(id)))

    // 系统剪贴板：读/写「文件列表」（复制源文件 / 粘贴外部文件）与纯文本
    ipcMain.handle('clipboard:write-files', (_e, paths) => wrap(() => clipboardSvc.writeFiles(paths ?? [])))
    ipcMain.handle('clipboard:read-files', () => wrap(() => clipboardSvc.readFiles()))
    ipcMain.handle('clipboard:write-text', (_e, text) => wrap(() => clipboardSvc.writeText(String(text ?? ''))))

    // 全局偏好（跨库一份，存在 userData/config.json）。
    // 改完向所有窗口广播：偏好是全局状态，别的窗口也得跟着变（现在只有一个窗口，
    // 但「谁改了谁广播」这条不能省 —— 否则以后加第二个窗口就是静默不一致）。
    ipcMain.handle('settings:get', () => wrap(() => configSvc.getSettings()))
    ipcMain.handle('settings:choices', () => wrap(() => configSvc.settingsChoices()))
    ipcMain.handle('settings:patch', (_e, patch) =>
      wrap(() => {
        const next = configSvc.patchSettings((patch ?? {}) as Partial<configSvc.Settings>)
        for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings:changed', next)
        return next
      })
    )

    // 缓存占用与清理（缩略图 / 派生预览分开算、分开清）
    ipcMain.handle('cache:stats', () => wrap(() => cacheSvc.cacheStats()))
    ipcMain.handle('cache:clear', (_e, { kind }) =>
      wrap(() => cacheSvc.clearCache(kind === 'derived' || kind === 'thumbs' || kind === 'all' ? kind : 'thumbs'))
    )
    // 在资源管理器里打开 .thumbs（清理前想自己看一眼时用）
    ipcMain.handle('cache:reveal', () =>
      wrap(async () => {
        const lib = librarySvc.getLibrary()
        if (!lib) throw new Error('ERR_NO_LIBRARY')
        const dir = join(lib.path, '.thumbs')
        if (!existsSync(dir)) throw new Error('ERR_NO_CACHE')
        const err = await shell.openPath(dir)
        return { opened: !err, error: err || null }
      })
    )

    // 按需压缩：把选中的图转成 JPG/WebP 并**原地替换**（不可逆，UI 侧已二次确认）。
    // 选项档位复用现成的 settings:choices（那边已经统一下发 compressQuality / compressMaxEdge）
    ipcMain.handle('compress:run', (_e, { ids, opts }) =>
      wrap(() => compressSvc.compressAssets((ids ?? []) as number[], (opts ?? {}) as compressSvc.CompressOptions))
    )

    // 生成参数：手动补扫
    ipcMain.handle('meta:backfill', () => wrap(() => genmetaSvc.backfillMeta()))
    // 来源标识的中文名由主进程给：渲染层再抄一张表迟早和上面分叉
    ipcMain.handle('meta:labels', () => wrap(() => genmetaSvc.AI_SOURCE_LABELS))

    // 库体检：找「索引还在、文件没了」的失效素材
    ipcMain.handle('health:stats', () => wrap(() => healthSvc.libraryStats()))
    ipcMain.handle('health:scan', () => wrap(() => healthSvc.scanMissing()))
    ipcMain.handle('health:clean', () => wrap(() => healthSvc.cleanMissing()))

    // 在资源管理器里打开**库目录**（不是 .thumbs）
    ipcMain.handle('library:reveal', () =>
      wrap(async () => {
        const lib = librarySvc.getLibrary()
        if (!lib) throw new Error('ERR_NO_LIBRARY')
        const err = await shell.openPath(lib.path)
        return { opened: !err, error: err || null }
      })
    )

    // 关于页要用的运行环境信息 + 打开配置目录
    ipcMain.handle('app:info', () =>
      wrap(() => ({
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        userData: app.getPath('userData')
      }))
    )
    ipcMain.handle('app:open-user-data', () =>
      wrap(async () => {
        const err = await shell.openPath(app.getPath('userData'))
        return { opened: !err, error: err || null }
      })
    )

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
        // 原文件 / 派生预览：stash://media/{id}
        // 走自定义协议而不是 file:// —— dev 下页面起源是 http，Chromium 会拦 file 子资源。
        // 这里必须**流式 + 支持 Range**（见 preview.serveMedia 的说明），
        // 所以不能照搬下面缩略图那种 readFileSync 整读。
        if (url.host === 'media') {
          if (!lib) return new Response('no library', { status: 404 })
          return await previewSvc.serveMedia(req, url.pathname.replace(/^\//, ''))
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

    // 图像压缩冒烟：真文件替换 / 保护规则 / 长边限制 / 界面 / watcher 一致性
    if (process.argv.includes('--smoke-compress')) {
      win.webContents.once('did-finish-load', () => {
        void runSmokeCompress(win)
      })
    }

    // 生成参数冒烟：六家解析器（纯解析）+ 导入后台扫到落库 + 卡片角标与详情栏 + 设置开关
    if (process.argv.includes('--smoke-meta')) {
      win.webContents.once('did-finish-load', () => {
        void runSmokeMeta(win)
      })
    }

    // 设置面板冒烟：入口 / 逐项生效（DOM + config 落盘）/ reload 持久化 / 旧偏好迁移 / 恢复默认
    if (process.argv.includes('--smoke-settings')) {
      win.webContents.once('did-finish-load', () => {
        void runSmokeSettings(win)
      })
    }

    // 文件夹管理冒烟：多级新建 / 重命名（子树 rel_path 同步）/ 物理删除，含 UI 右键菜单
    if (process.argv.includes('--smoke-folder')) {
      win.webContents.once('did-finish-load', () => {
        void runSmokeFolder(win)
      })
    }

    // 搜索与筛选冒烟：关键词 / 标签 / 评分 / 喜欢 / 类型 / 排序 / 分页 / 组合，含 UI 驱动
    if (process.argv.includes('--smoke-search')) {
      win.webContents.once('did-finish-load', () => {
        void runSmokeSearch(win)
      })
    }

    // 标签冒烟：详情页添加/摘掉标签 + 侧栏右键删除标签本体（含关联级联与筛选重置）
    if (process.argv.includes('--smoke-tag')) {
      win.webContents.once('did-finish-load', () => {
        void runSmokeTag(win)
      })
    }

    // 编辑能力冒烟：重命名素材/标签 + 提示词 + 复制粘贴源文件
    if (process.argv.includes('--smoke-edit')) {
      win.webContents.once('did-finish-load', () => {
        void runSmokeEdit(win)
      })
    }

    // 预览冒烟：主进程段（策略判定 / Range 流式 / 图片与视频派生）+ 渲染层段（浮层交互）
    if (process.argv.includes('--smoke-preview')) {
      win.webContents.once('did-finish-load', () => {
        void runSmokePreview(win)
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
