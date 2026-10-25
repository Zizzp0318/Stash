// 虚拟滚动冒烟（`--smoke-vscroll`）：M1–M8 全覆盖 + 纯算法边界（T01 安全网）
//
// 为什么单独一套：
//   · 「DOM 基数 ≠ 数据基数」之后，既有 15 套冒烟里没有任何一条能证明「窗口真的在生效」——
//     它们的小库（≤42 条）本来就全渲染，窗口化前后都绿。
//   · 唯一能失败的指标必须建在**大库**上：这里直插 1 万行 `assets`（content_hash = NULL，
//     没有 <img>、不发 404、不触发 thumb.ensure），测的是布局与滚动本身。
//   · 1 万条是**可复现**的：不落 1 万个真文件，一个事务就够（约 100ms）。
//
// 测试数据的关键选择（别改）：
//   · `content_hash = NULL` ⇒ 卡片走 `.thumb-fallback`（emoji），没有图片解码，M5 的内存数字干净。
//   · `width/height` 都有值 ⇒ `ratioOf()` 走索引分支，布局**完全确定**，M8 才能断「误差 0」。
//   · 必须在 `library.open` **之后**再插：开库时的对账/体检可能把「索引有、磁盘无」的行标 missing。
//
// 断言口径（§10.3 新增纪律 4）：断「数据基数」用 `assets.total` / `__vsDebug()`；
// 断「看得见什么」用 `.masonry-card` / `.list-row` 且**必须带上界**。
import { app, BrowserWindow } from 'electron'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { unwatchLibrary } from './watcher'
import { closeCurrent, createLibrary, forgetLibrary, mkdirRel, requireCurrent } from './library'
import { makeWaitUntil } from './smoke-util'
import { patchSettings } from './config'
import {
  anchorRestore,
  buildIndex,
  findRange,
  firstGreater,
  lowerBound,
  overscanPx,
  EMPTY_INDEX
} from '../../src/utils/virtual'
import type { StashVsDebug } from '../../src/env'

/** 夹具规模：1 万条（设计 §3 的可复现口径） */
const BIG_N = 10000
/** M1 的默认上界（1280×800 + viewZoom 170 实测 ~30 个节点，留 4 倍余量） */
const M1_SOFT_MAX = 120
/** M1 的硬上限（任何窗口/缩放下都不许超） */
const M1_HARD_MAX = 400
/**
 * M3 首屏预算（毫秒）。
 * 实测 160–195ms，原设计稿写 1500ms 是 7.7 倍余量 —— 首屏退化 5 倍也能过，等于没断。
 * 收紧到 400ms：仍留 ~2 倍余量（冷启动 / 杀软扫描不至于假红），但明显变慢会立刻红。
 */
const M3_BUDGET_MS = 400

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function onceLoaded(win: BrowserWindow): Promise<void> {
  return new Promise((resolve) => win.webContents.once('did-finish-load', () => resolve()))
}

/** 百分位（已在调用方排序） */
function pick(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))
  return sorted[i]
}

export async function runSmokeVScroll(win: BrowserWindow): Promise<void> {
  const R: Record<string, unknown> = {}
  const checks: Record<string, boolean> = {}
  const jsErrors: Array<{ code: string; error: string }> = []
  const rendererLogs: string[] = []

  /**
   * 记录一条断言。
   * `detail` 无论成败都进结果（失败时它就是排查线索；成功时它是「这次的实测数字」）。
   */
  const check = (name: string, ok: boolean, detail?: unknown): void => {
    checks[name] = ok
    if (detail !== undefined) R[name] = detail
  }

  win.webContents.on('console-message', (_e, _lvl, message) => {
    rendererLogs.push(message.slice(0, 300))
    if (rendererLogs.length > 60) rendererLogs.shift()
  })
  const rawJs = (code: string): Promise<unknown> => win.webContents.executeJavaScript(code)
  const js = async (code: string): Promise<unknown> => {
    try {
      return await rawJs(code)
    } catch (e) {
      jsErrors.push({ code: code.replace(/\s+/g, ' ').slice(0, 160), error: String(e).slice(0, 200) })
      return null
    }
  }
  const waitUntil = makeWaitUntil(js)

  /** 读一次虚拟滚动快照（`GalleryGrid` 挂在 window 上的只读出口） */
  const snap = async (): Promise<StashVsDebug | null> => {
    const s = (await js('window.__vsDebug ? JSON.stringify(window.__vsDebug()) : null')) as string | null
    if (!s || s === 'null' || s === 'undefined') return null
    try {
      return JSON.parse(s) as StashVsDebug
    } catch {
      return null
    }
  }
  /** 已渲染的卡片节点数（**带上界**的可见性口径，不能当数据基数用） */
  const domCards = async (): Promise<number> =>
    ((await js("document.querySelectorAll('.masonry-card').length")) as number | null) ?? -1
  const scrollHeight = async (): Promise<number> =>
    ((await js("document.querySelector('.grid-wrap')?.scrollHeight ?? 0")) as number | null) ?? -1
  const itemsLen = async (): Promise<number> => (await snap())?.n ?? -1
  /**
   * 某素材对应的节点（瀑布 `.masonry-card` / 列表 `.list-row`）相对 `.grid-wrap` 可视区顶边的 y。
   *
   * ⚠️ 为什么「锚点断言」必须配合它：`__vsDebug().anchorId` 是一个**只由 `updateAnchor()` 更新**
   * 的普通变量，而 `updateAnchor()` 只在 onScroll / 锚点恢复 / onMounted 里调用。
   * 于是「锚点恢复被整段删掉」时 scrollTop 不动 → 没有 scroll 事件 → `anchorId` 原样不动 →
   * 只比对 `anchorId` 的断言会**永远绿**（实测：关掉锚点恢复后 M6/M6_back/M6_zoom/M6_resize
   * 与段 9 的重排断言全部照旧通过，而画面其实跳到了列表的另一处）。
   * 所以「画面有没有跳」必须打在**节点位置**上：同一条素材的屏幕 y 变了就是跳了。
   */
  const nodeTopInView = async (id: number | null | undefined): Promise<number | null> =>
    id == null || id < 0
      ? null
      : (((await js(`(() => {
          const el = document.querySelector('[data-id="' + ${Number(id)} + '"]')
          if (!el) return null
          const wr = document.querySelector('.grid-wrap').getBoundingClientRect()
          return Math.round(el.getBoundingClientRect().top - wr.top)
        })()`)) as number | null) ?? null)

  /**
   * 渲染进程的私有内存（KB）。
   *
   * ⚠️ 不用 `webContents.getProcessMemoryInfo()` —— Electron 44 已经把它从 `WebContents`
   * 上移除了（只在 `process` 上），TS 会直接报 TS2339。改用 `app.getAppMetrics()` 按
   * `type === 'Tab'` 取渲染进程；Windows 上 `privateBytes` 是「不与他人共享的字节数」，
   * 正是 M5 要的那个量（没有它时退到 `workingSetSize`，口径会偏大，所以在结果里标明）。
   */
  const rendererMemoryKb = (): { kb: number; metric: 'privateBytes' | 'workingSetSize' } => {
    const tabs = app.getAppMetrics().filter((m) => m.type === 'Tab')
    let kb = 0
    let metric: 'privateBytes' | 'workingSetSize' = 'privateBytes'
    for (const t of tabs) {
      if (typeof t.memory.privateBytes === 'number') kb += t.memory.privateBytes
      else {
        metric = 'workingSetSize'
        kb += t.memory.workingSetSize
      }
    }
    return { kb, metric }
  }

  let dir: string | null = null
  let libPath = ''

  // ==================== 段 0：纯算法边界（T01 的安全网，脱 DOM）====================
  //
  // 这一段**不需要渲染层**：`src/utils/virtual.ts` 是零 Vue / 零 DOM 的纯函数，
  // 所以在主进程里直接构造 `LayoutIndex` 断言即可。先跑它，后面几段才有安全网 ——
  // 窗口区间算错时，「渲染数不对」的根因能立刻定位到算法层还是组件层。
  try {
    const pure: Record<string, unknown> = {}

    // 单列、每张 100 高：tops[i] = i*100，maxBottoms[i] = (i+1)*100
    const n = 1000
    const tops = new Int32Array(n)
    const heights = new Int32Array(n)
    const ids = new Array<number>(n)
    for (let i = 0; i < n; i++) {
      tops[i] = i * 100
      heights[i] = 100
      ids[i] = i + 1
    }
    const idx = buildIndex({ tops, heights, ids })

    const emptyIdx = { n: EMPTY_INDEX.n, total: EMPTY_INDEX.total }
    pure.emptyIndex = emptyIdx
    pure.emptyRange = findRange(EMPTY_INDEX, 0, 800, 240, 400)
    // 二分：maxBottoms 的最后一项是 100000，所以探针要取到 1e9 才算「全部越界」；
    // lowerBound(tops, 1e9) 同理返回 n。两个函数在「越界」上的返回值都是 `a.length`。
    pure.binary = {
      firstGreater: [firstGreater(idx.maxBottoms, 0), firstGreater(idx.maxBottoms, 1e9)],
      lowerBound: [lowerBound(idx.tops, 0), lowerBound(idx.tops, 1e9)]
    }
    // 视口在内容之上（vpBottom < tops[0]）→ 没有任何条目可见
    pure.above = findRange(idx, -2000, -1200, 0, 400)
    // 视口在内容之下 → 防御性兜底：至少保留最后一条，绝不返回空窗口
    pure.below = findRange(idx, 500000, 500800, 0, 400)
    // 正常视口：vpTop 1000..1800 → 第 10..17 条
    pure.normal = findRange(idx, 1000, 1800, 0, 400)
    // 单张超长卡片：n = 1、高 5000，视口落在它中间 → 必须渲染它
    const tall = buildIndex({ tops: [0], heights: [5000], ids: [7] })
    pure.tallCard = findRange(tall, 3000, 3100, 0, 400)
    // 预算兜底：带一屏缓冲时区间宽 25 条（38..63），超 maxNodes = 10 → 收缩到「刚好可视」。
    // vpTop 5000 / vpBottom 5100 只与第 50 条（y 5000..5100）相交，所以正确答案是 [50,51)。
    pure.budget = findRange(idx, 5000, 5100, 1200, 10)
    // 预算都不够时保持原区间（宁可多渲染，也不能在屏幕上留洞）
    pure.budgetImpossible = findRange(idx, 0, 5000, 0, 10)
    pure.total = idx.total
    pure.monotonic = (() => {
      for (let i = 1; i < idx.n; i++) {
        if (idx.tops[i] < idx.tops[i - 1] || idx.maxBottoms[i] < idx.maxBottoms[i - 1]) return false
      }
      return true
    })()
    pure.overscan = [overscanPx(0), overscanPx(500), overscanPx(5000)]
    pure.anchor = {
      hit: anchorRestore(idx, 11, 50, 16), // 第 11 条 id=11 在下标 10，tops=1000 → 1000-50+16
      gone: anchorRestore(idx, 99999, 50, 16),
      none: anchorRestore(idx, null, 0, 16)
    }
    R.pure = pure

    check('T01 空索引返回 [0,0)', JSON.stringify(pure.emptyRange) === '[0,0]')
    check('T01 n=0 时索引完全为空', emptyIdx.n === 0 && emptyIdx.total === 0)
    check(
      'T01 二分边界正确（首个 >0 为 0，超出范围返回 n；首个 >=0 为 0）',
      JSON.stringify(pure.binary) === JSON.stringify({ firstGreater: [0, n], lowerBound: [0, n] })
    )
    check('T01 视口在内容之上不渲染任何条目', JSON.stringify(pure.above) === '[0,0]')
    check('T01 视口在内容之下至少有最后一条（不返回空窗口）', JSON.stringify(pure.below) === `[${n - 1},${n}]`)
    check('T01 正常视口命中 [10,18)', JSON.stringify(pure.normal) === '[10,18]')
    check('T01 单张超长卡片必被渲染', JSON.stringify(pure.tallCard) === '[0,1]')
    check('T01 超预算时收缩到「刚好可视」[50,51)', JSON.stringify(pure.budget) === '[50,51]')
    check('T01 连可视区都超预算时保留原区间（不留空洞）', (pure.budgetImpossible as number[])[1] > 10)
    check('T01 精确总高 = 100000', pure.total === n * 100)
    check('T01 tops 与 maxBottoms 非递减', pure.monotonic === true)
    check('T01 overscan = clamp(h, 240, 1200)', JSON.stringify(pure.overscan) === '[240,500,1200]')
    check(
      'T01 锚点恢复：命中按 id 反推 / 锚点消失报 gone / 无锚报 no-anchor',
      JSON.stringify(pure.anchor) ===
        JSON.stringify({
          hit: { ok: true, scrollTop: 966 },
          gone: { ok: false, reason: 'gone' },
          none: { ok: false, reason: 'no-anchor' }
        })
    )
  } catch (e) {
    R.pureError = String((e as Error).stack ?? e)
    check('T01 纯算法段执行', false)
  }

  try {
    // ==================== 段 1：夹具（1 万行直插，无图）====================
    dir = mkdtempSync(join(tmpdir(), 'stash-vscroll-'))
    libPath = createLibrary({ name: 'vscroll-lib', parentDir: dir }).path

    // 先让主进程真的把这个库打开（走 openLibrary + watchLibrary，与用户点开库同一条路径），
    // 再插数据 —— 反过来的话开库对账可能把「索引有、磁盘无」的行标成 missing。
    await js(`window.stash.library.open(${JSON.stringify(libPath)}).then((r) => !!r.ok)`)

    const folder = mkdirRel('未分类')
    const t0 = Date.now()
    const ins = requireCurrent().db.prepare(
      `INSERT INTO assets (folder_id, name, rel_path, type, ext, size, width, height, content_hash,
                           rating, is_fav, file_mtime, imported_at, missing)
       VALUES (?, ?, ?, 'image', 'png', 1024, 1600, 1200, NULL, 0, 0, ?, ?, 0)`
    )
    const db = requireCurrent().db
    db.exec('BEGIN')
    try {
      for (let i = 0; i < BIG_N; i++) {
        const k = String(i).padStart(5, '0')
        ins.run(folder.id, `v${k}.png`, `未分类/v${k}.png`, t0 + i, t0 + i)
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    const inserted = (db.prepare('SELECT count(*) AS c FROM assets').get() as { c: number }).c
    check('夹具：1 万行已落库', inserted === BIG_N, { inserted })

    // 复现口径：窗口 1280×800 + viewZoom 170（默认值）。写进偏好后 reload 才会生效。
    win.setContentSize(1280, 800)
    patchSettings({ viewZoom: 170, defaultView: 'masonry' })

    // ==================== 段 2：首屏（M3 / M1 / M8）====================
    const reloaded = onceLoaded(win)
    win.webContents.reload()
    await reloaded
    const tNav = Date.now()
    const firstCardOk = await waitUntil("!!document.querySelector('.masonry-card')", 15000)
    const tFirst = Date.now() - tNav
    // 页面内的 performance.now() 含导航到此刻的全过程，比主进程计时更贴近「用户等了多久」
    const firstCardMs =
      ((await js('Math.round(performance.now())')) as number | null) ?? tFirst
    // `__vsDebug` 必须在首屏就挂好，否则后面几段全部读不到数
    const debugReady = await waitUntil('!!window.__vsDebug', 5000)

    R.boot = { firstCardOk, firstCardMs, tFirst, debugReady }
    /**
     * M3 阈值 400ms（不是设计稿的 1500ms）。
     * 实测首屏 160–195ms，1500ms 给了 7.7 倍余量 —— 首屏慢 5 倍也照样绿，那条断言等于没有。
     * 400ms 留了约 2 倍余量：慢一档的机器（冷启动 / 杀软在扫）不至于假红，但只要首屏退化到
     * 「明显变慢」就会红。实测值随断言一起打出来，便于后续按「不慢于基线 20%」继续收紧。
     */
    check('M3 首屏 ≤400ms 就渲染出第一张卡', firstCardOk && firstCardMs <= M3_BUDGET_MS, {
      firstCardMs,
      主进程侧计时: tFirst,
      budget: M3_BUDGET_MS
    })
    check('调试出口 __vsDebug 已挂载', debugReady)

    // 等第一页数据真的到位（items.length === 200 且 total === 10000）
    const firstPageOk = await waitUntil('!!window.__vsDebug && window.__vsDebug().n === 200', 8000)
    let s0 = await snap()
    R.firstPage = { ok: firstPageOk, snap: s0 }
    check('首屏恰好加载第一页（200 条）', firstPageOk && s0?.n === 200, { n: s0?.n })

    // —— M1：渲染节点数 ——
    const dom0 = await domCards()
    R.m1 = { rendered: s0?.rendered, dom: dom0 }
    check(
      'M1 渲染节点数 ≤120（默认视角）且 DOM 与窗口一致',
      (s0?.rendered ?? 9999) <= M1_SOFT_MAX && dom0 === s0?.rendered,
      { rendered: s0?.rendered, dom: dom0 }
    )
    check('M1 渲染节点数 ≤400（硬上限）', (s0?.rendered ?? 9999) <= M1_HARD_MAX && dom0 > 0 && dom0 <= M1_HARD_MAX, {
      rendered: s0?.rendered,
      dom: dom0
    })

    // —— M8：布局不变量 ——
    check(
      'M8 tops/maxBottoms 非递减、total 误差 0、窗口覆盖全部可见条目',
      s0?.monotonic === true && s0?.maxDiff === 0 && s0?.coverMiss === 0,
      { monotonic: s0?.monotonic, maxDiff: s0?.maxDiff, coverMiss: s0?.coverMiss }
    )

    // 总数据量必须是 10000（数据基数看这里，不看 DOM）
    const totalOk = s0?.dataTotal === BIG_N && s0?.n === 200
    check('数据基数与夹具一致（dataTotal = 10000，只加载了第一页）', totalOk, {
      dataTotal: s0?.dataTotal,
      n: s0?.n
    })

    // ==================== 段 3：M4 分页（必须在**未滚动过**的干净状态上跑）====================
    //
    // ⚠️ 段序有讲究：这条断言要的是「首次触底恰好追加一页」，一旦前面滚动过就会带着
    // 已经追加的页数，`before` 不再是 200（第一版就是这样假红的）。
    const scrollBottom = async (): Promise<void> => {
      await js(`(() => { const w = document.querySelector('.grid-wrap'); w.scrollTop = w.scrollHeight; return true })()`)
    }
    await scrollBottom()
    const grew2 = await waitUntil('window.__vsDebug().n > 200', 12000)
    await sleep(160)
    const lenAfter = await itemsLen()
    const s2page = await snap()
    R.m4_firstAppend = { before: 200, after: lenAfter, grew: grew2, dataTotal: s2page?.dataTotal }
    check('M4 距底 <800px 时恰好追加一页（200 → 400）', grew2 && lenAfter === 400, { after: lenAfter })
    /**
     * 重复 id 的判据用「数据基数」而不是 DOM：
     * `loadMore` 内部有 `seen` 去重，所以真出现重复只会表现为**加载不满**——
     * 段 5 的 `n === dataTotal === 10000` 就是那条断言的落点（比在 DOM 里数 id 可靠）。
     * 这里额外确认查询命中的总条数没有随追加而变化（分页不该改总数）。
     */
    check('M4 追加不改变数据基数（dataTotal 仍是 10000）', s2page?.dataTotal === BIG_N, {
      dataTotal: s2page?.dataTotal
    })

    // —— M1 滚动 10 屏：渲染数不允许随滚动深度增长 ——
    //
    // ⚠️ 对比基准必须选**两个都在内容中段**的位置（10 屏 vs 20 屏）：
    // 顶部那一屏只有下方一半的缓冲（上方没内容），渲染数天然比中段少 ~1/3，
    // 拿它当基准会把「窗口正常工作」判成「渲染数涨了 50%」。
    // 关键性质是**不随深度累积**，所以中段 vs 更深处才是有效对照。
    await js(
      `(() => { const w = document.querySelector('.grid-wrap'); w.scrollTop = w.clientHeight * 10; return true })()`
    )
    await sleep(320)
    const dom10 = await domCards()
    const s10 = await snap()
    await js(
      `(() => { const w = document.querySelector('.grid-wrap'); w.scrollTop = w.clientHeight * 20; return true })()`
    )
    await sleep(320)
    const dom20 = await domCards()
    const s20 = await snap()
    R.m1_scroll = { top: dom0, at10: dom10, at20: dom20, snap10: s10, snap20: s20 }
    check(
      'M1 滚动 10→20 屏渲染节点数几乎不变（≤20% 波动，不随深度累积）',
      // 容差取 ±max(6, 20%)：变高瀑布在「半个卡片高度」的位置上会多/少渲染一排，
      // 这是几何抖动而不是泄漏 —— 真泄漏是「200 → 10000」量级，任何合理容差都拦得住。
      dom10 > 0 && dom20 > 0 && Math.abs(dom20 - dom10) <= Math.max(6, Math.ceil(dom10 * 0.2)),
      { at10: dom10, at20: dom20 }
    )
    check(
      'M1 深处窗口仍在预算内且覆盖无缺口',
      (s20?.rendered ?? 9999) <= M1_SOFT_MAX && s20?.coverMiss === 0,
      { rendered: s20?.rendered, coverMiss: s20?.coverMiss }
    )
    // 回到顶部，后续段从一致的位置开始
    await js(`(() => { document.querySelector('.grid-wrap').scrollTop = 0; return true })()`)
    await sleep(200)

    // ==================== 段 4：M7 scrollHeight 单调 ====================
    // 前 10 页逐页读 scrollHeight：窗口化之后它只反映「已渲染的那一小段 + 精确 total」，
    // 所以单调性实际上是在验证「布局 total 随追加单调不减」。
    const heights: number[] = [await scrollHeight()]
    let pageGuard = 0
    while (heights.length < 10 && pageGuard++ < 40) {
      const before = await itemsLen()
      await scrollBottom()
      const ok = await waitUntil(`window.__vsDebug().n > ${before}`, 12000)
      if (!ok) break
      await sleep(120)
      heights.push(await scrollHeight())
    }
    R.m7 = { pages: heights.length, heights }
    const monotonicHeights = heights.every((h, i) => i === 0 || h >= heights[i - 1] || heights[i - 1] - h <= 40)
    check('M7 连续加载前 10 页 scrollHeight 不减小（末页允许收缩 ≤40px）', heights.length >= 5 && monotonicHeights, {
      heights
    })

    // ==================== 段 5：M4 收尾 + M5 内存 ====================
    const memBefore = rendererMemoryKb()
    let memAt6000 = memBefore.kb
    let memChecked = false
    let iter = 0
    while (iter++ < 200) {
      const before = await itemsLen()
      if (before >= 200 && before < BIG_N) {
        if (!memChecked && before >= 6000) {
          const m = rendererMemoryKb()
          memAt6000 = m.kb
          memChecked = true
          R.m5_at6000 = { items: before, kb: m.kb, metric: m.metric, baseKb: memBefore.kb }
        }
        await scrollBottom()
        await waitUntil(`window.__vsDebug().n > ${before}`, 12000)
        await sleep(60)
      } else break
    }
    const loadedAll = await waitUntil(`window.__vsDebug().n === ${BIG_N}`, 20000)
    const sFull = await snap()
    if (!memChecked) {
      const m = rendererMemoryKb()
      memAt6000 = m.kb
      R.m5_at6000 = { items: sFull?.n, kb: m.kb, metric: m.metric, baseKb: memBefore.kb, note: '未恰好在 6000 采样，取终值' }
    }
    const deltaMb = (memAt6000 - memBefore.kb) / 1024
    R.m5 = {
      baseKb: memBefore.kb,
      atKb: memAt6000,
      metric: memBefore.metric,
      deltaMb: Math.round(deltaMb * 10) / 10
    }
    check('M4 全部 10000 条已加载（n === 数据基数，无重复/无漏页）', loadedAll && sFull?.n === BIG_N && sFull?.dataTotal === BIG_N, {
      n: sFull?.n,
      dataTotal: sFull?.dataTotal
    })
    check('M5 已加载 6000+ 条后私有内存增量 ≤40MB', deltaMb <= 40, R.m5)
    const domFull = await domCards()
    check('M5 全部加载后渲染节点数仍 ≤120（DOM 不随数据膨胀）', domFull > 0 && domFull <= M1_SOFT_MAX, {
      dom: domFull
    })

    // 到底之后：不再增长、加载条不出现
    await scrollBottom()
    await sleep(1500)
    const h1 = await scrollHeight()
    await scrollBottom()
    await sleep(1500)
    const h2 = await scrollHeight()
    const stripThere = (await js("!!document.querySelector('[data-load-strip]')")) === true
    const sEnd = await snap()
    R.m4_end = { h1, h2, stripThere, n: sEnd?.n, total: sEnd?.total }
    check(
      'M4 items.length === total 后继续滚到底：高度不再增长、加载条不出现',
      h1 === h2 && !stripThere && sEnd?.n === BIG_N,
      { h1, h2, stripThere, n: sEnd?.n }
    )
    // 窗口区间宽度在「全部已加载」后仍受控
    check('M4 全部加载后窗口仍 ≤400 节点（硬上限）', (sEnd?.rendered ?? 9999) <= M1_HARD_MAX, {
      rendered: sEnd?.rendered
    })

    // ==================== 段 6：M2 帧率（页面内 rAF 采样）====================
    // 先采一段**空闲基线**（同位置、不滚动，60 帧），再采持续滚动 240 帧。
    //
    // 为什么必须有基线：绝对阈值（p95 ≤ 33ms）是照 60Hz 屏写的，而本机 rAF 在
    // `--disable-gpu` 下跑在 ~160Hz（空闲间隔 ≈6ms）。注入验证时「关闭窗口化」
    // p95 只升到 30ms —— 绝对值仍然绿，但相对基线是 **4.8 倍**。
    // 所以断言必须「绝对 + 相对」两条都在：只留绝对值的话，机器越快这套指标越失灵（§10.3 纪律 3）。
    await js(`(() => { const w = document.querySelector('.grid-wrap'); w.scrollTop = Math.round(w.scrollHeight / 3); return true })()`)
    await sleep(240)
    const baseStarted = (await js(`(() => {
      const s = (window.__vsBase = { d: [], done: false })
      let last = performance.now()
      let n = 0
      const tick = (t) => {
        s.d.push(t - last)
        last = t
        if (++n < 60) requestAnimationFrame(tick)
        else s.done = true
      }
      requestAnimationFrame(tick)
      return true
    })()`)) === true
    const baseDone = await waitUntil('window.__vsBase && window.__vsBase.done', 20000)
    const rawBase = (await js('JSON.stringify(window.__vsBase ? window.__vsBase.d : [])')) as string | null
    const baseSamples = (rawBase ? (JSON.parse(rawBase) as number[]) : []).slice(1).sort((a, b) => a - b)
    const idleP95 = pick(baseSamples, 0.95)
    const idleMean = baseSamples.length ? baseSamples.reduce((a, b) => a + b, 0) / baseSamples.length : 0
    // 相对阈值：滚动帧的 p95 不允许超过空闲基线的 2.5 倍（下限 8ms 防止基线过小导致抖动误判）
    const relP95 = Math.max(8, idleP95 * 2.5)
    R.m2_idle = {
      started: baseStarted,
      done: baseDone,
      frames: baseSamples.length,
      p95: Math.round(idleP95 * 10) / 10,
      mean: Math.round(idleMean * 10) / 10
    }

    // 采样点落在内容中部：240 帧 × 60px/帧 = 14400px 的持续滚动（≈3.6 屏/秒）
    const probeStarted = (await js(`(() => {
      const w = document.querySelector('.grid-wrap')
      if (!w) return false
      const s = (window.__vsProbe = { d: [], done: false })
      let last = performance.now()
      let n = 0
      const tick = (t) => {
        s.d.push(t - last)
        last = t
        w.scrollTop += 60
        if (++n < 240) requestAnimationFrame(tick)
        else s.done = true
      }
      requestAnimationFrame(tick)
      return true
    })()`)) === true
    const probeDone = await waitUntil('window.__vsProbe && window.__vsProbe.done', 40000)
    const rawD = (await js('JSON.stringify(window.__vsProbe ? window.__vsProbe.d : [])')) as string | null
    const samples = rawD ? (JSON.parse(rawD) as number[]) : []
    const sorted = samples.slice(1).sort((a, b) => a - b) // 丢掉第 1 帧（首帧含 rAF 启动抖动）
    const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 999
    const p95 = pick(sorted, 0.95)
    const max = sorted.length ? sorted[sorted.length - 1] : 999
    R.m2 = {
      probeStarted,
      probeDone,
      frames: sorted.length,
      p95: Math.round(p95 * 10) / 10,
      mean: Math.round(mean * 10) / 10,
      max: Math.round(max * 10) / 10,
      idleP95: Math.round(idleP95 * 10) / 10,
      relP95: Math.round(relP95 * 10) / 10
    }
    // 阈值口径（写进报告与 §11.2）：
    //   · 绝对：p95 ≤ 33ms（掉 2 帧以内）、平均 ≤ 20ms、最长 ≤ 80ms —— 按设计稿。
    //     平均那条设计稿写 ≤16ms，但 60Hz 屏上 rAF 间隔本身就是 16.67ms，字面永远红；
    //     本机实测 6.1ms，20ms 仍然远低于「注入验证」的 16.5ms（且相对判据会独立拦住它）。
    //   · 相对：p95 ≤ 空闲基线 × 2.5 —— 这条才是**能失败**的那条（见上面的基线说明）。
    check(
      'M2 帧率 p95 ≤33ms / 平均 ≤20ms / 最长 ≤80ms（1 万条已加载）',
      probeStarted && probeDone && sorted.length >= 200 && p95 <= 33 && mean <= 20 && max <= 80,
      R.m2
    )
    check('M2 滚动帧 p95 ≤ 空闲基线 ×2.5（注入验证时这条必红）', baseDone && sorted.length >= 200 && p95 <= relP95, {
      p95: R.m2 && (R.m2 as { p95: number }).p95,
      relP95: Math.round(relP95 * 10) / 10,
      idleP95: Math.round(idleP95 * 10) / 10
    })

    // ==================== 段 7：M6 视图切换 / 缩放 / 列数 ====================
    await js(`(() => { const w = document.querySelector('.grid-wrap'); w.scrollTop = Math.round(w.scrollHeight / 2); return true })()`)
    await sleep(320)
    const beforeSwitch = await snap()
    // 点工具栏的「列表视图」按钮（走真实 UI，store 与布局都跟着变）
    await js(`(() => { document.querySelectorAll('.viewtoggle button')[1].click(); return true })()`)
    const listReady = await waitUntil("window.__vsDebug && window.__vsDebug().view === 'list'", 8000)
    await sleep(320)
    const inList = await snap()
    // 列表视图的总高必须**精确**等于 上下内边距 + n×34
    const listBox = (await js(
      `(() => { const l = document.querySelector('.list'); return l ? Math.round(l.offsetHeight) : -1 })()`
    )) as number | null
    const expectListH = 8 + (inList?.n ?? 0) * 34 + 8
    R.m6 = { before: beforeSwitch, list: inList, listBox, expectListH, listReady }
    /**
     * 判据打在「同一条素材在视口内的位置」上（`nodeTopInView`，见文件上方注释）。
     * ⚠️ 只比 `anchorId` 是**空转**的：`anchorId` 只在 `updateAnchor()` 里更新，
     * 把锚点恢复整段删掉时它根本不会变 → 「首个可见条目不变」永远绿（QA 已实测证伪）。
     * 所以这里断的是「那条素材的屏幕 y 没动（±10px）」，并顺带证明它**仍在 DOM 里**
     * （`nodeTopInView` 找不到节点就返回 null）。`anchorId` 只留作诊断字段。
     */
    const m6ListTop = await nodeTopInView(beforeSwitch?.anchorId)
    check(
      'M6 切到列表视图后锚点素材仍在视口内同一位置（±10px，且仍在 DOM 里）',
      listReady &&
        m6ListTop != null &&
        Math.abs(m6ListTop - (beforeSwitch?.anchorOffset ?? 0)) <= 10,
      { id: beforeSwitch?.anchorId, offB: beforeSwitch?.anchorOffset, topA: m6ListTop }
    )
    check('M6 列表视图总高按 34px/行精确可算', Math.abs((listBox ?? -1) - expectListH) <= 1, {
      listBox,
      expectListH
    })
    check('M6 列表视图同样受窗口约束（≤120 行）', (inList?.rendered ?? 9999) <= M1_SOFT_MAX, {
      rendered: inList?.rendered
    })

    // 切回瀑布：锚点素材的位置仍要对得上（同一套位置口径）
    await js(`(() => { document.querySelectorAll('.viewtoggle button')[0].click(); return true })()`)
    const backReady = await waitUntil("window.__vsDebug && window.__vsDebug().view === 'masonry'", 8000)
    await sleep(320)
    const backMasonry = await snap()
    const m6BackTop = await nodeTopInView(beforeSwitch?.anchorId)
    R.m6_back = { ready: backReady, snap: backMasonry, topA: m6BackTop }
    check(
      'M6 往返 masonry → list → masonry 后锚点素材仍在视口内同一位置（±10px，且仍在 DOM 里）',
      backReady &&
        m6BackTop != null &&
        Math.abs(m6BackTop - (beforeSwitch?.anchorOffset ?? 0)) <= 10,
      { id: beforeSwitch?.anchorId, offB: beforeSwitch?.anchorOffset, topA: m6BackTop }
    )

    // 缩放 170 → 280：列数/总高都会变，锚点素材不能跳
    const beforeZoom = await snap()
    const beforeZoomTop = await nodeTopInView(beforeZoom?.anchorId)
    await js(`(() => {
      const el = document.querySelector('.zoom-ctrl input')
      if (!el) return false
      el.value = '280'
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await waitUntil('window.__vsDebug().cardW > 200', 8000)
    await sleep(420)
    const afterZoom = await snap()
    const afterZoomTop = await nodeTopInView(beforeZoom?.anchorId)
    R.m6_zoom = { before: beforeZoom, after: afterZoom, topB: beforeZoomTop, topA: afterZoomTop }
    check(
      'M6 缩放 170→280 后锚点素材位置不变（±10px）、列宽变大、总高变化',
      afterZoomTop != null &&
        beforeZoomTop != null &&
        Math.abs(afterZoomTop - beforeZoomTop) <= 10 &&
        (afterZoom?.cardW ?? 0) > (beforeZoom?.cardW ?? 0) &&
        (afterZoom?.total ?? 0) !== (beforeZoom?.total ?? -1),
      {
        id: beforeZoom?.anchorId,
        topB: beforeZoomTop,
        topA: afterZoomTop,
        cwB: beforeZoom?.cardW,
        cwA: afterZoom?.cardW
      }
    )
    // 还原缩放
    await js(`(() => {
      const el = document.querySelector('.zoom-ctrl input')
      el.value = '170'
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await waitUntil('window.__vsDebug().cardW < 200', 8000)
    await sleep(320)

    // 窗口变窄 → 列数变化，锚点素材的位置仍不能跳
    const beforeResize = await snap()
    const beforeResizeTop = await nodeTopInView(beforeResize?.anchorId)
    win.setContentSize(1000, 800)
    await sleep(700)
    const afterResize = await snap()
    const afterResizeTop = await nodeTopInView(beforeResize?.anchorId)
    R.m6_resize = { before: beforeResize, after: afterResize, topB: beforeResizeTop, topA: afterResizeTop }
    check(
      'M6 窗口宽度变化（列数重排）后锚点素材位置不变（±10px）、列数不增',
      afterResizeTop != null &&
        beforeResizeTop != null &&
        Math.abs(afterResizeTop - beforeResizeTop) <= 10 &&
        (afterResize?.cols ?? 0) <= (beforeResize?.cols ?? 99),
      {
        id: beforeResize?.anchorId,
        topB: beforeResizeTop,
        topA: afterResizeTop,
        colsB: beforeResize?.cols,
        colsA: afterResize?.cols
      }
    )
    win.setContentSize(1280, 800)
    await sleep(700)

    // ==================== 段 8：R6 keepDepth 不被静默截断 ====================
    // 触发 `App.vue` 的 `library.onExternal` → `assets.refresh({ keepDepth: true })`，
    // 也就是「用户滚到第 N 条时外部文件被改动」这条真实路径。
    // 修复前：服务端 `Math.min(limit, 1000)` 会把它砍到 1000 条，且 scrollTop 被夹回顶部。
    await js(`(() => { const w = document.querySelector('.grid-wrap'); w.scrollTop = Math.round(w.scrollHeight * 0.6); return true })()`)
    await sleep(400)
    const beforeRefresh = await snap()
    win.webContents.send('library:external', { added: 0, changed: 0, removed: 0, partial: false })
    const backToDepth = await waitUntil(`window.__vsDebug().n === ${BIG_N}`, 20000)
    await sleep(600)
    const afterRefresh = await snap()
    R.r6 = { before: beforeRefresh, after: afterRefresh, backToDepth }
    check('R6 refresh({keepDepth}) 后已加载条数不缩水（深浏览不被截断）', backToDepth && afterRefresh?.n === BIG_N, {
      before: beforeRefresh?.n,
      after: afterRefresh?.n
    })
    check(
      'R6 refresh 后滚动位置按锚点守住（没有被弹回顶部）',
      Math.abs((afterRefresh?.scrollTop ?? 0) - (beforeRefresh?.scrollTop ?? 0)) <= 400 &&
        (afterRefresh?.scrollTop ?? 0) > 1000,
      { before: beforeRefresh?.scrollTop, after: afterRefresh?.scrollTop }
    )

    // ==================== 段 9：热重排不再抖动（比例回写合并）====================
    // 1 万条 + 无图，`ratioRev` 不会被触发；这里改为验证「同一次布局变化只恢复一次滚动」：
    // 关掉「文件名」字段（信息区高度减 17px → 全量重排）后，锚点与滚动位置都要守住。
    // ⚠️ 必须挑**会改变卡片高度**的字段：只关「尺寸」不会让信息区变空（还剩大小/时间），
    // 那样 total 根本不变，断言就成了空转（G9）。
    await sleep(200)
    const beforeField = await snap()
    await js(`(() => { const b = [...document.querySelectorAll('.chip-ft')][0]; b.click(); return true })()`)
    await sleep(700)
    const afterField = await snap()
    await js(`(() => { const b = [...document.querySelectorAll('.chip-ft')][0]; b.click(); return true })()`)
    await sleep(700)
    const restoredField = await snap()
    R.reorder = { before: beforeField, after: afterField, restored: restoredField }
    /**
     * 位置口径（同 M6）：断「锚点素材的屏幕位置没动 + 它仍在 DOM 里」。
     * ⚠️ 不再附加「|anchorId 差| ≤ 1」：位置断言已完全覆盖这条行为，id 相等只是它的一个
     * 必要条件（QA Round 2 指出这是纯冗余条件），留着反而多一个无关的假红通道 ——
     * 重排后「视口内第一条」换人但画面没动，是合法且无感的情形。
     */
    const reorderTop = await nodeTopInView(beforeField?.anchorId)
    check(
      '重排（关闭文件名 → 信息区变矮）后锚点素材位置不变（±10px，且仍在 DOM 里）、总高真的变了',
      (afterField?.total ?? 0) < (beforeField?.total ?? 0) &&
        reorderTop != null &&
        Math.abs(reorderTop - (beforeField?.anchorOffset ?? 0)) <= 10,
      {
        idB: beforeField?.anchorId,
        idA: afterField?.anchorId,
        totalB: beforeField?.total,
        totalA: afterField?.total,
        offB: beforeField?.anchorOffset,
        topA: reorderTop
      }
    )
    // 位置口径（同 M6）：再开回文件名后，锚点素材必须回到原来那个屏幕位置
    const restoredTop = await nodeTopInView(beforeField?.anchorId)
    check(
      '重排恢复后（再开回文件名）总高回到原值、锚点素材位置不变（±10px，且仍在 DOM 里）',
      (restoredField?.total ?? -1) === (beforeField?.total ?? -2) &&
        restoredTop != null &&
        Math.abs(restoredTop - (beforeField?.anchorOffset ?? 0)) <= 10,
      {
        id: beforeField?.anchorId,
        totalB: beforeField?.total,
        totalR: restoredField?.total,
        offB: beforeField?.anchorOffset,
        topR: restoredTop
      }
    )

    // ==================== 段 10–16：QA 补充（独立证伪，2026-10-25）====================
    //
    // M1–M8 覆盖的是「窗口生效 → DOM 少 → 帧率好」这条主链，但有四类退化它抓不到，
    // 下面每条都是对着一个具体的、能让 M1–M8 全绿的破坏写的：
    //   ① R3「缓冲被去掉」：`overscanPx` 固定成 0 时，窗口仍然精确覆盖可视区、
    //      M1 反而更小、M8 的 coverMiss 仍是 0 —— 全套指标绿。⇒ QA-1
    //   ② D5「框选命中未渲染条目」：设计稿只写了「人工检查」，没有断言。⇒ QA-2
    //   ③ 换查询（排序 / 筛选 / 关键词）必须回第一屏：与「锚点恢复」存在**竞态**
    //      （scroll 事件可能晚于 IPC 返回，把旧列表的 anchorId 写回去 → 跳到新结果的中段）。⇒ QA-3.x/QA-4/QA-5
    //   ④ 「items ≤ 窗口容量时必须全渲染」：设计 §8.5 明确要求 T04 专门断言，原套件没写。⇒ QA-6
    // 口径遵守 §10.3 纪律 4：数据基数读 `__vsDebug().n` / `dataTotal`；DOM 计数一律带上界或显式比较。

    /** 批量条的「已选 N 项」——选中集合在数据层，不受窗口影响 */
    const selCount = async (): Promise<number> =>
      ((await js(`(() => { const b = document.querySelector('.bb-count b'); return b ? Number(b.textContent) : 0 })()`)) as
        | number
        | null) ?? 0
    /** 滚到「可滚动范围」的某个比例位置（0..1）；等一下让窗口与布局 flush */
    const scrollToRatio = async (r: number): Promise<void> => {
      await js(
        `(() => { const w = document.querySelector('.grid-wrap'); w.scrollTop = Math.round((w.scrollHeight - w.clientHeight) * ${r}); return true })()`
      )
      await sleep(320)
    }
    const typeSearch = async (text: string): Promise<void> => {
      await js(`(() => {
        const el = document.querySelector('.search-input')
        if (!el) return
        el.value = ${JSON.stringify(text)}
        el.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
    }
    /** 点开第 n 个芯片下拉（0 = 评分，1 = 类型，2 = 排序 —— fav 芯片没有 .chip-menu-trigger） */
    const openChip = async (n: number): Promise<void> => {
      await js(`(() => { const b = document.querySelectorAll('.chip-menu-trigger')[${n}]; if (b) b.click(); return true })()`)
      await sleep(200)
    }
    /**
     * 为什么不再拿 `anchorId` 当「画面有没有跳」的判据：见文件上方 `nodeTopInView` 的注释 ——
     * `anchorId` 只在 `updateAnchor()` 里更新，锚点恢复被破坏时它【不会跟着变】，断言会假绿。
     */

    // —— QA-1：缓冲存在性（R3 的唯一可断言形态）——
    // 判据：内容中段时，被渲染的卡片里**必须同时有**完全在视口上方和下方的（即 overscan > 0）。
    // overscan = 0 时窗口只覆盖可视区，这两个数都会是 0，而这套 API 的其它指标全部照旧绿。
    await scrollToRatio(0.5)
    const bufInfo = (await js(`(() => {
      const w = document.querySelector('.grid-wrap')
      const wr = w.getBoundingClientRect()
      const rs = [...document.querySelectorAll('.masonry-card')].map((c) => c.getBoundingClientRect())
      return {
        rendered: rs.length,
        above: rs.filter((r) => r.bottom <= wr.top + 1).length,
        below: rs.filter((r) => r.top >= wr.bottom - 1).length
      }
    })()`)) as { rendered: number; above: number; below: number } | null
    R.qa_buffer = bufInfo
    check(
      'QA-1 内容中段窗口带上下缓冲（视口外仍有已渲染卡片；overscan 置 0 时必红）',
      !!bufInfo && bufInfo.above >= 1 && bufInfo.below >= 1 && bufInfo.rendered <= M1_SOFT_MAX,
      bufInfo
    )

    // —— QA-2：跨屏框选命中「未渲染但已加载」的卡片（D5）——
    // 用合成鼠标事件把框拖到视口下方 3 屏处（用户手拖不出视口，但 D5 承诺的是**几何判定**，
    // 不是「只判定渲染出来的 DOM」；这条同时验证 findRange 剪枝没有把区间剪错）。
    await scrollToRatio(0)
    await js(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()`)
    await sleep(150)
    await js(`(() => {
      const w = document.querySelector('.grid-wrap')
      const wr = w.getBoundingClientRect()
      const down = (x, y) => w.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1, clientX: x, clientY: y }))
      const mv = (x, y) => window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: x, clientY: y }))
      const up = (x, y) => window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, buttons: 1, clientX: x, clientY: y }))
      const x1 = Math.round(wr.left + 30)
      const x2 = Math.round(wr.left + Math.max(60, wr.width - 30))
      const y1 = Math.round(wr.top + 80)
      const y2 = Math.round(wr.top + wr.height * 3)
      down(x1, y1)
      mv(x1 + 3, y1 + 3)
      mv(Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2))
      mv(x2, y2)
      up(x2, y2)
      return true
    })()`)
    const bandSelected = await waitUntil("!!document.querySelector('.bb-count b')", 8000)
    await sleep(300)
    const bandSel = await selCount()
    const bandDom = (await js(`(() => ({
      rendered: document.querySelectorAll('.masonry-card').length,
      selectedDom: document.querySelectorAll('.masonry-card.selected').length,
      marqueeGone: !document.querySelector('.marquee')
    }))()`)) as { rendered: number; selectedDom: number; marqueeGone: boolean } | null
    R.qa_band = { selected: bandSel, dom: bandDom }
    check(
      'QA-2 跨屏框选选中了「未渲染但已加载」的卡片（选中数 > 渲染数，D5 核心承诺）',
      bandSelected && !!bandDom && bandSel > bandDom.rendered && bandDom.selectedDom < bandSel && bandSel >= 20,
      { selected: bandSel, rendered: bandDom?.rendered, selectedDom: bandDom?.selectedDom }
    )

    // —— QA-10：keepDepth 深浏览的**行为**验收（必须先于任何「换查询」段跑：换查询会把 n 重置成一页）——
    // ① 条数不缩水；② scrollTop 不被弹回；③ 锚点条目仍在 DOM 且在视口内；④ 顺序不乱、无重复。
    // 工程师的 R6 段只断言了 ①②，③④ 是「只钳不补」「补齐时 offset 用 rows.length 可能重复」的落点。
    await scrollToRatio(0.42)
    const beforeKeep = await snap()
    win.webContents.send('library:external', { added: 0, changed: 0, removed: 0, partial: false })
    // refresh({keepDepth}) 会把 1 万条按 1000/页补 10 次 IPC，给它一个收敛窗口再看
    await sleep(1600)
    const stripGone = await waitUntil("!document.querySelector('[data-load-strip]')", 20000)
    const afterKeep = await snap()
    const keepAnchorId = Number(beforeKeep?.anchorId ?? -1)
    const anchorProbe = (await js(`(() => {
      const c = document.querySelector('.masonry-card[data-id="' + ${keepAnchorId} + '"]')
      if (!c) return { found: false, visible: false, topInView: null }
      const wr = document.querySelector('.grid-wrap').getBoundingClientRect()
      const r = c.getBoundingClientRect()
      return { found: true, visible: r.bottom > wr.top && r.top < wr.bottom, topInView: Math.round(r.top - wr.top) }
    })()`)) as { found: boolean; visible: boolean; topInView: number | null } | null
    const keepOrder = (await js(`(() => {
      const ids = [...document.querySelectorAll('.masonry-card')].map((c) => Number(c.dataset.id))
      let desc = true
      for (let i = 1; i < ids.length; i++) if (ids[i] >= ids[i - 1]) desc = false
      return { n: ids.length, desc, uniq: new Set(ids).size }
    })()`)) as { n: number; desc: boolean; uniq: number } | null
    R.qa_keep = { before: beforeKeep, after: afterKeep, anchor: anchorProbe, order: keepOrder }
    check(
      'QA-10 keepDepth 深浏览：条数不缩水、scrollTop 不被弹回、锚点条目仍在视口内、顺序严格递减且无重复',
      stripGone &&
        afterKeep?.n === BIG_N &&
        (afterKeep?.scrollTop ?? 0) > 1000 &&
        Math.abs((afterKeep?.scrollTop ?? 0) - (beforeKeep?.scrollTop ?? 0)) <= 400 &&
        anchorProbe?.found === true &&
        anchorProbe?.visible === true &&
        Math.abs((anchorProbe?.topInView ?? 9999) - (beforeKeep?.anchorOffset ?? 0)) <= 4 &&
        keepOrder?.desc === true &&
        keepOrder?.uniq === keepOrder?.n,
      {
        n: afterKeep?.n,
        scrollTopB: beforeKeep?.scrollTop,
        scrollTopA: afterKeep?.scrollTop,
        anchorId: keepAnchorId,
        anchor: anchorProbe,
        order: keepOrder
      }
    )

    // —— QA-15：深滚动后换关键词 → 必须回第一屏（抓「锚点恢复 vs scroll 事件」的竞态）——
    // 机制：query watcher 会把 anchorId 清成 null 并把 scrollTop 写 0，但**写 0 会异步派发 scroll 事件**；
    // 若那个 scroll 事件晚于 `asset:list` 返回，`updateAnchor()` 就会把**旧列表**的 anchorId 写回去，
    // 而随后 layout watcher 看到「total 变了」= 重排 → 按旧锚点恢复 → 画面跳到新结果的中段。
    // 排序/筛选/关键词三条路径共用这个 watcher，所以这里换着关键词反复触发 6 次。
    const kwRuns: Array<Record<string, unknown>> = []
    for (let i = 0; i < 6; i++) {
      const kw = i % 2 === 0 ? 'v09' : ''
      const expectTotal = i % 2 === 0 ? 1000 : BIG_N
      await scrollToRatio(0.45)
      const deep = await snap()
      await typeSearch(kw)
      const settled = await waitUntil(
        `!!window.__vsDebug && window.__vsDebug().dataTotal === ${expectTotal}`,
        15000
      )
      // 多等一会儿：竞态造成的跳转通常在 refresh 落地之后的下一帧才发生
      await sleep(700)
      const s = await snap()
      const run = {
        kw,
        deepScrollTop: deep?.scrollTop,
        dataTotal: s?.dataTotal,
        scrollTop: s?.scrollTop,
        anchorId: s?.anchorId
      }
      kwRuns.push(run)
      check(
        `QA-15.${i + 1} 深滚动后改关键词（${kw || '空'}）回到第一屏：scrollTop = 0`,
        settled && s?.scrollTop === 0 && s?.dataTotal === expectTotal,
        run
      )
    }
    R.qa_kw = kwRuns

    // —— QA-3：改排序 → 必须回第一屏（反复 3 次，抓锚点恢复与 scroll 事件的竞态）——
    const sortRuns: Array<Record<string, unknown>> = []
    for (let i = 0; i < 3; i++) {
      await scrollToRatio(0.45)
      const deepSnap = await snap()
      await openChip(2)
      const picked = (await js(`(() => {
        const cur = document.querySelector('.chip-menu .chip-menu-item.on')?.getAttribute('data-sort') ?? 'imported_at'
        const want = cur === 'name' ? 'imported_at' : 'name'
        const el = document.querySelector('.chip-menu [data-sort="' + want + '"]')
        if (!el) return null
        el.click()
        return want
      })()`)) as string | null
      // 名称升序 ⇒ 第一条是 v00000.png；导入时间降序 ⇒ 第一条是 v09999.png
      const expectFirst = picked === 'name' ? 'v00000.png' : 'v09999.png'
      const settled = await waitUntil(
        `(() => { const c = document.querySelector('.masonry-card .ci-name'); return !!c && c.textContent.trim() === ${JSON.stringify(expectFirst)} })()`,
        15000
      )
      // 多等一会儿：如果「锚点恢复」错把旧列表的 anchorId 恢复回去，位移会在这之后才出现
      await sleep(650)
      const afterSort = await snap()
      const firstCard = (await js(
        `document.querySelector('.masonry-card .ci-name')?.textContent?.trim() ?? ''`
      )) as string
      const run = {
        picked,
        deepScrollTop: deepSnap?.scrollTop,
        scrollTopAfter: afterSort?.scrollTop,
        firstCard,
        dataTotal: afterSort?.dataTotal
      }
      sortRuns.push(run)
      check(
        `QA-3.${i + 1} 改排序（→${String(picked)}）后回到第一屏：scrollTop = 0 且首卡是新排序的第一条`,
        settled && afterSort?.scrollTop === 0 && firstCard === expectFirst && afterSort?.dataTotal === BIG_N,
        run
      )
    }
    R.qa_sort = sortRuns
    // 还原成默认排序（imported_at desc），后续段依赖「id 递减」这个顺序
    await openChip(2)
    await js(`(() => { const el = document.querySelector('.chip-menu [data-sort="imported_at"]'); if (el) el.click(); return true })()`)
    const firstIsNewest = (): Promise<boolean> =>
      waitUntil(
        `(() => { const c = document.querySelector('.masonry-card .ci-name'); return !!c && c.textContent.trim() === 'v09999.png' })()`,
        10000
      )
    if (!(await firstIsNewest())) {
      // 兜底：若「点当前维度」把升降序翻成了 asc，再点一次方向芯片翻回来
      await js(`(() => { const b = document.querySelector('.chip-order'); if (b) b.click(); return true })()`)
      await firstIsNewest()
    }
    await sleep(300)

    // —— QA-4 / QA-5：类型筛选 → 空结果 → 空态；切回 → 第一屏 ——
    await scrollToRatio(0.4)
    await openChip(1)
    await js(`(() => { const el = document.querySelector('.chip-menu [data-type="video"]'); if (el) el.click(); return true })()`)
    const emptySettled = await waitUntil('!!window.__vsDebug && window.__vsDebug().n === 0', 15000)
    await sleep(400)
    const emptySnap = await snap()
    const emptyDom = (await js(`(() => ({
      cards: document.querySelectorAll('.masonry-card').length,
      empty: !!document.querySelector('.empty'),
      text: (document.querySelector('.empty')?.textContent ?? '').replace(/\\s+/g, ' ').trim()
    }))()`)) as { cards: number; empty: boolean; text: string } | null
    R.qa_empty = { snap: emptySnap, dom: emptyDom }
    check(
      'QA-4 筛选到空结果：n = 0 / 无卡片 / 显示空态 / 不崩（0 条边界）',
      emptySettled && emptySnap?.n === 0 && emptySnap?.dataTotal === 0 && emptyDom?.cards === 0 && emptyDom?.empty === true,
      { n: emptySnap?.n, dataTotal: emptySnap?.dataTotal, dom: emptyDom }
    )
    await openChip(1)
    await js(`(() => { const el = document.querySelector('.chip-menu [data-type="image"]'); if (el) el.click(); return true })()`)
    const imgBackSettled = await waitUntil(
      '!!window.__vsDebug && window.__vsDebug().n === 200 && window.__vsDebug().dataTotal === 10000',
      15000
    )
    await sleep(500)
    const imgBackSnap = await snap()
    check(
      'QA-5 从空筛选切回「图片」：回到第一屏（scrollTop = 0）、数据基数 10000',
      imgBackSettled && imgBackSnap?.scrollTop === 0 && imgBackSnap?.dataTotal === BIG_N,
      { scrollTop: imgBackSnap?.scrollTop, n: imgBackSnap?.n, dataTotal: imgBackSnap?.dataTotal }
    )

    // —— QA-6 / QA-7 / QA-8：关键词 → 10 条（≤ 窗口容量必须全渲染）/ 1 条 / 0 条 ——
    await typeSearch('v0001')
    const tenSettled = await waitUntil(
      '!!window.__vsDebug && window.__vsDebug().n === 10 && window.__vsDebug().dataTotal === 10',
      15000
    )
    await sleep(400)
    const tenSnap = await snap()
    const tenDom = await domCards()
    R.qa_ten = { snap: tenSnap, dom: tenDom }
    check(
      'QA-6 「items ≤ 窗口容量 ⇒ 全渲染」（10 条结果渲染 10 个节点，设计 §8.5 的硬要求）',
      tenSettled && tenSnap?.n === 10 && tenSnap?.rendered === 10 && tenDom === 10,
      { n: tenSnap?.n, rendered: tenSnap?.rendered, dom: tenDom }
    )

    await typeSearch('v00019')
    const oneSettled = await waitUntil(
      '!!window.__vsDebug && window.__vsDebug().n === 1 && window.__vsDebug().dataTotal === 1',
      15000
    )
    await sleep(350)
    const oneSnap = await snap()
    // 右键菜单仍要工作（极小数据下窗口/空态不能把交互弄坏）
    await js(`(() => {
      const c = document.querySelector('.masonry-card')
      if (!c) return false
      c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }))
      return true
    })()`)
    await sleep(250)
    const oneMenu = (await js(`(() => ({
      cards: document.querySelectorAll('.masonry-card').length,
      menu: !!document.querySelector('.ctx-menu'),
      ctxHead: document.querySelector('.ctx-head')?.textContent?.trim() ?? null
    }))()`)) as { cards: number; menu: boolean; ctxHead: string | null } | null
    await js(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()`)
    await sleep(150)
    R.qa_one = { snap: oneSnap, dom: oneMenu }
    check(
      'QA-7 只有 1 条结果：渲染 1 个节点、右键菜单可开（1 条边界）',
      oneSettled && oneSnap?.rendered === 1 && oneMenu?.cards === 1 && oneMenu?.menu === true,
      { rendered: oneSnap?.rendered, dom: oneMenu }
    )

    await typeSearch('zzzz-no-match')
    const zeroSettled = await waitUntil('!!window.__vsDebug && window.__vsDebug().n === 0', 15000)
    await sleep(400)
    const zeroDom = (await js(`(() => ({
      cards: document.querySelectorAll('.masonry-card').length,
      empty: !!document.querySelector('.empty'),
      strip: !!document.querySelector('[data-load-strip]')
    }))()`)) as { cards: number; empty: boolean; strip: boolean } | null
    check(
      'QA-8 关键词 0 命中：无卡片、显示空态、不显示加载条',
      zeroSettled && zeroDom?.cards === 0 && zeroDom?.empty === true && zeroDom?.strip === false,
      zeroDom
    )
    // 清关键词，回到 1 万条
    await typeSearch('')
    const backSettled = await waitUntil(
      '!!window.__vsDebug && window.__vsDebug().n === 200 && window.__vsDebug().dataTotal === 10000',
      15000
    )
    check('QA-9 清空关键词后恢复第一页（200 / 10000）', backSettled, await snap())

    // —— QA-16：滚到**最底部**再切视图（「scrollTop 被浏览器夹到边界」的瞬态）——
    //
    // 为什么必须单独测：瀑布 100 条的内容高 ~4750px，列表只有 8+100×34+8 = 3416px。
    // 在瀑布底部切到列表时，锚点算出来的 scrollTop 会**超出列表的可滚范围**，浏览器会把它
    // 夹到 `scrollHeight - clientHeight`。若恢复逻辑用的还是「夹之前」的期望值（而不是读回
    // 的真实值），锚点就会换算成一个越界的 (id, offset)，下一次切回时按它恢复 → 直接跳到
    // 内容之外（一屏空白）或位置错乱。这正是「归一化用读回值」那处改动要防的瞬态。
    //
    // ⚠️ 夹具选择：必须让 `items.length === dataTotal`（关键词 'v000' 恰好命中 100 条，一页装得下）。
    // 否则「滚到底 → maybeLoadMore 追加下一页 → 内容变高、底部挪走」，夹具自己就在动，
    // 量到的既不是底也不是夹取瞬态（第一版就是这么假红的：scrollTop 9428 vs max 19530）。
    await typeSearch('v000')
    const clampReady = await waitUntil(
      '!!window.__vsDebug && window.__vsDebug().n === 100 && window.__vsDebug().dataTotal === 100',
      15000
    )
    // 滚两趟到底：第一趟越过 240px 阈值后 `.has-totop` 才出现，`padding-bottom` 会变大
    // （scrollHeight +≈52px），于是「刚才那个底」又不是底了。第二趟才落在稳定后的 max 上。
    await scrollToRatio(1)
    await sleep(250)
    await scrollToRatio(1)
    // 原子读：scrollTop 与 max 必须在同一次求值里取，否则滚动过程中的两次 IPC 会给出不一致的快照
    const scrollProbe = `(() => {
      const w = document.querySelector('.grid-wrap')
      const cs = [...document.querySelectorAll('.masonry-card')]
      return {
        scrollTop: Math.round(w.scrollTop),
        max: Math.round(w.scrollHeight - w.clientHeight),
        lastId: cs.length ? Number(cs[cs.length - 1].dataset.id) : null
      }
    })()`
    const bottomBefore = (await js(scrollProbe)) as { scrollTop: number; max: number; lastId: number | null } | null
    await js(`(() => { document.querySelectorAll('.viewtoggle button')[1].click(); return true })()`)
    await waitUntil("window.__vsDebug && window.__vsDebug().view === 'list'", 8000)
    await sleep(340)
    const inListBottom = (await js(scrollProbe)) as { scrollTop: number; max: number } | null
    const inListSnap = await snap()
    await js(`(() => { document.querySelectorAll('.viewtoggle button')[0].click(); return true })()`)
    await waitUntil("window.__vsDebug && window.__vsDebug().view === 'masonry'", 8000)
    await sleep(340)
    const backBottom = (await js(scrollProbe)) as { scrollTop: number; max: number } | null
    const backSnap = await snap()
    // 切回来后锚点素材必须仍在视口内（这才是「画面没跳到空处」的判据；
    // 不要求「最后一条仍在视口」—— 两套布局的行归属不同，D6 只承诺「锚点那条钉住」）
    const anchorBox = (await js(`(() => {
      const el = document.querySelector('[data-id="' + ${Number(backSnap?.anchorId ?? bottomBefore?.lastId ?? -1)} + '"]')
      if (!el) return null
      const wr = document.querySelector('.grid-wrap').getBoundingClientRect()
      const r = el.getBoundingClientRect()
      return { top: Math.round(r.top - wr.top), bottom: Math.round(r.bottom - wr.top), vh: Math.round(wr.height) }
    })()`)) as { top: number; bottom: number; vh: number } | null
    R.qa_bottom = {
      ready: clampReady,
      before: bottomBefore,
      inList: inListBottom,
      inListAnchor: inListSnap?.anchorId ?? null,
      back: backBottom,
      backAnchor: backSnap?.anchorId ?? null,
      backRendered: backSnap?.rendered ?? null,
      anchorBox
    }
    check(
      'QA-16 滚到最底部再视图往返（scrollTop 被夹取）：夹取真的发生、全程不越界、锚点素材仍在视口内',
      clampReady &&
        (bottomBefore?.scrollTop ?? -1) >= (bottomBefore?.max ?? 1e9) - 2 &&
        // 列表更短 ⇒ 恢复值必然被浏览器夹到 max：这一条同时证明「归一化用的是读回值」生效了
        (inListBottom?.scrollTop ?? -1) >= (inListBottom?.max ?? 1e9) - 1 &&
        (inListBottom?.scrollTop ?? 1e9) <= (inListBottom?.max ?? -1) + 1 &&
        (backBottom?.scrollTop ?? -1) >= 0 &&
        (backBottom?.scrollTop ?? 1e9) <= (backBottom?.max ?? -1) + 1 &&
        (backSnap?.rendered ?? 0) > 0 &&
        anchorBox != null &&
        anchorBox.top < anchorBox.vh &&
        anchorBox.bottom > 0,
      R.qa_bottom
    )
    await typeSearch('')
    await waitUntil('!!window.__vsDebug && window.__vsDebug().n === 200 && window.__vsDebug().dataTotal === 10000', 15000)
    await sleep(300)

    // —— QA-11：视图切换 3 次往返 ——
    // 判据打在「同一条素材的屏幕位置」上（见 nodeTopInView 的注释）：`anchorId` 在两套布局里
    // 定义不等价，拿它比 ±1 会在 `anchorOffset < 0` 时假红（工程师的 M6 断言就有这个隐患，
    // 只是它恰好滚到一个 anchorOffset≈0 的位置）。
    await scrollToRatio(0.5)
    const switchBase = await snap()
    const switchId = Number(switchBase?.anchorId ?? -1)
    const switchOff = switchBase?.anchorOffset ?? 0
    const switchProbe: Array<{ view: string; anchorId: number; top: number | null }> = []
    for (let i = 0; i < 3; i++) {
      await js(`(() => { document.querySelectorAll('.viewtoggle button')[1].click(); return true })()`)
      await waitUntil("window.__vsDebug && window.__vsDebug().view === 'list'", 8000)
      await sleep(340)
      const inList = await snap()
      switchProbe.push({ view: 'list', anchorId: inList?.anchorId ?? -1, top: await nodeTopInView(switchId) })
      await js(`(() => { document.querySelectorAll('.viewtoggle button')[0].click(); return true })()`)
      await waitUntil("window.__vsDebug && window.__vsDebug().view === 'masonry'", 8000)
      await sleep(340)
      const inMasonry = await snap()
      switchProbe.push({ view: 'masonry', anchorId: inMasonry?.anchorId ?? -1, top: await nodeTopInView(switchId) })
    }
    R.qa_switch = { id: switchId, offset: switchOff, probe: switchProbe }
    check(
      'QA-11 masonry ↔ list 反复 3 次往返：锚点素材仍在视口内同一位置（±10px，不随切换漂移）',
      switchProbe.length === 6 &&
        switchProbe.every((p) => p.top != null && Math.abs((p.top as number) - switchOff) <= 10),
      R.qa_switch
    )

    // 变宽到 1600：列数必须变多，锚点素材位置仍稳定（设计只测了变窄，变宽是另一条分支）
    const widenBefore = await snap()
    const widenId = Number(widenBefore?.anchorId ?? -1)
    const widenOff = widenBefore?.anchorOffset ?? 0
    win.setContentSize(1600, 800)
    await sleep(900)
    const widenAfter = await snap()
    const widenTop = await nodeTopInView(widenId)
    R.qa_widen = { before: widenBefore, after: widenAfter, anchorId: widenId, anchorTop: widenTop }
    check(
      'QA-12 窗口从 1280 拉宽到 1600（列数变化）：锚点素材位置稳定（±10px）、列数增加、总高变化',
      widenTop != null &&
        Math.abs(widenTop - widenOff) <= 10 &&
        (widenAfter?.cols ?? 0) > (widenBefore?.cols ?? 99) &&
        (widenAfter?.total ?? 0) !== (widenBefore?.total ?? -1),
      {
        colsB: widenBefore?.cols,
        colsA: widenAfter?.cols,
        offB: widenOff,
        topA: widenTop,
        totalB: widenBefore?.total,
        totalA: widenAfter?.total
      }
    )
    win.setContentSize(1280, 800)
    await sleep(800)

    // —— QA-13：既有交互不回归（在 1 万条大库上抽查，小库冒烟覆盖不到的窗口态）——
    await scrollToRatio(0.5)
    // Ctrl 多选：点第一张 → Ctrl 点第三张
    await js(`(() => {
      const cs = [...document.querySelectorAll('.masonry-card')]
      cs[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return true
    })()`)
    await sleep(300)
    await js(`(() => {
      const cs = [...document.querySelectorAll('.masonry-card')]
      cs[2].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
      return true
    })()`)
    const ctrlSel = await waitUntil('!!document.querySelector(".bb-count b") && Number(document.querySelector(".bb-count b").textContent) === 2', 6000)
    const ctrlSelN = await selCount()
    // 回到顶部浮标：深处必须出现，顶部必须消失（浮标有 160ms 的 leave 过渡，用轮询而不是一次抓）
    const topBtnDeep = await waitUntil("!!document.querySelector('[data-to-top]')", 4000)
    await scrollToRatio(0)
    const topBtnTop = await waitUntil("!document.querySelector('[data-to-top]')", 4000)
    // 右键菜单
    await js(`(() => {
      const c = document.querySelector('.masonry-card')
      if (!c) return false
      c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }))
      return true
    })()`)
    await sleep(250)
    const ctxOk = (await js(`!!document.querySelector('.ctx-menu')`)) === true
    await js(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()`)
    await sleep(150)
    // 搜索高亮 hlName
    await typeSearch('v0000')
    const hlOk = await waitUntil(
      "document.querySelectorAll('.masonry-card .ci-name mark').length >= 1",
      10000
    )
    const hlText = (await js(
      `[...document.querySelectorAll('.masonry-card .ci-name mark')].map((m) => m.textContent).join('|')`
    )) as string
    await typeSearch('')
    await waitUntil('!!window.__vsDebug && window.__vsDebug().dataTotal === 10000', 12000)
    await sleep(300)
    R.qa_interact = { ctrlSelN, ctrlSel, topBtnDeep, topBtnTop, ctxOk, hlOk, hlText }
    check(
      'QA-13 大库上既有交互不回归：Ctrl 多选 2 项 / 回顶浮标阈值 / 右键菜单 / hlName 高亮',
      ctrlSel && ctrlSelN === 2 && topBtnDeep && topBtnTop && ctxOk && hlOk && hlText.includes('v0000'),
      R.qa_interact
    )

    // —— QA-14：预览 ←/→ 仍走 items 全量（能翻到窗口外的条目）——
    // 打开「窗口最后一张」再按 →：若翻页被窗口限制，会停在同一张或窗口边界；
    // 正确实现应在 **已加载 items** 里前进，翻到未渲染的那一条。
    await scrollToRatio(0.5)
    await js(`(() => {
      const cs = [...document.querySelectorAll('.masonry-card')]
      const last = cs[cs.length - 1]
      if (!last) return false
      last.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      return true
    })()`)
    const pvOpen = await waitUntil("!!document.querySelector('.pv-name')", 8000)
    const pvName1 = (await js(`document.querySelector('.pv-name')?.textContent?.trim() ?? ''`)) as string
    await js(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); return true })()`)
    await sleep(400)
    const pvName2 = (await js(`document.querySelector('.pv-name')?.textContent?.trim() ?? ''`)) as string
    const pvRenderedNames = (await js(
      `[...document.querySelectorAll('.masonry-card .ci-name')].map((n) => n.textContent.trim())`
    )) as string[]
    await js(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()`)
    await sleep(250)
    const pvClosed = (await js(`!document.querySelector('.pv-name')`)) === true
    R.qa_preview = { pvOpen, pvName1, pvName2, pvClosed }
    check(
      'QA-14 预览 ←/→ 走 items 全量：从窗口最后一张按 → 能翻到「未渲染」的条目',
      pvOpen &&
        pvName1 !== '' &&
        pvName2 !== '' &&
        pvName1 !== pvName2 &&
        !pvRenderedNames.includes(pvName2),
      { from: pvName1, to: pvName2, renderedInDom: pvRenderedNames.length, closed: pvClosed }
    )

    // 收尾：清掉选中，避免影响退出链
    await js(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()`)
    await sleep(150)

    R.ok = Object.values(checks).every(Boolean)
  } catch (e) {
    R.ok = false
    R.error = String((e as Error).stack ?? e)
  } finally {
    R.checks = checks
    R.jsErrors = jsErrors
    if (jsErrors.length) R.rendererLogs = rendererLogs.filter((l) => /error|Error|warn|Warn/.test(l)).slice(-10)
    // 退出链（§10.1）：先停 chokidar，再关库，再删临时目录，最后才 app.exit
    unwatchLibrary()
    try {
      if (libPath) forgetLibrary(libPath)
    } catch (e) {
      R.cleanupError = String(e)
    }
    closeCurrent()
    try {
      if (dir) rmSync(dir, { recursive: true, force: true })
    } catch (e) {
      R.cleanupError = `${R.cleanupError ? `${R.cleanupError}；` : ''}临时目录清理失败：${String((e as Error).message ?? e)}`
    }
    console.log('[SMOKE-VSCROLL] ' + JSON.stringify(R))
    try {
      win.destroy()
    } catch {
      /* 窗口可能已被销毁 */
    }
    app.once('quit', () => process.exit(0))
    app.exit(0)
    // app.exit 之后仍有语句不执行的情况（历史踩过），尾部同步补刀
    process.exit(0)
  }
}
