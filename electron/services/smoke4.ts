// M4 冒烟：多选（Ctrl 点选 / 拖拽框选 / 空白取消）+ 批量操作（评分 / 喜欢 / 移动 / 删除）
// 全程在临时库里跑，用真实鼠标输入事件驱动渲染层，最后核对磁盘与数据库
import { app, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { closeCurrent, createLibrary, deleteLibrary, mkdirRel, requireCurrent } from './library'
import { deleteAssets } from './assets'
import { importFiles } from './importer'

type Rect = { id: number; x: number; y: number; w: number; h: number; cx: number; cy: number }

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function onceLoaded(win: BrowserWindow): Promise<void> {
  return new Promise((resolve) => win.webContents.once('did-finish-load', () => resolve()))
}

export async function runSmokeM4(win: BrowserWindow): Promise<void> {
  const R: Record<string, unknown> = {}
  const jsErrors: Array<{ code: string; error: string }> = []
  const rendererLogs: string[] = []
  win.webContents.on('console-message', (_e, _lvl, message) => {
    rendererLogs.push(message.slice(0, 300))
    if (rendererLogs.length > 40) rendererLogs.shift()
  })
  const rawJs = (code: string): Promise<unknown> => win.webContents.executeJavaScript(code)
  /** 单个脚本失败不再中断整条链路，把出错脚本与原因记下来继续跑 */
  const js = async (code: string): Promise<unknown> => {
    try {
      return await rawJs(code)
    } catch (e) {
      jsErrors.push({ code: code.replace(/\s+/g, ' ').slice(0, 160), error: String(e).slice(0, 160) })
      return null
    }
  }
  const click = (x: number, y: number, ctrl = false): void => {
    const m = ctrl ? ['control'] : []
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y), modifiers: m })
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers: m })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers: m })
  }
  const drag = (x1: number, y1: number, x2: number, y2: number, ctrl = false): void => {
    const m = ctrl ? ['control'] : []
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x1), y: Math.round(y1), modifiers: m })
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x1), y: Math.round(y1), button: 'left', clickCount: 1, modifiers: m })
    // 分步移动，确保超过拖拽阈值并触发多次 mousemove
    for (let i = 1; i <= 6; i++) {
      win.webContents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(x1 + ((x2 - x1) * i) / 6),
        y: Math.round(y1 + ((y2 - y1) * i) / 6),
        modifiers: m
      })
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x2), y: Math.round(y2), button: 'left', clickCount: 1, modifiers: m })
  }
  const cards = async (): Promise<Rect[]> => {
    const s = (await js(`JSON.stringify([...document.querySelectorAll('.masonry-card')].map(c => {
        const r = c.getBoundingClientRect()
        return { id: +c.dataset.id, x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
      }))`)) as string | null
    return s ? (JSON.parse(s) as Rect[]) : []
  }
  const selIds = async (): Promise<number[]> => {
    const s = (await js(`JSON.stringify([...document.querySelectorAll('.masonry-card.selected')].map(c => +c.dataset.id))`)) as
      | string
      | null
    return s ? (JSON.parse(s) as number[]) : []
  }
  const dbRows = (): Array<{ id: number; rating: number; is_fav: number; rel_path: string; folder_id: number }> =>
    requireCurrent().db.prepare('SELECT id, rating, is_fav, rel_path, folder_id FROM assets ORDER BY id').all() as never
  /** 元素中心点（用于把「点击 SVG 里的星星」变成真实鼠标点击 —— SVGElement 没有 .click()） */
  const elPoint = async (selector: string, index = 0): Promise<{ x: number; y: number } | null> => {
    const s = (await js(`(() => {
      const e = document.querySelectorAll(${JSON.stringify(selector)})[${index}]
      if (!e) return 'null'
      e.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      const r = e.getBoundingClientRect()
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
    })()`)) as string | null
    return s && s !== 'null' ? (JSON.parse(s) as { x: number; y: number }) : null
  }
  const clickEl = async (selector: string, index = 0): Promise<boolean> => {
    const p = await elPoint(selector, index)
    if (!p) return false
    click(p.x, p.y)
    return true
  }
  const notice = async (): Promise<string | null> =>
    (await js(`document.querySelector('.notice-toast')?.textContent.trim() ?? null`)) as string | null
  /** 把鼠标挪到左上角，让 .stars 触发 mouseleave（否则 hoverStar 会覆盖真实显示） */
  const moveAway = (): void => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: 4 })
  }
  /**
   * 详情页心心的真实 DOM 状态。
   * 必须查 DOM 而不只查数据库：曾出现「DB 写成功、UI 不刷新」的假绿
   * （store 把 IPC 的 camelCase `isFav` 直接 assign 到 snake_case 行对象上）。
   */
  const detailHeartDom = async (): Promise<{ on: boolean; fill: string | null; color: string } | null> =>
    (await js(`(() => {
      const b = document.querySelector('.detail .heart-btn')
      if (!b) return null
      return { on: b.classList.contains('on'), fill: b.querySelector('svg')?.getAttribute('fill') ?? null, color: getComputedStyle(b).color }
    })()`)) as { on: boolean; fill: string | null; color: string } | null
  /**
   * 详情页当前点亮了几颗星（看 DOM 的 fill，不看数据库）。
   * 调用前务必先 moveAway()：星星有 `@mouseenter` 悬停预览，
   * 鼠标停在上面时点亮数会等于悬停星号，正好和刚点下的 rating 相同 → 断言假绿。
   */
  const detailStarOnCount = async (): Promise<number> =>
    ((await js(`[...document.querySelectorAll('.detail .star')].filter(x => x.getAttribute('fill') === 'currentColor').length`)) as
      | number
      | null) ?? -1
  const capture = async (name: string): Promise<void> => {
    const img = await win.webContents.capturePage()
    writeFileSync(join(process.cwd(), name), img.toPNG())
  }

  let dir: string | null = null
  let libPath = ''
  try {
    dir = mkdtempSync(join(tmpdir(), 'stash-smoke4-'))
    libPath = createLibrary({ name: 'm4lib', parentDir: dir }).path
    mkdirRel('目标文件夹')

    // —— 造 6 张真实图片并导入 ——
    const src = join(dir, 'src')
    mkdirSync(src)
    const paths: string[] = []
    for (let i = 0; i < 7; i++) {
      const p = join(src, `img-${i}.png`)
      await sharp({ create: { width: 240 + i * 40, height: 180, channels: 3, background: { r: 30 + i * 30, g: 90, b: 150 } } })
        .png()
        .toFile(p)
      paths.push(p)
    }
    const imp = await new Promise<{ added: number; failed: unknown[] }>((resolve) =>
      importFiles({ paths, mode: 'copy', onDone: (x) => resolve(x) })
    )
    R.import = { added: imp.added, failed: imp.failed.length }

    // —— 服务层直调：确认真删除是物理删除，且不留 .trash 目录 ——
    const fbRow = requireCurrent()
      .db.prepare("SELECT id, rel_path FROM assets WHERE name='img-6.png'")
      .get() as { id: number; rel_path: string } | undefined
    if (fbRow) {
      const fb = deleteAssets([fbRow.id])
      R.hardDeleteCheck = {
        result: fb,
        fileGone: !existsSync(join(libPath, ...fbRow.rel_path.split('/'))),
        rowGone: !requireCurrent().db.prepare('SELECT id FROM assets WHERE id=?').get(fbRow.id),
        trashDirCreated: existsSync(join(libPath, '.trash'))
      }
    }

    // —— 让渲染层打开这个库并重新挂载 ——
    await rawJs(`window.stash.library.open(${JSON.stringify(libPath)}).then(() => location.reload())`)
    await onceLoaded(win)
    await sleep(2500)

    const run = async (): Promise<void> => {
      let cs = await cards()
      R.cardCount = cs.length
      if (cs.length < 6) {
        R.abort = '卡片数量不足：' + cs.length
        return
      }

      // ① 普通点击 = 单选
      click(cs[1].cx, cs[1].cy)
      await sleep(250)
      R.step1_singleClick = await selIds()

      // ② Ctrl+点击 = 追加一项
      click(cs[3].cx, cs[3].cy, true)
      await sleep(250)
      R.step2_ctrlClick = await selIds()

      // ③ Ctrl+拖拽 = 框选追加（框住前 5 张卡片的外接范围）
      cs = await cards()
      const box = {
        x1: Math.min(...cs.slice(0, 5).map((c) => c.x)) + 2,
        y1: Math.min(...cs.slice(0, 5).map((c) => c.y)) + 2,
        x2: Math.max(...cs.slice(0, 5).map((c) => c.x + c.w)) - 2,
        y2: Math.max(...cs.slice(0, 5).map((c) => c.y + c.h)) - 2
      }
      drag(box.x1, box.y1, box.x2, box.y2, true)
      await sleep(300)
      const afterBand = await selIds()
      R.step3_ctrlBand = { ids: afterBand, count: afterBand.length }
      R.step3_marqueeGone = !(await js(`!!document.querySelector('.marquee')`))

      // ④ 底部悬浮条
      R.step4_batchbar = await js(`(() => {
        const b = document.querySelector('.batchbar')
        if (!b) return null
        return { text: b.querySelector('.bb-count')?.textContent.trim(), stars: b.querySelectorAll('.bb-star').length, btns: [...b.querySelectorAll('.bb-btn')].map(x => x.textContent.trim()) }
      })()`)

      // ④b 未点亮星必须是「空心描边」而不是隐形：fill=none 时必须有 stroke，否则整颗星看不见
      R.step4_bbStarPaint = await js(`(() => {
        const s = [...document.querySelectorAll('.batchbar .bb-star')]
        return s.length ? { fill: s[0].getAttribute('fill'), stroke: s[0].getAttribute('stroke'), color: getComputedStyle(s[0]).color } : null
      })()`)

      // ⑤ 批量评分：点第 4 颗星（真实鼠标点击，顺带验证星星没被别的东西盖住）
      R.step5_clicked = await clickEl('.batchbar .bb-star', 3)
      await sleep(700)
      const rated = dbRows().filter((r) => afterBand.includes(r.id))
      R.step5_bulkRate = { expect: 4, got: rated.map((r) => r.rating), allOk: rated.every((r) => r.rating === 4), notice: await notice() }

      // ⑥ 批量喜欢
      await js(`[...document.querySelectorAll('.batchbar .bb-btn')].find(b => b.textContent.includes('喜欢')).click()`)
      await sleep(600)
      const faved = dbRows().filter((r) => afterBand.includes(r.id))
      R.step6_bulkFav = { got: faved.map((r) => r.is_fav), allOk: faved.every((r) => r.is_fav === 1) }

      // ⑦ 批量移动：悬浮条「移动」→ 选目标文件夹 → 确认
      await js(`[...document.querySelectorAll('.batchbar .bb-btn')].find(b => b.textContent.includes('移动')).click()`)
      await sleep(250)
      R.step7_moveDialog = await js(`(() => {
        const m = document.querySelector('.modal')
        if (!m) return null
        return { title: m.querySelector('.modal-title')?.textContent.trim(), rows: [...m.querySelectorAll('.move-row')].map(r => r.textContent.trim()) }
      })()`)
      const picked = await js(`(() => {
        const row = [...document.querySelectorAll('.move-row')].find(r => r.textContent.includes('目标文件夹'))
        if (!row) return false
        row.click(); return true
      })()`)
      R.step7_picked = picked
      await sleep(150)
      await js(`[...document.querySelectorAll('.modal .w-btn')].find(b => b.textContent.includes('移动到此处')).click()`)
      await sleep(1200)
      const movedDir = join(libPath, '目标文件夹')
      const onDisk = existsSync(movedDir) ? readdirSync(movedDir) : []
      const afterMove = dbRows().filter((r) => afterBand.includes(r.id))
      R.step7_bulkMove = {
        filesInTarget: onDisk.length,
        relPaths: afterMove.map((r) => r.rel_path),
        relAllInTarget: afterMove.every((r) => r.rel_path.startsWith('目标文件夹/')),
        selectionCleared: (await selIds()).length === 0
      }

      // ⑧ 右键菜单（单张）：右键 → 菜单出现 → 「设为喜欢」不适用时显示「取消喜欢」
      cs = await cards()
      const ctx = await js(`(() => {
        const c = document.querySelectorAll('.masonry-card')[0]
        const r = c.getBoundingClientRect()
        c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20 }))
        return true
      })()`)
      R.step8_ctxDispatched = ctx
      await sleep(300)
      R.step8_ctxMenu = await js(`(() => {
        const m = document.querySelector('.ctx-menu')
        if (!m) return null
        return { head: m.querySelector('.ctx-head')?.textContent.trim(), items: [...m.querySelectorAll('.ctx-item')].map(x => x.textContent.trim()), stars: m.querySelectorAll('.ctx-star').length }
      })()`)
      // ⑧b 右键菜单里「未点亮的那颗星」同样要可见（关态描边），且与详情页星色一致
      // 注意：比对基准必须也是详情页里**未点亮**的星，取第一颗会拿到金色点亮态
      R.step8_ctxStarPaint = await js(`(() => {
        const s = [...document.querySelectorAll('.ctx-menu .ctx-star')]
        const off = s.find(x => x.getAttribute('fill') === 'none')
        const detailOff = [...document.querySelectorAll('.detail .star')].find(x => x.getAttribute('fill') === 'none')
        return off ? {
          fill: off.getAttribute('fill'),
          stroke: off.getAttribute('stroke'),
          color: getComputedStyle(off).color,
          detailOffColor: detailOff ? getComputedStyle(detailOff).color : null
        } : null
      })()`)

      // ⑨ 右键菜单里改评分：点第 5 颗星
      R.step9_clicked = await clickEl('.ctx-menu .ctx-star', 4)
      await sleep(700)
      R.step9_ctxRate = {
        menuClosed: !(await js(`!!document.querySelector('.ctx-menu')`)),
        ratings: dbRows().map((r) => r.rating),
        notice: await notice()
      }

      // ⑩ 右键 → 删除（物理删除，不可恢复）
      cs = await cards()
      const target = cs[0]
      const before = dbRows()
      const victim = before.find((r) => r.id === target.id)
      await js(`(() => {
        const c = [...document.querySelectorAll('.masonry-card')].find(x => +x.dataset.id === ${target.id})
        const r = c.getBoundingClientRect()
        c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20 }))
      })()`)
      await sleep(300)
      await js(`[...document.querySelectorAll('.ctx-menu .ctx-item')].find(b => b.textContent.trim() === '删除').click()`)
      await sleep(200)
      R.step10_confirmVisible = await js(`!!document.querySelector('.ctx-confirm')`)
      R.step10_confirmText = await js(`document.querySelector('.ctx-confirm-text')?.textContent.trim() ?? null`)
      await js(`[...document.querySelectorAll('.ctx-confirm-btn')].find(b => b.textContent.trim() === '删除').click()`)
      await sleep(2000)
      const victimFile = join(libPath, ...victim!.rel_path.split('/'))
      const after = dbRows()
      R.step10_delete = {
        victim: victim!.rel_path,
        fileGone: !existsSync(victimFile),
        rowGone: !after.some((r) => r.id === target.id),
        remaining: after.length,
        trashDirCreated: existsSync(join(libPath, '.trash')),
        notice: await notice()
      }

      // ⑩附加诊断：绕开 UI 直接调服务层，拿到真实错误
      const diagRow = dbRows()[0]
      if (diagRow) {
        try {
          R.diag_delete = deleteAssets([diagRow.id])
        } catch (e) {
          R.diag_delete = { error: String((e as Error).message ?? e) }
        }
      }

      // ⑪ 点击空白处取消选择
      cs = await cards()
      click(cs[0].cx, cs[0].cy, true)
      await sleep(300)
      const blankRaw = (await js(`(() => {
           const wr = document.querySelector('.grid-wrap').getBoundingClientRect()
           return JSON.stringify({ x: wr.left + 6, y: wr.top + 60 })
         })()`)) as string | null
      const blankPt = (blankRaw ? JSON.parse(blankRaw) : { x: 0, y: 0 }) as { x: number; y: number }
      click(blankPt.x, blankPt.y)
      await sleep(800)
      R.step11_blankClear = { selectedAfter: (await selIds()).length, batchbarGone: !(await js(`!!document.querySelector('.batchbar')`)) }

      // ⑫ 详情面板星级 / 心心
      // 每个动作都同时采 **数据库** 与 **DOM** 两份证据 —— 只查 DB 会漏掉「写成功但 UI 不刷新」
      cs = await cards()
      click(cs[0].cx, cs[0].cy)
      await sleep(400)
      const detailId = (await selIds())[0]
      const ratingBefore = dbRows().find((x) => x.id === detailId)?.rating
      moveAway()
      await sleep(200)
      const starOnBefore = await detailStarOnCount()

      R.step12_starClicked = await clickEl('.detail .star', 2)
      await sleep(400)
      moveAway() // 必须挪开：鼠标停在星上时 hoverStar 会覆盖显示，导致断言假绿
      await sleep(250)
      const ratingAfter = dbRows().find((x) => x.id === detailId)?.rating
      const starOnAfter = await detailStarOnCount()

      // 心心连点两次，两个方向都覆盖：喜欢→取消 与 取消→喜欢
      moveAway()
      await sleep(150)
      const favBefore = dbRows().find((x) => x.id === detailId)?.is_fav
      const heartBefore = await detailHeartDom()
      R.step12_heartClicked = await clickEl('.detail .heart-btn')
      await sleep(600)
      moveAway()
      await sleep(150)
      const favMid = dbRows().find((x) => x.id === detailId)?.is_fav
      const heartMid = await detailHeartDom()
      await clickEl('.detail .heart-btn')
      await sleep(600)
      moveAway()
      await sleep(150)
      const favEnd = dbRows().find((x) => x.id === detailId)?.is_fav
      const heartEnd = await detailHeartDom()

      R.step12_detail = {
        ratingBefore,
        ratingAfterStarClick: ratingAfter,
        starOnBefore,
        starOnAfter,
        favBefore,
        favMid,
        favEnd,
        heartBefore,
        heartMid,
        heartEnd,
        // 数据库：两次点击各翻转一次、最终回到起点
        heartDbToggled: favBefore != null && favBefore !== favMid && favMid !== favEnd && favBefore === favEnd,
        // DOM：class.on 同样翻转，且 fill 在 none / currentColor 之间切换
        heartDomToggled:
          !!heartBefore && !!heartMid && !!heartEnd &&
          heartBefore.on !== heartMid.on &&
          heartMid.on !== heartEnd.on &&
          heartBefore.on === heartEnd.on &&
          heartMid.fill !== heartBefore.fill,
        // DOM 点亮的星数必须与 DB 里的 rating 一致（点击前 + 点击后都要对）
        starDomFollowsDb: starOnAfter === (ratingAfter ?? -1) && starOnBefore === (ratingBefore ?? -1)
      }

      // ==================== 截图留证 ====================
      try {
        const wp = JSON.parse(
          (await js(`(() => { const r = document.querySelector('.grid-wrap').getBoundingClientRect(); return JSON.stringify({ x: r.left + 6, y: r.top + 60 }) })()`)) as string
        ) as { x: number; y: number }
        click(wp.x, wp.y)
        await sleep(500)

        // ① 框选进行中：选框、命中卡片、底部悬浮条同框
        cs = await cards()
        const bx1 = Math.min(...cs.slice(0, 4).map((c) => c.x)) + 2
        const by1 = Math.min(...cs.slice(0, 4).map((c) => c.y)) + 2
        const bx2 = Math.max(...cs.slice(0, 4).map((c) => c.x + c.w)) - 2
        const by2 = Math.max(...cs.slice(0, 4).map((c) => c.y + c.h)) - 70
        win.webContents.sendInputEvent({ type: 'mouseMove', x: bx1, y: by1, modifiers: ['control'] })
        win.webContents.sendInputEvent({ type: 'mouseDown', x: bx1, y: by1, button: 'left', clickCount: 1, modifiers: ['control'] })
        for (let i = 1; i <= 6; i++) {
          win.webContents.sendInputEvent({
            type: 'mouseMove',
            x: Math.round(bx1 + ((bx2 - bx1) * i) / 6),
            y: Math.round(by1 + ((by2 - by1) * i) / 6),
            modifiers: ['control']
          })
        }
        await sleep(300)
        await capture('shot-band.png')
        win.webContents.sendInputEvent({ type: 'mouseUp', x: bx2, y: by2, button: 'left', clickCount: 1, modifiers: ['control'] })
        await sleep(700)
        await capture('shot-selected.png')

        // ② 右键菜单
        const first = (await cards())[0]
        await js(`(() => {
          const c = [...document.querySelectorAll('.masonry-card')].find(x => +x.dataset.id === ${first.id})
          const r = c.getBoundingClientRect()
          c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }))
        })()`)
        await sleep(450)
        await capture('shot-menu.png')

        // ③ 移动弹窗
        await js(`[...document.querySelectorAll('.ctx-menu .ctx-item')].find(b => b.textContent.includes('移动到')).click()`)
        await sleep(450)
        await capture('shot-move.png')
        await js(`[...document.querySelectorAll('.modal .w-btn')].find(b => b.textContent.includes('取消'))?.click()`)
        await sleep(250)
      } catch (e) {
        R.shotError = String((e as Error).message ?? e)
      }
    }

    await run()

    // —— 断言汇总 ——
    const s1 = R.step1_singleClick as number[]
    const s2 = R.step2_ctrlClick as number[]
    const s3 = R.step3_ctrlBand as { count: number }
    const s4p = R.step4_bbStarPaint as { fill: string; stroke: string; color: string } | null
    const s8p = R.step8_ctxStarPaint as { fill: string; stroke: string; color: string; detailOffColor: string | null } | null
    const s5 = R.step5_bulkRate as { allOk: boolean }
    const s6 = R.step6_bulkFav as { allOk: boolean }
    const s7 = R.step7_bulkMove as { relAllInTarget: boolean; filesInTarget: number; selectionCleared: boolean }
    const s10 = R.step10_delete as { fileGone: boolean; rowGone: boolean; trashDirCreated: boolean }
    const s11 = R.step11_blankClear as { selectedAfter: number; batchbarGone: boolean }
    const s12 = R.step12_detail as {
      ratingAfterStarClick: number
      starDomFollowsDb: boolean
      heartDbToggled: boolean
      heartDomToggled: boolean
    }
    const hd = R.hardDeleteCheck as { fileGone: boolean; rowGone: boolean; trashDirCreated: boolean } | undefined

    R.checks = {
      singleClick: s1?.length === 1,
      ctrlClickAdds: s2?.length === 2,
      ctrlBandAdds: s3?.count >= 5,
      bulkRate: !!s5?.allOk,
      bulkFav: !!s6?.allOk,
      bulkMove: !!s7?.relAllInTarget && s7?.filesInTarget >= 5 && !!s7?.selectionCleared,
      // 未点亮的星必须是「空心描边」（fill:none + stroke:currentColor），不能是隐形的
      offStarOutlined:
        s4p?.fill === 'none' && s4p?.stroke === 'currentColor' &&
        s8p?.fill === 'none' && s8p?.stroke === 'currentColor',
      // 且关态颜色与详情页星星一致（详情面板未开时至少要求两处悬浮 UI 彼此一致）
      offStarColorMatchesDetail:
        !!s4p && !!s8p && s4p.color === s8p.color &&
        (s8p.detailOffColor == null || s8p.color === s8p.detailOffColor),
      // 删除即物理删除：文件没了、索引行没了，且绝不产生 .trash 回收站目录
      hardDelete: !!s10?.fileGone && !!s10?.rowGone && s10?.trashDirCreated === false,
      blankClears: s11?.selectedAfter === 0 && !!s11?.batchbarGone,
      // 详情页评分：DB 值 + DOM 点亮星数都要对
      detailStar: s12?.ratingAfterStarClick === 3 && !!s12?.starDomFollowsDb,
      // 详情页心心：DB 与 DOM 都必须翻转（只测 DB 会漏掉「没反应」这类 UI 层 bug）
      detailHeart: !!s12?.heartDbToggled && !!s12?.heartDomToggled,
      // 服务层直调同样不留孤儿行、不留回收站
      serviceHardDelete: hd?.rowGone === true && hd?.fileGone === true && hd.trashDirCreated === false
    }
    R.ok = Object.values(R.checks as Record<string, boolean>).every(Boolean)
  } catch (e) {
    R.ok = false
    R.error = String((e as Error).stack ?? e)
  } finally {
    R.jsErrors = jsErrors
    if (jsErrors.length) R.rendererLogs = rendererLogs.filter((l) => /error|Error|warn|Warn/.test(l)).slice(-8)
    try {
      if (libPath && existsSync(join(libPath, '.stash'))) deleteLibrary(libPath)
    } catch (e) {
      R.cleanupError = String(e)
    }
    closeCurrent()
    if (dir) rmSync(dir, { recursive: true, force: true })
    console.log('[SMOKE-M4] ' + JSON.stringify(R))
    app.exit(0)
  }
}
