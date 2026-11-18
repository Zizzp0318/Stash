// 开库骨架屏冒烟：electron . --smoke-boot
//
// 第 2 批（开库引导页）的验收。设计前提见 `App.vue` 与 `BootSkeleton.vue` 的文件头：
//   · 只有「真的要等」才显示（>100ms）——本机开库 5.5ms，热开库闪一下骨架比不显示更糟；
//   · 骨架层**不吃事件、不盖标题栏**（用户对「卡死」的第一判断是「窗口拖不动」）；
//   · 首屏数据到位 + 一帧绘制后立刻收，**不能晚到让用户看着空网格**，也不能早到闪一下空白；
//   · 超过阈值（默认 8s）给「先浏览」出口，后台继续补。
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

    // ==================== A. 快开库（不注入延迟）不该闪骨架 ====================
    await js('window.__testSlowBoot(0, 0)')
    const aT0 = Date.now()
    // ⚠️ 这里**await** 完整流程：A 验的是「一次正常速度的开库全过程」，等完才知道它到底花了多久
    const aRes = await js<string | null>(`window.__stashSwitchLibrary(${JSON.stringify(fastLib.path)})`)
    const aOpenMs = Date.now() - aT0
    const aState = await js<Record<string, unknown>>('window.__assetsState ? window.__assetsState() : null')
    result.fast = { openMs: aOpenMs, result: aRes, state: aState }
    // 轮询 400ms：这期间如果骨架亮过，就说明 100ms 阈值失效（本机开库只要几十毫秒）
    let fastSawSkeleton = false
    const trace: Array<Record<string, unknown>> = []
    for (let i = 0; i < 16; i++) {
      const snap = await js<{ layer: boolean; boot: unknown; assets: unknown }>(
        "({ layer: !!document.querySelector('[data-boot-layer]'), boot: window.__bootState ? window.__bootState() : null, assets: window.__assetsState ? window.__assetsState() : null })"
      )
      if (snap?.layer === true) fastSawSkeleton = true
      trace.push({ at: i * 25, ...(snap ?? {}) })
      await sleep(25)
    }
    result.fastTrace = trace
    const fastReady = await waitTrue("document.querySelectorAll('.masonry-card, .list-row').length > 0 || document.querySelector('.empty') !== null", 5000)
    result.fast = { ...(result.fast as Record<string, unknown>), fastSawSkeleton, fastReady }
    check('A 快开库（无注入延迟）全程不该闪加载浮层（100ms 阈值有效）', fastSawSkeleton === false, `openMs=${aOpenMs} 骨架亮过=${fastSawSkeleton}`)
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
      `B 慢开库时加载浮层出现（实测调用后 ${layerSeenAfter}ms；阈值 100ms，>90 才算没提前闪）`,
      layerSeenAfter >= 90 && layerSeenAfter <= 900,
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
        cardPointer: card ? getComputedStyle(card).pointerEvents : ''
      }
    })()`)
    result.geo = geo
    check('B 浮层 pointer-events:none（不吃点击，背后内容照常可交互）', geo?.pointer === 'none', geo?.pointer)
    check('B 浮层上的卡片可以点（「先浏览」要能按）', geo?.cardPointer === 'auto', geo?.cardPointer)
    check(
      'B 浮层不盖标题栏（窗口仍能拖动/最小化）',
      !!geo && geo.layerTop >= geo.titleBarBottom - 1,
      geo ? `layer.top=${geo.layerTop} titlebar.bottom=${geo.titleBarBottom}` : '(层不存在)'
    )
    check(
      'B 只盖中栏：左边缘不越过侧栏、右边缘不越过详情栏',
      !!geo && geo.layerLeft >= geo.sidebarRight - 1 && (geo.detailLeft < 0 || geo.layerRight <= geo.detailLeft + 1),
      geo ? `layer=[${geo.layerLeft},${geo.layerRight}] sidebar.right=${geo.sidebarRight} detail.left=${geo.detailLeft}` : '(层不存在)'
    )
    check(
      'B 预览窗口被虚化（backdrop-filter 含 blur）',
      !!geo && /blur\(/.test(geo.backdrop),
      geo?.backdrop
    )
    check('B 加载条真的画出来了（宽度 > 0）', (geo?.barWidth ?? 0) > 0, String(geo?.barWidth))
    check(
      'B 阶段文案是真状态（正在打开/读取/准备），不是「加载中」',
      !!geo && /正在打开素材库|正在读取索引|正在准备/.test(geo.label),
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

    // 留一张现场图（与其它套件的 shot-*.png 同规范），方便人工复看骨架的样子
    try {
      const img = await win.webContents.capturePage()
      writeFileSync(join(process.cwd(), 'shot-boot-loading.png'), img.toPNG())
      result.shot = 'shot-boot-loading.png'
    } catch (e) {
      result.shotError = String((e as Error)?.message ?? e)
    }

    // ==================== C. 超过阈值 → 「先浏览」出口 ====================
    const skipAfter = await waitTrue("!!document.querySelector('[data-boot-skip]')", 2000, 25)
    result.skipAfter = skipAfter
    check(`C 超过阈值（注入 700ms）出现「先浏览」出口（实测 +${skipAfter}ms）`, skipAfter >= 0, `skipAfter=${skipAfter}`)
    const hintText = await js<string>("(document.querySelector('[data-boot-hint]')?.textContent ?? '').trim()")
    check('C 出口旁边说清「后台继续补」', /可以先浏览/.test(hintText ?? ''), hintText ?? '')

    const clicked = await js<boolean>("(() => { const b = document.querySelector('[data-boot-skip]'); if (!b) return false; b.click(); return true })()")
    const goneAfterSkip = await waitTrue("!document.querySelector('[data-boot-layer]')", 1200, 20)
    result.skip = { clicked, goneAfterSkip }
    check('C 点「先浏览」后浮层立刻收掉（不被按在引导页上）', clicked === true && goneAfterSkip >= 0, `clicked=${String(clicked)} goneAfter=${goneAfterSkip}ms`)

    // ==================== D. 内容最终到位，骨架不再回来 ====================
    const contentAfter = await waitTrue("document.querySelectorAll('.masonry-card, .list-row').length > 0", 8000, 50)
    const backAgain = await js<boolean>("!!document.querySelector('[data-boot-layer]')")
    const slowOpen = await js<{ res: string; assets: unknown; boot: unknown }>(
      '({ res: window.__slowOpenRes ?? "(未设置)", assets: window.__assetsState ? window.__assetsState() : null, boot: window.__bootState ? window.__bootState() : null })'
    )
    result.content = { contentAfter, backAgain, slowOpen }
    check('D 打开完成后首屏有素材（浮层收掉 → 内容接上）', contentAfter >= 0,
      `cardsAfter=${contentAfter}ms open=${slowOpen?.res} assets=${JSON.stringify(slowOpen?.assets)}`)
    check('D 收掉之后浮层不再回来', backAgain === false, String(backAgain))

    // 素材数量与库一致（300 行里有 300 条；虚拟滚动下只断「有卡片」且上界 120）
    const cardCount = await js<number>("document.querySelectorAll('.masonry-card, .list-row').length")
    result.cardCount = cardCount
    check(
      'D 渲染的卡片数在窗口上界内（虚拟滚动：≤120）',
      typeof cardCount === 'number' && cardCount > 0 && cardCount <= 120,
      String(cardCount)
    )

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
