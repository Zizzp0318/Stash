// 标签冒烟：添加 / 从素材上摘掉 / 删除标签本体 / 关联级联清空 / 筛选重置
//
// 缘起：用户报「标签只能添加，不能删除」。根因是 `tags` 表只有 `createTag` 没有删除入口，
// 侧栏标签行也没有任何管理操作。这里覆盖两层语义，别混：
//   - 详情页点标签 chip = 从**这个素材**上摘掉（标签本体还在，其它素材照旧）→ `asset.setTags`
//   - 侧栏标签行右键 → 删除标签 = 删掉**标签本体**（所有素材一并解绑）→ `tag.remove`
//
// 断言全部同时核对**数据库**与**DOM**：本项目出过「DB 写成功、UI 不刷新」的假绿
// （store 把 camelCase 字段 assign 到 snake_case 行对象上），只查 DB 会漏。
import { app, BrowserWindow } from 'electron'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { closeCurrent, createLibrary, deleteLibrary, requireCurrent } from './library'
import { createTag, deleteTag, setTags } from './assets'
import { importFiles } from './importer'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
function onceLoaded(win: BrowserWindow): Promise<void> {
  return new Promise((resolve) => win.webContents.once('did-finish-load', () => resolve()))
}

/** [文件名, 边长] —— 尺寸不同，避免瀑布流把卡片叠在一起导致点错 */
const IMAGES: Array<[string, number]> = [
  ['红.png', 40],
  ['蓝.png', 60],
  ['绿.png', 80]
]

export async function runSmokeTag(win: BrowserWindow): Promise<void> {
  const R: Record<string, unknown> = {}
  const jsErrors: Array<{ code: string; error: string }> = []
  const rendererLogs: string[] = []
  win.webContents.on('console-message', (_e, _lvl, message) => {
    rendererLogs.push(message.slice(0, 300))
    if (rendererLogs.length > 40) rendererLogs.shift()
  })
  const rawJs = (code: string): Promise<unknown> => win.webContents.executeJavaScript(code)
  /** 单个脚本失败不中断整条链路，记下出错脚本继续跑 */
  const js = async (code: string): Promise<unknown> => {
    try {
      return await rawJs(code)
    } catch (e) {
      jsErrors.push({ code: code.replace(/\s+/g, ' ').slice(0, 160), error: String(e).slice(0, 160) })
      return null
    }
  }

  let dir: string | null = null
  let libPath = ''
  /** 每次取实时手柄：渲染层 bootstrap() 会重新 openLibrary，缓存下来的旧 db 会变成 not open */
  const D = (): ReturnType<typeof requireCurrent>['db'] => requireCurrent().db
  const step = (s: string): void => console.log('[SMOKE-TAG-STEP] ' + s)

  // ==================== 数据层助手 ====================
  const tagRows = (): Array<{ id: number; name: string }> =>
    D().prepare('SELECT id, name FROM tags ORDER BY name').all() as never
  const tagIdOf = (name: string): number | null => tagRows().find((t) => t.name === name)?.id ?? null
  const assetIdOf = (name: string): number =>
    (D().prepare('SELECT id FROM assets WHERE name=?').get(name) as { id: number } | undefined)?.id ?? -1

  /** asset_tags 关联，形如 `蓝.png→风景`（两侧都取名字，比 id 更能看出问题） */
  const links = (): string[] =>
    (
      D()
        .prepare(
          `SELECT a.name AS asset, t.name AS tag FROM asset_tags at
             JOIN assets a ON a.id = at.asset_id
             JOIN tags   t ON t.id = at.tag_id
           ORDER BY a.name, t.name`
        )
        .all() as Array<{ asset: string; tag: string }>
    ).map((r) => `${r.asset}→${r.tag}`)

  /**
   * 孤儿关联：指向已不存在的 tag_id 的行。
   * `PRAGMA foreign_keys` 被关掉时 CASCADE 不生效，删标签会留下这种脏数据
   * （表现为侧栏计数为 0、素材详情却还挂着空标签）。
   */
  const orphans = (): number =>
    (
      D()
        .prepare('SELECT count(*) AS c FROM asset_tags at LEFT JOIN tags t ON t.id = at.tag_id WHERE t.id IS NULL')
        .get() as { c: number }
    ).c

  // ==================== DOM 助手 ====================
  const click = (x: number, y: number): void => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) })
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
  }
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
  /** 把鼠标挪开：避免 :hover 样式污染「可见性」类断言 */
  const moveAway = (): void => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: 4 })
  }

  /** 详情面板里的标签 chip（`data-tag-id` 缺省的是「＋」按钮，不是真标签；名字要去掉常驻的 ×） */
  const detailChips = async (): Promise<string[]> =>
    JSON.parse(
      ((await js(`JSON.stringify([...document.querySelectorAll('.detail .tag-chips .tag-chip[data-tag-id]')]
        .map(e => e.textContent.replace('×', '').trim()))`)) as string | null) ?? '[]'
    ) as string[]

  const detailHint = async (): Promise<string | null> =>
    (await js(`document.querySelector('.detail .tag-chips .d-hint')?.textContent.trim() ?? null`)) as string | null

  const sidebarTags = async (): Promise<Array<{ id: number; name: string; count: number }>> =>
    JSON.parse(
      ((await js(`JSON.stringify([...document.querySelectorAll('.side-item[data-tag-id]')].map(e => {
        const n = (e.querySelector('.n')?.textContent ?? '0').trim()
        return { id: +e.dataset.tagId, name: e.textContent.replace(n, '').trim(), count: +n }
      }))`)) as string | null) ?? '[]'
    ) as Array<{ id: number; name: string; count: number }>

  /**
   * 集合相等（忽略顺序）。
   * 中文在 SQLite 的默认 BINARY collation 下按 UTF-8 字节排，手写期望值时极易写错顺序 ——
   * 一律用它比较，不直接 join 后对字符串。
   */
  const sameSet = (got: string[] | undefined, want: string[]): boolean =>
    (got?.length ?? -1) === want.length && (got ?? []).slice().sort().join('|') === want.slice().sort().join('|')

  /** 侧栏标签行「名 → 计数」的紧凑表示，便于断言 */
  const sideMap = async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {}
    for (const t of await sidebarTags()) out[t.name] = t.count
    return out
  }

  const cardNames = async (): Promise<string[]> =>
    ((await js(`[...document.querySelectorAll('.masonry-card')].map(c => c.querySelector('.ci-name')?.textContent ?? '')`)) as
      | string[]
      | null) ?? []

  const noticeText = async (): Promise<string | null> =>
    (await js(`document.querySelector('.notice-toast')?.textContent.trim() ?? null`)) as string | null

  /** 在输入框里用真实输入管线打字并回车（v-model 才收得到） */
  const typeAndEnter = async (sel: string, text: string): Promise<void> => {
    await js(`(() => { const i = ${sel}; if (i) { i.focus(); i.select && i.select() } })()`)
    await sleep(120)
    win.webContents.insertText(text)
    await sleep(180)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await sleep(800)
  }

  /** 右键第 idx 个侧栏标签行；优先真实右键，失败退回 dispatchEvent */
  const openTagCtx = async (idx: number): Promise<string> => {
    const pt = await elPoint('.side-item[data-tag-id]', idx)
    if (!pt) return 'ROW_NOT_FOUND'
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(pt.x), y: Math.round(pt.y) })
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(pt.x), y: Math.round(pt.y), button: 'right', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(pt.x), y: Math.round(pt.y), button: 'right', clickCount: 1 })
    await sleep(320)
    if (await js(`!!document.querySelector('.tag-ctx')`)) return 'real'
    await js(`(() => {
      const el = document.querySelectorAll('.side-item[data-tag-id]')[${idx}]
      if (!el) return false
      const r = el.getBoundingClientRect()
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + r.height / 2 }))
      return true
    })()`)
    await sleep(320)
    return (await js(`!!document.querySelector('.tag-ctx')`)) ? 'dispatch' : 'FAILED'
  }
  const clickCtxItem = async (label: string): Promise<boolean> =>
    ((await js(`(() => {
      const b = [...document.querySelectorAll('.tag-ctx .ctx-item')].find(x => x.textContent.trim() === ${JSON.stringify(label)})
      if (!b) return false
      b.click(); return true
    })()`)) as boolean | null) ?? false
  /** 删除标签的确认弹窗（此时页面上只有这一个 modal） */
  const modalInfo = async (): Promise<{ title: string | null; text: string | null } | null> => {
    const s = (await js(`(() => {
      const m = document.querySelector('.modal-mask .modal')
      if (!m) return 'null'
      return JSON.stringify({
        title: m.querySelector('.modal-title')?.textContent.trim() ?? null,
        text: m.querySelector('.modal-text')?.textContent.replace(/\\s+/g, ' ').trim() ?? null
      })
    })()`)) as string | null
    return s && s !== 'null' ? (JSON.parse(s) as { title: string | null; text: string | null }) : null
  }
  const clickModalBtn = async (label: string): Promise<boolean> =>
    ((await js(`(() => {
      const b = [...document.querySelectorAll('.modal-mask .modal-foot .w-btn')].find(x => x.textContent.trim() === ${JSON.stringify(label)})
      if (!b) return false
      b.click(); return true
    })()`)) as boolean | null) ?? false

  const capture = async (name: string): Promise<void> => {
    try {
      const img = await win.webContents.capturePage()
      writeFileSync(join(process.cwd(), name), img.toPNG())
    } catch (e) {
      R.shotError = String((e as Error).message ?? e)
    }
  }

  try {
    await sleep(1200)
    dir = mkdtempSync(join(tmpdir(), 'stash-smoke-tag-'))
    libPath = createLibrary({ name: 'taglib', parentDir: dir }).path

    // ==================== A. 准备：3 素材 / 2 标签 / 4 条关联 ====================
    step('A-准备')
    const srcFiles: string[] = []
    for (const [name, size] of IMAGES) {
      const p = join(dir, name)
      await sharp({ create: { width: size, height: size, channels: 3, background: { r: 90, g: 130, b: 170 } } })
        .png()
        .toFile(p)
      srcFiles.push(p)
    }
    const imported = await new Promise<{ added: number }>((resolve) =>
      importFiles({ paths: srcFiles, folderId: null, mode: 'copy', onDone: (x) => resolve(x) })
    )
    // 红：风景  蓝：风景+天空  绿：天空  → 风景 2 个、天空 2 个、共 4 条关联
    const tScenery = createTag({ name: '风景' })
    const tSky = createTag({ name: '天空' })
    setTags(assetIdOf('红.png'), [tScenery.id])
    setTags(assetIdOf('蓝.png'), [tScenery.id, tSky.id])
    setTags(assetIdOf('绿.png'), [tSky.id])
    R.a_setup = {
      added: imported.added,
      tags: tagRows().map((t) => t.name),
      links: links(),
      orphans: orphans()
    }

    // ==================== H. UI 段：真实鼠标驱动 ====================
    step('H-UI')
    await rawJs(`window.stash.library.open(${JSON.stringify(libPath)}).then(() => location.reload())`)
    await onceLoaded(win)
    await sleep(2600)

    // H0 侧栏标签区两行、计数各 2
    R.h0_sidebar = await sideMap()

    // H1 选中「蓝.png」（挂着两个标签）→ 详情页应有 2 个标签 chip
    const idBlue = assetIdOf('蓝.png')
    await clickEl(`.masonry-card[data-id="${idBlue}"]`)
    await sleep(700)
    moveAway()
    await sleep(150)
    R.h1_detailBefore = { chips: await detailChips(), hint: await detailHint() }
    await capture('shot-tag-detail.png')

    // H2 点「天空」chip → 只从这张素材上摘掉，标签本体必须还在
    await clickEl(`.detail .tag-chips .tag-chip[data-tag-id="${tSky.id}"]`)
    await sleep(900)
    moveAway()
    await sleep(150)
    R.h2_removeOne = {
      chips: await detailChips(),
      db: links(),
      sidebar: await sideMap(),
      tagStillExists: tagIdOf('天空') != null
    }
    await capture('shot-tag-removed.png')

    // H3 再把「风景」也摘掉 → 详情页回到「暂无标签」
    await clickEl(`.detail .tag-chips .tag-chip[data-tag-id="${tScenery.id}"]`)
    await sleep(900)
    moveAway()
    await sleep(150)
    R.h3_removeAll = {
      chips: await detailChips(),
      hint: await detailHint(),
      db: links(),
      sidebar: await sideMap()
    }

    // H4 在详情页新建并挂上「水」→ 覆盖「添加」这条路径没被改坏
    await clickEl('.detail .tag-chips .tag-add')
    await sleep(300)
    R.h4_inputShown = await js(`!!document.querySelector('.detail .inline-form input')`)
    await typeAndEnter(`document.querySelector('.detail .inline-form input')`, '水')
    moveAway()
    await sleep(200)
    R.h4_add = { chips: await detailChips(), db: links(), sidebar: await sideMap() }

    // H5 侧栏右键「水」→ 删除标签（删本体，不是摘链接）
    const idxWater = (await sidebarTags()).findIndex((t) => t.name === '水')
    R.h5_targetIndex = idxWater
    R.h5_ctxMode = await openTagCtx(idxWater)
    R.h5_menuItems = await js(`[...document.querySelectorAll('.tag-ctx .ctx-item')].map(x => x.textContent.trim())`)
    await capture('shot-tag-menu.png')
    R.h5_clicked = await clickCtxItem('删除标签')
    await sleep(400)
    R.h5_modal = await modalInfo()
    await capture('shot-tag-confirm.png')
    R.h5_confirmClicked = await clickModalBtn('删除')
    await sleep(1000)
    moveAway()
    await sleep(150)
    R.h5_deleted = {
      tagGone: tagIdOf('水') == null,
      modalGone: !(await js(`!!document.querySelector('.modal-mask')`)),
      db: links(),
      orphans: orphans(),
      sidebar: await sideMap(),
      chips: await detailChips(),
      notice: await noticeText()
    }
    await capture('shot-tag-deleted.png')

    // H6 先按「天空」筛选，再把这个标签删掉 → 筛选必须重置回「所有素材」
    await clickEl(`.side-item[data-tag-id="${tSky.id}"]`)
    await sleep(800)
    R.h6_filtered = { cards: await cardNames(), sidebar: await sideMap() }
    const idxSky = (await sidebarTags()).findIndex((t) => t.id === tSky.id)
    R.h6_ctxMode = await openTagCtx(idxSky)
    R.h6_clicked = await clickCtxItem('删除标签')
    await sleep(400)
    R.h6_confirmClicked = await clickModalBtn('删除')
    await sleep(1000)
    R.h6_afterDelete = {
      cards: await cardNames(),
      tagGone: tagIdOf('天空') == null,
      sidebar: await sideMap(),
      db: links(),
      orphans: orphans()
    }

    // ==================== F. 服务层负例 ====================
    step('F-负例')
    const nah = (fn: () => unknown): string => {
      try {
        fn()
        return 'NO_ERROR'
      } catch (e) {
        return String((e as Error).message ?? e)
      }
    }
    R.f_negative = {
      // 删不存在的标签必须明确报错，不能静默成功
      missing: nah(() => deleteTag(99999)),
      // 刚删掉的也不能再删（证明是「行真的没了」而不是「一直假装成功」）
      alreadyDeleted: nah(() => deleteTag(tSky.id)),
      finalTags: tagRows().map((t) => t.name),
      finalLinks: links(),
      finalOrphans: orphans()
    }

    await capture('shot-tag-done.png')

    // ==================== 断言汇总 ====================
    const a = R.a_setup as { added: number; tags: string[]; links: string[]; orphans: number }
    const h0 = R.h0_sidebar as Record<string, number>
    const h1 = R.h1_detailBefore as { chips: string[]; hint: string | null }
    const h2 = R.h2_removeOne as { chips: string[]; db: string[]; sidebar: Record<string, number>; tagStillExists: boolean }
    const h3 = R.h3_removeAll as { chips: string[]; hint: string | null; db: string[]; sidebar: Record<string, number> }
    const h4 = R.h4_add as { chips: string[]; db: string[]; sidebar: Record<string, number> }
    const h5m = R.h5_modal as { title: string | null; text: string | null } | null
    const h5 = R.h5_deleted as {
      tagGone: boolean; modalGone: boolean; db: string[]; orphans: number
      sidebar: Record<string, number>; chips: string[]; notice: string | null
    }
    const h6f = R.h6_filtered as { cards: string[]; sidebar: Record<string, number> }
    const h6 = R.h6_afterDelete as {
      cards: string[]; tagGone: boolean; sidebar: Record<string, number>; db: string[]; orphans: number
    }
    const f = R.f_negative as {
      missing: string; alreadyDeleted: string; finalTags: string[]; finalLinks: string[]; finalOrphans: number
    }

    R.checks = {
      // A 素材与标签就位
      setupImported: a?.added === 3,
      setupTags: a?.tags?.join('|') === '天空|风景',
      setupLinks: sameSet(a?.links, ['红.png→风景', '绿.png→天空', '蓝.png→天空', '蓝.png→风景']),
      setupNoOrphans: a?.orphans === 0,

      // H0 侧栏：两个标签各挂 2 个素材
      sidebarCounts: h0?.['风景'] === 2 && h0?.['天空'] === 2,

      // H1 详情页把该素材的两个标签都列出来
      detailListsBothTags: h1?.chips?.length === 2 &&
        h1.chips.includes('风景') && h1.chips.includes('天空') && h1.hint === null,

      // H2 从素材摘掉「天空」：DB、DOM、侧栏计数三处都要动，且标签本体还在
      removeOneUpdatesDb: sameSet(h2?.db, ['红.png→风景', '绿.png→天空', '蓝.png→风景']),
      removeOneUpdatesDom: h2?.chips?.length === 1 && h2.chips[0] === '风景',
      removeOneUpdatesSidebar: h2?.sidebar?.['天空'] === 1 && h2?.sidebar?.['风景'] === 2,
      // 摘链接 ≠ 删标签，本体必须留着
      removeKeepsTagItself: h2?.tagStillExists === true,

      // H3 摘光后详情页出现「暂无标签」，DB 里这张素材不再有任何关联
      removeAllClearsDb: sameSet(h3?.db, ['红.png→风景', '绿.png→天空']),
      removeAllShowsHint: h3?.chips?.length === 0 && h3?.hint === '暂无标签',
      removeAllUpdatesSidebar: h3?.sidebar?.['风景'] === 1 && h3?.sidebar?.['天空'] === 1,

      // H4 添加路径正常：新标签建出来、挂上去、三处同步
      addCreatesAndLinks: sameSet(h4?.db, ['红.png→风景', '绿.png→天空', '蓝.png→水']),
      addShowsChip: h4?.chips?.join('|') === '水',
      addShowsInSidebar: h4?.sidebar?.['水'] === 1,

      // H5 侧栏右键删除标签本体
      tagMenuOpened: R.h5_ctxMode === 'real' || R.h5_ctxMode === 'dispatch',
      tagMenuItems: (R.h5_menuItems as string[])?.join('|') === '删除标签',
      tagMenuHitCorrectRow: (R.h5_targetIndex as number) >= 0,
      confirmShowsImpact: h5m?.title?.includes('水') === true && /1 个素材/.test(h5m?.text ?? ''),
      confirmSaysFilesSafe: /不受影响/.test(h5m?.text ?? ''),
      deleteRemovesTagRow: h5?.tagGone === true,
      deleteClearsLinks: sameSet(h5?.db, ['红.png→风景', '绿.png→天空']),
      deleteLeavesNoOrphans: h5?.orphans === 0,
      deleteClosesModal: h5?.modalGone === true,
      deleteRemovesSidebarRow: h5?.sidebar?.['水'] === undefined && h5?.sidebar?.['风景'] === 1,
      // 详情页正开着这张素材，chip 必须跟着消失（否则就是「删了但界面还留着」）
      deleteRemovesDetailChip: h5?.chips?.length === 0,
      deleteNotifies: /已删除标签「水」/.test(h5?.notice ?? ''),

      // H6 正筛着的标签被删 → 筛选重置，列表回到全部
      filterApplies: h6f?.cards?.length === 1 && h6f.cards[0] === '绿.png',
      filterResetsAfterDelete: h6?.cards?.length === 3,
      filterResetClearsTag: h6?.tagGone === true && h6?.sidebar?.['天空'] === undefined,
      filterResetKeepsOther: sameSet(h6?.db, ['红.png→风景']),
      filterResetNoOrphans: h6?.orphans === 0,

      // F 负例：不存在 / 已删除的标签都要明确报错
      missingTagThrows: f?.missing === 'ERR_TAG_NOT_FOUND',
      deletedTagThrows: f?.alreadyDeleted === 'ERR_TAG_NOT_FOUND',
      finalStateClean: f?.finalTags?.join('|') === '风景' && sameSet(f?.finalLinks, ['红.png→风景']) &&
        f?.finalOrphans === 0,

      // 渲染层不应有 JS 报错
      noJsErrors: jsErrors.length === 0
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
    console.log('[SMOKE-TAG] ' + JSON.stringify(R))
    app.exit(0)
  }
}
