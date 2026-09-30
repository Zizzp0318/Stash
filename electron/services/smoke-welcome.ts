// 欢迎页冒烟：electron . --smoke-welcome
//
// 为什么单开一套：欢迎页是**独立视图**（App.vue 里 `v-if="!lib.info"` 与库视图互斥），
// 它不渲染 TitleBar；而窗口是 `frame:false` 的无边框窗口，**没有系统标题栏** ——
// 于是「欢迎页右上角没有按钮」= 窗口既不能最小化也不能关闭，只能 Alt+F4 强杀。
//
// 所以断言不看「DOM 里有没有这个节点」，而是真的用鼠标去点：
// 点最小化后 `win.isMinimized()` 必须为 true，点关闭必须真的把窗口关掉。
// 只查 DOM 会漏掉「按钮被整页的拖拽区吃掉点击」这种假绿 —— 那正是这类 bug 的形态。
//
// 两个坑记在这里：
// ① 欢迎页只在「从未开过库」时出现（渲染层启动会自动恢复最近打开的库），
//    所以 main.ts 里对 `--smoke-welcome` 先把 userData 换成一次性目录，否则永远进不了这个视图；
// ② 最小化 / 最大化都会改变窗口尺寸与布局，**每次点击前都要重新量坐标**，
//    缓存第一次的坐标会点到空处（表现成「按钮点了没反应」，跟真 bug 分不清）。
import { app, BrowserWindow } from 'electron'
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeCurrent, createLibrary, getLibrary, openLibrary } from './library'
import { isWatching, unwatchLibrary } from './watcher'
import { addRecentLibrary } from './config'
import { SCHEMA_VERSION } from './db'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

interface Btn {
  key: string | null
  w: number
  h: number
  cx: number
  cy: number
  icon: number
  text: string
  inViewport: boolean
  hitSelf: boolean
  region: string
  welcomeRegion: string
}

export async function runSmokeWelcome(win: BrowserWindow): Promise<void> {
  const R: Record<string, unknown> = {}
  const jsErrors: Array<{ code: string; error: string }> = []
  // I5 段用的临时库目录（在 finally 里清理）与「启动路径」控制台未捕获异常采集器
  let dirVer: string | null = null
  const bootConsoleErr: string[] = []
  const js = async (code: string): Promise<unknown> => {
    try {
      return await win.webContents.executeJavaScript(code)
    } catch (e) {
      jsErrors.push({ code: code.replace(/\s+/g, ' ').slice(0, 160), error: String(e).slice(0, 160) })
      return null
    }
  }

  /** 不做错误包装的 rawJs：`location.reload()` 会中断页面 → executeJavaScript 必然 reject，
   *  那是导航的正常表现，不能算 jsError（与 --smoke-watch 同款约定）。 */
  const rawJs = (code: string): Promise<unknown> => win.webContents.executeJavaScript(code)

  const click = (x: number, y: number): void => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) })
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
  }
  const elPoint = async (selector: string): Promise<{ x: number; y: number } | null> => {
    const s = (await js(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)})
      if (!e) return 'null'
      const r = e.getBoundingClientRect()
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
    })()`)) as string | null
    return s && s !== 'null' ? (JSON.parse(s) as { x: number; y: number }) : null
  }

  /** 轮询等待（DOM 侧）：把「是否等到」交给调用方放进断言（G4：不用固定 sleep 判成败） */
  const waitUntil = async (expr: string, timeout = 20000): Promise<boolean> => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      if ((await js(`!!(${expr})`)) === true) return true
      await sleep(200)
    }
    return false
  }

  /**
   * 重启渲染层，并**强制 bootstrap 走「自动恢复最近库」分支**。
   * `location.reload()` 只重启渲染层、不重启主进程 —— 若主进程里还开着 current，
   * 渲染层 `library.getInfo()` 会直接返回它、bootstrap 根本不碰最近库列表。
   * 所以先把主进程侧的库关掉（unwatch + closeCurrent），让 getInfo() 返回 null。
   */
  const reloadWait = async (): Promise<void> => {
    unwatchLibrary()
    closeCurrent()
    const loaded = new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()))
    try {
      await rawJs('location.reload()')
    } catch {
      /* reload 中断页面，属正常导航 */
    }
    await loaded
  }

  /**
   * 关闭按钮会让窗口销毁 → `window-all-closed` → `app.quit()`。
   * 不拦住 quit 的话，「关闭真的生效」这条断言的输出会赶不上进程退出（看到的是空输出），
   * 所以先把 quit 挂起，等 finally 里主动 exit。
   */
  let finished = false
  app.on('before-quit', (e) => {
    if (!finished) e.preventDefault()
  })

  /** 读欢迎页右上角控制条：几何 + 命中测试 + 拖拽区归属（一次性取回，避免多次往返） */
  const readButtons = async (): Promise<{ view: Record<string, unknown>; btns: Btn[] }> => {
    const raw = (await js(`(() => {
      const v = document.querySelector('.welcome')
      const region = (el) => {
        try { return getComputedStyle(el).getPropertyValue('-webkit-app-region').trim() } catch (_) { return '' }
      }
      const view = {
        welcome: !!v,
        card: !!document.querySelector('.w-card'),
        titlebar: !!document.querySelector('.titlebar'),
        detailBtn: !!document.querySelector('[data-wc="detail"]'),
        welcomeRegion: v ? region(v) : ''
      }
      const btns = v ? [...v.querySelectorAll('.win-controls .wc-btn')] : []
      return JSON.stringify({
        view,
        btns: btns.map((b) => {
          const r = b.getBoundingClientRect()
          const svg = b.querySelector('svg')
          const sr = svg ? svg.getBoundingClientRect() : null
          const cx = Math.round(r.left + r.width / 2)
          const cy = Math.round(r.top + r.height / 2)
          const hit = document.elementFromPoint(cx, cy)
          return {
            key: b.dataset.wc ?? null,
            w: Math.round(r.width),
            h: Math.round(r.height),
            cx: Math.round((r.left + r.width / 2) * 10) / 10,
            cy: Math.round((r.top + r.height / 2) * 10) / 10,
            icon: sr ? Math.round(sr.width) : 0,
            text: b.textContent.trim(),
            inViewport: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
            hitSelf: !!hit && (hit === b || b.contains(hit)),
            region: region(b),
            welcomeRegion: view.welcomeRegion
          }
        })
      })
    })()`)) as string | null
    if (!raw) return { view: {}, btns: [] }
    const parsed = JSON.parse(raw) as { view: Record<string, unknown>; btns: Btn[] }
    return { view: parsed.view, btns: parsed.btns }
  }

  try {
    // 等渲染层 bootstrap 落定（settings.init → loadRecent → 自动开库尝试）
    await sleep(1500)

    const first = await readButtons()
    R.view = first.view
    R.buttons = first.btns

    try {
      const img = await win.webContents.capturePage()
      writeFileSync(join(process.cwd(), 'shot-welcome-controls.png'), img.toPNG())
    } catch (e) {
      R.shotError = String((e as Error).message ?? e)
    }

    // —— 「新建库」面板展开后控件仍然可点（面板会撑高卡片，顺带验证不遮右上角）——
    const newBtn = await elPoint('.w-card .w-btn.primary')
    if (newBtn) click(newBtn.x, newBtn.y)
    await sleep(350)
    R.newPanel = (await js(`(() => {
      const box = document.querySelector('.w-new')
      if (!box) return JSON.stringify({ open: false })
      const inp = box.querySelector('input')
      const go = box.querySelector('.w-btn')
      const r = go ? go.getBoundingClientRect() : null
      const hit = r ? document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)) : null
      return JSON.stringify({
        open: true,
        input: !!inp,
        btn: !!go,
        btnHitSelf: !!hit && !!go && (hit === go || go.contains(hit))
      })
    })()`)) as string | null

    // —— 真实点击：最小化 ——
    const pMin = await elPoint('.welcome .win-controls .wc-btn[data-wc="min"]')
    if (pMin) click(pMin.x, pMin.y)
    await sleep(700)
    R.minimize = { minimized: win.isMinimized(), destroyed: win.isDestroyed() }

    win.restore()
    await sleep(700)
    R.afterRestore = {
      minimized: win.isMinimized(),
      destroyed: win.isDestroyed(),
      stillWelcome: (await js(`!!document.querySelector('.welcome')`)) === true
    }

    // —— 真实点击：最大化 / 还原 ——
    const pMax = await elPoint('.welcome .win-controls .wc-btn[data-wc="max"]')
    if (pMax) click(pMax.x, pMax.y)
    await sleep(700)
    R.maximize = { maximized: win.isMaximized(), destroyed: win.isDestroyed() }

    // 最大化后布局与坐标都变了 —— 重新量（缓存旧坐标就是「点了没反应」的典型写法）
    const pMax2 = await elPoint('.welcome .win-controls .wc-btn[data-wc="max"]')
    if (pMax2) click(pMax2.x, pMax2.y)
    await sleep(700)
    R.unmaximize = { maximized: win.isMaximized() }

    // —— 窗口变窄后按钮仍贴右上角 ——
    // 这步不打「最大化」当驱动：最大化后的尺寸取决于当前屏幕分辨率，断言会随环境漂移；
    // 直接改窗口尺寸，cx 必须随之变小、cy 不变（top:8 定位）。
    win.setSize(1000, 820)
    await sleep(600)
    R.buttonsAfterResize = (await readButtons()).btns

    // ==================== 库 schema 版本门控（I5，审计 §1.4）====================
    //
    // 覆盖：
    //   A 正常库：新建 meta.schema_version == String(SCHEMA_VERSION)；重开不报错、版本不变
    //   B 老库兼容：version='0' 或**整行删掉** → 必须能打开，且打开后回写成当前版本
    //               （关键反面：绝不能被误判成「太新」——那会让用户彻底打不开自己的库）
    //   C 太新的库被拒：version='999' → 服务层抛 ERR_LIBRARY_TOO_NEW、IPC 回执形状不变、
    //               且拒绝后不留损坏状态（文件仍在、版本改回后仍能打开）
    //   D 渲染层人话：Welcome（欢迎页最近库）与 TitleBar（标题栏菜单）两个入口，
    //               打开太新的库都要显示中文提示而不是裸错误码
    //   E 启动路径：最近库是「太新」的库 → 优雅退回欢迎页、给出人话、不抛未捕获异常
    dirVer = mkdtempSync(join(tmpdir(), 'stash-smoke-welcome-'))
    const pGood = join(dirVer, 'good')
    const pTooA = join(dirVer, 'tooA')
    const pTooB = join(dirVer, 'tooB')

    // 独立连接读写版本号（**不复用生产的 openDatabase 判据**，避免 G11「断言复用被测代码」）
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const DatabaseSync = require('node:sqlite').DatabaseSync
    const withDb = <T>(
      lib: string,
      fn: (db: { prepare: (s: string) => { get: () => unknown; run: (...a: string[]) => unknown }; close: () => void }) => T
    ): T => {
      const db = new DatabaseSync(join(lib, '.stash'))
      try {
        return fn(db)
      } finally {
        db.close()
      }
    }
    const readVer = (lib: string): string | null =>
      withDb(lib, (db) => {
        const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value?: string } | undefined
        return row?.value ?? null
      })
    const writeVer = (lib: string, v: string): void =>
      void withDb(lib, (db) => db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)").run(v))
    const dropVer = (lib: string): void =>
      void withDb(lib, (db) => db.prepare("DELETE FROM meta WHERE key='schema_version'").run())

    /** 打开库，返回 '' 表示成功、否则返回错误码（服务层直接调用，最严格） */
    const tryOpen = (lib: string): string => {
      try {
        openLibrary(lib)
        return ''
      } catch (e) {
        return String((e as Error).message ?? e)
      }
    }

    // —— A 正常库 ——
    createLibrary({ name: 'good', parentDir: dirVer })
    const aVer = readVer(pGood)
    const aOpenErr = tryOpen(pGood)
    const aVer2 = readVer(pGood)
    R.lib_A = { aVer, aVer2, aOpenErr, expect: String(SCHEMA_VERSION) }

    // —— B 老库兼容（两种形态：version='0'、整行删掉）——
    writeVer(pGood, '0')
    const bOpen0 = tryOpen(pGood)
    const bVer0 = readVer(pGood)
    dropVer(pGood)
    const bOpenNone = tryOpen(pGood)
    const bVerNone = readVer(pGood)
    R.lib_B = { bOpen0, bVer0, bOpenNone, bVerNone }

    // —— C 太新的库被拒 ——
    writeVer(pGood, '999')
    const cThrow = tryOpen(pGood)
    const cFileAlive = existsSync(join(pGood, '.stash'))
    const cIpc = (await rawJs(`window.stash.library.open(${JSON.stringify(pGood)})`)) as { ok: boolean; error?: string }
    writeVer(pGood, String(SCHEMA_VERSION))
    const cReopen = tryOpen(pGood)
    R.lib_C = { cThrow, cFileAlive, cIpc, cReopen }

    // ==================== I5-QA 独立探针（QA 自写，不复用工程师 A~E 的判据）====================
    //
    // 期望版本号**写死**为 '1'：由「读 db.ts 的 SCHEMA_VERSION 常量 + 新建库后用独立只读连接
    // 读到的 meta.schema_version」双向确认 —— 断言里**不引用** SCHEMA_VERSION，避免
    // 「拿被测代码的判据给自己打分」（铁律 G11）。
    const EXPECT_VER = '1'
    const qaFreshVer = readVer(pGood)

    // —— 边界值对撞：逐个写版本 → 打开 → 记录（拒绝 / 当 0 / 其它）——
    // readSchemaVersion 只认纯十进制整数（/^\d+$/），其余一律当 0（最老的库）—— 设计意图是
    // fail-safe：**绝不把老库误判成「太新」**。期望：
    //   '999999' / '2' → 拒绝(ERR_LIBRARY_TOO_NEW)，且版本不被改写；
    //   'abc' / '' / '1.5' / '-1' / ' 2 ' → 当 0 → 能打开且回写成 '1'。
    const qaEdge: Record<string, { err: string; ver: string | null }> = {}
    for (const ev of ['999999', 'abc', '', '1.5', '-1', ' 2 ', '2']) {
      writeVer(pGood, ev)
      qaEdge[ev] = { err: tryOpen(pGood), ver: readVer(pGood) }
    }
    // ⚠️ 边界循环最后停在 '2'（太新）→ 必须把 pGood 复原为当前版本，否则后面 D/E 段
    // 依赖的 pGood 会变成「打不开的库」。
    writeVer(pGood, EXPECT_VER)
    R.lib_QEdge = qaEdge

    // —— 拒绝后的状态洁净度（独立于 C 段）——
    // 用全新临时库，并**先释放 createLibrary 自己留下的连接**（否则锁住 .stash 的是「它」，
    // 不是被拒的那个新连接，会得出假阳性）。
    const pRej = join(dirVer, 'rej')
    createLibrary({ name: 'rej', parentDir: dirVer })
    closeCurrent()
    writeVer(pRej, '999')
    const qaRejErr = tryOpen(pRej) // 服务层拒绝
    const qaRejFileAlive = existsSync(join(pRej, '.stash'))
    // 句柄/锁：被拒连接已 close、且此刻无其它连接 → Windows 上应能原子改名（被锁会 EBUSY/EPERM）
    let qaRenameOk = true
    let qaRenameErr = ''
    try {
      renameSync(join(pRej, '.stash'), join(pRej, '.stash.qa'))
      renameSync(join(pRej, '.stash.qa'), join(pRej, '.stash'))
    } catch (e) {
      qaRenameOk = false
      qaRenameErr = String((e as Error).message ?? e)
    }
    const qaWatchedAfterRej = isWatching()
    // 另起一个正常库并**经 IPC** 打开（装 watcher）；再试图打开被拒的库 → 监听必须仍在
    // 那个正常库上、current 也不能被改。
    const pGood2 = join(dirVer, 'good2')
    createLibrary({ name: 'good2', parentDir: dirVer })
    const qaIpcOpenGood = (await rawJs(`window.stash.library.open(${JSON.stringify(pGood2)})`)) as {
      ok?: boolean
    }
    const qaWatchOnGood = isWatching()
    const qaRejIpc = (await rawJs(`window.stash.library.open(${JSON.stringify(pRej)})`)) as {
      ok?: boolean
      error?: string
    }
    const qaWatchStillGood = isWatching()
    const qaCurStillGood = getLibrary()?.path === pGood2
    R.qaFreshVer = qaFreshVer
    R.lib_QClean = {
      qaRejErr,
      qaRejFileAlive,
      qaRenameOk,
      qaRenameErr,
      qaWatchedAfterRej,
      qaIpcOpenGoodOk: qaIpcOpenGood?.ok === true,
      qaWatchOnGood,
      qaRejIpc,
      qaWatchStillGood,
      qaCurStillGood
    }

    // —— 备好两个「太新」的库（D/E 用）——
    createLibrary({ name: 'tooA', parentDir: dirVer })
    createLibrary({ name: 'tooB', parentDir: dirVer })
    writeVer(pTooA, '999')
    writeVer(pTooB, '999')

    // —— D-TitleBar：把 good 顶到最近列表首位 → bootstrap 进库视图 → 从菜单切到「太新的库」——
    addRecentLibrary(pGood)
    await reloadWait()
    const inLibView = await waitUntil(`document.querySelector('.tab-select')`)
    await rawJs(`document.querySelector('.tab-select')?.click()`)
    const menuOpen = await waitUntil(`document.querySelector('.lib-menu .lib-menu-item .lm-path')`)
    const clickedTooInMenu =
      (await rawJs(`(() => {
        const items = [...document.querySelectorAll('.lib-menu .lib-menu-item')]
        const el = items.find((b) => (b.querySelector('.lm-name')?.textContent || '').includes('tooB'))
        if (!el) return false
        el.click(); return true
      })()`)) === true
    const tbErrShown = await waitUntil(`(document.querySelector('.lib-menu-err')?.textContent || '').trim().length > 0`)
    const tbErr = (await js(`document.querySelector('.lib-menu-err')?.textContent?.trim() ?? ''`)) as string
    R.lib_titlebar = { inLibView, menuOpen, clickedTooInMenu, tbErrShown, tbErr }

    // —— D-Welcome + E：最近库首位是「太新的库」→ 启动自动恢复必然失败 ——
    // 采集「启动期间」渲染层的未捕获异常（Chromium 会把 uncaught 记成含 Uncaught 的控制台消息）。
    // 只看 Uncaught/Unhandled，避免把代码里有意打的 console.warn 误算成错误。
    win.webContents.on('console-message', (_e, _lvl, message) => {
      if (/Uncaught|Unhandled rejection/i.test(String(message))) bootConsoleErr.push(String(message).slice(0, 200))
    })
    bootConsoleErr.length = 0
    addRecentLibrary(pTooA) // recent = [tooA, good, tooB]
    await reloadWait()
    const eWelcome = await waitUntil(`document.querySelector('.welcome')`)
    // bootstrap 是异步的（loadRecent → openLibrary 一个 IPC 往返）→ 落在欢迎页后还要等报错渲染出来，
    // 否则会在「视图已在、但 bootError 尚未写」的窗口里读到空串（第一版就这么假绿过一次）。
    const eErrShown = await waitUntil(`(document.querySelector('.w-err')?.textContent || '').trim().length > 0`)
    const eBootErr = (await js(`document.querySelector('.w-err')?.textContent?.trim() ?? ''`)) as string
    const eInfoNull = (await rawJs('window.stash.library.getInfo().then((r) => r.data === null)')) === true
    // 正对照：装一个捕获阶段的「最近库点击」采集探针，证明下面那次点击真的打到了 .w-recent-item
    await rawJs(`(() => {
      window.__wClick = 0
      const card = document.querySelector('.w-card')
      if (card) card.addEventListener('click', (e) => {
        const b = e.target && e.target.closest && e.target.closest('.w-recent-item')
        if (b) window.__wClick++
      }, true)
    })()`)
    const clickedTooRecent =
      (await rawJs(`(() => {
        const items = [...document.querySelectorAll('.w-recent .w-recent-item')]
        const el = items.find((b) => (b.querySelector('.w-recent-name')?.textContent || '').trim() === 'tooB')
        if (!el) return false
        el.click(); return true
      })()`)) === true
    const wErrShown = await waitUntil(`(document.querySelector('.w-err')?.textContent || '').trim().length > 0`)
    const wErr = (await js(`document.querySelector('.w-err')?.textContent?.trim() ?? ''`)) as string
    const wClick = (await rawJs('window.__wClick || 0')) as number
    R.lib_welcome = { eWelcome, eErrShown, eBootErr, eInfoNull, clickedTooRecent, wErrShown, wErr, wClick, bootConsoleErr: [...bootConsoleErr] }

    // —— I5-QA-D bootError 生命周期（验证「清理」这一环）——
    // 「声明/写入/清理/展示」四环里查「清理」：store 的 bootError 除了 bootstrap 开头置空，
    // 还会不会在「成功打开另一个库 / 关闭库」时被清掉？直接读 Pinia store 取真值（不复用 DOM）。
    const pinia = "document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('library')"
    const qaBootBefore = (await rawJs(`${pinia}.bootError`)) as string
    const qaOpenGood = (await rawJs(
      `${pinia}.openLibrary(${JSON.stringify(pGood)}).then(() => null).catch((e) => String(e))`
    )) as string | null
    const qaBootAfterOpen = (await rawJs(`${pinia}.bootError`)) as string
    const qaInfoAfterOpen = (await rawJs(`${pinia}.info ? ${pinia}.info.path : null`)) as string | null
    await rawJs(`${pinia}.closeLibrary()`)
    const qaWelcomeAgain = await waitUntil(`document.querySelector('.welcome')`)
    const qaErrTextAfterClose = (await js(
      `(document.querySelector('.w-err')?.textContent ?? '').trim()`
    )) as string
    R.lib_QBoot = { qaBootBefore, qaOpenGood, qaBootAfterOpen, qaInfoAfterOpen, qaWelcomeAgain, qaErrTextAfterClose }

    // —— F2 **反向检查**：打开**失败**的库**绝不能**清空 bootError ——
    // （否则「启动失败」那条提示会被随后一次失败的开库顺手清掉，用户什么也看不到。）
    // 构造：先把 store.bootError 人为置成一条「启动失败残留」，再打开一个**不存在**的库（必然失败），
    // 断言 bootError **原样保留**。openLibrary 的失败分支在 `if (!r.ok) return ...` 处提前返回、不碰 bootError。
    const qaBootRevSet = 'ERR_LIBRARY_TOO_NEW'
    await rawJs(`${pinia}.bootError = ${JSON.stringify(qaBootRevSet)}`)
    const qaFailOpen = (await rawJs(
      `${pinia}.openLibrary(${JSON.stringify(join(dirVer, 'no-such-lib-dir'))}).then((v) => String(v)).catch((e) => 'THROW:' + String(e))`
    )) as string | null
    const qaBootAfterFail = (await rawJs(`${pinia}.bootError`)) as string
    R.lib_QBootRev = { qaBootRevSet, qaFailOpen, qaBootAfterFail }

    // —— 真实点击：关闭（必须是最后一步，窗口会销毁）——
    const pClose = await elPoint('.welcome .win-controls .wc-btn[data-wc="close"]')
    const closed = new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 5000)
      win.once('closed', () => {
        clearTimeout(t)
        resolve(true)
      })
    })
    if (pClose) click(pClose.x, pClose.y)
    R.close = { clicked: !!pClose, closed: await closed, destroyed: win.isDestroyed() }

    // ==================== 断言 ====================
    const v = R.view as Record<string, unknown>
    const btns = (R.buttons as Btn[]) ?? []
    const btns2 = (R.buttonsAfterResize as Btn[]) ?? []
    const keys = btns.map((b) => b.key)
    const sameRow = (list: Btn[]): boolean =>
      list.length > 0 && Math.max(...list.map((b) => b.cy)) - Math.min(...list.map((b) => b.cy)) < 0.6
    const geo = (list: Btn[]): boolean =>
      list.length > 0 && list.every((b) => b.w === 28 && b.h === 28 && b.icon === 16 && b.text === '')
    const nMin = R.minimize as { minimized: boolean; destroyed: boolean }
    const nBack = R.afterRestore as { minimized: boolean; destroyed: boolean; stillWelcome: boolean }
    const nMax = R.maximize as { maximized: boolean; destroyed: boolean }
    const nMax2 = R.unmaximize as { maximized: boolean }
    const nClose = R.close as { clicked: boolean; closed: boolean; destroyed: boolean }
    const nNew = JSON.parse((R.newPanel as string) ?? '{"open":false}') as Record<string, boolean>

    // —— I5 schema 版本门控的断言输入 ——
    const A = (R.lib_A ?? {}) as { aVer?: string; aVer2?: string; aOpenErr?: string; expect?: string }
    const B = (R.lib_B ?? {}) as { bOpen0?: string; bVer0?: string; bOpenNone?: string; bVerNone?: string }
    const C = (R.lib_C ?? {}) as { cThrow?: string; cFileAlive?: boolean; cIpc?: { ok?: boolean; error?: string }; cReopen?: string }
    const TB = (R.lib_titlebar ?? {}) as { inLibView?: boolean; menuOpen?: boolean; clickedTooInMenu?: boolean; tbErrShown?: boolean; tbErr?: string }
    const WL = (R.lib_welcome ?? {}) as { eWelcome?: boolean; eErrShown?: boolean; eBootErr?: string; eInfoNull?: boolean; clickedTooRecent?: boolean; wErrShown?: boolean; wErr?: string; wClick?: number; bootConsoleErr?: string[] }
    // —— I5-QA 独立探针的断言输入 ——
    const QE = (R.lib_QEdge ?? {}) as Record<string, { err: string; ver: string | null }>
    const QC = (R.lib_QClean ?? {}) as {
      qaRejErr?: string
      qaRejFileAlive?: boolean
      qaRenameOk?: boolean
      qaRenameErr?: string
      qaWatchedAfterRej?: boolean
      qaIpcOpenGoodOk?: boolean
      qaWatchOnGood?: boolean
      qaRejIpc?: { ok?: boolean; error?: string }
      qaWatchStillGood?: boolean
      qaCurStillGood?: boolean
    }
    const QB = (R.lib_QBoot ?? {}) as {
      qaBootBefore?: string
      qaOpenGood?: string | null
      qaBootAfterOpen?: string
      qaInfoAfterOpen?: string | null
      qaWelcomeAgain?: boolean
      qaErrTextAfterClose?: string
    }
    const QBR = (R.lib_QBootRev ?? {}) as {
      qaBootRevSet?: string
      qaFailOpen?: string | null
      qaBootAfterFail?: string
    }
    /** 人话判据：含中文、且不含裸错误码（ERR_XXX）—— 直接对应「用户看到的是中文提示而不是裸错误码」 */
    const isHuman = (s?: string): boolean => !!s && /[\u4e00-\u9fff]/.test(s) && !/ERR_[A-Z]/.test(s)
    const cur = String(SCHEMA_VERSION)

    const checks: Record<string, boolean> = {
      // 前置：确实落在欢迎页（没开库的视图），且它没有 TitleBar
      welcomeViewRendered: v.welcome === true && v.card === true,
      welcomeHasNoTitleBar: v.titlebar === false,
      // 核心：控制条在场，且是 min/max/close 三个（欢迎页没有「收起侧栏」）
      winControlsPresent: btns.length === 3,
      winControlsAreMinMaxClose: JSON.stringify(keys) === JSON.stringify(['min', 'max', 'close']),
      noDetailButtonOnWelcome: v.detailBtn === false,
      // 与库视图同一套几何：28×28 方形按钮 + 16px 图标、同一行、无文字字符
      winControlsGeometryConsistent: geo(btns) && sameRow(btns),
      // 在视口内且中心命中按钮自身（没被别的浮层盖住）
      winControlsInsideViewport: btns.length === 3 && btns.every((b) => b.inViewport),
      winControlsNotCovered: btns.length === 3 && btns.every((b) => b.hitSelf),
      // 整页是拖拽区，按钮必须自己 no-drag，否则鼠标事件被 caption 吃掉（点了没反应）
      winControlsEscapedDragRegion: btns.length === 3 && btns.every((b) => b.region !== 'drag') && v.welcomeRegion === 'drag',
      // 「新建库」面板展开后按钮仍可点，且不遮挡右上角控制条
      newPanelOpens: nNew.open === true && nNew.input === true && nNew.btn === true && nNew.btnHitSelf === true,
      // 真实的窗口行为：最小化 / 还原 / 最大化 / 再点还原 / 关闭
      minActuallyMinimizes: nMin.minimized === true,
      restoredAfterMinimize: nBack.minimized === false && nBack.destroyed === false && nBack.stillWelcome === true,
      maxActuallyMaximizes: nMax.maximized === true && nMax.destroyed === false,
      secondMaxClickRestores: nMax2.maximized === false,
      // 窗口变窄按钮要跟着贴右上角（cx 变小、cy 不变），并且仍落在视口内
      geometryStableAfterResize:
        geo(btns2) &&
        sameRow(btns2) &&
        (btns2[0]?.cx ?? 1e9) < (btns[0]?.cx ?? 0) &&
        (btns2[0]?.cy ?? -1) === (btns[0]?.cy ?? -2) &&
        btns2.every((b) => b.inViewport && b.hitSelf),
      // 无边框窗口唯一的关闭途径：点了必须真的关掉
      closeActuallyCloses: nClose.clicked === true && nClose.closed === true && nClose.destroyed === true,
      noJsErrors: jsErrors.length === 0,

      // —————————————— I5 库 schema 版本门控 ——————————————
      // A 正常库
      'I5-A 新建库 meta.schema_version == String(SCHEMA_VERSION)': A.aVer === cur && A.expect === cur,
      'I5-A 重开正常库不报错且版本不变': A.aOpenErr === '' && A.aVer2 === cur,
      // B 老库兼容（两种形态都必须能开且回写 —— 绝不误判成「太新」）
      'I5-B 老库(version=0)能打开并回写成当前版本': B.bOpen0 === '' && B.bVer0 === cur,
      'I5-B 无版本行的老库能打开并回写成当前版本(不被误判太新)': B.bOpenNone === '' && B.bVerNone === cur,
      // C 太新的库被拒
      'I5-C 服务层 openLibrary 抛 ERR_LIBRARY_TOO_NEW': C.cThrow === 'ERR_LIBRARY_TOO_NEW',
      'I5-C IPC 回执保持 {ok:false,error} 形状(A3 契约)': C.cIpc?.ok === false && C.cIpc?.error === 'ERR_LIBRARY_TOO_NEW',
      'I5-C 拒绝后库文件仍在(不留损坏状态)': C.cFileAlive === true,
      'I5-C 版本改回后仍能打开': C.cReopen === '',
      // D 渲染层两个入口都必须给人话
      'I5-D TitleBar 入口：切到太新的库显示中文人话': TB.inLibView === true && TB.menuOpen === true && TB.clickedTooInMenu === true && TB.tbErrShown === true && isHuman(TB.tbErr),
      'I5-D Welcome 入口：打开太新的库显示中文人话': WL.clickedTooRecent === true && WL.wErrShown === true && (WL.wClick ?? 0) >= 1 && isHuman(WL.wErr),
      // E 启动路径：最近库是「太新」的库 → 优雅退回欢迎页、给人话、无未捕获异常
      'I5-E 最近库太新 → 落到欢迎页且未开库': WL.eWelcome === true && WL.eInfoNull === true,
      'I5-E 欢迎页给出中文人话(非白屏/裸错误码)': WL.eErrShown === true && isHuman(WL.eBootErr),
      'I5-E 启动期间无未捕获异常': (WL.bootConsoleErr ?? []).length === 0,

      // —————————————— I5-QA 独立探针（QA 自写，口径独立于工程师 A~E）——————————————
      // 正对照：期望版本号**写死为 '1'**，且来自**独立只读连接**（不复用 SCHEMA_VERSION 常量）
      'I5-QA 正对照：新建库版本 == 写死的 1（独立只读连接读到，不引用 SCHEMA_VERSION）':
        (R.qaFreshVer as string) === EXPECT_VER,
      // 边界值对撞（逐条把行为钉死）
      "I5-QA 边界 '999999'(远大于当前) 被拒且版本未被改写":
        QE['999999']?.err === 'ERR_LIBRARY_TOO_NEW' && QE['999999']?.ver === '999999',
      "I5-QA 边界 '2'(恰为当前+1) 被拒":
        QE['2']?.err === 'ERR_LIBRARY_TOO_NEW' && QE['2']?.ver === '2',
      "I5-QA 边界 'abc'/''/'1.5'/'-1'/' 2 '(非法值) 一律当 0 → 能开且回写为 1（绝不误判太新）":
        ['abc', '', '1.5', '-1', ' 2 '].every((k) => QE[k]?.err === '' && QE[k]?.ver === EXPECT_VER),
      // 拒绝后的洁净度
      'I5-QA 拒绝后库文件仍在 + 无残留文件锁（可原子改名）':
        QC.qaRejErr === 'ERR_LIBRARY_TOO_NEW' && QC.qaRejFileAlive === true && QC.qaRenameOk === true,
      'I5-QA 拒绝的库不残留 watcher；且拒绝时不会挤掉正在监听的正常库':
        QC.qaWatchedAfterRej === false &&
        QC.qaIpcOpenGoodOk === true &&
        QC.qaWatchOnGood === true &&
        QC.qaRejIpc?.ok === false &&
        QC.qaRejIpc?.error === 'ERR_LIBRARY_TOO_NEW' &&
        QC.qaWatchStillGood === true &&
        QC.qaCurStillGood === true,
      // bootError 生命周期探针的**正对照**：证明「启动失败后打开正常库」这条路径真的走通了
      // （qaInfoAfterOpen == 正常库路径）。bootError 是否被清掉单独记录在 R.lib_QBoot，供报告核查。
      'I5-QA-D bootError 探针正对照：启动失败后成功打开正常库（info 指向该库）':
        QB.qaOpenGood === null && QB.qaInfoAfterOpen === pGood,
      // —————————————— F2 bootError 的「清理」环 ——————————————
      // 前置（G11 显式前置）：探针起点 bootError 必须**确实是**启动失败那条（非空），
      // 否则「打开后变空」会在「本来就空」的情况下恒真 → 空转假绿。
      'F2 前置：探针起点 bootError 确为启动失败的原因（否则「被清空」是空转断言）':
        QB.qaBootBefore === 'ERR_LIBRARY_TOO_NEW',
      'F2 成功打开正常库后 bootError 被清空（不再残留启动失败的原因）':
        QB.qaBootAfterOpen === '',
      'F2 关闭库回到欢迎页后 .w-err 不再显示陈旧的启动失败文案':
        QB.qaWelcomeAgain === true && QB.qaErrTextAfterClose === '',
      // —— F2 反向：失败的开库不得清空 bootError ——
      // 前置：openLibrary(不存在的库) 必须**真的失败**（qaFailOpen 非空），否则「bootError 仍在」
      // 会在「压根没打开过」的情况下恒真（空转）。两项都要满足。
      'F2 反向：打开**失败**的库不得清空 bootError（否则启动失败提示会被一次失败的开库顺手清掉）':
        QBR.qaFailOpen != null && QBR.qaFailOpen !== '' && QBR.qaBootAfterFail === QBR.qaBootRevSet
    }

    R.checks = checks
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k)
    R.ok = failed.length === 0
    R.failed = failed
    R.jsErrors = jsErrors
    console.log('[SMOKE-WELCOME] ' + JSON.stringify(R))
    console.log(`[SMOKE-WELCOME] ${R.ok ? 'PASS' : 'FAIL'} (${Object.keys(checks).length - failed.length}/${Object.keys(checks).length})`)
  } catch (e) {
    console.log('[SMOKE-WELCOME] ERROR ' + String((e as Error).stack ?? e))
    console.log('[SMOKE-WELCOME] ' + JSON.stringify(R))
  } finally {
    // I5 段用的临时库目录：先关连接、停监听，再删目录（Windows 上句柄未释放会删不掉）
    try {
      unwatchLibrary()
      closeCurrent()
    } catch {
      /* 没有当前库 */
    }
    if (dirVer) {
      try {
        rmSync(dirVer, { recursive: true, force: true })
      } catch {
        /* 句柄未释放，留着由一次性 userData 兜底 */
      }
    }
    finished = true
    app.exit(0)
  }
}
