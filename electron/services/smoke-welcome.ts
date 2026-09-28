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
import { writeFileSync } from 'fs'
import { join } from 'path'

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
  const js = async (code: string): Promise<unknown> => {
    try {
      return await win.webContents.executeJavaScript(code)
    } catch (e) {
      jsErrors.push({ code: code.replace(/\s+/g, ' ').slice(0, 160), error: String(e).slice(0, 160) })
      return null
    }
  }

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
      noJsErrors: jsErrors.length === 0
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
    finished = true
    app.exit(0)
  }
}
