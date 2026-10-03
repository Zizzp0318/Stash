// 搜索与筛选冒烟（M5）：关键词 / 标签 / 评分 / 喜欢 / 类型 / 排序 / 分页 / 组合，含 UI 驱动
//
// 素材刻意造得「有坑」：
//   - `100%.png` 与 `1000.png`、`a_b.png` 与 `axb.png` 成对出现，用来验证 LIKE 的 % 和 _
//     确实被转义成字面量（不转义时搜 `100%` 会连 `1000.png` 一起捞出来）
//   - `x&amp;y.png` 文件名里带 HTML 实体，用来验证高亮走的是「先转义再插 <mark>」，
//     不转义的话 `&amp;` 会被浏览器解析成 `&`，textContent 与真实文件名对不上
import { app, BrowserWindow } from 'electron'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { closeCurrent, createLibrary, deleteLibrary, requireCurrent } from './library'
import { createTag, listAssets, setTags, updateAsset } from './assets'
import { importFiles } from './importer'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 图片素材：[文件名, 宽, 高]，尺寸递增方便验证按大小排序 */
const IMAGES: Array<[string, number, number]> = [
  ['红色风景.png', 24, 24],
  ['blue sky.jpg', 40, 40],
  ['100%.png', 56, 56],
  ['1000.png', 64, 64],
  ['a_b.png', 72, 72],
  ['axb.png', 80, 80],
  ['a&b.png', 88, 88],
  ['x&amp;y.png', 96, 96]
]

/** 非图片素材（内容随意，搜的是元数据不是文件内容） */
const OTHERS: Array<[string, Buffer]> = [
  ['clip.mp4', Buffer.from('0000ftypisom-fake-video-bytes-0000000000')],
  ['track.mp3', Buffer.from('ID3fake-mp3-bytes-0000000000000000000000')],
  ['notes.txt', Buffer.from('hello world\nthis is a note used by the search smoke test\n')]
]

export async function runSmokeSearch(win: BrowserWindow): Promise<void> {
  const R: Record<string, unknown> = {}
  const jsErrors: Array<{ code: string; error: string }> = []
  const rendererLogs: string[] = []
  win.webContents.on('console-message', (_e, _lvl, message) => {
    rendererLogs.push(message.slice(0, 300))
    if (rendererLogs.length > 40) rendererLogs.shift()
  })
  // 泛型化：调用点可写 `js<boolean>(expr)` 拿到收窄类型（与 smoke-watch 的 js 同形）。
  // 默认 `T = unknown` → 既有的 `await js(...)` 行为不变；返回 `T | null` 表示「脚本出错时是 null」。
  const js = async <T = unknown>(code: string): Promise<T | null> => {
    try {
      return (await win.webContents.executeJavaScript(code)) as T
    } catch (e) {
      jsErrors.push({ code: code.replace(/\s+/g, ' ').slice(0, 160), error: String(e).slice(0, 160) })
      return null
    }
  }
  /** 不做错误包装的版本：`location.reload()` 会中断页面，executeJavaScript 必然 reject —— 不能算 jsError */
  const rawJs = (code: string): Promise<unknown> => win.webContents.executeJavaScript(code)
  const onceLoaded = (): Promise<void> =>
    new Promise((resolve) => win.webContents.once('did-finish-load', () => resolve()))

  let dir: string | null = null
  let libPath = ''
  /** 每次取实时手柄：渲染层 bootstrap() 可能替换掉当前库连接 */
  const D = (): ReturnType<typeof requireCurrent>['db'] => requireCurrent().db
  const step = (s: string): void => console.log('[SMOKE-SEARCH-STEP] ' + s)
  const capture = async (name: string): Promise<void> => {
    try {
      const img = await win.webContents.capturePage()
      writeFileSync(join(process.cwd(), name), img.toPNG())
    } catch (e) {
      R.shotError = String((e as Error).message ?? e)
    }
  }

  /** 走服务层查询：返回命中文件名（按当前排序）与总数 */
  const q = (query: Parameters<typeof listAssets>[0]): { total: number; names: string[]; sizes: number[]; ratings: number[]; ids: number[] } => {
    const r = listAssets(query)
    const items = r.items as Array<{ id: number; name: string; size: number; rating: number }>
    return {
      total: r.total,
      names: items.map((i) => i.name),
      sizes: items.map((i) => i.size),
      ratings: items.map((i) => i.rating),
      ids: items.map((i) => i.id)
    }
  }
  /** 单调性检查：sort 方向是否真的生效（比断言具体顺序更抗 collation 差异） */
  const monotonic = (arr: number[], dir: 'asc' | 'desc'): boolean =>
    arr.every((v, i) => i === 0 || (dir === 'asc' ? arr[i - 1] <= v : arr[i - 1] >= v))
  const sortedCopy = (arr: string[]): string[] => arr.slice().sort()

  /** 真人在搜索框里打字：直接派发 input 事件，v-model 会接住 */
  const typeSearch = async (text: string): Promise<void> => {
    await js(`(() => {
      const el = document.querySelector('.search-input')
      if (!el) return
      el.value = ${JSON.stringify(text)}
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    // ⚠️ 这里原来是 `await sleep(420)`（「300ms 防抖 + 一次查询」的**固定**估计）——
    // 机器一忙就不够，调用方会偶发拿到上一轮的结果（实测 `--smoke-search` 3 次里红 1 次，见 G12）。
    // 现在**不再在打字函数里赌时间**：派发 input 后立刻返回，
    // 由每个调用点用自己的 `waitUntil` 等「该关键词对应的 DOM 真的变了」再抓快照（见 G 段）。
  }
  /** 当前画廊里渲染出来的卡片文件名 */
  const cardNames = async (): Promise<string[]> =>
    ((await js(`[...document.querySelectorAll('.masonry-card')].map(c => c.querySelector('.ci-name')?.textContent ?? '')`)) as
      | string[]
      | null) ?? []
  /**
   * 轮询等待条件成立。
   * `typeSearch` 里的 `sleep(420)` 是「300ms 防抖 + 一次查询」的**固定**估计 —— 机器一忙就不够，
   * 抢跑的步骤会偶发拿到 null（实测 `--smoke-search` 3 次里红 1 次）。容易 flake 的步骤用这个。
   */
  const waitUntil = async (expr: string, timeoutMs = 8000): Promise<boolean> => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      if (await js<boolean>(expr)) return true
      await sleep(100)
    }
    return false
  }
  const clickSel = async (sel: string): Promise<boolean> =>
    ((await js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true })()`)) as
      | boolean
      | null) ?? false

  try {
    await sleep(1200)
    dir = mkdtempSync(join(tmpdir(), 'stash-smoke-search-'))
    libPath = createLibrary({ name: 'searchlib', parentDir: dir }).path

    // ==================== 造素材 ====================
    step('A-造素材')
    const srcFiles: string[] = []
    for (const [name, w, h] of IMAGES) {
      const p = join(dir, name)
      await sharp({ create: { width: w, height: h, channels: 3, background: { r: 120, g: 90, b: 60 } } })
        .png()
        .toFile(p)
      srcFiles.push(p)
    }
    for (const [name, buf] of OTHERS) {
      const p = join(dir, name)
      writeFileSync(p, buf)
      srcFiles.push(p)
    }

    const imported = await new Promise<{ added: number }>((resolve) =>
      importFiles({ paths: srcFiles, folderId: null, mode: 'copy', onDone: (x) => resolve(x) })
    )
    const assetRows = (): Array<{ id: number; name: string }> =>
      D().prepare('SELECT id, name FROM assets ORDER BY id').all() as never
    const idOf = (name: string): number => {
      const row = assetRows().find((a) => a.name === name)
      if (!row) throw new Error('素材不存在：' + name)
      return row.id
    }
    R.a_imported = { added: imported.added, rows: assetRows().length }

    // 标签：两个素材共享「风景」，其中一个额外挂「天空」
    const tagLandscape = createTag({ name: '风景' })
    const tagSky = createTag({ name: '天空' })
    setTags(idOf('红色风景.png'), [tagLandscape.id])
    setTags(idOf('blue sky.jpg'), [tagLandscape.id, tagSky.id])
    // 评分 / 喜欢：只给 3 个素材设置，留下大部分是 0 星未喜欢，筛选才有区分度
    updateAsset(idOf('红色风景.png'), { rating: 5, isFav: true })
    updateAsset(idOf('blue sky.jpg'), { rating: 3, isFav: true })
    updateAsset(idOf('100%.png'), { rating: 3 })
    R.a_setup = {
      total: assetRows().length,
      rated3plus: (D().prepare('SELECT count(*) c FROM assets WHERE rating >= 3').get() as { c: number }).c,
      fav: (D().prepare('SELECT count(*) c FROM assets WHERE is_fav = 1').get() as { c: number }).c
    }

    // ⚠️ 必须**自己**把渲染层带到这个库。A 段全是主进程侧操作（建库 / 导入 / 改 DB），
    // 渲染层只有在启动时靠 `bootstrap()` 自动恢复「最近库」这一条路 ——
    // 以前能进库视图，是因为**用户 config.json 里恰好有库**（本质上是撞运气，不是设计）；
    // 现在冒烟统一跑在一次性 userData 里（config 是空的），渲染层就停在欢迎页，
    // 从 `uiSearchResult` 起 37 条 UI 断言整片全垮。
    // 照 smoke-edit / smoke-compress 的做法：自己 open + reload + 等加载完。
    await rawJs(`window.stash.library.open(${JSON.stringify(libPath)}).then(() => location.reload())`)
    await onceLoaded()
    await sleep(2500)

    // ==================== B. 关键词搜索 + LIKE 转义 ====================
    step('B-关键词')
    R.b_keyword = {
      byName: q({ keyword: '红色' }),
      byTag: q({ keyword: '天空' }), // 纯标签命中（没有任何文件名含「天空」）
      sharedTag: q({ keyword: '风景' }), // 文件名命中 1 个 + 标签命中 1 个
      caseInsensitive: q({ keyword: 'BLUE' })
    }
    // LIKE 转义的核心：% 与 _ 必须当字面量
    R.b_escape = {
      percent: q({ keyword: '100%' }), // 不转义会连 1000.png 一起捞出
      percentBare: q({ keyword: '%' }), // 全库只有 100%.png 含字面 %
      underscore: q({ keyword: 'a_b' }), // 不转义会连 axb.png 一起捞出（_ 匹配任意单字符）
      underscoreBare: q({ keyword: '_' }),
      axb: q({ keyword: 'axb' }), // 反向验证 axb 自己能被搜到
      backslash: q({ keyword: '\\' }) // 反斜杠自身，全库无此字符应为 0
    }

    // ==================== C. 评分 / 喜欢 / 类型 ====================
    step('C-筛选维度')
    R.c_filters = {
      rating3: q({ rating: 3 }),
      rating5: q({ rating: 5 }),
      fav: q({ fav: true }),
      image: q({ type: 'image' }),
      video: q({ type: 'video' }),
      audio: q({ type: 'audio' }),
      text: q({ type: 'text' })
    }

    // ==================== D. 组合筛选（AND 语义）====================
    step('D-组合')
    R.d_combo = {
      imageAndRating3: q({ type: 'image', rating: 3 }),
      kw100AndImage: q({ keyword: '100', type: 'image' }),
      favAndRating5: q({ fav: true, rating: 5 }),
      noneMatch: q({ keyword: '红色', type: 'video' }) // 互相矛盾 → 0
    }

    // ==================== E. 排序 ====================
    step('E-排序')
    const bySizeDesc = q({ sort: 'size', order: 'desc' })
    const bySizeAsc = q({ sort: 'size', order: 'asc' })
    const byNameAsc = q({ sort: 'name', order: 'asc' })
    const byNameDesc = q({ sort: 'name', order: 'desc' })
    const byRatingDesc = q({ sort: 'rating', order: 'desc' })
    const byImportedDesc = q({ sort: 'imported_at', order: 'desc' })
    R.e_sort = {
      sizeDesc: bySizeDesc,
      sizeAsc: bySizeAsc,
      nameAscCount: byNameAsc.total,
      nameDescCount: byNameDesc.total,
      // 同维度正反序必须互为逆序 —— 这个断言不依赖具体 collation，最稳
      nameAscIsReverseOfDesc: byNameAsc.names.join('|') === byNameDesc.names.slice().reverse().join('|'),
      nameAscIsSorted: byNameAsc.names.join('|') === sortedCopy(byNameAsc.names).join('|'),
      sizeDescCount: bySizeDesc.total,
      sizeDescMonotonic: monotonic(bySizeDesc.sizes, 'desc'),
      sizeAscMonotonic: monotonic(bySizeAsc.sizes, 'asc'),
      ratingDesc: byRatingDesc,
      ratingDescMonotonic: monotonic(byRatingDesc.ratings, 'desc'),
      importedDescCount: byImportedDesc.total,
      // 非法 sort 值必须回落到默认列而不是拼进 SQL
      badSortFallback: q({ sort: 'name; DROP TABLE assets' as never })
    }

    // ==================== F. 分页 ====================
    step('F-分页')
    const all = q({})
    // 11 个素材按 4 条一页切，三次刚好走完且不重叠
    const p1 = q({ limit: 4, offset: 0 })
    const p2 = q({ limit: 4, offset: 4 })
    const p3 = q({ limit: 4, offset: 8 })
    const walked = new Set([...p1.ids, ...p2.ids, ...p3.ids])
    R.f_page = {
      total: all.total,
      p1Count: p1.ids.length,
      p2Count: p2.ids.length,
      p3Count: p3.ids.length,
      p1p2Overlap: p1.ids.filter((i) => p2.ids.includes(i)).length,
      walkedCount: walked.size,
      // 逐页走完必须恰好覆盖全部素材，且没有重复（重复说明排序不稳定，翻页会漏项）
      walkedCoversAll: walked.size === all.total && all.total === 11
    }

    // ==================== G. UI：搜索框 / 高亮 / 空态 / 清除 ====================
    step('G-UI')
    await sleep(200)

    // ⚠️ G 段连调 4 次搜索、每次都要等「该关键词对应的 DOM 真的变了」再抓快照（G4/G12）。
    // 原来只有空态那一步等到位，前三次是「打字后立即抓」→ 抢跑会一次抓取级联红 6 条。
    // 每一步都把 `waitUntil` 的返回值并入该步的断言：**超时必须能红**，不能只靠后面的快照兜底（G11）。

    // '100%'：唯一命中 100%.png —— 等卡片集合真的变成它
    await typeSearch('100%')
    const gSearchReady = await waitUntil(
      "document.querySelectorAll('.masonry-card').length === 1 && document.querySelector('.masonry-card .ci-name')?.textContent?.trim() === '100%.png'"
    )
    R.gSearch = {
      ready: gSearchReady,
      cards: await cardNames(),
      total: await js(`document.querySelector('.toolbar .total')?.textContent.trim() ?? null`),
      clearChip: await js(`document.querySelector('.chip-clear')?.getAttribute('data-count') ?? null`)
    }
    await capture('shot-search-keyword.png')

    // 高亮：命中片段被包成 <mark>，且内容就是关键词本身
    // —— 等「高亮片段」真的出现（不是等某个倒计时）
    await typeSearch('红色')
    const gHighlightReady = await waitUntil(
      "[...document.querySelectorAll('.masonry-card .ci-name mark')].map((m) => m.textContent).join('|') === '红色'"
    )
    R.g_highlight = {
      ready: gHighlightReady,
      marks: await js(`[...document.querySelectorAll('.masonry-card .ci-name mark')].map(m => m.textContent)`),
      fullName: await js(`document.querySelector('.masonry-card .ci-name')?.textContent ?? null`),
      rawHTML: await js(`document.querySelector('.masonry-card .ci-name')?.innerHTML ?? null`)
    }

    // HTML 转义：文件名 x&amp;y.png 必须逐字显示，不能被解析成 x&y.png
    // —— 等「那个带实体的文件名」真的出现在卡片列表里
    await typeSearch('y.png')
    const gEscapeReady = await waitUntil(
      "[...document.querySelectorAll('.masonry-card .ci-name')].map((e) => e.textContent).includes('x&amp;y.png')"
    )
    R.g_escape = {
      ready: gEscapeReady,
      text: await js(`[...document.querySelectorAll('.masonry-card .ci-name')].map(e => e.textContent)`),
      // 转义正确时 DOM 里只有一个文本节点，不会凭空多出元素
      childElements: await js(
        `[...document.querySelectorAll('.masonry-card .ci-name')].map(e => e.children.length)`
      )
    }

    // 空结果：文案要区分「没有匹配」而不是「暂无素材」
    await typeSearch('zzz绝不存在的关键词')
    // ⚠️ 必须等空状态**真的渲染出来**再读/点：抢跑时 `.empty .w-btn` 是 null，
    // 下一次点击会抛 TypeError，更麻烦的是**筛选没被清掉** → 后面一整片依赖
    // 「列表回到 11 项」的断言级联失败（实测 3 次里红 1 次，纯 flake）。
    const emptyReady = await waitUntil("!!document.querySelector('.empty .w-btn')")
    R.g_empty = {
      ready: emptyReady,
      items: (await cardNames()).length,
      text: await js(`document.querySelector('.empty')?.textContent.replace(/\\s+/g, ' ').trim() ?? null`),
      hasSub: await js(`!!document.querySelector('.empty-sub')`),
      clearBtn: await js(`document.querySelector('.empty .w-btn')?.textContent.trim() ?? null`)
    }

    // 清除筛选：列表恢复全量、搜索框同步清空、清除按钮消失
    // 原来固定 sleep(500) 等它生效 —— Round 1 注入验证时这一步的 4 条断言正是「同一次抓取的级联红」。
    // 改成有界轮询「列表回到 11 项 + 搜索框清空 + 清除按钮消失」，并把结果并入断言（超时→明确红）。
    await js(`document.querySelector('.empty .w-btn')?.click(); true`)
    const gClearedReady = await waitUntil(
      "document.querySelectorAll('.masonry-card').length === 11 && document.querySelector('.search-input')?.value === '' && !document.querySelector('.chip-clear')"
    )
    R.g_cleared = {
      ready: gClearedReady,
      count: (await cardNames()).length,
      total: await js(`document.querySelector('.toolbar .total')?.textContent.trim() ?? null`),
      searchValue: await js(`document.querySelector('.search-input')?.value ?? null`),
      clearChipGone: !(await js(`!!document.querySelector('.chip-clear')`))
    }

    // ==================== H. UI：类型 / 评分 / 排序三个下拉 ====================
    step('H-下拉菜单')
    /**
     * 四个筛选芯片已改成纯图标，状态文案不再显示在芯片上，改由 title 承载。
     * 因此断言读 title 而不是 textContent。
     */
    const chipTitle = async (chip: string): Promise<string | null> =>
      (await js(`document.querySelector('[data-chip="${chip}"]')?.getAttribute('title') ?? null`)) as string | null

    // H0 芯片形态：四个芯片必须「只有图标、没有文字」，且尺寸比原来的文字芯片大
    R.h_iconOnly = await js(`(() => {
      const out = []
      for (const key of ['rating', 'fav', 'type', 'sort']) {
        const el = document.querySelector('[data-chip="' + key + '"]')
        if (!el) { out.push({ key, missing: true }); continue }
        const box = el.getBoundingClientRect()
        const svg = el.querySelector('svg')
        const sb = svg ? svg.getBoundingClientRect() : null
        out.push({
          key,
          text: (el.textContent || '').replace(/\\s+/g, ''),        // 必须为空字符串
          svgCount: el.querySelectorAll('svg').length,
          w: Math.round(box.width),
          h: Math.round(box.height),
          iconW: sb ? Math.round(sb.width) : 0
        })
      }
      return { chips: out }
    })()`)

    // H1 类型下拉
    const typeChipOpened = await clickSel('[data-chip="type"]')
    await sleep(250)
    R.h_typeMenu = {
      opened: typeChipOpened,
      items: await js(`[...document.querySelectorAll('.chip-menu-item')].map(e => e.textContent.trim())`),
      active: await js(`document.querySelector('.chip-menu-item.on')?.getAttribute('data-type') ?? null`)
    }
    await capture('shot-search-typemenu.png')

    await clickSel('.chip-menu-item[data-type="video"]')
    await sleep(450)
    R.h_typeApplied = {
      cards: await cardNames(),
      chipTitle: await chipTitle('type'),
      menuGone: !(await js(`!!document.querySelector('.chip-menu')`)),
      total: await js(`document.querySelector('.toolbar .total')?.textContent.trim() ?? null`),
      // 切换类型后，类型芯片的图标应该换成「视频」那一个（形状编码类别）
      iconMark: await js(`document.querySelector('[data-chip="type"] svg g')?.getAttribute('data-icon') ?? null`)
    }

    // H1.5 立刻把类型恢复「全部」：后面的评分/排序都要在完整 11 项上验证。
    // 否则评分筛选会叠在「只剩 1 个视频」上恒为 0 项，断言毫无区分度。
    await clickSel('[data-chip="type"]')
    await sleep(200)
    await clickSel('.chip-menu-item[data-type="all"]')
    await sleep(450)
    R.h_orderReset = { count: (await cardNames()).length }

    // H2 评分下拉（原来这里是「点一下 +1 星」的循环式芯片）
    await clickSel('[data-chip="rating"]')
    await sleep(250)
    R.h_ratingMenu = {
      items: await js(`[...document.querySelectorAll('.chip-menu-item')].map(e => e.getAttribute('data-rating'))`),
      labels: await js(`[...document.querySelectorAll('.chip-menu-item')].map(e => e.getAttribute('title'))`),
      active: await js(`document.querySelector('.chip-menu-item.on')?.getAttribute('data-rating') ?? null`),
      // 「3 星及以上」这一项应该正好点亮 3 颗星（其余带 off）
      filled: await js(`document.querySelectorAll('.chip-menu-item[data-rating="3"] .cmi-star:not(.off)').length`)
    }
    await capture('shot-search-ratingmenu.png')
    await clickSel('.chip-menu-item[data-rating="3"]')
    await sleep(450)
    R.h_ratingApplied = {
      names: await cardNames(),
      chipTitle: await chipTitle('rating'),
      menuGone: !(await js(`!!document.querySelector('.chip-menu')`)),
      clearChip: await js(`document.querySelector('.chip-clear')?.getAttribute('data-count') ?? null`),
      // 清除筛选芯片是同一行里唯一保留文字的按钮，用来对照「四个筛选芯片确实没有文字」
      clearText: await js(`document.querySelector('.chip-clear')?.textContent.replace(/\\s+/g, ' ').trim() ?? null`),
      clearH: await js(`Math.round(document.querySelector('.chip-clear')?.getBoundingClientRect().height ?? 0)`),
      total: await js(`document.querySelector('.toolbar .total')?.textContent.trim() ?? null`),
      // 生效时星星要变实心（fill 不再是 none）
      starFilled: await js(`document.querySelector('[data-chip="rating"] path')?.getAttribute('fill') ?? null`)
    }

    // 恢复「不限」：下面的方向按钮断言需要完整 11 项列表
    await clickSel('[data-chip="rating"]')
    await sleep(200)
    await clickSel('.chip-menu-item[data-rating="0"]')
    await sleep(450)
    R.h_ratingReset = {
      count: (await cardNames()).length,
      clearGone: !(await js(`!!document.querySelector('.chip-clear')`)),
      starFilled: await js(`document.querySelector('[data-chip="rating"] path')?.getAttribute('fill') ?? null`)
    }

    // H3 排序方向按钮（列表此时已回到完整 11 项，翻转方向必然改变首项）
    const orderBefore = await js(`document.querySelector('.chip-order')?.getAttribute('data-order') ?? null`)
    const firstBefore = (await cardNames())[0] ?? null
    await clickSel('.chip-order')
    await sleep(450)
    R.h_order = {
      before: orderBefore,
      after: await js(`document.querySelector('.chip-order')?.getAttribute('data-order') ?? null`),
      firstBefore,
      firstAfter: (await cardNames())[0] ?? null
    }

    // H4 排序下拉：换维度到「名称」
    await clickSel('[data-chip="sort"]')
    await sleep(250)
    R.h_sortMenu = {
      items: await js(`[...document.querySelectorAll('.chip-menu-item')].map(e => e.textContent.replace(/[↑↓\\s]/g, ''))`),
      active: await js(`document.querySelector('.chip-menu-item.on')?.getAttribute('data-sort') ?? null`),
      dirMark: await js(`document.querySelector('.chip-menu-item.on .cmi-dir')?.textContent ?? null`)
    }
    await capture('shot-search-sortmenu.png')
    await clickSel('.chip-menu-item[data-sort="name"]')
    await sleep(450)
    R.h_sortApplied = {
      names: await cardNames(),
      chipTitle: await chipTitle('sort'),
      menuGone: !(await js(`!!document.querySelector('.chip-menu')`)),
      // 排序维度换到「名称」后，排序芯片的图标也要跟着换成「名称」那个
      iconMark: await js(`document.querySelector('[data-chip="sort"] svg g')?.getAttribute('data-icon') ?? null`),
      // UI 顺序必须等于后端同参数查询的顺序，而不是只看芯片文案变了
      expected: q({ sort: 'name', order: 'asc' }).names
    }

    // H5 点开菜单再点「当前维度」本身 = 翻转升降序（不能原地不动）
    await clickSel('[data-chip="sort"]')
    await sleep(250)
    const sortDirBefore = await js(`document.querySelector('.chip-menu-item.on .cmi-dir')?.textContent ?? null`)
    await clickSel('.chip-menu-item[data-sort="name"]')
    await sleep(450)
    R.h_sortFlip = {
      dirBefore: sortDirBefore,
      names: await cardNames(),
      expected: q({ sort: 'name', order: 'desc' }).names,
      orderAttr: await js(`document.querySelector('.chip-order')?.getAttribute('data-order') ?? null`)
    }

    await capture('shot-search-done.png')

    // ==================== 断言汇总 ====================
    const nameSet = (v: { names: string[] }): string => v.names.slice().sort().join('|')
    const b = R.b_keyword as Record<string, { total: number; names: string[] }>
    const be = R.b_escape as Record<string, { total: number; names: string[] }>
    const c = R.c_filters as Record<string, { total: number; names: string[] }>
    const d = R.d_combo as Record<string, { total: number; names: string[] }>
    const e = R.e_sort as Record<string, unknown>
    const f = R.f_page as Record<string, unknown>
    const gHl = R.g_highlight as { ready: boolean; marks: string[] | null; fullName: string | null; rawHTML: string | null }
    const gEs = R.g_escape as { ready: boolean; text: string[] | null; childElements: number[] | null }
    const gEm = R.g_empty as { ready: boolean; items: number; text: string | null; clearBtn: string | null }
    const gCl = R.g_cleared as {
      ready: boolean
      count: number
      total: string | null
      searchValue: string | null
      clearChipGone: boolean
    }
    const gSe = R.gSearch as { ready: boolean; cards: string[] | null; total: string | null; clearChip: string | null }
    const hTm = R.h_typeMenu as { items: string[] | null; active: string | null }
    const hIc = R.h_iconOnly as {
      chips: Array<{ key: string; text?: string; svgCount?: number; w?: number; h?: number; iconW?: number; missing?: boolean }>
    }
    const iconChips = hIc?.chips ?? []
    const hTa = R.h_typeApplied as {
      cards: string[]; chipTitle: string | null; menuGone: boolean; total: string | null; iconMark: string | null
    }
    const hOr = R.h_order as { before: string | null; after: string | null; firstBefore: string | null; firstAfter: string | null }
    const hRm = R.h_ratingMenu as { items: string[] | null; labels: string[] | null; active: string | null; filled: number }
    const hRa = R.h_ratingApplied as {
      names: string[]; chipTitle: string | null; menuGone: boolean; clearChip: string | null
      clearText: string | null; clearH: number; total: string | null; starFilled: string | null
    }
    const hRr = R.h_ratingReset as { count: number; clearGone: boolean; starFilled: string | null }
    const hSm = R.h_sortMenu as { items: string[] | null; active: string | null; dirMark: string | null }
    const hSa = R.h_sortApplied as {
      names: string[]; chipTitle: string | null; menuGone: boolean; iconMark: string | null; expected: string[]
    }
    const hSf = R.h_sortFlip as { dirBefore: string | null; names: string[]; expected: string[]; orderAttr: string | null }
    const a = R.a_imported as { added: number; rows: number }
    const aS = R.a_setup as { total: number; rated3plus: number; fav: number }

    R.checks = {
      // A 素材就位（11 个：8 图 + 1 视频 + 1 音频 + 1 文本）
      importedAll: a?.added === 11 && a?.rows === 11,
      setupApplied: aS?.rated3plus === 3 && aS?.fav === 2,

      // B 关键词：文件名 / 标签名 / 大小写
      searchByName: b?.byName?.total === 1 && b.byName.names[0] === '红色风景.png',
      searchByTagOnly: b?.byTag?.total === 1 && b.byTag.names[0] === 'blue sky.jpg',
      searchNameOrTag: b?.sharedTag?.total === 2,
      searchCaseInsensitive: b?.caseInsensitive?.total === 1,

      // B 核心：LIKE 通配符必须被转义成字面量
      likePercentEscaped: be?.percent?.total === 1 && be.percent.names[0] === '100%.png',
      likePercentBare: be?.percentBare?.total === 1 && be.percentBare.names[0] === '100%.png',
      likeUnderscoreEscaped: be?.underscore?.total === 1 && be.underscore.names[0] === 'a_b.png',
      likeUnderscoreBare: be?.underscoreBare?.total === 1 && be.underscoreBare.names[0] === 'a_b.png',
      likePlainStillWorks: be?.axb?.total === 1 && be.axb.names[0] === 'axb.png',
      likeBackslashEscaped: be?.backslash?.total === 0,

      // C 单维度筛选
      ratingAtLeast: c?.rating3?.total === 3,
      ratingTop: c?.rating5?.total === 1 && c.rating5.names[0] === '红色风景.png',
      favOnly: c?.fav?.total === 2,
      typeImage: c?.image?.total === 8,
      typeVideo: c?.video?.total === 1 && c.video.names[0] === 'clip.mp4',
      typeAudio: c?.audio?.total === 1 && c.audio.names[0] === 'track.mp3',
      typeText: c?.text?.total === 1 && c.text.names[0] === 'notes.txt',

      // D 组合筛选是 AND 语义
      comboImageRating: d?.imageAndRating3?.total === 3,
      comboKeywordType: d?.kw100AndImage?.total === 2 && nameSet(d.kw100AndImage) === ['100%.png', '1000.png'].sort().join('|'),
      comboFavRating: d?.favAndRating5?.total === 1,
      comboContradictory: d?.noneMatch?.total === 0,

      // E 排序
      sortNameReverse: e?.nameAscIsReverseOfDesc === true && e?.nameAscIsSorted === true,
      sortSizeDesc: e?.sizeDescMonotonic === true && (e?.sizeDescCount as number) === 11,
      sortSizeAsc: e?.sizeAscMonotonic === true,
      sortSizeDiffers: (e?.sizeDesc as { names: string[] })?.names[0] !== (e?.sizeAsc as { names: string[] })?.names[0],
      sortRatingDesc: e?.ratingDescMonotonic === true &&
        ((e?.ratingDesc as { ratings: number[] })?.ratings[0] ?? 0) === 5,
      sortImportedDesc: (e?.importedDescCount as number) === 11,
      // 非法 sort 必须被白名单挡下（不能拼进 SQL）
      sortInjectionBlocked: (e?.badSortFallback as { total: number })?.total === 11,

      // F 分页
      pageSlices: (f?.p1Count as number) === 4 && (f?.p2Count as number) === 4 &&
        (f?.p3Count as number) === 3 && (f?.p1p2Overlap as number) === 0,
      pageWalksAll: f?.walkedCoversAll === true,

      // G UI 搜索（`ready` 是防假绿的闸门：没等到「该关键词对应的结果」就不算通过 —— 见 G11）
      uiSearchResult: gSe?.ready === true && gSe?.cards?.length === 1 && gSe?.cards?.[0] === '100%.png',
      uiSearchCount: gSe?.ready === true && gSe?.total?.includes('/') === true,
      uiClearChipShown: gSe?.ready === true && gSe?.clearChip === '1',

      // G 高亮（关键词被包成 mark，且文本就是关键词）；`ready` 同上，超时必须红
      highlightMarks: gHl?.ready === true && Array.isArray(gHl?.marks) && gHl.marks.length === 1 && gHl.marks[0] === '红色',
      highlightKeepsFullName: gHl?.fullName === '红色风景.png',
      highlightHTMLWellFormed: typeof gHl?.rawHTML === 'string' && /^<mark>红色<\/mark>风景\.png$/.test(gHl.rawHTML),

      // G HTML 转义（文件名里的 &amp; 必须逐字显示，不能被解析成 &）；`ready` 同上
      escapeEntityPreserved: gEs?.ready === true && Array.isArray(gEs?.text) && gEs.text.includes('x&amp;y.png'),
      escapeNoInjectedNodes: Array.isArray(gEs?.childElements) && gEs.childElements.every((n) => n <= 1),

      // G 空态：文案要指向「筛选」而不是「去导入」
      // （`ready` 是防假绿的闸门：没等到空状态就不算通过）
      emptyCopyFiltered: gEm?.ready === true &&
        /没有匹配的素材/.test(gEm?.text ?? '') && !/暂无素材/.test(gEm?.text ?? ''),
      emptyHasClearButton: gEm?.ready === true && (gEm?.clearBtn ?? '').includes('清除筛选'),

      // G 清除筛选：列表恢复、搜索框同步清空、按钮消失、分母回归「个文件」
      // （`ready` = 「清除筛选已生效」这一步的轮询结果，防假绿闸门，见 G11：超时→这几条明确红）
      clearRestoresAll: gCl?.ready === true && gCl?.count === 11,
      clearSyncsSearchBox: gCl?.ready === true && gCl?.searchValue === '',
      clearHidesChip: gCl?.ready === true && gCl?.clearChipGone === true,
      clearCountLabel: gCl?.ready === true && /个文件/.test(gCl?.total ?? '') && !/\//.test(gCl?.total ?? ''),

      // H0 芯片形态：评分/喜欢/类型/排序四个芯片必须是「纯图标」——
      // 无文字节点、恰好一个 svg、32×32 方形（比原来的 26 高文字芯片大）、图标 17px
      chipsAreIconOnly: iconChips.length === 4 && iconChips.every((c) => !c.missing && c.text === ''),
      chipsHaveSingleIcon: iconChips.length === 4 && iconChips.every((c) => c.svgCount === 1),
      chipsAreSquare32: iconChips.length === 4 && iconChips.every((c) => c.w === 32 && c.h === 32),
      chipsIconIsBigger: iconChips.length === 4 && iconChips.every((c) => (c.iconW ?? 0) === 17),
      // 清除筛选芯片是同行唯一保留文字的按钮（高度与图标芯片齐平）
      clearChipKeepsText: /清除筛选/.test(hRa?.clearText ?? '') && hRa?.clearH === 32,

      // H 类型弹层
      typeMenuItems: hTm?.items?.join('|') === '全部类型|图片|视频|音频|文本',
      typeMenuDefaultActive: hTm?.active === 'all',
      typeMenuApplies: hTa?.cards?.length === 1 && hTa.cards[0] === 'clip.mp4',
      // 芯片不再有文字，状态改由 title 与图标形状承载
      typeMenuCloses: hTa?.menuGone === true && /视频/.test(hTa?.chipTitle ?? ''),
      typeMenuCountLabel: hTa?.total?.includes('/') === true,
      typeChipIconSwitches: hTa?.iconMark === 'video',

      // H2 评分下拉：6 档（含「不限」）、默认选中不限、星星数要跟档位对上
      ratingMenuItems: hRm?.items?.join('|') === '0|1|2|3|4|5',
      ratingMenuLabels: hRm?.labels?.join('|') === '不限评分|1 星及以上|2 星及以上|3 星及以上|4 星及以上|5 星',
      ratingMenuDefaultActive: hRm?.active === '0',
      ratingMenuStarsFilled: hRm?.filled === 3,
      // 应用后只剩 3 个 ≥3 星素材，芯片 title 带上档位、星星变实心，清除筛选计数 = 1
      ratingMenuApplies: hRa?.names?.length === 3 && hRa?.menuGone === true &&
        /≥3 星/.test(hRa?.chipTitle ?? '') && hRa?.clearChip === '1',
      ratingChipStarFills: hRa?.starFilled === 'currentColor' && hRr?.starFilled === 'none',
      // 选回「不限」要能真正解除筛选（列表回 11 项、清除按钮消失）。
      // 这里带上 hRa 的前提：否则「筛选压根没生效过」时列表本来就是 11 项，断言会假绿。
      ratingMenuResets: hRa?.names?.length === 3 &&
        hRr?.count === 11 && hRr?.clearGone === true,

      // H 排序方向（重置为全部类型后列表有 11 项，方向翻转必然改变首项）
      orderToggles: hOr?.before === 'desc' && hOr?.after === 'asc',
      orderChangesOrder: (hOr?.firstBefore ?? '') !== (hOr?.firstAfter ?? '') &&
        (R.h_orderReset as { count: number })?.count === 11,

      // H4 排序下拉：菜单四项齐全、当前维度有方向标记；
      // 选「名称」后 UI 顺序必须等于后端同参数查询的顺序（不能只看芯片文案变了）
      sortMenuItems: hSm?.items?.join('|') === '导入时间|名称|大小|评分',
      sortMenuMarksCurrent: hSm?.active === 'imported_at' && (hSm?.dirMark === '↑' || hSm?.dirMark === '↓'),
      sortMenuApplies: hSa?.menuGone === true && /名称/.test(hSa?.chipTitle ?? '') &&
        (hSa?.names ?? []).length === 11 &&
        (hSa?.names ?? []).join('|') === (hSa?.expected ?? []).join('|'),
      sortChipIconSwitches: hSa?.iconMark === 'name',
      // H5 在菜单里点当前维度本身 = 翻转方向（切换维度会顺带把方向重置成该维度的默认值）
      sortMenuFlipsOnSameField: hSf?.orderAttr === 'desc' &&
        (hSf?.names ?? []).length === 11 &&
        (hSf?.names ?? []).join('|') === (hSf?.expected ?? []).join('|'),

      // 渲染层不应有 JS 报错（v-html / 正则构造出错都会在这里露出来）
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
    console.log('[SMOKE-SEARCH] ' + JSON.stringify(R))
    app.exit(0)
  }
}
