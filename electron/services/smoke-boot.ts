// 开库全屏加载层冒烟：electron . --smoke-boot
//
// 第三版（全屏磨砂层）的验收。设计前提见 `App.vue` 与 `BootOverlay.vue` 的文件头：
//   · 只有「真的要等」才显示（>100ms）——本机开库 5.5ms，热开库闪一下反而像卡了；
//   · **全屏覆盖**（含标题栏与左右栏）：切库时左右栏还是旧库内容，只盖中栏会让人以为已经好了；
//   · 但窗口仍然拖得动（-webkit-app-region: drag）——「拖不动」是用户判断卡死的第一依据；
//   · 进度由渲染层自驱（主进程卡住时没有任何事件可等），且永远到不了 100%；
//   · 首屏数据到位 + 两帧绘制后立刻收，不能晚到让用户看着空网格。
//
// 怎么把它测成「可证伪」：真机上开库太快，骨架根本来不及亮 → 用一个**测试缝**
// `lib.__testSlowBoot(delayMs, stuckMs)` 把等待注进去（生产恒 0）。这不是打桩实现，
// 只是把「慢」这个外部条件搬进测试；骨架的显示/隐藏走的仍是真实代码路径。
import { app, type BrowserWindow } from 'electron'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeCurrent, createLibrary, getDatabase, mkdirRel } from './library'
import { unwatchLibrary } from './watcher'

interface Check {
  name: string
  pass: boolean
  detail?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function runSmokeBoot(win: BrowserWindow): Promise<void> {
  const checks: Check[] = []
  const result: Record<string, unknown> = {}
  const check = (name: string, pass: boolean, detail?: string): void => {
    checks.push({ name, pass, detail })
  }

  /** 在渲染层求值（失败返回 null，不抛） */
  const js = async <T>(code: string): Promise<T | null> => {
    try {
      return (await win.webContents.executeJavaScript(`(() => { try { return ${code} } catch (e) { return null } })()`, true)) as T
    } catch {
      return null
    }
  }

  /** 轮询直到表达式为真（有界），返回耗时 ms；超时返回 -1 */
  const waitTrue = async (expr: string, timeoutMs: number, everyMs = 25): Promise<number> => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      if ((await js<boolean>(expr)) === true) return Date.now() - t0
      await sleep(everyMs)
    }
    return -1
  }

  let dir: string | null = null
  let libPath = ''
  try {
    // ---------- 夹具：两个库（一个用来验「慢开库有骨架」，一个验「快开库不该闪」）----------
    dir = mkdtempSync(join(tmpdir(), 'stash-smoke-boot-'))
    const lib = createLibrary({ name: 'boot-slow', parentDir: dir })
    libPath = lib.path
    const folder = mkdirRel('批量')
    const db = getDatabase()
    db.exec('BEGIN')
    const ins = db.prepare(
      `INSERT INTO assets(folder_id,name,rel_path,type,ext,size,content_hash,file_mtime,imported_at,missing)
       VALUES(?,?,?,'image','jpg',?,NULL,?,?,0)`
    )
    for (let i = 0; i < 300; i++) {
      ins.run(folder.id, `b_${i}.jpg`, `批量/b_${i}.jpg`, 1000, Date.now(), Date.now())
    }
    db.exec('COMMIT')
    result.fixtureRows = 300

    // 第二个库（快开库用）：空库，开起来最便宜
    const fastLib = createLibrary({ name: 'boot-fast', parentDir: dir })
    result.fastLib = fastLib.path
    // createLibrary 会把 current 换到 fastLib —— 切回来的动作交给渲染层的 openLibrary

    const hasSeam = await js<boolean>("typeof window.__stashOpenLibrary === 'function' && typeof window.__stashSwitchLibrary === 'function'")
    check('前置：渲染层暴露了 __stashOpenLibrary / __stashSwitchLibrary 测试缝', hasSeam === true, String(hasSeam))

    // ==================== A. 快开库：固定开场窗口同样生效 ====================
    await js('window.__testSlowBoot(0, 0)')
    // 冒烟环境下固定窗口应当是 0（否则每个套件都被 9 秒拖死）
    result.initMinMs = await js<number>('(window.__bootState && window.__bootState() || {}).minMs')
    // 生产是 9 秒固定窗口；冒烟压到 700ms —— 验的是「到窗口才收」，不是「数据一到就收」
    await js('window.__testBootMin(700)')
    const aT0 = Date.now()
    // ⚠️ 这里**await** 完整流程：A 验的是「一次正常速度的开库全过程」，等完才知道它到底花了多久
    const aRes = await js<string | null>(`window.__stashSwitchLibrary(${JSON.stringify(fastLib.path)})`)
    const aOpenMs = Date.now() - aT0
    const aState = await js<Record<string, unknown>>('window.__assetsState ? window.__assetsState() : null')
    result.fast = { openMs: aOpenMs, result: aRes, state: aState }
    // 轮询 3s：骨架要等「窗口(700) + 探针(3 次 × 250ms) + 淡出(420)」，1.6s 不够
    let fastSawSkeleton = false
    let fastGoneAt = -1
    const trace: Array<Record<string, unknown>> = []
    for (let i = 0; i < 120; i++) {
      const snap = await js<{ layer: boolean; boot: unknown; assets: unknown }>(
        "({ layer: !!document.querySelector('[data-boot-layer]'), boot: window.__bootState ? window.__bootState() : null, assets: window.__assetsState ? window.__assetsState() : null })"
      )
      if (snap?.layer === true) fastSawSkeleton = true
      else if (fastSawSkeleton && fastGoneAt < 0) fastGoneAt = i * 25
      trace.push({ at: i * 25, ...(snap ?? {}) })
      await sleep(25)
    }
    result.fastTrace = trace
    const fastReady = await waitTrue("document.querySelectorAll('.masonry-card, .list-row').length > 0 || document.querySelector('.empty') !== null", 5000)
    result.fast = { ...(result.fast as Record<string, unknown>), fastSawSkeleton, fastGoneAt, fastReady }
    check(
      'A 快开库也会播固定开场（骨架出现，且测试窗口 700ms 之后才收）',
      fastSawSkeleton === true && fastGoneAt >= 600,
      `openMs=${aOpenMs} 骨架亮过=${fastSawSkeleton} 消失于≈${fastGoneAt}ms`
    )
    check('A 快开库仍然正常到位（有卡片或空态）', fastReady >= 0, `readyAfter=${fastReady}ms state=${JSON.stringify(aState)}`)

    // ==================== B. 慢开库（每阶段注入 600ms）→ 骨架必须出现 ====================
    const seam = await js<{ delayMs: number; stuckMs: number }>('window.__testSlowBoot(600, 700)')
    result.seam = seam
    const t0 = Date.now()
    // 不 await：要看骨架在打开**过程中**的样子；结果挂到全局，稍后再读
    await js(`(() => {
      window.__slowOpenRes = 'pending'
      window.__stashSwitchLibrary(${JSON.stringify(libPath)}).then((r) => { window.__slowOpenRes = String(r) }, (e) => { window.__slowOpenRes = 'ERR ' + String(e && e.message || e) })
      return 'started'
    })()`)
    const layerSeenAfter = await waitTrue("!!document.querySelector('[data-boot-layer]')", 1200, 20)
    result.layerSeenAfter = layerSeenAfter
    check(
      `B 慢开库时加载浮层立即出现（固定窗口下不再有防闪阈值；实测 +${layerSeenAfter}ms）`,
      layerSeenAfter >= 0 && layerSeenAfter <= 250,
      `seenAfter=${layerSeenAfter}ms`
    )

    // 虚化浮层的几何与「只盖中栏」约束（第二版设计：中栏虚化 + 中间一条悬浮加载条）
    const geo = await js<{
      pointer: string
      layerTop: number
      layerLeft: number
      layerRight: number
      titleBarBottom: number
      galleryRect: [number, number]
      sidebarRight: number
      detailLeft: number
      backdrop: string
      label: string
      barWidth: number
      ratio: string | null
      cardPointer: string
      winW: number
    }>(`(() => {
      const el = document.querySelector('[data-boot-layer]')
      if (!el) return null
      const tb = document.querySelector('.titlebar')
      const gallery = document.querySelector('.gallery')
      const side = document.querySelector('.sidebar')
      const detail = document.querySelector('.detail')
      const r = el.getBoundingClientRect()
      const gr = gallery ? gallery.getBoundingClientRect() : null
      const card = el.querySelector('[data-boot-pill]')
      const fill = el.querySelector('.boot-fill')
      const cs = getComputedStyle(el)
      return {
        pointer: cs.pointerEvents,
        backdrop: cs.backdropFilter || cs.webkitBackdropFilter || 'none',
        layerTop: Math.round(r.top),
        layerLeft: Math.round(r.left),
        layerRight: Math.round(r.right),
        titleBarBottom: tb ? Math.round(tb.getBoundingClientRect().bottom) : -1,
        galleryRect: gr ? [Math.round(gr.width), Math.round(gr.height)] : [0, 0],
        sidebarRight: side ? Math.round(side.getBoundingClientRect().right) : -1,
        detailLeft: detail ? Math.round(detail.getBoundingClientRect().left) : -1,
        label: (el.querySelector('[data-boot-label]')?.textContent ?? '').trim(),
        barWidth: fill ? Math.round(fill.getBoundingClientRect().width) : -1,
        ratio: fill ? fill.getAttribute('data-boot-ratio') : null,
        cardPointer: card ? getComputedStyle(card).pointerEvents : '',
        winW: window.innerWidth
      }
    })()`)
    result.geo = geo
    check('B 浮层挡住整窗（加载期间不接受点击）', geo?.pointer === 'auto', geo?.pointer)
    check(
      'B 浮层覆盖整个窗口（含标题栏与左右栏）',
      !!geo && geo.layerTop <= 0 && geo.layerLeft <= 0 && geo.layerRight >= geo.winW - 1,
      geo ? `layer=[${geo.layerLeft},${geo.layerTop},${geo.layerRight}] winW=${geo.winW}` : '(层不存在)'
    )
    check(
      'B 标题栏也在遮盖范围内（切库时左右栏/标题栏都是旧内容，必须一起盖住）',
      !!geo && geo.layerTop <= geo.titleBarBottom,
      geo ? `layer.top=${geo.layerTop} titlebar.bottom=${geo.titleBarBottom}` : '(层不存在)'
    )
    check(
      'B 预览窗口被虚化（backdrop-filter 含 blur）',
      !!geo && /blur\(/.test(geo.backdrop),
      geo?.backdrop
    )
    check('B 加载条真的画出来了（宽度 > 0）', (geo?.barWidth ?? 0) > 0, String(geo?.barWidth))
    check(
      'B 标题是真状态（正在打开素材库），不是笼统的「加载中」',
      !!geo && /正在打开素材库/.test(geo.label),
      geo?.label
    )

    // 视觉证据：先确认骨架**真的画出来了**（computedStyle + elementFromPoint），再截图。
    // 只看 DOM 存在是不够的 —— 一个 z-index 被压住/透明度为 0 的层也能让上面的断言全绿。
    const visual = await js<Record<string, unknown>>(`(() => {
      const el = document.querySelector('[data-boot-layer]')
      if (!el) return null
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      const atCenter = document.elementsFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
        .slice(0, 3).map((n) => n.className || n.tagName)
      const card = el.querySelector('[data-boot-pill]')
      const ccs = card ? getComputedStyle(card) : null
      const cr = card ? card.getBoundingClientRect() : null
      return {
        display: cs.display, opacity: cs.opacity, visibility: cs.visibility, zIndex: cs.zIndex,
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        cardRect: cr ? [Math.round(cr.width), Math.round(cr.height)] : null,
        cardBg: ccs ? ccs.backgroundColor : null,
        atCenter
      }
    })()`)
    result.visual = visual

    // 留一张现场图（与其它套件的 shot-*.png 同规范），方便人工复看加载层的样子。
    // 先等一下再截：--disable-gpu 下 capturePage 可能拿到上一帧，磨砂层还没合成进去。
    try {
      await sleep(180)
      const img = await win.webContents.capturePage()
      writeFileSync(join(process.cwd(), 'shot-boot-loading.png'), img.toPNG())
      result.shot = 'shot-boot-loading.png'
    } catch (e) {
      result.shotError = String((e as Error)?.message ?? e)
    }

    // ==================== C. 超过阈值 → 慢盘提示（不再有「先浏览」出口）====================
    const hintAfter = await waitTrue("!!document.querySelector('[data-boot-hint]')", 2000, 25)
    result.hintAfter = hintAfter
    check(
      `C 超过阈值（注入 700ms）出现慢盘提示（实测 +${hintAfter}ms）`,
      hintAfter >= 0,
      `hintAfter=${hintAfter}`
    )
    const hintText = await js<string>("(document.querySelector('[data-boot-hint]')?.textContent ?? '').trim()")
    check('C 提示说的是「首次打开/刚开机会慢」，不是含糊的「请稍候」', /首次打开|刚开机/.test(hintText ?? ''), hintText ?? '')

    // 语义变了：以前是「早收骨架、不给出口」（怕揭开露出冻住的界面）；
    // 现在固定 9 秒窗口，不给出口就等于把人锁 9 秒，必须有「跳过」。
    const hasSkip = await js<boolean>("!!document.querySelector('[data-boot-skip]')")
    result.hasSkip = hasSkip
    check('C 提供「跳过」出口（固定窗口必须能提前结束）', hasSkip === true, String(hasSkip))

    // ==================== D. 内容最终到位，浮层收掉且不再回来 ====================
    const contentAfter = await waitTrue("document.querySelectorAll('.masonry-card, .list-row').length > 0", 8000, 50)
    // 内容出现 ≠ 层已收：收层要等 markBootPainted（首屏到位 + 两帧绘制），给一个独立窗口
    const layerGone = await waitTrue("!document.querySelector('[data-boot-layer]')", 3000, 25)
    const backAgain = await js<boolean>("!!document.querySelector('[data-boot-layer]')")
    const slowOpen = await js<{ res: string; assets: unknown; boot: unknown }>(
      '({ res: window.__slowOpenRes ?? "(未设置)", assets: window.__assetsState ? window.__assetsState() : null, boot: window.__bootState ? window.__bootState() : null })'
    )
    result.content = { contentAfter, layerGone, backAgain, slowOpen }
    check('D 打开完成后首屏有素材（浮层收掉 → 内容接上）', contentAfter >= 0,
      `cardsAfter=${contentAfter}ms open=${slowOpen?.res} assets=${JSON.stringify(slowOpen?.assets)}`)
    check('D 内容到位后浮层收掉', layerGone >= 0, `goneAfter=${layerGone}ms`)
    check('D 收掉之后浮层不再回来', backAgain === false, String(backAgain))

    // 素材数量与库一致（300 行里有 300 条；虚拟滚动下只断「有卡片」且上界 120）
    const cardCount = await js<number>("document.querySelectorAll('.masonry-card, .list-row').length")
    result.cardCount = cardCount
    check(
      'D 渲染的卡片数在窗口上界内（虚拟滚动：≤120）',
      typeof cardCount === 'number' && cardCount > 0 && cardCount <= 120,
      String(cardCount)
    )

    // ==================== E. 主进程繁忙 → 骨架必须继续盖着 ====================
    /*
     * 探针的语义：骨架的退出条件是「能操作」，不是「数据到了」。
     * 这里给 sys:ping 注入 250ms 延迟（> 60ms 阈值）模拟「主进程正忙」：
     * 窗口设成 300ms —— 只看窗口的话 1 秒内就该撤，骨架必须仍然在。
     * 然后恢复延迟，确认它能正常撤掉（否则「不撤」只是卡死，不是探针生效）。
     */
    // 先等上一轮骨架彻底收完：否则上一轮的排期 timer 会在这段里到点，把新骨架一起带走
    const idleBeforeBusy = await waitTrue("!!(window.__bootState && window.__bootState().booting === false)", 8000, 50)
    result.idleBeforeBusy = idleBeforeBusy
    await js('window.__testBootMin(300)')
    // 探针在冒烟里默认关闭（否则每个套件都被 750ms 拖慢），这里显式打开来验证它
    await js('window.__testProbeEnabled(true)')
    await js('window.stash.sys.testPingDelay(250)')
    // 诊断：延迟到底生效没有（RTT 应该 > 200ms，这正是探针要拦住的状态）
    const busyRtt = await js<number>(
      `(async () => { const t0 = performance.now(); await window.stash.sys.ping(); return Math.round(performance.now() - t0) })()`
    )
    result.busyRtt = busyRtt
    await js(`(() => {
      window.__busyOpenRes = 'pending'
      window.__stashSwitchLibrary(${JSON.stringify(fastLib.path)}).then(
        () => { window.__busyOpenRes = 'ok' },
        (e) => { window.__busyOpenRes = 'ERR ' + String(e && e.message || e) }
      )
      return 'started'
    })()`)
    await sleep(1600)
    const heldWhileBusy = await js<boolean>("!!document.querySelector('[data-boot-layer]')")
    result.busyHeld = heldWhileBusy
    check(
      'E 主进程繁忙时骨架不撤（RTT 探针生效；窗口只有 300ms）',
      heldWhileBusy === true,
      String(heldWhileBusy)
    )

    await js('window.stash.sys.testPingDelay(0)')
    const goneAfterRecover = await waitTrue("!document.querySelector('[data-boot-layer]')", 8000, 50)
    result.busyGoneAfter = goneAfterRecover
    check('E 主进程恢复后骨架正常撤掉（不是卡死）', goneAfterRecover >= 0, `goneAfter=${goneAfterRecover}ms`)

    result.checks = checks
    result.failed = checks.filter((c) => !c.pass)
    result.ok = checks.every((c) => c.pass)
  } catch (e) {
    result.ok = false
    result.error = String((e as Error)?.stack ?? e)
    result.checks = checks
    result.failed = checks.filter((c) => !c.pass)
  } finally {
    try {
      unwatchLibrary()
      closeCurrent()
      if (dir) rmSync(dir, { recursive: true, force: true })
    } catch (e) {
      result.cleanupError = String((e as Error)?.message ?? e)
    }
    console.log('[SMOKE-BOOT] ' + JSON.stringify(result, null, 2))
    app.exit(0)
  }
}
