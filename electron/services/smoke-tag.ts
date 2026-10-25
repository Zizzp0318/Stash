// 标签冒烟：添加 / 从素材上摘掉 / 删除标签本体 / 关联级联清空 / 筛选重置 / **归零自删** / **最近标签快捷区** / **批量打标**
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
// H9 覆盖「点 ＋ 后输入框下方的**悬浮**下拉（最近添加的 4 个标签，行尾带计数）」。三条经验写在这里，别重复踩：
//   - 下拉行必须 `@mousedown.prevent`：输入框有 `@blur="addTag"`，不拦 mousedown 的话
//     点击会先 blur → `addingTag=false` → v-if 把整个表单摘掉 → click 落在已卸载的节点上，静默失败；
//   - 下拉必须**脱离文档流**：用户明确要「悬浮，不是在页面上拓展」。断言不能只看
//     `getComputedStyle().position` —— 把下拉临时 `display:none` 再量下方评分区的 top，
//     两者相等才算真的没占位（改回 static/relative 立刻变红）；
//   - 「4 行」是布局行为，只能靠行 top 坐标去重计数来断言（内容断言 3 行/5 行都能过）。
//
// H10 覆盖**批量打标**（多选批量条的「标签」按钮 + 浮层 → `asset:bulk-tags` / `bulkUpdateTags`）。
// 与前 9 段最大的不同：那一层是**增量**语义，不是「整体替换」。三条最容易写错、也最容易假绿的：
//   - `attach` 只是 `INSERT OR IGNORE` 追加。若被写成复用 `setTags`（先 DELETE 再插），
//     每张素材原有的其他标签会被抹掉 —— 所以断言必须**同时**看「新标签挂上了」与「原标签还在」，
//     只看前者是测不出来的；
//   - `detach` 后标签归零要自动删除，但候选集是「原本真挂着、这次被摘掉」的标签，且**在 DELETE 之前取**。
//     拿请求参数当候选，会把「刚建好、还没挂过任何素材」的标签当场删掉（创建与挂载之间有窗口期）；
//   - 浮层是 `position:absolute`：打开它批量条高度 / `--bb-extra` / 网格底部留白三者都不得动，
//     否则底部让位与「回到顶部」浮标会整体漂移。
// 上述「追加不覆盖」与「候选集在 DELETE 前取」两条都做过注入验证（改坏实现 → 断言变红 → 改回）。
//
// 断言全部同时核对**数据库**与**DOM**：本项目出过「DB 写成功、UI 不刷新」的假绿
// （store 把 camelCase 字段 assign 到 snake_case 行对象上），只查 DB 会漏。
import { app, BrowserWindow } from 'electron'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { unwatchLibrary } from './watcher'
import { closeCurrent, createLibrary, forgetLibrary, requireCurrent } from './library'
import { createTag, deleteTag, setTags } from './assets'
import { importFiles } from './importer'
import { makeWaitUntil, type InputModifiers } from './smoke-util'

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
  /** 有界轮询（G4）：共享实现见 smoke-util.ts —— 超时返回 false，调用方必须把结果并入断言/诊断 */
  const waitUntil = makeWaitUntil(js)
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

  /** 某个素材当前挂着的标签名（批量打标要核对「原标签是否还在」，名字比 id 更直观） */
  const assetTagNames = (assetId: number): string[] =>
    (
      D()
        .prepare(
          `SELECT t.name AS name FROM asset_tags at JOIN tags t ON t.id = at.tag_id
            WHERE at.asset_id=? ORDER BY t.name`
        )
        .all(assetId) as Array<{ name: string }>
    ).map((r) => r.name)

  /** 某个标签当前挂着几个素材 */
  const tagLinkCount = (tagId: number): number =>
    (D().prepare('SELECT COUNT(*) AS c FROM asset_tags WHERE tag_id=?').get(tagId) as { c: number }).c

  /** 某个标签当前挂在哪些素材上（按素材名） */
  const tagAssetNames = (tagId: number): string[] =>
    (
      D()
        .prepare(
          `SELECT a.name AS name FROM asset_tags at JOIN assets a ON a.id = at.asset_id
            WHERE at.tag_id=? ORDER BY a.name`
        )
        .all(tagId) as Array<{ name: string }>
    ).map((r) => r.name)

  // ==================== DOM 助手 ====================
  const click = (x: number, y: number, mods: InputModifiers = []): void => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y), modifiers: mods })
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers: mods })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, modifiers: mods })
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
  /** 带修饰键的真实点击（Ctrl+点 = 多选追加）。坐标每次现取：详情面板展开会让瀑布流重排 */
  const clickElWith = async (selector: string, mods: InputModifiers, index = 0): Promise<boolean> => {
    const p = await elPoint(selector, index)
    if (!p) return false
    click(p.x, p.y, mods)
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
   * 「＋」下方标签下拉的快照。
   * 除了内容（ids/names/counts），还要采**几何**：
   *   - 「悬浮」= 不占文档流，靠 menuTop/inputBottom 与 display:none 前后比对（见断言段）；
   *   - 「4 行」只能靠行的 top 坐标去重数出来（内容断言 3 行/5 行都能过）。
   * 行尾计数取自 `.tag-menu-count`，断言时与 DB 的 asset_tags 逐一对账。
   */
  interface RecentSnap {
    present: boolean
    ids: number[]
    names: string[]
    counts: number[]
    rows: number
    menuW: number
    inputW: number
    menuLeft: number
    inputLeft: number
    menuTop: number
    inputBottom: number
    position: string | null
    hint: string | null
    inputShown: boolean
    ellipsized: string[]
  }
  const recentSnap = async (): Promise<RecentSnap> =>
    JSON.parse(
      ((await js(`(() => {
        const m = document.querySelector('.detail .tag-menu')
        const gi = document.querySelector('.detail .inline-form input')
        const rows = m ? [...m.querySelectorAll('.tag-menu-item')] : []
        const boxes = rows.map(e => {
          const r = e.getBoundingClientRect()
          const n = e.querySelector('.tag-menu-name')
          return {
            id: +e.dataset.tagOptionId,
            t: Math.round(r.top),
            name: n ? n.textContent : '',
            count: +(e.querySelector('.tag-menu-count')?.textContent ?? '0'),
            full: n ? n.scrollWidth <= n.clientWidth + 1 : true
          }
        })
        const mr = m ? m.getBoundingClientRect() : null
        const ir = gi ? gi.getBoundingClientRect() : null
        return JSON.stringify({
          present: !!m,
          ids: boxes.map(b => b.id),
          names: boxes.map(b => b.name),
          counts: boxes.map(b => b.count),
          rows: [...new Set(boxes.map(b => b.t))].length,
          menuW: mr ? Math.round(mr.width) : 0,
          inputW: ir ? Math.round(ir.width) : 0,
          menuLeft: mr ? Math.round(mr.left) : -1,
          inputLeft: ir ? Math.round(ir.left) : -2,
          menuTop: mr ? Math.round(mr.top) : -1,
          inputBottom: ir ? Math.round(ir.bottom) : -2,
          position: m ? getComputedStyle(m).position : null,
          hint: m ? (m.querySelector('.tag-menu-empty')?.textContent.trim() ?? null) : null,
          inputShown: !!gi,
          ellipsized: boxes.filter(b => !b.full).map(b => b.name)
        })
      })()`)) as string | null) ?? '{}'
    ) as RecentSnap

  /** 点下拉第 idx 行（真实鼠标；输入框会 blur，靠 @mousedown.prevent 兜住） */
  const clickRecent = async (idx: number): Promise<boolean> => clickEl('.detail .tag-menu-item', idx)

  /**
   * 底部批量条 + 「标签」浮层的联合快照。
   *
   * 一次求值同时采三组证据，避免分多次读导致「读条高时浮层还没开」这类错位：
   *   ① 条高 / `--bb-extra` / `.grid-wrap` 底部留白 —— 浮层是 `position:absolute`，
   *      打开它这三项必须分毫不动（改了 static/relative 就会把条子撑高、留白整体漂移）；
   *   ② 浮层几何 —— 是否真的浮在条子上方（不是把条子顶开）；
   *   ③ 每一行的三态（all/some/none）与行尾计数 —— 三态是「选中集合里挂了这个标签的个数」
   *      与 `selectedCount` 比出来的，只查 DB 看不出来。
   */
  interface BulkSnap {
    bar: boolean
    rows: number
    ids: number[]
    names: string[]
    counts: number[]
    states: string[]
    barH: number
    barTop: number
    panel: boolean
    panelPosition: string | null
    panelTop: number
    panelBottom: number
    extra: string | null
    padBottom: number
    countText: string | null
  }
  const bulkSnap = async (): Promise<BulkSnap> =>
    JSON.parse(
      ((await js(`(() => {
        const bar = document.querySelector('.batchbar')
        const panel = document.querySelector('[data-bb-tag-panel]')
        const gallery = document.querySelector('.gallery')
        const wrap = document.querySelector('.grid-wrap')
        const rows = panel ? [...panel.querySelectorAll('[data-bb-tag-option-id]')] : []
        const stateOf = (e) => {
          const s = e.querySelector('.bb-tag-state')
          if (!s) return ''
          return ['all', 'some', 'none'].find(x => s.classList.contains(x)) ?? ''
        }
        const br = bar ? bar.getBoundingClientRect() : null
        const pr = panel ? panel.getBoundingClientRect() : null
        return JSON.stringify({
          bar: !!bar,
          rows: rows.length,
          ids: rows.map(e => +e.dataset.bbTagOptionId),
          names: rows.map(e => e.querySelector('.tag-menu-name')?.textContent ?? ''),
          counts: rows.map(e => +(e.querySelector('.tag-menu-count')?.textContent ?? '0')),
          states: rows.map(stateOf),
          barH: br ? Math.round(br.height) : -1,
          barTop: br ? Math.round(br.top) : -1,
          panel: !!panel,
          panelPosition: panel ? getComputedStyle(panel).position : null,
          panelTop: pr ? Math.round(pr.top) : -1,
          panelBottom: pr ? Math.round(pr.bottom) : -1,
          extra: gallery ? getComputedStyle(gallery).getPropertyValue('--bb-extra').trim() : null,
          padBottom: wrap ? Math.round(parseFloat(getComputedStyle(wrap).paddingBottom)) : -1,
          countText: bar ? (bar.querySelector('.bb-count')?.textContent ?? '').replace(/\\s+/g, ' ').trim() : null
        })
      })()`)) as string | null) ?? '{}'
    ) as BulkSnap

  /** 浮层里某一行（按 tag id）的三态与行尾计数 */
  const rowOf = (s: BulkSnap, tagId: number): { state: string; count: number; name: string } | null => {
    const i = s.ids.indexOf(tagId)
    return i < 0 ? null : { state: s.states[i] ?? '', count: s.counts[i] ?? -1, name: s.names[i] ?? '' }
  }

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

    // ==================== H9. 「＋」下方的最近标签悬浮下拉 ====================
    //
    // 需求：点添加标签的 ＋ 后，**悬浮**显示最近添加的标签（4 行封顶、行尾带计数），点一下直接挂上。
    // 三个容易翻车的点各有断言盯着：
    //   ① 输入框带 `@blur="addTag"`：点行会先 blur → 表单被 v-if 摘掉 → click 落空。
    //      靠行上的 `@mousedown.prevent` 兜住（H9f/H9g 变红就是这里坏了）。
    //   ② 下拉必须脱离文档流（用户要的是「悬浮」不是「在页面上拓展」）：断言段用
    //      「临时 display:none 前后下方评分区 top 是否一致」来判定，改回 static/relative 会变红。
    //   ③ 「4 行」是布局行为，内容断言完全看不出来（3 行/5 行都过），只能靠行 top 坐标去重计数。
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
    // 必须挂最新的那个：挂最老的（标签01）它本来就排在 4 行窗口之外，
    // 「已挂标签要从下拉里排除」这条规则失效了也看不出来（注入验证踩过这个坑）。
    // 另外给蓝.png 挂上 标签11/10/09，让行尾计数出现 1/1/1/0 的梯度 ——
    // 全 0 的话「计数是真查出来的还是写死的」就分不清了。
    // （别用绿.png：它在 H8 里被当作「删素材」的靶子删掉了，再挂会撞外键。）
    const tagNames12 = Array.from({ length: 12 }, (_, i) => `标签${String(i + 1).padStart(2, '0')}`)
    const tagIds12: Record<string, number> = {}
    for (const n of tagNames12) tagIds12[n] = createTag({ name: n }).id
    const idNewest = tagIds12['标签12']
    setTags(idRedCard, [idNewest])
    setTags(assetIdOf('蓝.png'), [tagIds12['标签11'], tagIds12['标签10'], tagIds12['标签09']])
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

    /** 期望的下拉内容：库里的标签按 id 倒序（= 添加时间倒序），去掉已挂上的，取前 n 行 */
    const expectRecent = (n: number): number[] =>
      tagIdsDesc()
        .filter((id) => !attachedTagIds(idRedCard).includes(id))
        .slice(0, n)
    /** 输入框搜 q 时的期望：名字含 q、未挂在本素材上、4 行封顶 */
    const expectSearch = (q: string): number[] => {
      const attached = attachedTagIds(idRedCard)
      return tagIdsDesc()
        .filter((id) => !attached.includes(id))
        .filter((id) => (tagRows().find((t) => t.id === id)?.name ?? '').toLowerCase().includes(q))
        .slice(0, 4)
    }
    /** 行尾那个数字该是多少：直接查 DB，别拿 DOM 互相印证 */
    const dbTagCount = (id: number): number =>
      (D().prepare('SELECT COUNT(*) AS c FROM asset_tags WHERE tag_id = ?').get(id) as { c: number }).c

    await clickEl(`.masonry-card[data-id="${idRedCard}"]`)
    await sleep(700)
    await clickEl('.detail .tag-chips .tag-add')
    await sleep(400)
    moveAway()
    await sleep(150)
    R.h9_menu = await recentSnap()
    R.h9_menuExpect = expectRecent(4)
    R.h9_menuCounts = (R.h9_menuExpect as number[]).map(dbTagCount)
    // 已挂在这个素材上的标签不该出现在下拉里（上方 chip 已经有了）
    R.h9_excludesAttached = await js(
      `!document.querySelector('.detail .tag-menu-item[data-tag-option-id="${idNewest}"]')`
    )
    // 「悬浮」不是看 CSS 属性就完事：把下拉临时拿掉，下面评分区若原地不动才算真的没占位
    R.h9_float = await js(`(() => {
      const m = document.querySelector('.detail .tag-menu')
      const rr = document.querySelector('.detail .rate-row')
      if (!m || !rr) return null
      const withMenu = Math.round(rr.getBoundingClientRect().top)
      const old = m.style.display
      m.style.display = 'none'
      const withoutMenu = Math.round(rr.getBoundingClientRect().top)
      m.style.display = old
      return { withMenu, withoutMenu }
    })()`)
    await capture('shot-tag-recent.png')

    // H9b 在输入框里搜「1」→ 下拉换成匹配项
    //（名字含 1 的有 标签01/10/11/12，12 已挂在本素材上 → 剩 3 行，同样是最近的在前）
    const searchFocused = await js(`(() => {
      const i = document.querySelector('.detail .inline-form input')
      if (!i) return false
      i.focus()
      return true
    })()`)
    win.webContents.insertText('1')
    await sleep(400)
    moveAway()
    await sleep(150)
    R.h9_searchTyped = searchFocused === true
    R.h9_search = await recentSnap()
    R.h9_searchExpect = expectSearch('1')
    await capture('shot-tag-recent-search.png')
    // 退格清空 → 回到「最近 4 行」
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
    await sleep(400)
    R.h9_afterClear = await recentSnap()

    // H9f 点第一行（最新的那个）→ 挂上、输入框不被 blur 关掉、该行消失且列表就地补位
    const pick1 = (R.h9_menu as RecentSnap).ids[0]
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
      expect: expectRecent(4),
      pickedName: tagRows().find((t) => t.id === pick1)?.name ?? null
    }
    await capture('shot-tag-recent-picked.png')

    // H9g 重排之后再点最后一次 → 「第一下点得动」不代表「重排后还点得动」
    const pick2 = snap1.ids[3]
    R.h9_pick2Target = pick2
    R.h9_click2 = await clickRecent(3)
    await sleep(1100)
    moveAway()
    await sleep(150)
    const snap2 = await recentSnap()
    R.h9_afterPick2 = {
      snap: snap2,
      attached: attachedTagIds(idRedCard),
      expect: expectRecent(4),
      pickedName: tagRows().find((t) => t.id === pick2)?.name ?? null
    }

    // H9h 12 个标签全挂到这张素材上 → 下拉没有可加的了，提示要换成「都已添加」
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

    // ==================== H10. 批量打标：多选批量条上的「标签」浮层 ====================
    //
    // 入口是 `asset:bulk-tags`（服务层 `bulkUpdateTags`），UI 是批量条里的「标签」按钮 + 浮层。
    // 本段重点**证伪**工程师自述的三条语义，任何一条被写错都应该是红：
    //   ① attach 是 `INSERT OR IGNORE` **追加**，不是覆盖 —— 若偷偷复用 `setTags` 的整体替换，
    //      一张挂了 12 个标签的素材在批量挂 1 个新标签后会**只剩 1 个**（select 时必须同时断言「原标签还在」，
    //      只看「新标签挂上了」是测不出来的）；
    //   ② detach 后标签归零会自动删除，但候选集必须是「原本真挂着、这次被摘掉」的那些标签，
    //      且**在 DELETE 之前取** —— 拿请求参数当候选，会把「刚建好、还没挂过任何素材」的标签当场删掉；
    //   ③ 浮层 `position:absolute` 不进文档流：打开前后批量条高度、`--bb-extra`、网格底部留白三者都不得动
    //      （浮层一旦占位会把条子撑高，底部让位与「回到顶部」浮标整体漂移）。
    //
    // 另外顺手锁死几个「已经写进文档但不测就会飘」的点：错误码（ERR_ASSET_NOT_FOUND /
    // ERR_TAG_NOT_FOUND / ERR_INVALID_MODE）、`tag:create` 的 trim + ERR_EMPTY_NAME + ERR_TAG_EXISTS、
    // `asset:bulk-update` 仍然只认 rating/isFav（批量打标没被塞进那条通道）。
    step('H10-批量打标')

    // 再导入 3 张（尺寸各异，避免瀑布流叠在一起点错）——「多选 3 项挂同一标签」要有足够素材
    const bulkSrc: string[] = []
    const BULK_IMAGES: Array<[string, number]> = [
      ['甲.png', 100],
      ['乙.png', 130],
      ['丙.png', 160]
    ]
    for (const [name, size] of BULK_IMAGES) {
      const p = join(dir, name)
      await sharp({ create: { width: size, height: size, channels: 3, background: { r: 210, g: 120, b: 70 } } })
        .png()
        .toFile(p)
      bulkSrc.push(p)
    }
    const imp10 = await new Promise<{ added: number }>((resolve) =>
      importFiles({ paths: bulkSrc, folderId: null, mode: 'copy', onDone: (x) => resolve(x) })
    )

    // 三个标签各有分工，别混用：
    //   批量A  —— 待挂 → 再摘到归零 → 必须被自动清除（H10f）
    //   预挂P  —— 预先只挂在 甲.png 上 → 浮层三态里必须是「部分挂 some」
    //   未挂过 —— 建好后**一个素材都没挂** → 对它 detach 绝不能把它删掉（候选集语义的靶子）
    const tBulkA = createTag({ name: '批量A' })
    const tSome = createTag({ name: '预挂P' })
    const tFresh = createTag({ name: '未挂过' })
    setTags(assetIdOf('甲.png'), [tSome.id])

    const reloadedH10 = onceLoaded(win)
    await rawJs(`location.reload()`)
    await reloadedH10
    // 等「新导入的 3 张 + 原有 2 张」全部上卡并且标签行渲染出来，再开始点（不用固定 sleep）
    const h10Ready = await waitUntil(
      `document.querySelectorAll('.masonry-card').length >= 5 && !!document.querySelector('.side-item[data-tag-id="${tSome.id}"]')`,
      20000
    )
    const idJia = assetIdOf('甲.png')
    const idYi = assetIdOf('乙.png')
    const idBing = assetIdOf('丙.png')
    R.h10_setup = {
      ready: h10Ready,
      imported: imp10.added,
      cards: await cardNames(),
      tags: tagRows().map((t) => t.name),
      sidebar: await sideMap(),
      // 红.png 此刻挂着 H9h 那 12 个标签 —— 它就是「追加不覆盖」的靶子
      redTags: assetTagNames(idRedCard),
      // 前置：批量A 一个都没挂、预挂P 只挂 甲、未挂过 一个都没挂
      preAttach: { a: tagLinkCount(tBulkA.id), p: tagAssetNames(tSome.id), fresh: tagLinkCount(tFresh.id) }
    }

    // H10a 多选 3 项：红（原有 12 标签）+ 甲 + 乙
    await clickEl(`.masonry-card[data-id="${idRedCard}"]`)
    const selOne = await waitUntil(
      `document.querySelectorAll('.masonry-card.selected').length === 1 && !!document.querySelector('.detail')`,
      8000
    )
    const ctrlJia = await clickElWith(`.masonry-card[data-id="${idJia}"]`, ['control'])
    const selTwo = await waitUntil(`document.querySelectorAll('.masonry-card.selected').length === 2`, 8000)
    const ctrlYi = await clickElWith(`.masonry-card[data-id="${idYi}"]`, ['control'])
    const selThree = await waitUntil(`document.querySelectorAll('.masonry-card.selected').length === 3`, 8000)
    R.h10_select = {
      selOne,
      ctrlJia,
      selTwo,
      ctrlYi,
      selThree,
      selected: await js(`document.querySelectorAll('.masonry-card.selected').length`)
    }

    // H10b 浮层关闭时的批量条基线（条高 / --bb-extra / 网格底部留白）
    const barClosed = await bulkSnap()

    // H10c 点「标签」→ 浮层出现，且条子几何分毫不动
    const tagsBtnClicked = await clickEl('.batchbar [data-bb-tags]')
    const panelShown = await waitUntil(`!!document.querySelector('[data-bb-tag-panel]')`, 8000)
    const barOpen = await bulkSnap()
    R.h10_panel = { tagsBtnClicked, panelShown, barClosed, barOpen }
    // 按钮顺序：「标签」必须排在「喜欢」之后 —— `--smoke-m4` 的 h13 用 `.bb-btn` 索引 0 点「喜欢」，
    // 把「标签」插到前面会让那条几何断言点错按钮（点开浮层而不是切换喜欢）
    R.h10_btnOrder = await js(`[...document.querySelectorAll('.batchbar .bb-btn')].map(b => b.textContent.trim())`)
    await capture('shot-bulk-tag.png')

    // H10d 三态：批量A「都没挂」、预挂P「部分挂」、行尾计数等于 DB 里的全局挂载数
    const rowA0 = rowOf(barOpen, tBulkA.id)
    const rowP0 = rowOf(barOpen, tSome.id)
    const rowF0 = rowOf(barOpen, tFresh.id)
    R.h10_tristate = {
      rows: barOpen.rows,
      a: rowA0,
      p: rowP0,
      fresh: rowF0,
      // 行尾计数是 `counts.byTag`（全局挂载数），与 DB 逐一对账
      dbCountA: tagLinkCount(tBulkA.id),
      dbCountP: tagLinkCount(tSome.id),
      // 悬浮语义：浮层下沿贴住条子上沿（实测净空 0~12px），既不与条子重叠、也没把它顶开
      gapAboveBar: barOpen.barTop - barOpen.panelBottom
    }

    // H10e 挂上「批量A」：3 项各 +1 行关联、红.png 的原 12 个标签必须一个不少
    // 先用输入框把列表收到「批量」一行（下拉有 15+ 个标签、要滚动，按名字过滤比滚着点稳）
    await js(`(() => { const i = document.querySelector('[data-bb-tag-input]'); if (!i) return false; i.focus(); return true })()`)
    win.webContents.insertText('批量')
    const filteredA = await waitUntil(`document.querySelectorAll('[data-bb-tag-option-id]').length === 1`, 8000)
    const attachClicked = await clickEl(`[data-bb-tag-option-id="${tBulkA.id}"]`)
    // ⚠️ 提示文案按 `\s*` 写：`已为${n} 项…` 的模板里，数字前没有空格、后面有一个
    //（`已为3 项挂上标签`）。断言对齐的是「谁 + 几项 + 哪个标签」这个语义，
    // 不锁死标点/空格的排版细节 —— 那属于文案打磨，不该让冒烟红。
    const attachNoticeSeen = await waitUntil(
      `/已为\\s*3\\s*项挂上标签「批量A」/.test(document.querySelector('.notice-toast')?.textContent ?? '')`,
      10000
    )
    const afterAttach = await bulkSnap()
    R.h10_attach = {
      filteredA,
      attachClicked,
      attachNoticeSeen,
      notice: await noticeText(),
      linkCount: tagLinkCount(tBulkA.id),
      assets: tagAssetNames(tBulkA.id),
      // ① 追加不覆盖的核心证据：红.png 仍是 13 个标签（原 12 + 批量A）
      redTags: assetTagNames(idRedCard),
      // 同样重要的反面证据：没被选中的 蓝.png 一个字节都不该动
      blueTags: assetTagNames(assetIdOf('蓝.png')),
      sidebar: await sideMap(),
      row: rowOf(afterAttach, tBulkA.id),
      dbCount: tagLinkCount(tBulkA.id)
    }

    // H10f 再点同一行（三态已变 all）→ detach → 批量A 归零 → 自动清除 + 提示带「已自动清除」
    const detachClicked = await clickEl(`[data-bb-tag-option-id="${tBulkA.id}"]`)
    const pruneNoticeSeen = await waitUntil(
      `/已自动清除/.test(document.querySelector('.notice-toast')?.textContent ?? '')`,
      10000
    )
    const afterDetach = await bulkSnap()
    R.h10_detach = {
      detachClicked,
      pruneNoticeSeen,
      notice: await noticeText(),
      tagGone: tagIdOf('批量A') == null,
      tags: tagRows().map((t) => t.name),
      linkRows: links().filter((l) => l.endsWith('→批量A')).length,
      orphans: orphans(),
      sidebar: await sideMap(),
      zeroRows: (await sidebarTags()).filter((t) => t.count === 0).map((t) => t.name),
      // ② 反向证据：摘掉批量A 之后，红.png 必须回到原来那 12 个标签，一个不多一个不少
      //（若 detach 写成了「整体替换/清空」，这里会变成 0）
      redTags: assetTagNames(idRedCard),
      panelStillOpen: afterDetach.panel
    }
    await capture('shot-bulk-tag-pruned.png')

    // H10g Esc 只收浮层，不该把整批选中一起清掉（GalleryGrid 在 window 上有全局 Esc=取消多选）
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    const escClosedPanel = await waitUntil(`!document.querySelector('[data-bb-tag-panel]')`, 6000)
    R.h10_esc = {
      escClosedPanel,
      selectedAfterEsc: (await js(`document.querySelectorAll('.masonry-card.selected').length`)) as number | null,
      barStillThere: (await bulkSnap()).bar
    }

    // ==================== H10h. IPC 层负例与「候选集」语义（走真实 preload → IPC → 服务层）====================
    const idsJson = JSON.stringify([idRedCard, idJia, idYi])
    type IpcRes = { ok: boolean; data?: unknown; error?: string } | null
    const ipc = async (code: string): Promise<IpcRes> => (await js(code)) as IpcRes

    const attachPartial = await ipc(
      `window.stash.asset.bulkTags(${JSON.stringify([idJia, idYi])}, [${tSome.id}], 'attach')`
    )
    // 再挂一次完全相同的组合：INSERT OR IGNORE → 0 行变更，而不是报错/重复插入
    const attachAgain = await ipc(
      `window.stash.asset.bulkTags(${JSON.stringify([idJia, idYi])}, [${tSome.id}], 'attach')`
    )
    // ② 的核心靶子：detach 一个「建好后没挂过任何素材」的标签 → 关联 0 行、且**绝不能**把它清掉
    const detachUnlinked = await ipc(`window.stash.asset.bulkTags(${idsJson}, [${tFresh.id}], 'detach')`)
    R.h10_ipc = {
      attachPartial,
      attachAgain,
      detachUnlinked,
      pAfterAttach: tagAssetNames(tSome.id),
      pLinkCount: tagLinkCount(tSome.id),
      freshStillExists: tagIdOf('未挂过') != null,
      freshLinkCount: tagLinkCount(tFresh.id),
      orphans: orphans()
    }

    // H10i 错误码 + tag:create 硬化（纯 IPC，不碰界面）
    const assetMissing = await ipc(`window.stash.asset.bulkTags([999999], [${tSome.id}], 'attach')`)
    const tagMissing = await ipc(`window.stash.asset.bulkTags([${idRedCard}], [999999], 'attach')`)
    const badMode = await ipc(`window.stash.asset.bulkTags([${idRedCard}], [${tSome.id}], 'toggle')`)
    const emptyName = await ipc(`window.stash.tag.create({ name: '   ' })`)
    const paddedExisting = await ipc(`window.stash.tag.create({ name: ' 预挂P ' })`)
    const paddedNew = await ipc(`window.stash.tag.create({ name: '  新空格标签  ' })`)
    R.h10_errors = {
      assetMissing,
      tagMissing,
      badMode,
      emptyName,
      paddedExisting,
      paddedNew,
      tags: tagRows().map((t) => t.name)
    }

    // H10j `asset:bulk-update` 仍然只认 rating/isFav：塞进去的 tagIds 必须被完全忽略
    //（批量打标刻意走独立通道，没被塞进这条老接口 —— 否则「只改评分」会顺手改标签）
    const bingTagsBefore = assetTagNames(idBing)
    const bulkUpdateWithTags = await ipc(
      `window.stash.asset.bulkUpdate([${idBing}], { rating: 2, tagIds: [${tSome.id}] })`
    )
    R.h10_bulkUpdate = {
      res: bulkUpdateWithTags,
      ratingAfter:
        (D().prepare('SELECT rating FROM assets WHERE id=?').get(idBing) as { rating: number } | undefined)?.rating ?? -1,
      tagsBefore: bingTagsBefore,
      tagsAfter: assetTagNames(idBing),
      pLinkCountUnchanged: tagLinkCount(tSome.id)
    }

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
    const h9m = R.h9_menu as RecentSnap
    const h9mExp = R.h9_menuExpect as number[]
    const h9mCnt = R.h9_menuCounts as number[]
    const h9ex = R.h9_excludesAttached as boolean
    const h9flt = R.h9_float as { withMenu: number; withoutMenu: number } | null
    const h9st = R.h9_searchTyped as boolean
    const h9sr = R.h9_search as RecentSnap
    const h9srExp = R.h9_searchExpect as number[]
    const h9ac = R.h9_afterClear as RecentSnap
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
    const h10s = R.h10_setup as {
      ready: boolean; imported: number; cards: string[]; tags: string[]; sidebar: Record<string, number>
      redTags: string[]; preAttach: { a: number; p: string[]; fresh: number }
    }
    const h10sel = R.h10_select as {
      selOne: boolean; ctrlJia: boolean; selTwo: boolean; ctrlYi: boolean; selThree: boolean
      selected: number | null
    }
    const h10p = R.h10_panel as { tagsBtnClicked: boolean; panelShown: boolean; barClosed: BulkSnap; barOpen: BulkSnap }
    const h10t = R.h10_tristate as {
      rows: number
      a: { state: string; count: number; name: string } | null
      p: { state: string; count: number; name: string } | null
      fresh: { state: string; count: number; name: string } | null
      dbCountA: number; dbCountP: number; gapAboveBar: number
    }
    const h10a = R.h10_attach as {
      filteredA: boolean; attachClicked: boolean; attachNoticeSeen: boolean; notice: string | null
      linkCount: number; assets: string[]; redTags: string[]; blueTags: string[]; sidebar: Record<string, number>
      row: { state: string; count: number; name: string } | null; dbCount: number
    }
    const h10d = R.h10_detach as {
      detachClicked: boolean; pruneNoticeSeen: boolean; notice: string | null; tagGone: boolean
      tags: string[]; linkRows: number; orphans: number; sidebar: Record<string, number>; zeroRows: string[]
      redTags: string[]; panelStillOpen: boolean
    }
    const h10e = R.h10_esc as { escClosedPanel: boolean; selectedAfterEsc: number | null; barStillThere: boolean }
    const h10i = R.h10_ipc as {
      attachPartial: { ok: boolean; data?: unknown } | null
      attachAgain: { ok: boolean; data?: unknown } | null
      detachUnlinked: { ok: boolean; data?: unknown } | null
      pAfterAttach: string[]; pLinkCount: number; freshStillExists: boolean; freshLinkCount: number; orphans: number
    }
    const h10er = R.h10_errors as {
      assetMissing: { ok: boolean; error?: string } | null
      tagMissing: { ok: boolean; error?: string } | null
      badMode: { ok: boolean; error?: string } | null
      emptyName: { ok: boolean; error?: string } | null
      paddedExisting: { ok: boolean; error?: string } | null
      paddedNew: { ok: boolean; error?: string } | null
      tags: string[]
    }
    const h10b = R.h10_bulkUpdate as {
      res: { ok: boolean; data?: unknown } | null
      ratingAfter: number; tagsBefore: string[]; tagsAfter: string[]; pLinkCountUnchanged: number
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
      tagMenuItems: (R.h5_menuItems as string[])?.join('|') === '重命名标签|删除标签',
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

      // ==================== H9 「＋」下方的最近标签悬浮下拉 ====================
      // ① 库里一个标签都没有：下拉在，但没有行，提示指向「新建」
      recentEmptyWhenNoTags: h9e0?.present === true && (h9e0?.ids?.length ?? -1) === 0 &&
        h9e0?.hint === '输入名称新建第一个标签' && h9e0?.inputShown === true,
      // ② 12 个标签、红.png 已挂 1 个 → 可加 11 个，只显示最近 4 行
      recentSetupOk: h9s?.tagCount === 12 && (h9s?.attached?.length ?? -1) === 1 && h9s?.sidebar?.['标签12'] === 1,
      recentMenuShowsFourRows: (h9m?.ids?.length ?? -1) === 4 && h9m?.rows === 4,
      // 顺序 == DB 里「按添加时间倒序、去掉已挂的、截前 4 行」
      recentMenuOrderMatchesDb: (h9m?.ids ?? []).join('|') === (h9mExp ?? []).join('|') &&
        (h9mExp?.length ?? -1) === 4,
      recentMenuExcludesAttached: h9ex === true,
      // 行尾计数是查 DB 来的：1/1/1/0 的梯度，写死 0 或只数当前素材都会露馅
      recentMenuCountsMatchDb: (h9m?.counts ?? []).join('|') === (h9mCnt ?? []).join('|') &&
        (h9mCnt ?? []).join('|') === '1|1|1|0',
      // ③ 悬浮：与输入框等宽、左对齐，紧贴输入框下沿
      recentMenuAlignedWithInput: (h9m?.inputLeft ?? -2) >= 0 &&
        Math.abs((h9m?.menuLeft ?? -1) - (h9m?.inputLeft ?? -2)) <= 1 &&
        Math.abs((h9m?.menuW ?? 0) - (h9m?.inputW ?? 0)) <= 1,
      recentMenuHugsInput: (h9m?.menuTop ?? -1) - (h9m?.inputBottom ?? -2) >= 0 &&
        (h9m?.menuTop ?? -1) - (h9m?.inputBottom ?? -2) <= 8,
      // 关键：**不占文档流**。把下拉 display:none 掉，下方评分区若分毫不动才算真悬浮；
      // 改成 static/relative 会立刻变红（那就是用户嫌弃的「在页面上拓展」）。
      recentMenuOutOfFlow: h9m?.position === 'absolute' && h9flt !== null &&
        h9flt.withMenu === h9flt.withoutMenu,
      // ④ 搜索：输入「1」→ 只剩名字含 1 的（同样排除已挂的、4 行封顶）
      recentSearchTypedReal: h9st === true,
      recentSearchFilters: (h9sr?.ids ?? []).join('|') === (h9srExp ?? []).join('|') &&
        (h9srExp?.length ?? -1) === 3 && h9sr?.inputShown === true,
      // 退格清空 → 回到「最近 4 行」
      recentSearchClearsBack: (h9ac?.ids ?? []).join('|') === (h9mExp ?? []).join('|') &&
        h9ac?.hint === null && h9ac?.rows === 4,
      // ⑤ 点一行：挂上了、输入框没被 blur 关掉、该行消失且列表就地补位
      recentPickClickLanded: R.h9_click1 === true,
      recentPickAddsToDb: (h9p1?.attached?.length ?? -1) === 2 && h9p1?.attached?.includes(h9p1t) === true,
      recentPickAddsChip: h9p1?.chips?.includes(h9p1?.pickedName ?? '') === true,
      // 侧栏计数要跟着 +1（原来的值就是下拉里那行的数字）
      recentPickUpdatesSidebar: h9p1?.sidebar?.[h9p1?.pickedName ?? ''] === (h9mCnt?.[0] ?? -99) + 1,
      // 关键：输入框还开着（blur 陷阱）；被点的那行消失，列表保持 4 行并补上新的一个
      recentPickKeepsInputOpen: h9p1?.snap?.inputShown === true,
      recentPickRefillsMenu: (h9p1?.snap?.ids ?? []).join('|') === (h9p1?.expect ?? []).join('|') &&
        h9p1?.snap?.ids?.includes(h9p1t) === false && h9p1?.snap?.rows === 4,
      // ⑥ 重排之后再点一次：证明不是「只有第一次点得动」
      recentPick2ClickLanded: R.h9_click2 === true,
      recentPick2AddsToDb: (h9p2?.attached?.length ?? -1) === 3 && h9p2?.attached?.includes(h9p2t) === true,
      recentPick2KeepsInputOpen: h9p2?.snap?.inputShown === true &&
        (h9p2?.snap?.ids ?? []).join('|') === (h9p2?.expect ?? []).join('|') &&
        h9p2?.snap?.ids?.includes(h9p2t) === false,
      // ⑦ 12 个标签全挂上后：没有可加的了，提示换成「都已添加」
      recentAllAttachedHint: h9all?.present === true && (h9all?.ids?.length ?? -1) === 0 &&
        h9all?.hint === '近期标签都已添加' && h9all?.inputShown === true,

      // ==================== H10 批量打标（多选批量条的「标签」浮层）====================
      // 前置：3 张新素材上卡、三个靶子标签各就各位、红.png 仍挂着 12 个标签
      bulkSetupOk: h10s?.ready === true && h10s?.imported === 3 && (h10s?.cards?.length ?? -1) === 5 &&
        (h10s?.redTags?.length ?? -1) === 12 &&
        h10s?.preAttach?.a === 0 && (h10s?.preAttach?.p ?? []).join('|') === '甲.png' &&
        h10s?.preAttach?.fresh === 0,
      // 多选 3 项：每一下点击都必须真的生效（等待也是断言的一部分，G11）
      bulkSelectThree: h10sel?.selOne === true && h10sel?.ctrlJia === true && h10sel?.selTwo === true &&
        h10sel?.ctrlYi === true && h10sel?.selThree === true && h10sel?.selected === 3,
      // ③ 浮层绝对定位、浮在条子上方留缝（不是把条子顶开）
      bulkPanelFloats: h10p?.panelShown === true && h10p?.tagsBtnClicked === true &&
        h10p?.barOpen?.panel === true && h10p?.barOpen?.panelPosition === 'absolute' &&
        (h10t?.gapAboveBar ?? -99) >= 0 && (h10t?.gapAboveBar ?? 99) <= 12,
      // 「标签」按钮排在「喜欢」之后（否则 --smoke-m4 的 h13 会点到它）
      bulkTagsBtnAfterFav: ((R.h10_btnOrder as string[] | null)?.[0] ?? '') === '喜欢' &&
        ((R.h10_btnOrder as string[] | null)?.[1] ?? '') === '标签',
      // ③ 关键：打开浮层前后，条高 / --bb-extra / 网格底部留白三者**分毫不动**
      //（改成 static/relative 立刻变红：条子被撑高 → 三项一起漂）
      bulkPanelDoesNotShiftBar: h10p?.barClosed?.barH === h10p?.barOpen?.barH &&
        h10p?.barClosed?.extra === h10p?.barOpen?.extra &&
        h10p?.barClosed?.padBottom === h10p?.barOpen?.padBottom,
      // 单行高度必须仍是 44（.to-top 让位与 --smoke-m4 的 h13 几何断言都按 44 算），
      // 且 --bb-extra 应为 0px、网格底部留白 84
      bulkBarSingleLine44: h10p?.barOpen?.barH === 44 && h10p?.barOpen?.extra === '0px' &&
        h10p?.barOpen?.padBottom === 84,
      // 三态：批量A 都没挂 → none；预挂P 只在 3 项中的 1 项上 → some；行尾计数与 DB 一致
      bulkTriState: h10t?.a?.state === 'none' && h10t?.p?.state === 'some' && h10t?.fresh?.state === 'none' &&
        h10t?.a?.count === h10t?.dbCountA && h10t?.p?.count === h10t?.dbCountP,
      // ② 多选 3 项挂同一标签 → DB 关联 +3、侧栏计数 +3（从 0 到 3）
      bulkAttachClickLanded: h10a?.filteredA === true && h10a?.attachClicked === true,
      bulkAttachCountsDb: h10a?.linkCount === 3 &&
        sameSet(h10a?.assets, ['甲.png', '乙.png', '红.png']) && h10a?.dbCount === 3,
      bulkAttachSidebarPlus3: h10a?.sidebar?.['批量A'] === 3,
      bulkAttachRowAll: h10a?.row?.state === 'all' && h10a?.row?.count === 3,
      bulkAttachNotifies: h10a?.attachNoticeSeen === true && /已为\s*3\s*项挂上标签「批量A」/.test(h10a?.notice ?? ''),
      // ① 追加不覆盖：红.png 原本 12 个标签，挂完仍是 13 个（12 + 批量A），一个都不许少
      bulkAttachAppendsNotOverwrites: (h10a?.redTags?.length ?? -1) === 13 &&
        h10a.redTags!.includes('批量A') && h10a.redTags!.includes('标签01') && h10a.redTags!.includes('标签12'),
      // 反面证据：没被选中的 蓝.png 一个字节都没动
      bulkAttachLeavesOthersAlone: sameSet(h10a?.blueTags, ['标签11', '标签10', '标签09']),

      // ② detach 到归零 → 标签自动删除，提示带「已自动清除」
      bulkDetachClickLanded: h10d?.detachClicked === true,
      bulkDetachPrunesTag: h10d?.tagGone === true && h10d?.tags?.includes('批量A') === false,
      bulkDetachClearsLinks: h10d?.linkRows === 0 && h10d?.orphans === 0,
      bulkDetachRemovesSidebarRow: h10d?.sidebar?.['批量A'] === undefined &&
        // 此刻侧栏允许存在**一个**计数 0 的行：`未挂过` 是刚建好、还没挂任何素材的标签，
        // 「创建与挂载之间有窗口期」正是 `selectEmptyTags` 刻意保护的状态（见其注释），
        // 它本来就该留着。批量A 这种「刚被摘空」的必须消失 —— 两者的区别就是本段要守的边界。
        (h10d?.zeroRows ?? []).join('|') === '未挂过',
      bulkDetachNotifiesPruned: h10d?.pruneNoticeSeen === true &&
        /已从\s*3\s*项上摘除标签「批量A」/.test(h10d?.notice ?? '') &&
        /已自动清除/.test(h10d?.notice ?? ''),
      // 摘掉之后红.png 必须回到原来那 12 个标签（写错成「整体替换」会变成 0）
      bulkDetachKeepsOtherTags: (h10d?.redTags?.length ?? -1) === 12 && h10d?.redTags?.includes('标签12') === true &&
        h10d?.redTags?.includes('批量A') === false,
      // Esc 只收浮层、不清选中（GalleryGrid 的全局 Esc 被捕获阶段拦掉了）
      bulkEscClosesPanelOnly: h10e?.escClosedPanel === true && h10e?.selectedAfterEsc === 3 && h10e?.barStillThere === true,

      // ② 候选集语义（IPC 直调）：detach 一个「建好后没挂过素材」的标签 → 0 行变更 + 返回 pruned 空 + 标签仍在
      bulkIpcAttachPartial: (h10i?.attachPartial?.data as { attached?: number } | undefined)?.attached === 1 &&
        (h10i?.pLinkCount ?? -1) === 2,
      // INSERT OR IGNORE：同一组合再挂一次是 0 行变更，不是报错也不是重复行
      bulkIpcAttachIdempotent: (h10i?.attachAgain?.data as { attached?: number } | undefined)?.attached === 0 &&
        (h10i?.pAfterAttach?.length ?? -1) === 2,
      bulkIpcDetachUnlinked: h10i?.detachUnlinked?.ok === true &&
        (h10i?.detachUnlinked?.data as { detached?: number; pruned?: unknown[] } | undefined)?.detached === 0 &&
        ((h10i?.detachUnlinked?.data as { pruned?: unknown[] } | undefined)?.pruned?.length ?? -1) === 0,
      // 核心：摘一个从没挂过的标签，标签本体必须还在（拿请求参数当候选集就会把它删掉）
      bulkDetachUnlinkedKeepsTag: h10i?.freshStillExists === true && h10i?.freshLinkCount === 0 && h10i?.orphans === 0,

      // 错误码
      bulkErrAssetNotFound: h10er?.assetMissing?.ok === false && h10er?.assetMissing?.error === 'ERR_ASSET_NOT_FOUND',
      bulkErrTagNotFound: h10er?.tagMissing?.ok === false && h10er?.tagMissing?.error === 'ERR_TAG_NOT_FOUND',
      bulkErrInvalidMode: h10er?.badMode?.ok === false && h10er?.badMode?.error === 'ERR_INVALID_MODE',
      // tag:create 硬化：空名（含纯空格）报 ERR_EMPTY_NAME，trim 后重名报 ERR_TAG_EXISTS
      bulkTagCreateEmptyName: h10er?.emptyName?.ok === false && h10er?.emptyName?.error === 'ERR_EMPTY_NAME',
      bulkTagCreateTrimRejectsDup: h10er?.paddedExisting?.ok === false && h10er?.paddedExisting?.error === 'ERR_TAG_EXISTS',
      // 带空格的新名要按 trim 后落库（不是原样存进去）
      bulkTagCreateTrimmed: h10er?.paddedNew?.ok === true && h10er?.tags?.includes('新空格标签') === true &&
        h10er?.tags?.some((n) => n !== n.trim()) === false,
      // `asset:bulk-update` 仍然只认 rating/isFav：塞进去的 tagIds 被完全忽略
      bulkUpdateIgnoresTags: h10b?.ratingAfter === 2 && sameSet(h10b?.tagsAfter, h10b?.tagsBefore ?? []) &&
        (h10b?.pLinkCountUnchanged ?? -1) === 2,

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
    // ⚠️ 删目录前先停 chokidar：它还持有库目录句柄，Windows 上会让 rmSync 抛 ENOTEMPTY/EPERM，
    // 于是外层的 rmSync(dir) 必然也失败、临时库永远留在临时目录里。
    // 这是 `library:close` 早就写死的纪律，`smoke-folder.ts` 也已对齐，这里补齐。
    // `forgetLibrary` 只清 `config.json` 的最近库记录（不再物理删库），删目录由外层 rmSync(dir) 负责。
    unwatchLibrary()
    try {
      if (libPath) forgetLibrary(libPath)
    } catch (e) {
      R.cleanupError = String(e)
    }
    closeCurrent()
    // 临时目录清理失败只记录、不抛 —— 这一段夹在「结果 JSON」与 `app.exit(0)` 之间，
    // 一旦抛出就把整轮结论一起吞掉（表现为「无结论地挂死」，只能靠外部超时杀；QA 本轮就被这个卡住）。
    try {
      if (dir) rmSync(dir, { recursive: true, force: true })
    } catch (e) {
      R.cleanupError = `${R.cleanupError ? `${R.cleanupError}；` : ''}临时目录清理失败：${String((e as Error).message ?? e)}`
    }
    console.log('[SMOKE-TAG] ' + JSON.stringify(R))
    app.exit(0)
  }
}
