// 标签冒烟：添加 / 从素材上摘掉 / 删除标签本体 / 关联级联清空 / 筛选重置 / **归零自删** / **最近标签快捷区**
//
// 缘起：用户报「标签只能添加，不能删除」。根因是 `tags` 表只有 `createTag` 没有删除入口，
// 侧栏标签行也没有任何管理操作。这里覆盖两层语义，别混：
//   - 详情页点标签 chip = 从**这个素材**上摘掉（标签本体还在，其它素材照旧）→ `asset.setTags`
//   - 侧栏标签行右键 → 删除标签 = 删掉**标签本体**（所有素材一并解绑）→ `tag.remove`
//
// 后来又报了第二条：「详情页把标签都摘掉后，侧栏那个标签还在，数字显示 0」。
// 于是补了自动清理（`pruneUnlinkedTags`）：标签一个素材都不挂就失去意义，各条会减少
// 标签关联的路径收尾都要清掉它。H7 覆盖「摘标签」入口，H8 覆盖「删素材」入口。
//
// H9 覆盖「点 ＋ 后输入框下方的最近添加标签（4 列）」。两条经验写在这里，别重复踩：
//   - 快捷区按钮必须 `@mousedown.prevent`：输入框有 `@blur="addTag"`，不拦 mousedown 的话
//     点击会先 blur → `addingTag=false` → v-if 把表单整个摘掉 → click 落在已卸载的节点上，静默失败；
//   - 「4 列」是栅格行为，只能靠格子左上角坐标去重计数来断言（内容断言 3 列/5 列都能过）。
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

  /** 标签 id 从新到旧（`tags.id` 是自增主键 = 创建先后），用来核对「最近添加的标签」的顺序 */
  const tagIdsDesc = (): number[] =>
    (D().prepare('SELECT id FROM tags ORDER BY id DESC').all() as Array<{ id: number }>).map((r) => r.id)

  /** 某个素材当前挂着的 tag_id */
  const attachedTagIds = (assetId: number): number[] =>
    (D().prepare('SELECT tag_id FROM asset_tags WHERE asset_id=?').all(assetId) as Array<{ tag_id: number }>).map(
      (r) => r.tag_id
    )

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

  /**
   * 「最近添加的标签」快捷区快照。
   * 除了内容（ids/names），还要采**几何**：用户要求的是「4 列」，
   * 而 `repeat(4, ...)` 写成 3 列 / 5 列在内容断言下完全看不出来，只能靠左下角坐标去重计数。
   */
  interface RecentSnap {
    present: boolean
    ids: number[]
    names: string[]
    cols: number
    rows: number
    widths: number[]
    gridW: number
    inputW: number
    gridLeft: number
    chipsLeft: number
    cellBg: string | null
    chipBg: string | null
    hint: string | null
    inputShown: boolean
    ellipsized: string[]
  }
  const recentSnap = async (): Promise<RecentSnap> =>
    JSON.parse(
      ((await js(`(() => {
        const g = document.querySelector('.detail .recent-tags')
        const gi = document.querySelector('.detail .inline-form input')
        const gc = document.querySelector('.detail .tag-chips')
        const items = g ? [...g.querySelectorAll('.recent-tag')] : []
        const boxes = items.map(e => {
          const r = e.getBoundingClientRect()
          const n = e.querySelector('.recent-tag-name')
          return {
            id: +e.dataset.recentTagId,
            l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width),
            name: n ? n.textContent : '',
            full: n ? n.scrollWidth <= n.clientWidth + 1 : true
          }
        })
        return JSON.stringify({
          present: !!g,
          ids: boxes.map(b => b.id),
          names: boxes.map(b => b.name),
          cols: [...new Set(boxes.map(b => b.l))].length,
          rows: [...new Set(boxes.map(b => b.t))].length,
          widths: [...new Set(boxes.map(b => b.w))],
          gridW: g ? Math.round(g.getBoundingClientRect().width) : 0,
          inputW: gi ? Math.round(gi.getBoundingClientRect().width) : 0,
          gridLeft: g ? Math.round(g.getBoundingClientRect().left) : -1,
          chipsLeft: gc ? Math.round(gc.getBoundingClientRect().left) : -2,
          // 快捷区用「标签色淡底」代替色点：与上方 tag-chip 的底色（--bg-raised）一比就知道有没有生效
          cellBg: items.length ? getComputedStyle(items[0]).backgroundColor : null,
          chipBg: (() => { const c = document.querySelector('.detail .tag-chips .tag-chip[data-tag-id]'); return c ? getComputedStyle(c).backgroundColor : null })(),
          hint: g ? (g.querySelector('.recent-empty')?.textContent.trim() ?? null) : null,
          inputShown: !!gi,
          ellipsized: boxes.filter(b => !b.full).map(b => b.name)
        })
      })()`)) as string | null) ?? '{}'
    ) as RecentSnap

  /** 点快捷区第 idx 个标签（真实鼠标；输入框会 blur，靠 @mousedown.prevent 兜住） */
  const clickRecent = async (idx: number): Promise<boolean> => clickEl('.detail .recent-tags .recent-tag', idx)

  /**
   * 侧栏标签行。
   * 名字必须从**计数那一段之前**截断：早先用 `replace(n,'')` 是从名字里第一个匹配处切，
   * 一旦标签名自己带数字（「标签10」+ 计数 0 → textContent「标签10 0」）就会被切坏，
   * 断言随即假绿。计数永远是最后一段，所以用 lastIndexOf 找它的起点。
   */
  const sidebarTags = async (): Promise<Array<{ id: number; name: string; count: number }>> =>
    JSON.parse(
      ((await js(`JSON.stringify([...document.querySelectorAll('.side-item[data-tag-id]')].map(e => {
        const n = (e.querySelector('.n')?.textContent ?? '0').trim()
        const raw = e.textContent
        const cut = raw.lastIndexOf(n)
        return { id: +e.dataset.tagId, name: (cut >= 0 ? raw.slice(0, cut) : raw).trim(), count: +n }
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

    // ==================== H7. 标签归零 → 自动删除（含筛选重置）====================
    //
    // 缘起：用户报「详情页把素材上的标签都摘掉后，侧栏那个标签还在，数字显示 0」。
    // 标签的全部意义就是给素材分类，挂 0 个素材的标签没有任何信息量 —— 必须自删。
    // 这段同时覆盖两个点：
    //   ① 标签本体从 tags 表消失（侧栏行跟着消失）；
    //   ② 若当时正按它筛选，筛选要一起重置 —— 否则列表会卡在一个永远查不到东西的
    //      条件上，表现为「标签没了，列表也空了」。
    step('H7-归零自删')
    await clickEl(`.side-item[data-tag-id="${tScenery.id}"]`)
    await sleep(800)
    R.h7_filtered = { cards: await cardNames(), sidebar: await sideMap() }

    const idRed = assetIdOf('红.png')
    await clickEl(`.masonry-card[data-id="${idRed}"]`)
    await sleep(700)
    R.h7_detailBefore = { chips: await detailChips() }
    // 摘掉「风景」—— 它是这个标签仅剩的一个关联
    await clickEl(`.detail .tag-chips .tag-chip[data-tag-id="${tScenery.id}"]`)
    await sleep(1000)
    moveAway()
    await sleep(200)
    R.h7_after = {
      tagGone: tagIdOf('风景') == null,
      tags: tagRows().map((t) => t.name),
      links: links(),
      orphans: orphans(),
      sidebar: await sideMap(),
      // 用户报的是「显示 0」，所以直接断言：侧栏不该存在任何计数为 0 的标签行
      zeroRows: (await sidebarTags()).filter((t) => t.count === 0).map((t) => t.name),
      chips: await detailChips(),
      hint: await detailHint(),
      cards: await cardNames(),
      notice: await noticeText()
    }
    await capture('shot-tag-autoprune.png')

    // ==================== H8. 删素材导致标签归零 → 同样自动清理 ====================
    //
    // 与 H7 是同一条规则的另一条入口：删素材时 asset_tags 靠外键 CASCADE 一起消失，
    // 挂在它上面的标签也会归零。只在 setTags 里处理会漏掉这一条。
    step('H8-删素材归零')
    const tIsland = createTag({ name: '孤岛' })
    setTags(assetIdOf('绿.png'), [tIsland.id])
    // 刚才是服务层直接改的库，渲染层还不知道 —— 重新 bootstrap。
    // 先挂 did-finish-load 监听再触发 reload，否则可能与加载完成抢跑。
    const reloaded = onceLoaded(win)
    await rawJs(`location.reload()`)
    await reloaded
    await sleep(2600)
    R.h8_beforeDelete = {
      sidebar: await sideMap(),
      tags: tagRows().map((t) => t.name),
      links: links()
    }

    const idGreen = assetIdOf('绿.png')
    await clickEl(`.masonry-card[data-id="${idGreen}"]`)
    await sleep(700)
    moveAway()
    await sleep(150)
    // 选中卡片后详情页才展开，chip 要在这一步之后取（reload 会清掉选中状态）
    R.h8_detailBefore = { chips: await detailChips() }
    await clickEl('.batchbar .bb-btn.danger')
    await sleep(500)
    R.h8_modal = await modalInfo()
    await capture('shot-tag-delasset-confirm.png')
    R.h8_confirmClicked = await clickModalBtn('删除')
    await sleep(1400)
    moveAway()
    await sleep(200)
    R.h8_after = {
      tagGone: tagIdOf('孤岛') == null,
      tags: tagRows().map((t) => t.name),
      links: links(),
      orphans: orphans(),
      sidebar: await sideMap(),
      zeroRows: (await sidebarTags()).filter((t) => t.count === 0).map((t) => t.name),
      cards: await cardNames(),
      notice: await noticeText()
    }

    await capture('shot-tag-done.png')

    // ==================== H9. 「＋」下方的最近标签快捷区 ====================
    //
    // 需求：点添加标签的 ＋ 后，输入框下方显示最近添加的标签（4 列），点一下直接挂上。
    // 两个容易翻车的点各有断言盯着：
    //   ① 输入框带 `@blur="addTag"`：点按钮会先 blur → 表单被 v-if 摘掉 → click 落空。
    //      靠快捷区按钮上的 `@mousedown.prevent` 兜住（H9c/H9d 变红就是这里坏了）。
    //   ② 「4 列」是 CSS 栅格行为，内容断言完全看不出来（3 列/5 列都过），
    //      只能靠格子左上角坐标去重计数。
    step('H9-最近标签')
    // 此刻（H8 刚跑完）库里标签已被清空 —— 正好先验「一个标签都没有」那条提示
    const idRedCard = assetIdOf('红.png')
    await clickEl(`.masonry-card[data-id="${idRedCard}"]`)
    await sleep(700)
    await clickEl('.detail .tag-chips .tag-add')
    await sleep(400)
    R.h9_emptyState = await recentSnap()
    await capture('shot-tag-recent-empty.png')
    // 收起输入框，回到干净状态（后面还会 reload 重建整个 UI）
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await sleep(300)

    // 造 12 个标签（创建顺序 = id 顺序），把**最新的**「标签12」挂到红.png 上。
    // 必须挂最新的那个：挂最老的（标签01）它本来就排在 8 格窗口之外，
    // 「已挂标签要从快捷区排除」这条规则失效了也看不出来（注入验证踩过这个坑）。
    const tagNames12 = Array.from({ length: 12 }, (_, i) => `标签${String(i + 1).padStart(2, '0')}`)
    const tagIds12: Record<string, number> = {}
    for (const n of tagNames12) tagIds12[n] = createTag({ name: n }).id
    const idNewest = tagIds12['标签12']
    setTags(idRedCard, [idNewest])
    // 刚才是服务层直接改的库，渲染层还不知道 → 重新 bootstrap
    const reloadedH9 = onceLoaded(win)
    await rawJs(`location.reload()`)
    await reloadedH9
    await sleep(2600)
    R.h9_setup = {
      tagCount: tagRows().length,
      attached: attachedTagIds(idRedCard),
      sidebar: await sideMap()
    }

    /** 期望的快捷区内容：库里的标签按 id 倒序（= 添加时间倒序），去掉已挂上的，取前 n 个 */
    const expectRecent = (n: number): number[] =>
      tagIdsDesc()
        .filter((id) => !attachedTagIds(idRedCard).includes(id))
        .slice(0, n)

    await clickEl(`.masonry-card[data-id="${idRedCard}"]`)
    await sleep(700)
    await clickEl('.detail .tag-chips .tag-add')
    await sleep(400)
    // 先把鼠标挪开：参考用的 tag-chip 一旦被 hover 底色就变了，淡底断言会假绿
    moveAway()
    await sleep(150)
    R.h9_grid = await recentSnap()
    R.h9_gridExpect = expectRecent(8)
    // 已挂在这个素材上的标签不该出现在快捷区（上方 chip 已经有了）
    R.h9_excludesAttached = await js(
      `!document.querySelector('.detail .recent-tags .recent-tag[data-recent-tag-id="${idNewest}"]')`
    )
    await capture('shot-tag-recent.png')

    // H9c 点第一个格子（最新的那个）→ 挂上、输入框不被 blur 关掉、格子就地重排
    const pick1 = (R.h9_grid as RecentSnap).ids[0]
    R.h9_pick1Target = pick1
    R.h9_click1 = await clickRecent(0)
    await sleep(1100)
    moveAway()
    await sleep(150)
    const snap1 = await recentSnap()
    R.h9_afterPick1 = {
      snap: snap1,
      attached: attachedTagIds(idRedCard),
      chips: await detailChips(),
      sidebar: await sideMap(),
      expect: expectRecent(8),
      pickedName: tagRows().find((t) => t.id === pick1)?.name ?? null
    }
    await capture('shot-tag-recent-picked.png')

    // H9d 再点最后一个格子 → 「第一下点得动」不代表「重排后还点得动」
    const pick2 = snap1.ids[6]
    R.h9_pick2Target = pick2
    R.h9_click2 = await clickRecent(6)
    await sleep(1100)
    moveAway()
    await sleep(150)
    const snap2 = await recentSnap()
    R.h9_afterPick2 = {
      snap: snap2,
      attached: attachedTagIds(idRedCard),
      expect: expectRecent(8),
      pickedName: tagRows().find((t) => t.id === pick2)?.name ?? null
    }

    // H9e 12 个标签全挂到这张素材上 → 快捷区无标签可点，提示要换成「都已添加」
    setTags(idRedCard, Object.values(tagIds12))
    const reloadedH9e = onceLoaded(win)
    await rawJs(`location.reload()`)
    await reloadedH9e
    await sleep(2600)
    await clickEl(`.masonry-card[data-id="${idRedCard}"]`)
    await sleep(700)
    await clickEl('.detail .tag-chips .tag-add')
    await sleep(400)
    R.h9_allAttached = await recentSnap()
    await capture('shot-tag-recent-all.png')

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
    const h7f = R.h7_filtered as { cards: string[]; sidebar: Record<string, number> }
    const h7 = R.h7_after as {
      tagGone: boolean; tags: string[]; links: string[]; orphans: number
      sidebar: Record<string, number>; zeroRows: string[]
      chips: string[]; hint: string | null; cards: string[]; notice: string | null
    }
    const h8b = R.h8_beforeDelete as {
      sidebar: Record<string, number>; tags: string[]; links: string[]
    }
    const h8d = R.h8_detailBefore as { chips: string[] }
    const h8m = R.h8_modal as { title: string | null; text: string | null } | null
    const h8a = R.h8_after as {
      tagGone: boolean; tags: string[]; links: string[]; orphans: number
      sidebar: Record<string, number>; zeroRows: string[]
      cards: string[]; notice: string | null
    }
    const h9e0 = R.h9_emptyState as RecentSnap
    const h9s = R.h9_setup as { tagCount: number; attached: number[]; sidebar: Record<string, number> }
    const h9g = R.h9_grid as RecentSnap
    const h9gExp = R.h9_gridExpect as number[]
    const h9ex = R.h9_excludesAttached as boolean
    const h9p1t = R.h9_pick1Target as number
    const h9p1 = R.h9_afterPick1 as {
      snap: RecentSnap; attached: number[]; chips: string[]; sidebar: Record<string, number>
      expect: number[]; pickedName: string | null
    }
    const h9p2t = R.h9_pick2Target as number
    const h9p2 = R.h9_afterPick2 as {
      snap: RecentSnap; attached: number[]; expect: number[]; pickedName: string | null
    }
    const h9all = R.h9_allAttached as RecentSnap

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
      // 注意：这里是「H6 刚跑完」的快照，后面 H7/H8 还会继续删，别拿它当最终状态用
      finalStateClean: f?.finalTags?.join('|') === '风景' && sameSet(f?.finalLinks, ['红.png→风景']) &&
        f?.finalOrphans === 0,

      // H7 摘掉最后一个关联 → 标签自动删除
      // 先证明筛选真的生效过（列表只剩 1 项）：否则「最后回到 3 项」可能因为压根没筛选而假绿
      prunedTagFilterWasApplied: h7f?.cards?.length === 1 && h7f.cards[0] === '红.png',
      prunedTagRowIsGone: h7?.tagGone === true && (h7?.tags?.length ?? -1) === 0,
      prunedTagLinksCleared: (h7?.links?.length ?? -1) === 0 && h7?.orphans === 0,
      prunedTagRemovedFromSidebar: h7?.sidebar?.['风景'] === undefined &&
        Object.keys(h7?.sidebar ?? {}).length === 0,
      // 直击用户报的现象：侧栏不该存在任何计数为 0 的标签行
      prunedTagNoZeroRows: (h7?.zeroRows?.length ?? -1) === 0,
      prunedTagClearsDetailChips: h7?.chips?.length === 0 && h7?.hint === '暂无标签',
      // 筛选被重置回「所有素材」，列表恢复完整
      prunedTagResetsFilter: h7?.cards?.length === 3,
      prunedTagNotifies: /已无任何素材，已自动清除/.test(h7?.notice ?? ''),

      // H8 删素材导致标签归零 → 同一条规则的另一条入口
      // 同样先证明前置状态成立（标签在、挂在这张素材上、侧栏计数 1）
      deleteAssetSetupOk: h8b?.sidebar?.['孤岛'] === 1 && h8d?.chips?.join('|') === '孤岛' &&
        (h8b?.links?.length ?? -1) === 1,
      deleteAssetConfirmShowsImpact: (h8m?.title ?? '').includes('1 项素材'),
      deleteAssetPrunesTag: h8a?.tagGone === true && (h8a?.tags?.length ?? -1) === 0,
      deleteAssetClearsLinks: (h8a?.links?.length ?? -1) === 0 && h8a?.orphans === 0,
      deleteAssetNoZeroRows: Object.keys(h8a?.sidebar ?? {}).length === 0 && (h8a?.zeroRows?.length ?? -1) === 0,
      deleteAssetCardsRemain: h8a?.cards?.length === 2,
      deleteAssetNotifies: /已自动清除/.test(h8a?.notice ?? ''),

      // ==================== H9 「＋」下方的最近标签快捷区 ====================
      // ① 库里一个标签都没有：快捷区在，但没有格子，提示指向「新建」
      recentEmptyWhenNoTags: h9e0?.present === true && (h9e0?.ids?.length ?? -1) === 0 &&
        h9e0?.hint === '输入名称新建第一个标签' && h9e0?.inputShown === true,
      // ② 12 个标签、已挂 1 个 → 可加 11 个，取最新 8 个：正好 4 列 2 行
      recentSetupOk: h9s?.tagCount === 12 && (h9s?.attached?.length ?? -1) === 1 && h9s?.sidebar?.['标签12'] === 1,
      recentGridIsFourColumns: h9g?.cols === 4 && h9g?.rows === 2 && (h9g?.ids?.length ?? -1) === 8,
      recentGridCellsEqualWidth: (h9g?.widths?.length ?? 0) === 1 && (h9g?.widths?.[0] ?? 0) >= 45,
      // 淡底生效（用标签色替代色点）：底色必须不同于上方 tag-chip 的 --bg-raised
      recentGridCellsTinted: h9g?.cellBg != null && h9g?.chipBg != null && h9g.cellBg !== h9g.chipBg,
      // 与上方标签 chip 左对齐、且用满整个详情栏（比输入框宽）—— 挪回 .inline-form 会一起变红。
      // 196 而不是 206：详情栏有纵向滚动条，占掉约 10px
      recentGridAlignsWithChips: Math.abs((h9g?.gridLeft ?? -1) - (h9g?.chipsLeft ?? -2)) <= 1 &&
        (h9g?.gridW ?? 0) >= 190 && (h9g?.gridW ?? 0) > (h9g?.inputW ?? 0),
      // ③ 顺序与筛选：DOM 顺序 == DB 里「按添加时间倒序、去掉已挂的、截前 8」
      recentGridOrderMatchesDb: (h9g?.ids ?? []).join('|') === (h9gExp ?? []).join('|') && (h9gExp?.length ?? -1) === 8,
      recentGridExcludesAttached: h9ex === true,
      // ④ 点一个格子：挂上了、输入框没被 blur 关掉、该格消失且列表就地补位
      recentPickClickLanded: R.h9_click1 === true,
      recentPickAddsToDb: (h9p1?.attached?.length ?? -1) === 2 && h9p1?.attached?.includes(h9p1t) === true,
      recentPickAddsChip: h9p1?.chips?.includes(h9p1?.pickedName ?? '') === true,
      recentPickUpdatesSidebar: h9p1?.sidebar?.[h9p1?.pickedName ?? ''] === 1,
      // 关键：输入框还开着（blur 陷阱）；被点的格子从列表里消失，列表保持 8 个并补上新的一个
      recentPickKeepsInputOpen: h9p1?.snap?.inputShown === true,
      recentPickRefillsGrid: (h9p1?.snap?.ids ?? []).join('|') === (h9p1?.expect ?? []).join('|') &&
        h9p1?.snap?.ids?.includes(h9p1t) === false && (h9p1?.snap?.cols ?? 0) === 4,
      // ⑤ 重排之后再点一次：证明不是「只有第一次点得动」
      recentPick2ClickLanded: R.h9_click2 === true,
      recentPick2AddsToDb: (h9p2?.attached?.length ?? -1) === 3 && h9p2?.attached?.includes(h9p2t) === true,
      recentPick2KeepsInputOpen: h9p2?.snap?.inputShown === true &&
        (h9p2?.snap?.ids ?? []).join('|') === (h9p2?.expect ?? []).join('|') &&
        h9p2?.snap?.ids?.includes(h9p2t) === false,
      // ⑥ 12 个标签全挂上后：没有可加的标签了，提示换成「都已添加」
      recentAllAttachedHint: h9all?.present === true && (h9all?.ids?.length ?? -1) === 0 &&
        h9all?.hint === '近期标签都已添加' && h9all?.inputShown === true,

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
