import { app, BrowserWindow, ipcMain, dialog, protocol, shell, Tray, Menu, nativeImage, nativeTheme } from 'electron'
import { spawn } from 'child_process'
import { join, dirname } from 'path'
import { existsSync, readFileSync, rmSync, mkdirSync, mkdtempSync, writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import * as librarySvc from './services/library'
import * as assetsSvc from './services/assets'
import * as importerSvc from './services/importer'
import * as clipboardSvc from './services/clipboard'
import * as previewSvc from './services/preview'
import {
  unwatchLibrary, watchLibrary, isWatching, suspendWatchingAsync, reconcileWhenReady, suppressSubtree
} from './services/watcher'
import * as configSvc from './services/config'
import * as cacheSvc from './services/cache'
import * as healthSvc from './services/health'
import * as genmetaSvc from './services/genmeta'
import * as compressSvc from './services/compress'
import * as updateSvc from './services/update'
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
import { runSmokeWelcome } from './services/smoke-welcome'
import { runSmokeWatch } from './services/smoke-watch'
import { runSmokeVScroll } from './services/smoke-vscroll'
import { ensureThumb, ensureBatch, retestLegacyDims, pausePumpAsync, resumePump, invalidateGridPresence, SIZES, type ThumbSize } from './services/thumbs'
import { pauseMetaPumpAsync, resumeMetaPump } from './services/genmeta'
import { registerMediaHandleGuard, registerRenameIsolationGuard } from './services/handles'
import { isThumbHash } from './services/paths'

/**
 * 把 `preview` 的「媒体句柄释放 / 抑制」实现接进 `handles.ts` 的注册表。
 *
 * 为什么需要这份注册表：`preview.ts` import 了 `library.ts`（取库路径），
 * 所以 `library.renameFolder` **不能**反向 import `preview.ts` —— 会成环（MEMORY.md I3）。
 * 由 `main.ts`（谁都 import、谁都不被 import 的顶层）在启动时把实现接上，
 * 依赖方向变成 `library → handles ← preview`，没有环。
 *
 * 为什么放在**模块顶层**而不是 `bootstrap()` 里：正常启动走 `bootstrap()`，
 * 12 套冒烟走别的分支，放顶层才能保证「任何入口都接上」——
 * 否则 `--smoke-folder` 那条端到端断言会因为「没人注册」而退化成空转（G11）。
 */
registerMediaHandleGuard(previewSvc.mediaHandleGuard)

/**
 * 把「改名隔离」的三个实现接进 `handles.ts` 的第二份注册表。
 *
 * 为什么在这里接（而不是让 library 直接 import 它们）：`library` 被 `watcher` / `thumbs` /
 * `genmeta` / `preview` **全都** import 着，反向 import 会立刻成环（MEMORY.md I3）。
 * `main.ts` 是唯一「谁都 import、谁都不被 import」的顶层，所以由它接线：
 *   `library → handles ← watcher / thumbs / genmeta`。
 *
 * 三件事各自为什么必须由 main 转一手：
 *   · 暂停泵：`thumbs` / `genmeta` 都 import 了 `library`（取库路径），library 不能反向调；
 *   · 停/重挂监听器：`watchLibrary(libPath, db)` 需要**当前库**的路径与连接，而
 *     `library.renameFolder` 手上现成有这两个值，顺着 handles 的参数传进来最稳
 *     （让实现方自己 `requireCurrent()` 会在「改名失败 + 事务回滚」的中间态读到不确定的值）。
 *
 * 同样放在模块顶层：12 套冒烟各有入口分支，放 `bootstrap()` 里会让冒烟退化成空转（G11）。
 */
registerRenameIsolationGuard({
  async pausePumps(maxWaitMs: number) {
    // 两个泵并行暂停：串行等待会让上限翻倍（各 3s），并行则总上限仍是 3s。
    const [thumbs, meta] = await Promise.all([pausePumpAsync(maxWaitMs), pauseMetaPumpAsync(maxWaitMs)])
    return [
      { pump: 'thumbs' as const, ...thumbs },
      { pump: 'genmeta' as const, ...meta }
    ]
  },
  resumePumps() {
    // 顺序无关：两个泵互不依赖，各自幂等。任一抛错不能挡住另一个。
    try {
      resumePump()
    } finally {
      resumeMetaPump()
    }
  },
  suspendWatcher() {
    // 必须是**可等待**的 `suspendWatchingAsync`：`unwatchLibrary()` 只是发起 close() 就返回，
    // 而 Windows 上目录句柄在 close 真正完成前仍会挡住祖先目录改名（实测：这是本轮的关键）。
    return suspendWatchingAsync()
  },
  restartWatcher(libPath, db) {
    // `watchLibrary` 开头自带 `unwatchLibrary()`，所以这里不会产生重复 watcher；
    // `ignoreInitial: true` 保证重挂时不会炸出一堆 add 事件（把存量素材重复索引）。
    watchLibrary(libPath, db)
    return isWatching()
  },
  watcherActive() {
    return isWatching()
  },
  suppressTree(rel: string, ms?: number) {
    // 搬迁前登记：旧路径的 unlink/unlinkDir（以及搬到新路径后 chokidar 补发的事件）
    // 都不该再改索引 —— 索引事务只改 rel_path、不碰 missing，漏进来就是一片灰卡。
    // 前缀 + 按时间过期（不消费）：一次目录搬迁会来 unlinkDir + N 个 unlink，消费式挡不住。
    suppressSubtree(rel, ms)
  },
  reconcileAfterWindow(libPath, db) {
    // 停监听 → 重挂到 ready 之间写进库的文件会被 ignoreInitial 吞掉（窗口随库规模线性增长），
    // 全库又没有第二个「磁盘 → 索引」入口，所以这条是收尾责任：等 ready 后补一次对账。
    // 内部 `setImmediate` + 不 await，绝不拖慢改名/删除的 IPC 返回。
    reconcileWhenReady(db, libPath)
  }
})

/**
 * 移除库的**唯一收口入口**：IPC 与 `--smoke-forget` 都走它，避免两处各写一遍。
 *
 * 顺序刻意是「先删记录、后关库」：万一写配置失败，应用仍停在原来的库上，
 * 不会出现「库还开着、但列表里已经没了」这种半截状态。
 * 当前库要先 unwatch 再 close（同 library:close）：chokidar 持有句柄时直接 close 不干净。
 *
 * ⚠️ 全程不允许出现 rmSync / unlink —— 这个函数**只删 config.json 里的一行记录**。
 */
function forgetLibrary(target: string): { removed: boolean } {
  const res = librarySvc.forgetLibrary(target)
  const cur = librarySvc.getLibrary()
  const isCurrent = !!cur && cur.path.toLowerCase() === librarySvc.normalizeLibraryPath(target).toLowerCase()
  if (isCurrent) {
    unwatchLibrary()
    librarySvc.closeCurrent()
  }
  return res
}

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

// ── 数据目录：默认 `%APPDATA%\Stash`，**便携模式**下改到「程序目录旁的 data\」 ──
//
// 两条触发通道（任一成立即可）：
//   · 程序目录里有标记文件 `portable.txt` —— 便携包 zip 里预置了它，**解压即便携**
//   · 启动参数带 `--portable`
//
// ⚠️ 必须在 app ready 之前 setPath：Chromium 一旦把 userData 用起来就改不动了。
// ⚠️ 开发模式下「程序目录」取 `process.cwd()`：dev 时 `process.execPath` 指向
//    `node_modules/electron/dist/electron.exe`，按它算会把数据丢进依赖目录里。
// ⚠️ 目标目录不可写时**退回默认目录并打印警告**，不静默假装成功 ——
//    否则用户以为数据在 U 盘上、其实写回了 C 盘（便携包常被放在只读介质或受保护目录）。
const PORTABLE_MARK = 'portable.txt'

/** 「程序目录」：打包后是 exe 所在目录，开发时是项目根 */
function appDir(): string {
  return app.isPackaged ? dirname(process.execPath) : process.cwd()
}

/** 便携数据目录；没启用便携、或目录不可写时返回 null */
function resolvePortableDir(): string | null {
  if (!process.argv.includes('--portable') && !existsSync(join(appDir(), PORTABLE_MARK))) return null
  const dir = join(appDir(), 'data')
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, '.write-probe')
    writeFileSync(probe, 'ok')
    unlinkSync(probe)
    return dir
  } catch (e) {
    console.warn(
      `[Stash] 便携数据目录不可写，已退回默认目录：${dir} —— ${String((e as Error).message ?? e)}`
    )
    return null
  }
}

const portableDir = resolvePortableDir()
if (portableDir) app.setPath('userData', portableDir)

// **所有冒烟都跑在一次性 userData 里**（config.json 根本不落在用户目录）。两个理由：
//   ① 绝不碰用户真实配置 —— 用户 2026-09-29 明确提过：不想每次冒烟都拿他的设置跑。
//      顺带治好一个副作用：套件里的 createLibrary 会 addRecentLibrary，以前会把一堆
//      `smoke-*-lib` 临时库写进用户「最近打开的库」列表里。
//   ② 每次都是全新的默认设置 → 断言可复现，不会因为用户改了「高清预览上限 / 自动播放」
//      之类的偏好就让断言整片变红（那种红跟产品有没有坏毫无关系）。
// `--smoke-welcome` 原先就靠这招保证「落在欢迎页」（config 里没有历史库），这里推广到全部。
// 必须在 app ready 之前设置；目录固定、启动时先清空，所以不会留一堆残留。
// ⚠️ 这一层的**优先级高于便携模式**：冒烟永远用一次性目录，绝不动 portable\data。
if (isSmokeRun) {
  const ud = join(tmpdir(), 'stash-smoke-ud')
  try {
    rmSync(ud, { recursive: true, force: true })
  } catch {
    /* 清不掉就复用：里面也只会是上一次冒烟写的东西 */
  }
  app.setPath('userData', ud)
}

// 数据目录排错入口：`electron . --data-dir-probe` 一行看清「最终用的是哪个目录、为什么」
// （放在冒烟那段之后，这样报告的是**最终生效**的值）
if (process.argv.includes('--data-dir-probe')) {
  console.log(
    '[stash-data-dir] ' +
      JSON.stringify({
        packaged: app.isPackaged,
        appDir: appDir(),
        portable: portableDir,
        smoke: isSmokeRun,
        userData: app.getPath('userData')
      })
  )
  app.exit(0)
}

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

// 单实例：托盘常驻后再双击图标，应唤起已有窗口而不是开出第二个进程。
// 必须在 userData 重定向**之后**请求 —— 锁按 userData 划分，冒烟各自的一次性目录互不相干。
const gotLock = app.requestSingleInstanceLock()

// M1 冒烟测试模式：electron . --smoke-m1
if (!gotLock) {
  app.quit()
} else if (process.argv.includes('--smoke-m1')) {
  app.whenReady().then(() => runSmoke())
} else if (process.argv.includes('--smoke-m2')) {
  app.whenReady().then(() => runSmokeM2())
} else if (process.argv.includes('--smoke-m3')) {
  app.whenReady().then(() => runSmokeM3())
} else if (process.argv.includes('--smoke-forget')) {
  // 移除库冒烟：electron . --smoke-forget（**不带参数**，自己造库自己收尾）
  // 核心承诺：记录被移除，但目录 / .stash / .thumbs 一个都不少。
  // 不用 argv 传库路径：手搓的目录不在 config.json 里，`wasListed` 会恒为 false，
  // 断言就成了空转（铁律 G9）。用应用自己的 createLibrary 造库，才是真实路径。
  app.whenReady().then(() => {
    const root = mkdtempSync(join(tmpdir(), 'stash-forget-'))
    try {
      const lib = librarySvc.createLibrary({ name: 'forget-smoke-lib', parentDir: root })
      const listed = (): boolean =>
        librarySvc.listLibraries().some((l) => l.path.toLowerCase() === lib.path.toLowerCase())

      const wasListed = listed() // 正对照：必须在列表里
      const res = forgetLibrary(lib.path) // 与 IPC 共用同一个收口函数
      const stillListed = listed()

      const dirExists = existsSync(lib.path)
      const stashExists = existsSync(join(lib.path, '.stash'))
      const thumbsExists = existsSync(join(lib.path, '.thumbs'))
      const currentCleared = librarySvc.getLibrary() === null

      console.log('[SMOKE-FORGET] ' + JSON.stringify({
        wasListed, removed: res.removed, stillListed,
        dirExists, stashExists, thumbsExists, currentCleared,
        ok: wasListed && res.removed && !stillListed && dirExists && stashExists && thumbsExists && currentCleared
      }))
    } catch (e) {
      console.log('[SMOKE-FORGET] FAIL:', String((e as Error).message ?? e))
    } finally {
      // 只清这个临时根目录（自己建的），不碰任何用户数据
      try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    app.exit(0)
  })
} else {
  bootstrap()
}

function bootstrap(): void {
  let win: BrowserWindow

  /**
   * 窗口底色 = 主题的「外壳色」（与渲染层的 `--bg-app` 同值）。
   *
   * 它什么时候会被看见：
   *   ① 启动首帧（窗口 show:false + ready-to-show，正常路径看不到）；
   *   ② **拖拽改变窗口大小时新暴露出来的那块区域** —— 这块由 OS 直接填窗口背景色，
   *      CSS 还没重绘到那儿。写死 #0D0D0E 的话，浅色用户一拉窗口就闪出一道深色边。
   *
   * ⚠️ 必须用**外壳色**（`--bg-app`）而不是面板色（`--bg-panel`）：窗口最外圈就是外壳，
   * 面板是从外壳「长」出来的。用面板色会让拉伸时新暴露的那条边比紧邻的顶栏/侧栏亮一档，
   * 看起来像边缘漏光；首帧也应该是「先外壳、再长出面板」这个由外向内的顺序。
   *
   * 只在**创建时**取一次，刻意不做实时同步：主题变了重开窗口即可，为此在主进程与渲染层之间
   * 架一条实时同步通道属于过度设计（这条底色只影响上面那两个瞬间）。
   *
   * `system` 用 `nativeTheme.shouldUseDarkColors` 解析 —— 与渲染层
   * `matchMedia('(prefers-color-scheme: light)')` 是同一个事实源，不会分叉。
   * 配置读不出来（首启 / 文件损坏）就回落深色：那是 `:root` 的默认，也是既有观感。
   */
  function windowBgColor(): string {
    let theme: 'dark' | 'light' | 'system' = 'dark'
    try {
      theme = configSvc.getSettings().theme
    } catch {
      /* 配置还没就绪：回落深色（注释见上） */
    }
    if (theme === 'light') return '#E8E4DC' // --bg-app（外壳色）：窗口最外圈就是它
    if (theme === 'system') return nativeTheme.shouldUseDarkColors ? '#0D0D0E' : '#E8E4DC'
    return '#0D0D0E'
  }

  function createWindow(): BrowserWindow {
    const w = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 960,
      minHeight: 600,
      frame: false,
      // 与 --bg-app / --bg-panel 同值（见 windowBgColor 的注释）：
      // 无边框窗口首帧/透明处/拉伸时新暴露的区域露出的就是它。
      // ⚠️ 之前这里写死 #0D0D0E，浅色主题下拉伸窗口会露出一道深色边。
      backgroundColor: windowBgColor(),
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
    // 移除库：只删软件里的记录，磁盘不动。收口入口见上面的 `forgetLibrary()`。
    ipcMain.handle('library:forget', (_e, target: string) => wrap(() => forgetLibrary(target)))
    ipcMain.handle('library:open', (_e, target) =>
      wrap(() => {
        const info = librarySvc.openLibrary(target)
        watchLibrary(info.path, librarySvc.getDatabase())
        return info
      })
    )
    ipcMain.handle('library:list', () => wrap(() => librarySvc.listLibraries()))
    // 库占用空间（素材 + 缩略图缓存）：侧栏「占用空间」那一行
    ipcMain.handle('library:usage', () => wrap(() => healthSvc.libraryUsage()))
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
    // 移动整个文件夹（含子树）：物理目录与索引一起搬，`targetParentId === null` = 库根
    ipcMain.handle('folder:move', (_e, { id, targetParentId }) =>
      wrap(() => librarySvc.moveFolder(id, targetParentId)))
    ipcMain.handle('folder:delete', (_e, id) => wrap(() => librarySvc.deleteFolder(id)))
    ipcMain.handle('folder:list', () => wrap(() => librarySvc.listFolders()))

    // 导入
    ipcMain.handle('import:files', (_e, args) => wrap(() => importerSvc.importFiles(args)))
    // 导入整个文件夹：按磁盘目录层级在库里建对应子文件夹
    ipcMain.handle('import:folder', (_e, args) => wrap(() => importerSvc.importFolder(args)))

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
        // 存量尺寸重测（幂等、一次性）：老库里写的是「EXIF 旋转前 / 忽略旋转」的尺寸，
        // 先清空让它们落回欠账条件，下面的 ensureBatch 才会把它们重新纳入并补写成**显示尺寸**。
        // 放这里而不是缩略图队列内部：所有「开库」路径都会调本 handler，挂这里最省事。
        retestLegacyDims()
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
    /**
     * 移动素材前**先停一下后台泵**。
     *
     * 起因（2026-11-07 用户反馈，现象很具体）：几十 MB 的视频拖动移动没事，**几百 MB 的**
     * 就会出现「文件被复制过去 + 报 EBUSY ... unlink」。
     *
     * 大小分界来自 `thumbs.openSource` 的 `READ_INTO_MEMORY_MAX_BYTES = 64MB`：
     * 不超过阈值的会 `readFileSync` 读进内存、源文件句柄立刻释放；超过的只能 `sharp(abs)`
     * 按路径打开，**整个解码过程一直握着源文件**。此刻 `rename` 被系统拒绝 →
     * `moveFileSync` 退化成「拷贝 + 删源」→ 删源也被那个句柄挡住 → 半截状态。
     *
     * 这个坑在「重命名文件夹」上早就踩过，`library.renameFolder` 甚至有一套分级隔离 + trail；
     * 但**移动文件这条路一直没接**。这里补上最小够用的一档：只停泵，不停 watcher
     * （移动单个文件不影响索引一致性，watcher 自己会跟着更新）。
     *
     * 预算 2.5s：`pausePumpAsync` 到点就返回 `timedOut`，绝不把移动卡死 ——
     * 用户主动操作优先于后台缩略图。没任务在跑时它立即返回，等于零开销。
     * `resumePumps` 必须在 finally：否则一次失败会把队列永久停掉（卡片一直灰）。
     */
    const withPumpsPaused = async <T>(fn: () => T): Promise<T> => {
      try {
        await Promise.all([pausePumpAsync(2500), pauseMetaPumpAsync(2500)])
        return fn()
      } finally {
        // 两个泵互不依赖、各自幂等；任一抛错不能挡住另一个
        try {
          resumePump()
        } finally {
          resumeMetaPump()
        }
      }
    }

    ipcMain.handle('asset:move', (_e, { ids, folderId }) =>
      wrap(() => withPumpsPaused(() => assetsSvc.moveAssets(ids, folderId))))
    ipcMain.handle('asset:delete', (_e, { ids }) => wrap(() => assetsSvc.deleteAssets(ids)))
    ipcMain.handle('asset:rename', (_e, { id, name }) => wrap(() => assetsSvc.renameAsset(id, name)))
    /** 库内复制：在目标文件夹生成一份保留评分/喜欢/备注/标签的副本 */
    ipcMain.handle('asset:copy', (_e, { ids, folderId }) => wrap(() => assetsSvc.copyAssets(ids ?? [], folderId ?? null)))
    /** 粘贴剪贴板里的文件：库内的生成副本，库外的走导入管线（分流在服务层） */
    ipcMain.handle('asset:paste', (_e, { paths, folderId }) => wrap(() => assetsSvc.pastePaths(paths ?? [], folderId ?? null)))
    ipcMain.handle('asset:setTags', (_e, { id, tagIds }) => wrap(() => assetsSvc.setTags(id, tagIds)))
    // 批量打标浮层的三态分布：一条 GROUP BY 算完，别让渲染层对每个选中项各发一次 asset:get
    ipcMain.handle('asset:tag-counts', (_e, ids) =>
      wrap(() => assetsSvc.tagCountsFor((ids ?? []) as number[]))
    )
    // 批量打标：**增量**语义（attach = 追加，绝不覆盖素材已有的其他标签），
    // 与上面 setTags 的「单素材整体替换」刻意分开 —— 复用 setTags 会把每张素材原有的标签抹掉
    ipcMain.handle('asset:bulk-tags', (_e, { ids, tagIds, mode }) =>
      wrap(() => assetsSvc.bulkUpdateTags((ids ?? []) as number[], (tagIds ?? []) as number[], mode))
    )

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

    // 用**系统默认浏览器**打开外部链接（关于页的 GitHub 图标 / 「去下载」）。
    // ⚠️ `openExternal` 是危险能力：白名单必须判在**主进程**（`isAllowedExternalUrl`），
    // 渲染层的任何 URL 都不许直接透传 —— 渲染层被 XSS 时，透传等于任意协议拉起。
    ipcMain.handle('shell:open-external', (_e, url) =>
      wrap(async () => {
        const target = String(url ?? '')
        if (!updateSvc.isAllowedExternalUrl(target)) throw new Error('ERR_URL_NOT_ALLOWED')
        await shell.openExternal(target)
        return { opened: true }
      })
    )

    // 检查更新：只查询最新 tag，**不下载、不安装、不自动更新**（纯提示）。
    // 当前版本号在 handler 层取 —— `update.ts` 是纯函数模块，冒烟要能直接 import（不许依赖 app 单例）。
    ipcMain.handle('update:check', () =>
      wrap(async () => {
        const current = app.getVersion()
        const r = await updateSvc.checkLatest()
        if ('error' in r) throw new Error(r.error || 'ERR_UPDATE_CHECK')
        // `hasUpdate` 由主进程算：逐段数字比较的唯一一份实现在 `update.ts`，
        // 渲染层拿不到它（跨进程），让 UI 自己再比一遍迟早跟这里分叉
        return {
          latest: r.latest,
          url: r.url,
          current,
          hasUpdate: updateSvc.compareVersion(r.latest, current) > 0
        }
      })
    )

    ipcMain.handle('tag:list', () => wrap(() => assetsSvc.listTags()))
    ipcMain.handle('tag:create', (_e, args) => wrap(() => assetsSvc.createTag(args)))
    ipcMain.handle('tag:rename', (_e, { id, name }) => wrap(() => assetsSvc.renameTag(id, name)))
    // 改标签颜色：只动配色（名字与素材关联都不动），换色后侧栏/详情页的色点一起跟着变
    ipcMain.handle('tag:set-color', (_e, { id, color }) => wrap(() => assetsSvc.setTagColor(id, color)))
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
      wrap(() => {
        const k = kind === 'derived' || kind === 'thumbs' || kind === 'all' ? kind : 'thumbs'
        const r = cacheSvc.clearCache(k)
        /*
         * 清掉缩略图后必须让「目录集合」失效：
         * `thumbs.ensureBatch` 判断「已有 grid 缩略图」靠的是**一次 readdir 拿到的 hash 目录集合**
         * （比逐条 stat 快一个数量级，见 thumbs.ts 的 thumbHashDirs）。而清理只 unlink 文件、
         * hash 目录会留下来，目录集合会撒谎 —— 紧接着的 `thumb:backfill` 就会把整库当成
         * 「已有缩略图」，一张都不重建（用户看到：清了缓存，网格从此全 404）。
         * 标记之后，下一次全量 grid 批次退回逐条 existsSync，把该补的重新捞出来。
         */
        if (k === 'thumbs' || k === 'all') invalidateGridPresence()
        return r
      })
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
    // 重扫：清「已扫过」位后全库重来。状态位一旦置位 backfill 就不会再碰这张图，
    // 所以解析器升级后**必须**有这么一个显式入口，否则存量素材永远拿不到新解析结果
    ipcMain.handle('meta:rescan', () => wrap(() => genmetaSvc.rescanAllMeta()))
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
        userData: app.getPath('userData'),
        /** 是否运行在便携模式（数据在程序目录旁的 data\ 里） */
        portable: portableDir !== null
      }))
    )
    ipcMain.handle('app:open-user-data', () =>
      wrap(async () => {
        const err = await shell.openPath(app.getPath('userData'))
        return { opened: !err, error: err || null }
      })
    )

    // 系统对话框
    //
    // 「记住上次导入目录」：不传 `defaultPath` 时 Windows 每次都会把对话框开在「下载」，
    // 用户每导一次就要重新翻一遍目录 —— 这是导入体验里最常被抱怨的一点。
    /**
     * 上次导入目录，用作 `defaultPath`。
     * 没有记录、或该目录已经不在了（U 盘拔掉 / 被改名）→ 返回 undefined，交给系统默认位置。
     */
    function importStartDir(): string | undefined {
      try {
        const d = configSvc.getSettings().lastImportDir
        return d && existsSync(d) ? d : undefined
      } catch {
        return undefined
      }
    }
    /**
     * 记住本次选择的位置。
     *
     * ⚠️ 存的是**父目录**（`dirname`）而不是选中的那一项：导入文件时拿到的本来就是文件全路径，
     * 导入文件夹时拿到的是文件夹本身 —— 统一取父目录，下次打开就能看见刚选的那个以及它的同级，
     * 而不是一进去就已经站在上一次选中的文件夹**内部**。
     */
    function rememberImportDir(picked: string): void {
      try {
        configSvc.patchSettings({ lastImportDir: dirname(picked) })
      } catch {
        /* 记不住不影响这次导入本身 */
      }
    }

    /**
     * 选目录。`purpose` 区分调用来源：
     *  - `'import'`：导入文件夹 → 从上次导入位置开始，选完记住它
     *  - 其余（新建库 / 打开库）：**不**带默认路径 —— 选库和选导入目录是两件事，
     *    让「新建库」也从上次导入的地方开始会很怪。
     */
    ipcMain.handle('dialog:pick-folder', async (_e, purpose?: 'import' | 'library') => {
      const start = purpose === 'import' ? importStartDir() : undefined
      const r = await dialog.showOpenDialog(win, {
        properties: ['openDirectory', 'createDirectory'],
        ...(start ? { defaultPath: start } : {})
      })
      const picked = r.canceled ? null : r.filePaths[0]
      if (picked && purpose === 'import') rememberImportDir(picked)
      return picked
    })
    ipcMain.handle('dialog:pick-files', async () => {
      const start = importStartDir()
      const r = await dialog.showOpenDialog(win, {
        properties: ['openFile', 'multiSelections'],
        ...(start ? { defaultPath: start } : {})
      })
      if (r.canceled || !r.filePaths.length) return []
      rememberImportDir(r.filePaths[0])
      return r.filePaths
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
        // hash 只做小写归一，**不再「剔掉非 hex 字符」再校验**：那一步等于放宽了校验
        // （`abc-xdef…` 剔完还能凑够 20 位 hex 就算合法）。这里直接用全仓唯一的那份
        // `isThumbHash`（paths.ts）—— 它同时是「hash 能安全拼进 .thumbs 路径」的唯一闸门。
        const hash = (segs[0] ?? '').toLowerCase()
        const size = (segs[1] ?? '').replace(/\.webp$/i, '')
        if (!isThumbHash(hash) || !['grid', 'detail'].includes(size)) {
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

    // ==================== 托盘 + 关闭拦截 ====================
    let forceQuit = false
    app.on('before-quit', () => {
      forceQuit = true
    })

    const showMain = (): void => {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }

    // 托盘图标：优先 .ico（多尺寸），退回 .png；两者都没有就不建托盘，
    // 并让「关闭 = 隐藏」自动失效 —— 没有托盘图标的隐藏等于把应用藏丢，找不回来。
    let tray: Tray | null = null
    const trayIco = join(__dirname, '../../build/icon.ico')
    const trayPng = join(__dirname, '../../build/icon.png')
    const trayIconPath = existsSync(trayIco) ? trayIco : existsSync(trayPng) ? trayPng : null
    if (trayIconPath) {
      try {
        tray = new Tray(nativeImage.createFromPath(trayIconPath))
        tray.setToolTip('Stash · 素材库')
        tray.setContextMenu(
          Menu.buildFromTemplate([
            { label: '打开 Stash', click: showMain },
            { type: 'separator' },
            {
              label: '退出',
              click: () => {
                forceQuit = true
                app.quit()
              }
            }
          ])
        )
        tray.on('double-click', showMain)
      } catch (e) {
        console.log('[tray ERR]', String(e))
        tray = null
      }
    }

    // 关闭拦截：偏好「最小化到托盘」开着 → 点 × 只是隐藏；托盘菜单「退出」或偏好关掉 → 真退。
    // forceQuit 由 before-quit 置位 —— app.quit() 自己也会触发窗口 close 事件，不置位会被拦住。
    // 托盘没建成（找不到图标）时也放行，绝不允许「应用在跑却无处可寻」。
    win.on('close', (e) => {
      if (!forceQuit && configSvc.getSettings().closeToTray && tray) {
        e.preventDefault()
        win.hide()
      }
    })

    // 第二实例：唤起已有窗口
    app.on('second-instance', showMain)

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

    // 欢迎页冒烟：未开库视图（无 TitleBar）也必须能最小化/最大化/关闭 —— 无边框窗口的唯一出口
    if (process.argv.includes('--smoke-welcome')) {
      win.webContents.once('did-finish-load', () => {
        void runSmokeWelcome(win)
      })
    }

    // 外部变更同步冒烟：把文件从「资源管理器」直接拷进库目录 → watcher 增量同步索引（I1 修复）
    if (process.argv.includes('--smoke-watch')) {
      win.webContents.once('did-finish-load', () => {
        void runSmokeWatch(win)
      })
    }

    // 虚拟滚动冒烟：直插 1 万行 → M1–M8（渲染节点数 / 帧率 / 首屏 / 分页 / 内存 / 视图切换 / 高度单调 / 布局不变量）
    if (process.argv.includes('--smoke-vscroll')) {
      win.webContents.once('did-finish-load', () => {
        void runSmokeVScroll(win)
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
