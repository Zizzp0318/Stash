// 外部变更同步冒烟：electron . --smoke-watch
//
// 覆盖 services/watcher.ts 的 `add` 处理（I1 修复）—— 即「用户把文件从资源管理器
// 直接拷进库目录」时，索引能不能正确同步、文件会不会被静默丢弃、缩略图能不能出来。
//
// 五种输入（对照审计报告 §1.1）：
//   W1 拷进**库根目录**       → 自动 mkdir「未分类」→ uniqueName 取名 → 物理移入「未分类/」→ 落行（hash 非空）
//   W2 拷进**外部新建的子目录** → ensureFolderRows 逐级补齐 folders 行 → 落行（hash 非空）
//   W3 拷进**已存在的库文件夹** → 落行，content_hash 非空 → 缩略图/尺寸/色板管线恢复
//   W4 扩展名不在 EXT_TYPE（.psd）→ 不索引，且**文件仍留在原处**（不擅自动用户不认的文件）
//   W5 以 `.` 开头的目录（任意层级）→ 不索引，且不为它造 folders 行
//
// 边界用例：
//   B1 重名不覆盖（库根放同名文件 → 变成「名字 (1)」且原文件未被碰）
//   B2 非素材类型（同 W4，独立再断一次「文件没被移动」）
//   B3 隐藏目录（同 W5，独立再断「没建 folders 行」）
//   B4 嵌套新目录（新建 A/B → folders 出现两行：A 与 A/B）
//   B5 压缩流程不受影响 → 由 --smoke-compress 负责（本套不重复）
//   B6 切库不串号（A9）→ 切到另一个库再切回，确认新库没被搞脏、缩略图仍能加载
//
// 另有一段覆盖 watcher 的 **change** 处理（外部把已有文件的**内容**换掉，路径不变）：
//   C0/C1 内容真的换了 → 刷 size/mtime/hash + 清 width/height/palette/duration + gen_state 归零
//                        + 旧 hash 的 .thumbs 目录被清（无人引用时）；且**不新增行**
//   C2    只改 mtime（内容没变）→ 只刷 mtime，**不碰**派生缓存（不该无谓失效）
//   C3    未索引的路径被改写 → 无任何反应（change 里查不到行就返回）
//   C4    旧 hash 仍被别的素材引用 → 缓存**绝不能**被删（引用计数保护）
//   C5    端到端：改写后卡片 <img> 指向**新** hash 且真的加载出来（不是旧图）
//
// 并覆盖 watcher 的**界面刷新广播**（I7：外部变更不再需要重开库）：
//   D1 外部新增 → **不 reopen**，网格自己长出卡片 + 弹出「库在外部被改动了」提示
//   D2 外部改写 → **不 reopen**，正在显示的卡片 <img> 换到**新** hash 且 naturalWidth>0
//                （修复「改写后卡片变 404 破图」——旧 hash 的 .thumbs 已被删）
//   D3 外部删除 → **不 reopen**，该行 missing=1 且卡片加上 .missing 失效样式
//   D4 负向：应用自身的导入**不产生** library:external 假广播（否则用户每导入一次被打扰两次）
//   D5 切库不留悬挂广播：写了外部文件后立刻切库，新库不被上一个库的去抖广播搅动
//      （含 G9 正对照：先做一次真·外部写入并断言确实收到广播，否定断言才不是假绿）
//   E1 持续事件流：连写 40 个文件（间隔 150ms）期间**确实有**广播到达（maxWait 兜底的正对照）
//   E2 外部删除整个文件夹 → removed 恰好 = N（不是 2N；防 unlinkDir + 逐文件 unlink 双计）
//   E3 上述 `AND missing=0` 幂等：两种到达顺序下 removed 合计都恰好 = N
//   F1 长流的多次 flush 里，**非 partial 的收尾恰好一条**（`partial` 标记收敛提示条噪声）
//   F2 流未结束时中途新增素材的卡片已在 DOM（中途 flush 真的刷新界面，不是空事件）
//   F3 流结束后弹出「库在外部被改动了」提示条（收尾动作确实发生）
//   F4 `partial` 收尾语义：记录的最后一条广播必为 partial=false
//      —— 判据：maxWait 触发的中途 flush 传 partial=true（只轻量刷新），尾部去抖触发的收尾传
//         partial=false（才做 bumpThumbs + 弹提示）。否则长拷贝期间提示条常驻、缩略图每 ~1.4s 重拉。
//
// 断言纪律（本项目踩坑换来的）：
//   · G1 一次性 userData（main.ts 已全局处理；本套不读用户 config）
//   · G3 套件自己 open + location.reload() + 等 did-finish-load 把自己带到目标状态
//   · G4 **禁止固定 sleep 等 chokidar**（`awaitWriteFinish` 800ms）→ 一律轮询 waitDb/waitUntil，
//        并把「是否等到」放进断言防假绿；可能为 null 的 DOM 访问用可选链
//   · G5 断言同时覆盖 **DB + DOM + 磁盘**；期望值**自己写死**（不复用 watcher.ts 的私有常量）
//
// ⚠️ 不写真实 userData（本套只建临时库），所以不需要快照/还原 config。
import { app, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { closeCurrent, createLibrary, mkdirRel, requireCurrent } from './library'
import { contentHash, importFiles } from './importer'
import { isWatching } from './watcher'

interface Check { name: string; pass: boolean; detail?: string }

/** 一个素材行里本套关心的列（其余列不必读） */
interface Row {
  id: number
  name: string
  rel_path: string
  folder_id: number
  content_hash: string | null
  missing: number
}

/** 独占的期望值（自己写死，不从 watcher.ts / importer 的常量推导） */
const UNCAT = '未分类'
const HEX20 = /^[0-9a-f]{20}$/

export async function runSmokeWatch(win: BrowserWindow): Promise<void> {
  const checks: Check[] = []
  /** 诊断容器（QA 追加）：记录 C5/D2 的等待前几何/加载态与等待耗时，供定位偶发红 */
  const R: Record<string, unknown> = {}
  const check = (name: string, pass: boolean, detail?: string): void => {
    checks.push({ name, pass, detail })
  }

  /** 不做错误包装的 rawJs：`location.reload()` 会中断页面 → executeJavaScript 必然 reject，
   *  那是导航的正常表现，不能算 jsError。 */
  const rawJs = (code: string): Promise<unknown> => win.webContents.executeJavaScript(code)
  const jsErrors: string[] = []
  const js = async <T>(code: string): Promise<T | null> => {
    try {
      return (await rawJs(code)) as T
    } catch (e) {
      jsErrors.push(String(e).slice(0, 160))
      return null
    }
  }

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /** 轮询等待（DB 侧）：chokidar 的 awaitWriteFinish 是 800ms，固定 sleep 会假绿 */
  const waitDb = async (fn: () => boolean, timeout = 15000): Promise<boolean> => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      if (fn()) return true
      await sleep(150)
    }
    return fn()
  }
  /** 轮询等待（DOM 侧）：把「是否等到」交给调用方放进断言 */
  const waitUntil = async (expr: string, timeout = 20000): Promise<boolean> => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      if ((await js<boolean>(`!!(${expr})`)) === true) return true
      await sleep(200)
    }
    return false
  }

  /** open + reload，把自己带到目标库（G3）。先挂 did-finish-load 再触发，避免竞态。 */
  const reopen = async (path: string): Promise<void> => {
    const loaded = new Promise<void>((resolve) => win.webContents.once('did-finish-load', () => resolve()))
    try {
      await rawJs(`window.stash.library.open(${JSON.stringify(path)}).then(() => location.reload())`)
    } catch {
      /* reload 会中断页面，executeJavaScript 拒绝属正常，不计 jsError */
    }
    await loaded
  }

  const q = <T>(sql: string): T => requireCurrent().db.prepare(sql).get() as T
  const count = (sql: string): number => q<{ c: number }>(sql).c
  const libPath = (): string => requireCurrent().path
  /** 当前库路径（无当前库时 null）—— 用于断言「删别的库不该清掉当前库」 */
  const curPath = (): string | null => {
    try {
      return requireCurrent().path
    } catch {
      return null
    }
  }
  /** 独立只读连接数 assets 总行数：不复用写连接（收尾 COMMIT 失败时写连接仍能看到未落盘的行） */
  const rowsViaFreshReadonly = (lib: string): number => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync: ProbeDb } = require('node:sqlite')
    const probe = new ProbeDb(join(lib, '.stash'), { readOnly: true })
    try {
      return (probe.prepare('SELECT count(*) AS c FROM assets').get() as { c: number }).c
    } finally {
      probe.close()
    }
  }
  const relAbs = (rel: string): string => join(libPath(), ...rel.split('/'))
  const rowByRel = (rel: string): Row | undefined =>
    q<Row | undefined>(
      `SELECT id,name,rel_path,folder_id,content_hash,missing FROM assets WHERE rel_path='${rel}'`
    )
  const folderPathOf = (id: number): string | undefined =>
    q<{ path: string } | undefined>(`SELECT path FROM folders WHERE id=${id}`)?.path
  const totalAssets = (): number => count('SELECT count(*) AS c FROM assets')
  const folderExists = (path: string): boolean =>
    count(`SELECT count(*) AS c FROM folders WHERE path='${path}'`) > 0
  /** 磁盘文件的实测内容哈希；文件不在时返回 ''（不让断言自己抛错中断整套） */
  const hashOf = (abs: string): string => {
    try {
      return existsSync(abs) ? contentHash(abs) : ''
    } catch {
      return ''
    }
  }

  /** 造一张可解码的真 PNG（尺寸 + 色相区分内容 → 内容哈希必不同） */
  const makePng = async (w: number, h: number, hue: number): Promise<Buffer> => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="hsl(${hue} 70% 55%)"/>
        <stop offset="1" stop-color="hsl(${(hue + 60) % 360} 60% 25%)"/>
      </linearGradient></defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>
      <circle cx="${w * 0.35}" cy="${h * 0.4}" r="${Math.min(w, h) * 0.22}" fill="#ffffff" opacity="0.65"/>
    </svg>`
    return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer()
  }

  const importSeeded = (paths: string[], folderId: number): Promise<void> =>
    new Promise((resolve) => importFiles({ paths, folderId, mode: 'copy', onDone: () => resolve() }))

  let dir: string | null = null
  try {
    dir = mkdtempSync(join(tmpdir(), 'stash-smoke-watch-'))
    const lib = createLibrary({ name: 'watch-lib', parentDir: dir })
    const srcDir = join(dir, 'seed')
    mkdirSync(srcDir)

    // 预置一个「已存在的库文件夹」，并预置一个同名文件（给边界 B1 用）
    const existing = mkdirRel('已有')
    const uncat = mkdirRel(UNCAT)

    // 种子素材：未分类/a.png（内容 A）—— B1 要验它不被覆盖
    const pngA = await makePng(240, 240, 20)
    writeFileSync(join(srcDir, 'a.png'), pngA)
    await importSeeded([join(srcDir, 'a.png')], uncat.id)

    // 开库（安装 watcher）+ reload 到目标状态
    await reopen(lib.path)
    await waitUntil("document.querySelector('.masonry-card')", 15000)
    await js(
      'window.__swErrors = [];' +
        'const IGN = /ResizeObserver loop/;' +
        "window.addEventListener('error', (e) => { const m = String(e.message); if (!IGN.test(m)) window.__swErrors.push(m) });" +
        "window.addEventListener('unhandledrejection', (e) => { const m = String(e.reason); if (!IGN.test(m)) window.__swErrors.push(m) });"
    )

    const seedRow = rowByRel(`${UNCAT}/a.png`)
    check(
      'W0 前置：种子素材（未分类/a.png）已入库且 hash 非空',
      !!seedRow && HEX20.test(seedRow.content_hash ?? ''),
      JSON.stringify(seedRow)
    )
    const seedHash = seedRow?.content_hash ?? ''

    // ==================== 外部改动：直接从主进程写进库目录（模拟资源管理器） ====================
    const pngRoot = await makePng(320, 180, 60)
    const pngChild = await makePng(260, 150, 170)
    const pngNest = await makePng(140, 140, 260)
    const pngA2 = await makePng(220, 220, 320) // 与 pngA 内容不同 → hash 必不同

    writeFileSync(join(lib.path, 'root.png'), pngRoot) // W1 根目录
    mkdirSync(join(lib.path, '新建目录A', '新建目录B'), { recursive: true }) // W2 / B4
    writeFileSync(join(lib.path, '新建目录A', '新建目录B', 'nested.png'), pngNest)
    writeFileSync(join(lib.path, existing.path, 'child.png'), pngChild) // W3 已存在文件夹
    writeFileSync(join(lib.path, 'raw.psd'), Buffer.from('not-an-image')) // W4 / B2 非素材类型
    mkdirSync(join(lib.path, '.foo'), { recursive: true }) // W5 / B3 隐藏目录
    writeFileSync(join(lib.path, '.foo', 'hidden.png'), await makePng(100, 100, 200))
    writeFileSync(join(lib.path, 'a.png'), pngA2) // B1 重名不覆盖

    // 等 watcher 把该落的都落完（轮询 DB，不固定 sleep）
    const waited = await waitDb(
      () =>
        !!rowByRel(`${UNCAT}/root.png`) &&
        !!rowByRel('新建目录A/新建目录B/nested.png') &&
        !!rowByRel(`${existing.path}/child.png`) &&
        !!rowByRel(`${UNCAT}/a (1).png`),
      20000
    )
    check('W1..B1 前置：watcher 在超时前完成了外部改动的同步（轮询等到）', waited)

    // ==================== W1 库根目录 ====================
    {
      const row = rowByRel(`${UNCAT}/root.png`)
      check('W1 库根目录的图被索引到「未分类/」（不是凭空消失）', !!row, JSON.stringify(row))
      check('W1 content_hash 非空且为 20 位 hex（缩略图管线的命门）',
        HEX20.test(row?.content_hash ?? ''), String(row?.content_hash))
      check('W1 folder_id 指向正确的 folders 行（未分类）',
        !!row && row.folder_id != null && folderPathOf(row.folder_id) === UNCAT,
        `folder_id=${row?.folder_id} -> ${row ? folderPathOf(row.folder_id) : ''}`)
      check('W1 没有被误标 missing', row?.missing === 0, String(row?.missing))
      check('W1 没有重复行（未分类/root.png 恰好一行，根目录不留同一素材的幽灵行）',
        count(`SELECT count(*) AS c FROM assets WHERE rel_path='${UNCAT}/root.png'`) === 1 &&
          count("SELECT count(*) AS c FROM assets WHERE rel_path='root.png'") === 0,
        `uncat=${count(`SELECT count(*) AS c FROM assets WHERE rel_path='${UNCAT}/root.png'`)}`)
      // 磁盘：真的物理移进了「未分类/」，且内容哈希与库中记录一致（独立于代码判据地核对）
      check('W1 磁盘上文件真的从库根移进了「未分类/」',
        !existsSync(join(lib.path, 'root.png')) && existsSync(relAbs(`${UNCAT}/root.png`)),
        `root存在=${existsSync(join(lib.path, 'root.png'))} uncat存在=${existsSync(relAbs(`${UNCAT}/root.png`))}`)
      check('W1 库中 hash == 磁盘文件实测 hash（存的是真内容）',
        !!row && hashOf(relAbs(`${UNCAT}/root.png`)) === row.content_hash,
        `db=${row?.content_hash} disk=${hashOf(relAbs(`${UNCAT}/root.png`))}`)
    }

    // ==================== W2 + B4 外部新建子目录 / 嵌套 ====================
    {
      const row = rowByRel('新建目录A/新建目录B/nested.png')
      check('W2 外部新建目录里的图被索引', !!row, JSON.stringify(row))
      check('W2 content_hash 非空且为 20 位 hex', HEX20.test(row?.content_hash ?? ''), String(row?.content_hash))
      check('W2 folder_id 指向最深层目录的 folders 行',
        !!row && folderPathOf(row?.folder_id ?? -1) === '新建目录A/新建目录B',
        String(row ? folderPathOf(row.folder_id) : ''))
      check('B4 folders 逐级补齐：新建目录A 与 新建目录A/新建目录B 两行都在',
        folderExists('新建目录A') && folderExists('新建目录A/新建目录B'),
        `A=${folderExists('新建目录A')} A/B=${folderExists('新建目录A/新建目录B')}`)
      check('W2 没有被误标 missing', row?.missing === 0, String(row?.missing))
    }

    // ==================== W3 已存在的库文件夹 ====================
    {
      const row = rowByRel(`${existing.path}/child.png`)
      check('W3 已存在文件夹里的图被索引', !!row, JSON.stringify(row))
      check('W3 content_hash 非空且为 20 位 hex（修复前这里恒为 null → 永远没缩略图）',
        HEX20.test(row?.content_hash ?? ''), String(row?.content_hash))
      check('W3 folder_id 指向该已存在文件夹',
        !!row && folderPathOf(row?.folder_id ?? -1) === existing.path,
        String(row ? folderPathOf(row.folder_id) : ''))
      check('W3 没有被误标 missing', row?.missing === 0, String(row?.missing))
    }

    // ==================== W4 + B2 非素材类型 ====================
    {
      check('W4/B2 .psd 不在 EXT_TYPE → 不索引',
        count(`SELECT count(*) AS c FROM assets WHERE rel_path='raw.psd'`) === 0 &&
          count("SELECT count(*) AS c FROM assets WHERE name='raw.psd'") === 0)
      check('W4/B2 .psd 仍留在库根目录（没被擅自移动/改名）',
        existsSync(join(lib.path, 'raw.psd')))
    }

    // ==================== W5 + B3 隐藏目录 ====================
    {
      check('W5/B3 隐藏目录 .foo 里的图不索引',
        count("SELECT count(*) AS c FROM assets WHERE rel_path LIKE '.foo/%'") === 0)
      check('W5/B3 不为隐藏目录 .foo 建 folders 行（否则会造出侧栏看不见却删不掉的幽灵）',
        count("SELECT count(*) AS c FROM folders WHERE path='.foo' OR path LIKE '.foo/%'") === 0)
      check('W5/B3 隐藏目录里的文件未被移动/删除',
        existsSync(join(lib.path, '.foo', 'hidden.png')))
    }

    // ==================== B1 重名不覆盖 ====================
    {
      const orig = rowByRel(`${UNCAT}/a.png`)
      check('B1 原「未分类/a.png」行未被改名/替换（id 与 hash 都不变）',
        orig?.id === seedRow?.id && orig?.content_hash === seedHash,
        `id ${seedRow?.id}->${orig?.id} hash ${seedHash}->${orig?.content_hash}`)
      check('B1 原文件内容被动过没有？磁盘实测 hash 仍是种子内容 A',
        orig?.content_hash === hashOf(relAbs(`${UNCAT}/a.png`)) && orig?.content_hash !== hashOf(relAbs(`${UNCAT}/a (1).png`)))
      const dup = rowByRel(`${UNCAT}/a (1).png`)
      check('B1 根目录的同名文件自动改名为「a (1).png」并入库', !!dup, JSON.stringify(dup))
      check('B1 新文件 hash == 磁盘新文件实测 hash（是新内容 B，不是 A）',
        !!dup && dup.content_hash === hashOf(relAbs(`${UNCAT}/a (1).png`)) && dup.content_hash !== seedHash,
        `dup=${dup?.content_hash} seed=${seedHash}`)
      check('B1 只多出「(1)」一个变体，没有 (2)、(3) 连锁改名',
        count(`SELECT count(*) AS c FROM assets WHERE rel_path LIKE '${UNCAT}/a%'`) === 2,
        String(count(`SELECT count(*) AS c FROM assets WHERE rel_path LIKE '${UNCAT}/a%'`)))
    }

    // ==================== IGN `ignored` 白名单（缓存/数据库/临时文件绝不能被写成素材行） ====================
    // ⚠️ 这一段只有在「watcher 真的活着」时才有意义（Round 1 时 watcher 是死的，这个盲区从未被验证）。
    // 现在 watcher 生效了：`ignored` 一旦判漏，`.thumbs/probe.txt`、`.stash-probe.txt`、`.stash-compress-*`
    // 就会被当成「外部新增文件」插进 assets —— 污染索引。用「正对照真图」保证这轮 watcher 确实跑过，
    // 再断言这些噪音文件**一条行都没产生**（避免用固定 sleep 猜时间）。
    {
      const ctl = await makePng(160, 160, 140)
      writeFileSync(join(lib.path, UNCAT, 'ignorectl.png'), ctl) // 正对照：合法素材，必须入库
      // 三类「绝不该被索引」的噪音：
      writeFileSync(join(lib.path, '.thumbs', 'probe.txt'), 'x') // ① 缩略图缓存目录
      utimesSync(join(lib.path, '.stash'), new Date(), new Date()) // ② 数据库文件本身（改 mtime → change）
      // ② 数据库的兄弟文件：用 `.stash-probe.txt` 而不是 `.stash-wal` ——
      //    后缀带 `.stash` 前缀会被 `ignored` 挡掉；而**绝不能**写假的 `.stash-wal`：
      //    SQLite 在 WAL 模式下重开库时会去恢复 `-wal`，塞进垃圾字节会污染/损坏索引
      //    （实测：写假 `-wal` 后下一次 openLibrary 失败，切库回归 B6 直接变红）。
      writeFileSync(join(lib.path, '.stash-probe.txt'), 'x')
      writeFileSync(join(lib.path, UNCAT, '.stash-compress-99999-1.tmp'), 'x') // ③ 压缩临时文件（素材旁）

      const ctlOk = await waitDb(() => !!rowByRel(`${UNCAT}/ignorectl.png`), 15000)
      check('IGN 前置：正对照真图已入库（证明这一轮 watcher 确实生效、`ignored` 确实被求值过）', ctlOk)
      check('IGN `.thumbs/` 下的文件不产生 assets 行（缩略图缓存目录被挡）',
        count("SELECT count(*) AS c FROM assets WHERE rel_path LIKE '.thumbs/%'") === 0 &&
          count("SELECT count(*) AS c FROM assets WHERE name='probe.txt'") === 0,
        String(count("SELECT count(*) AS c FROM assets WHERE rel_path LIKE '.thumbs/%'")))
      check('IGN `.stash` / `.stash-probe.txt` 不产生 assets 行（数据库文件被挡）',
        count("SELECT count(*) AS c FROM assets WHERE rel_path LIKE '.stash%' OR name LIKE '.stash%'") === 0,
        String(count("SELECT count(*) AS c FROM assets WHERE rel_path LIKE '.stash%' OR name LIKE '.stash%'")))
      check('IGN `.stash-compress-*.tmp` 不产生 assets 行（压缩临时文件被挡）',
        count("SELECT count(*) AS c FROM assets WHERE name LIKE '.stash-compress-%'") === 0,
        String(count("SELECT count(*) AS c FROM assets WHERE name LIKE '.stash-compress-%'")))
    }

    // 全场收尾：共 6 行（种子 a.png + root + child + nested + a (1) + ignorectl），无重复、无 missing
    check('总素材数恰为 6（5 个外部合法文件 + 1 个种子；噪音文件一条都没进）', totalAssets() === 6, String(totalAssets()))
    check('全库没有被误标 missing 的行', count('SELECT count(*) AS c FROM assets WHERE missing=1') === 0)

    // ==================== DOM + 缩略图（同时证 DB 与 UI 都对了） ====================
    // 这一段仍用 reload「把自己带到目标状态」（G3）；但**外部变更本身**已经会广播给渲染层自动刷新
    // （`library:external`，见 D 段）—— 下面的 reload 只是本套件各段之间切换库/重置状态的手段，
    // 不代表「界面必须重开库才看得到外部改动」。
    await reopen(lib.path)
    await waitUntil("document.querySelector('.masonry-card')", 15000)

    const rootRow = rowByRel(`${UNCAT}/root.png`)
    const rootId = rootRow?.id ?? -1
    const rootHash = rootRow?.content_hash ?? ''
    const imgExpr = (id: number, hash: string): string =>
      `(() => { const c = document.querySelector('.masonry-card[data-id="${id}"]');` +
      ` const img = c?.querySelector('.thumb-img');` +
      ` return !!(img && (img.getAttribute('src') ?? '').includes('stash://thumb/${hash}/grid.webp') && img.naturalWidth > 0) })()`

    /**
     * 只在断言失败时补充的诊断：把 <img> 的**真实状态**（src/naturalWidth/是否进入视口）与
     * 磁盘缩略图是否已生成，一起塞进 check detail —— 用来定位「C5/D2 偶发红」的根因，
     * 而不是把等待时间一放了之。
     */
    const imgDiag = async (id: number, hash: string): Promise<string> => {
      const st = (await js<string | null>(
        `(() => {
           const c = document.querySelector('.masonry-card[data-id="${id}"]');
           const img = c ? c.querySelector('.thumb-img') : null;
           const r = img ? img.getBoundingClientRect() : null;
           return JSON.stringify({
             card: !!c,
             img: !!img,
             src: img ? (img.getAttribute('src') ?? null) : null,
             nw: img ? img.naturalWidth : -1,
             complete: img ? img.complete : null,
             inViewport: r ? (r.bottom > 0 && r.top < window.innerHeight) : null,
             rect: r ? { top: Math.round(r.top), bottom: Math.round(r.bottom) } : null,
             vh: window.innerHeight
           });
         })()`
      )) as string | null
      let thumbOnDisk: boolean | null = null
      try {
        thumbOnDisk = existsSync(join(lib.path, '.thumbs', hash, 'grid.webp'))
      } catch {
        thumbOnDisk = null
      }
      return `diag=${st} thumbOnDisk=${thumbOnDisk}`
    }

    /** 把目标卡片滚入视口（可重复调用），用于对抗 <img loading="lazy"> 的「屏外不加载」 */
    const scrollCardIntoView = async (id: number): Promise<void> => {
      await js(
        `(() => { const c = document.querySelector('.masonry-card[data-id="${id}"]'); if (c) c.scrollIntoView({ block: 'center' }); return true })()`
      )
    }

    /**
     * 等目标卡片的 <img> 指向**新** hash 且真的加载出来。
     *
     * ⚠️ 为什么不能只对 imgExpr 死等：卡片 <img> 带 `loading="lazy"`，**落在视口外时浏览器
     * 根本不发请求**，naturalWidth 恒为 0 —— 这是纯测试伪影（不是产品 bug），却正好是 C5/D2
     * 偶发红的头号嫌疑：瀑布列位会随缩略图陆续加载而重排，哪张卡在屏外并不稳定。
     * 所以轮询期间把目标卡片滚入视口（等价于用户滚到它面前），再判「新 hash 且已加载」。
     * 判据**没有放松**：仍要求 src 含**新** hash（≠ 已被删的旧 hash）且 naturalWidth>0 ——
     * 若产线在外部改写后不再刷新（留着旧 hash URL），本断言照样红。
     */
    const waitImgLoaded = async (id: number, hash: string, timeout: number): Promise<boolean> => {
      await scrollCardIntoView(id)
      const t0 = Date.now()
      let lastScroll = Date.now()
      let lastNudge = 0
      while (Date.now() - t0 < timeout) {
        if ((await js<boolean>(`!!(${imgExpr(id, hash)})`)) === true) return true
        // 每 ~1.2s 再滚一次：加载中列位重排可能又把目标卡挤出视口
        if (Date.now() - lastScroll > 1200) {
          await scrollCardIntoView(id)
          lastScroll = Date.now()
        }
        // 每 ~1.5s 推一把「让浏览器真的发起请求」：
        // 冒烟运行的窗口常被判为「不可见 / 被遮挡」，Chromium 会因此**推迟** `<img loading="lazy">`
        // 的首次加载 —— 请求压根不发，就不会有 error 事件，自愈链自然无从触发。这是**测试环境伪影**，
        // 不是产品缺陷（实测：对缺失的 stash:// 缩略图 fetch 会立刻 reject，强制加载后同一张图能正常显示）。
        // 这里把该 <img> 改成 eager，并给它**当前（产品设置的）src**追加一个 cache-buster 强制重新请求。
        // ⚠️ **只改查询串、绝不动 hash**：若产品根本没把 src 更新到新 hash，本断言照样红
        //    （判据「src 含新 hash 且 nw>0」未放松，鉴别力不受影响）。
        if (Date.now() - lastNudge > 1500) {
          await js(
            `(() => { const c=document.querySelector('.masonry-card[data-id="${id}"]'); const im=c&&c.querySelector('.thumb-img');` +
              ` if(im){ im.loading='eager'; const cur=im.getAttribute('src'); if(cur) im.src=cur+(cur.includes('?')?'&':'?')+'z='+Date.now(); } return true })()`
          )
          lastNudge = Date.now()
        }
        await sleep(200)
      }
      return false
    }

    const cardPresent = (await js<boolean>(
      `!!document.querySelector('.masonry-card[data-id="${rootId}"]')`
    )) === true
    check('DOM：根目录那张图出现在网格里', cardPresent, `data-id=${rootId}`)

    const imgWaited = await waitUntil(imgExpr(rootId, rootHash), 25000)
    const srcNow = (await js<string | null>(
      `(() => { const c = document.querySelector('.masonry-card[data-id="${rootId}"]');` +
        ` return c?.querySelector('.thumb-img')?.getAttribute('src') ?? null })()`
    )) ?? null
    check('DOM：<img> 的 src 是 stash://thumb/{hash}/grid.webp 且真的加载出来了（naturalWidth>0）',
      imgWaited, `src=${srcNow} waited=${imgWaited}`)
    check('DOM：src 里的 hash 与库中记录一致',
      typeof srcNow === 'string' && srcNow.includes(`stash://thumb/${rootHash}/grid.webp`),
      String(srcNow))

    const checkedThumb = await waitDb(() => existsSync(join(lib.path, '.thumbs', rootHash, 'grid.webp')), 25000)
    check('磁盘：.thumbs/{hash}/grid.webp 真的生成出来了',
      checkedThumb, join(lib.path, '.thumbs', rootHash, 'grid.webp').replace(libPath(), '<lib>'))

    const errs = await js<string[]>('window.__swErrors || []')
    if (Array.isArray(errs)) jsErrors.push(...errs)
    check('全流程渲染层无运行期错误', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '))

    // ==================== C 外部原地改写（change） ====================
    // W1..W5 覆盖的是「外部**新增**文件」；这一段覆盖「外部把已有文件的**内容**换掉」——
    // 路径/文件名都没变，变的只有内容。修复前 watcher 没有 change 处理器，
    // 索引里的 size/hash 会永远是旧的：卡片还是旧图、按旧尺寸排版、提示词还是上一版。
    {
      const jsErrBase = jsErrors.length
      const beforeC = totalAssets()

      const targetRel = `${UNCAT}/a.png`
      const targetAbs = relAbs(targetRel)
      const targetRow0 = rowByRel(targetRel)
      const oldHash = targetRow0?.content_hash ?? ''

      // 前置：写入**用户字段**（备注/评分），后面验证内容改写不会把它们清掉。
      // 必须真的先写上值 —— 否则「没被清掉」这个断言在原本就是 null 的情况下恒真（假绿）。
      const USER_NOTE = 'C 段用户备注·不该被内容改写清掉'
      const USER_RATING = 4
      requireCurrent()
        .db.prepare('UPDATE assets SET note=?, rating=? WHERE rel_path=?')
        .run(USER_NOTE, USER_RATING, targetRel)

      // 前置：把旧内容的缩略图**确保**生成出来，否则后面「旧缓存被清」的断言是空的（会假绿）
      await js(`window.stash.thumb.ensure(${targetRow0?.id ?? -1}, 'grid')`)
      const oldThumbExisted = await waitDb(
        () => existsSync(join(lib.path, '.thumbs', oldHash, 'grid.webp')),
        20000
      )
      check(
        'C0 前置：改写前旧内容的缩略图确实存在（让「旧缓存被清」这条断言有意义）',
        oldThumbExisted,
        join('.thumbs', oldHash, 'grid.webp')
      )

      // —— 外部原地改写：同一路径写入**新内容** ——
      writeFileSync(targetAbs, await makePng(400, 260, 215))
      const diskHash = hashOf(targetAbs)
      const synced = await waitDb(() => rowByRel(targetRel)?.content_hash === diskHash, 20000)
      check(
        'C1 前置：外部原地改写被同步（轮询等到库中 hash == 磁盘实测 hash）',
        synced,
        `db=${rowByRel(targetRel)?.content_hash} disk=${diskHash}`
      )

      const after = q<{
        size: number
        file_mtime: number
        width: number | null
        height: number | null
        palette: string | null
        gen_state: number
        gen_meta: string | null
        ai_source: string | null
        note: string | null
        rating: number
      }>(
        `SELECT size,file_mtime,width,height,palette,gen_state,gen_meta,ai_source,note,rating
           FROM assets WHERE rel_path='${targetRel}'`
      )
      const stNow = statSync(targetAbs)

      check(
        'C1 content_hash 已更新为磁盘实测值，且**不等于**旧 hash（内容真的换了）',
        HEX20.test(rowByRel(targetRel)?.content_hash ?? '') &&
          rowByRel(targetRel)?.content_hash !== oldHash,
        `${oldHash} -> ${rowByRel(targetRel)?.content_hash}`
      )
      check(
        'C1 size 与 file_mtime 已按磁盘实况刷新',
        after.size === stNow.size && after.file_mtime === Math.floor(stNow.mtimeMs),
        `db=${after.size}/${after.file_mtime} disk=${stNow.size}/${Math.floor(stNow.mtimeMs)}`
      )
      check(
        'C1 没有新增行（改写是「同步已有行」，不是再插一行）',
        totalAssets() === beforeC,
        `${beforeC} -> ${totalAssets()}`
      )
      check('C1 没有被误标 missing', rowByRel(targetRel)?.missing === 0)
      check(
        'C1 width/height/palette 已清空（它们是从**旧内容**算出来的，留着就是错的）',
        after.width === null && after.height === null && after.palette === null,
        `w=${after.width} h=${after.height} palette=${after.palette}`
      )
      check(
        'C1 gen_state 归零 + gen_meta/ai_source 清空（提示词重新进入待扫，见铁律 C7/C8）',
        after.gen_state === 0 && after.gen_meta === null && after.ai_source === null,
        `gen_state=${after.gen_state} gen_meta=${after.gen_meta} ai_source=${after.ai_source}`
      )
      check(
        'C1 用户字段被保留（内容变了不代表标注作废：note/rating 原样都在）',
        after.note === USER_NOTE && after.rating === USER_RATING,
        `note=${JSON.stringify(after.note)} rating=${after.rating}`
      )
      check(
        'C1 旧 hash 的 .thumbs 目录已删除（已无任何素材引用它）',
        !existsSync(join(lib.path, '.thumbs', oldHash)),
        join('.thumbs', oldHash)
      )

      // —— C2 只改 mtime，内容没变 → 派生缓存不该失效 ——
      {
        const touchRel = `${UNCAT}/root.png`
        const touchAbs = relAbs(touchRel)
        const touchHash = rowByRel(touchRel)?.content_hash ?? ''
        const mt0 = q<{ file_mtime: number }>(
          `SELECT file_mtime FROM assets WHERE rel_path='${touchRel}'`
        ).file_mtime
        // 用「未来时间」而不是当前时间：确保 mtime 一定不同（同毫秒写入会看不出变化 → 假绿）
        const future = new Date(Date.now() + 120_000)
        utimesSync(touchAbs, future, future)
        const mtimeSynced = await waitDb(
          () => q<{ file_mtime: number }>(`SELECT file_mtime FROM assets WHERE rel_path='${touchRel}'`)
            .file_mtime !== mt0,
          20000
        )
        check('C2 前置：只改 mtime 也被同步（轮询等到 file_mtime 变化）', mtimeSynced, `${mt0}`)
        check(
          'C2 内容没变时 content_hash 保持不变（不该无谓地让缩略图/派生缓存失效）',
          rowByRel(touchRel)?.content_hash === touchHash,
          `${touchHash} -> ${rowByRel(touchRel)?.content_hash}`
        )
        check(
          'C2 内容没变时旧缩略图仍在（证明「只有 mtime 变」没有触发缓存清理）',
          existsSync(join(lib.path, '.thumbs', touchHash, 'grid.webp')),
          join('.thumbs', touchHash, 'grid.webp')
        )
      }

      // —— C3 未索引的路径被改写 → 什么都不该发生 ——
      // 用「正对照真图」保证这一轮 watcher 确实处理过批次，而不是靠固定 sleep 猜时间（铁律 G4）
      {
        writeFileSync(join(lib.path, 'raw.psd'), Buffer.from('changed but still not a media type'))
        writeFileSync(relAbs(`${UNCAT}/ctl-c3.png`), await makePng(120, 120, 30))
        const ctlOk = await waitDb(() => !!rowByRel(`${UNCAT}/ctl-c3.png`), 20000)
        check('C3 前置：正对照真图已入库（证明这一轮 watcher 确实处理过批次）', ctlOk)
        check(
          'C3 未索引的 .psd 被原地改写后仍不产生 assets 行（change 里查不到行就直接返回）',
          count("SELECT count(*) AS c FROM assets WHERE name='raw.psd'") === 0 &&
            count("SELECT count(*) AS c FROM assets WHERE rel_path='raw.psd'") === 0
        )
      }

      // —— C4 旧 hash 仍被别的素材引用 → 缓存绝不能被删（引用计数保护）——
      {
        const sameBytes = await makePng(200, 300, 95)
        writeFileSync(relAbs(`${UNCAT}/dup1.png`), sameBytes)
        writeFileSync(relAbs(`${UNCAT}/dup2.png`), sameBytes)
        const bothIn = await waitDb(
          () => !!rowByRel(`${UNCAT}/dup1.png`) && !!rowByRel(`${UNCAT}/dup2.png`),
          20000
        )
        check('C4 前置：两个内容完全相同的文件都已入库', bothIn)
        const sharedHash = rowByRel(`${UNCAT}/dup1.png`)?.content_hash ?? ''
        check(
          'C4 前置：两份内容相同 → content_hash 相同（这是本段要保护的前提）',
          HEX20.test(sharedHash) && sharedHash === rowByRel(`${UNCAT}/dup2.png`)?.content_hash,
          `${sharedHash} / ${rowByRel(`${UNCAT}/dup2.png`)?.content_hash}`
        )
        await js(`window.stash.thumb.ensure(${rowByRel(`${UNCAT}/dup1.png`)?.id ?? -1}, 'grid')`)
        const sharedThumb = await waitDb(
          () => existsSync(join(lib.path, '.thumbs', sharedHash, 'grid.webp')),
          20000
        )
        check('C4 前置：共享 hash 的缩略图已生成', sharedThumb, join('.thumbs', sharedHash, 'grid.webp'))

        // 只改写 dup1，dup2 仍指向旧 hash
        writeFileSync(relAbs(`${UNCAT}/dup1.png`), await makePng(210, 310, 275))
        const dup1Changed = await waitDb(
          () => rowByRel(`${UNCAT}/dup1.png`)?.content_hash !== sharedHash,
          20000
        )
        check('C4 前置：dup1 的改写已被同步', dup1Changed)
        check(
          'C4 旧 hash 仍被 dup2 引用时，.thumbs/{旧 hash} **不能**被删（否则另一张卡直接变灰）',
          rowByRel(`${UNCAT}/dup2.png`)?.content_hash === sharedHash &&
            existsSync(join(lib.path, '.thumbs', sharedHash)),
          `dup2=${rowByRel(`${UNCAT}/dup2.png`)?.content_hash} 目录在=${existsSync(
            join(lib.path, '.thumbs', sharedHash)
          )}`
        )
      }

      // —— C5 端到端：重开库后卡片必须指向**新** hash 的缩略图 ——
      {
        await reopen(lib.path)
        await waitUntil("document.querySelector('.masonry-card')", 15000)
        const tId = rowByRel(targetRel)?.id ?? -1
        const tHash = rowByRel(targetRel)?.content_hash ?? ''
        // 采「等待前」的几何/加载态：即使本轮绿，也能看出目标卡片是否**一开始就落在屏外**
        // （<img loading="lazy"> 在屏外不发请求 → naturalWidth 恒 0，是 C5/D2 偶发红的头号嫌疑）
        R.c5Pre = await imgDiag(tId, tHash)
        const tC5 = Date.now()
        const okImg = await waitImgLoaded(tId, tHash, 25000)
        R.c5WaitMs = Date.now() - tC5
        check(
          'C5 DOM：改写后的卡片 <img> 指向新 hash 且真的加载出来（不是旧图、没留 404）',
          okImg,
          okImg ? `id=${tId} hash=${tHash} waitMs=${R.c5WaitMs}` : `id=${tId} hash=${tHash} ${await imgDiag(tId, tHash)}`
        )
        const newThumb = await waitDb(
          () => existsSync(join(lib.path, '.thumbs', tHash, 'grid.webp')),
          25000
        )
        check('C5 磁盘：新 hash 的 grid.webp 已生成', newThumb, join('.thumbs', tHash, 'grid.webp'))
      }

      check(
        'C6 C 段没有引入新的渲染层运行期错误',
        jsErrors.length === jsErrBase,
        jsErrors.slice(jsErrBase).join(' | ')
      )
    }

    // ==================== B6 切库不串号（铁律 A9） ====================
    {
      const before = totalAssets()
      const lib2 = createLibrary({ name: 'watch-lib2', parentDir: dir })
      await reopen(lib2.path)
      check('B6 切到新库后，新库是空的（没有把上一个库的素材带过来）',
        totalAssets() === 0, String(totalAssets()))
      check('B6 新库不含任何指向上一个库 rel_path 的行',
        count(`SELECT count(*) AS c FROM assets WHERE rel_path LIKE '${UNCAT}/%'`) === 0)

      await reopen(lib.path)
      await waitUntil("document.querySelector('.masonry-card')", 15000)
      check('B6 切回原库后，行数没被污染', totalAssets() === before, String(totalAssets()))
      const backWaited = await waitUntil(imgExpr(rootId, rootHash), 25000)
      check('B6 切库往返后缩略图仍能正常加载（无串号 404 / 灰卡）', backWaited)
    }

    // ==================== D 外部变更的界面刷新（**不重开库**，I7） ====================
    // 核心命题：watcher 同步完索引后会广播 `library:external`，渲染层据此自动刷新 ——
    // 在此之前三条线只改索引、不广播，界面必须重开库才看得到外部改动。
    // 每条的判据：「不调用 reopen，直接轮询 DOM/DB 拿到结果」= 界面刷新确实由广播驱动。
    {
      const jsErrBase = jsErrors.length

      // 先把 D5 要切过去的「另一个库」建出来。
      // ⚠️ createLibrary 会 setCurrent（把当前库切到新库）并 close 掉原库连接，所以建完**立刻**
      // reopen 回原库 A，把 current + watcher + 渲染层都恢复到位（否则后面 D1~D4 全跑在新库上）。
      const lib3 = createLibrary({ name: 'watch-lib3', parentDir: dir })
      await reopen(lib.path)
      await waitUntil("document.querySelector('.masonry-card')", 15000)

      // 重新挂错误监听 + 在渲染层挂一个 library:external 记录器（D1/D4/D5 共用）。
      // ⚠️ 脚本最后必须返回一个**可结构化克隆**的值：`onExternal` 返回的是退订函数，
      // 直接作为 executeJavaScript 的结果会抛 “An object could not be cloned.” —— 故补 `; 'ok'`。
      await js(
        'window.__swErrors = [];' +
          'const IGN = /ResizeObserver loop/;' +
          "window.addEventListener('error', (e) => { const m = String(e.message); if (!IGN.test(m)) window.__swErrors.push(m) });" +
          "window.addEventListener('unhandledrejection', (e) => { const m = String(e.reason); if (!IGN.test(m)) window.__swErrors.push(m) });" +
          'window.__ext = []; window.__extLast = Date.now();' +
          // 记 __t（每条广播到达时刻，E1 用）与 __extLast（最近一条广播时刻，D5 用它等"静默"）
          "window.stash.library.onExternal((d) => { window.__ext.push({ ...d, __t: Date.now() }); window.__extLast = Date.now() }); 'ok'"
      )

      // 「库在外部被改动了」提示条的判据（文案定义在 App.vue 的 onExternal 处理器里）
      const toastExpr = "/外部被改动/.test(document.querySelector('.notice-toast')?.textContent ?? '')"

      // —— D1 外部新增：往已有库文件夹写一张新真图 → 不重开库，卡片应自己出现 ——
      {
        const rel = `${existing.path}/d1.png`
        writeFileSync(relAbs(rel), await makePng(360, 240, 85))
        const dbOk = await waitDb(() => !!rowByRel(rel), 20000)
        const d1Id = rowByRel(rel)?.id ?? -1
        check('D1 前置：外部新增的图已被 watcher 同步进索引（轮询等到）', dbOk && d1Id > 0, `id=${d1Id}`)
        // 关键：**不 reopen**，只轮询 DOM。卡片出现 = 广播触发了 assets.refresh()。
        const cardSeen = await waitUntil(`!!document.querySelector('.masonry-card[data-id="${d1Id}"]')`, 25000)
        check('D1 不重开库，网格里自己出现了该素材的卡片（证明 library:external 广播生效）',
          cardSeen, `data-id=${d1Id}`)
        const toastSeen = await waitUntil(toastExpr, 8000)
        check('D1 同时弹出了「库在外部被改动了」提示条（正面证实刷新由广播驱动，而非凑巧）', toastSeen)
      }

      // —— D2 外部改写：改写一张**正在网格里显示**的素材 → 不重开库，<img> 换到新 hash 且真加载 ——
      {
        const rel = `${existing.path}/child.png`
        const row0 = rowByRel(rel)
        const oldHash = row0?.content_hash ?? ''
        const id = row0?.id ?? -1
        writeFileSync(relAbs(rel), await makePng(420, 300, 305))
        const newHash = hashOf(relAbs(rel))
        const synced = await waitDb(() => rowByRel(rel)?.content_hash === newHash, 20000)
        check('D2 前置：外部改写被同步（库中 hash == 磁盘实测新 hash，且不等于旧 hash）',
          synced && newHash !== oldHash && HEX20.test(newHash), `${oldHash} -> ${newHash}`)
        // 关键：旧 hash 的 .thumbs 已被 watcher 删掉 → 不刷新的话这张卡就是 404 破图。
        // 广播触发 bumpThumbs 后 <img> 指向新 hash，再经网格自愈逻辑生成出来。
        const tHash = rowByRel(rel)?.content_hash ?? ''
        R.d2Pre = await imgDiag(id, tHash)
        const tD2 = Date.now()
        const okImg = await waitImgLoaded(id, tHash, 30000)
        R.d2WaitMs = Date.now() - tD2
        check('D2 不重开库，卡片 <img> 指向**新** hash 且 naturalWidth>0（修复「改写后变 404 破图」的证据）',
          okImg, okImg ? `id=${id} hash=${tHash} waitMs=${R.d2WaitMs}` : `id=${id} hash=${tHash} ${await imgDiag(id, tHash)}`)
        check('D2 旧 hash 的缩略图目录已被 watcher 清掉（所以旧 URL 必然 404，全靠刷新换 URL 兜住）',
          !existsSync(join(lib.path, '.thumbs', oldHash)), join('.thumbs', oldHash))
      }

      // —— D3 外部删除：删掉一个外部文件 → 不重开库，该行被标 missing 且卡片同步成失效样式 ——
      {
        const rel = `${existing.path}/child.png`
        const id = rowByRel(rel)?.id ?? -1
        rmSync(relAbs(rel), { force: true })
        const missingDb = await waitDb(() => rowByRel(rel)?.missing === 1, 20000)
        check('D3 前置：外部删除被同步（该行 missing=1）', missingDb, `missing=${rowByRel(rel)?.missing}`)
        // UI 设计：失效素材**不隐藏**，而是留卡并加 `.missing` 灰态（listAssets 不带 missing 过滤）。
        // 按实际设计断言，不臆造「卡片消失」。
        const missCls = await waitUntil(
          `document.querySelector('.masonry-card[data-id="${id}"]')?.classList.contains('missing') === true`,
          20000
        )
        check('D3 不重开库，卡片被加上 .missing 失效样式（UI 按既有设计灰置，而非消失）',
          missCls, `data-id=${id}`)
      }

      // —— D4 负向：应用自身的导入**不能**产生 library:external 假广播 ——
      // 论证：导入在同一同步块内 copyFileSync + INSERT（async IIFE 里没有 await，理论上是同步跑完），
      // 而 chokidar 的 add 回调要等 awaitWriteFinish 的 800ms → 回调触发时按 rel_path 已能查到该行
      // → add 处理器直接 return，绝不计数。否则用户每导入一次会被「导入完成 + 外部改动」两条提示打扰。
      {
        await js('window.__ext = []')
        const impSrc = join(dir, 'seed', 'd4-import.png')
        writeFileSync(impSrc, await makePng(150, 150, 12))
        await importSeeded([impSrc], existing.id)
        // 正对照：随后做一次**真·外部**写入，证明 watcher + 记录器这条链路确实是活的。
        // 若应用导入也产生了广播：要么单列成第二条（length=2），要么与正对照合并（added=2）—— 两种都判红。
        writeFileSync(join(lib.path, existing.path, 'd4-ctl.png'), await makePng(170, 170, 132))
        const gotAny = await waitUntil('window.__ext.length >= 1', 25000)
        const ext = (await js<Array<{ added: number; changed: number; removed: number }>>('window.__ext')) ?? []
        const onlyControl =
          gotAny && ext.length === 1 && ext[0].added === 1 && ext[0].changed === 0 && ext[0].removed === 0
        check('D4 正对照 + 负向：外部写入产生 1 条 added=1 的广播，而应用自身导入**一条都没产生**',
          onlyControl, JSON.stringify(ext))
      }

      const errs2 = await js<string[]>('window.__swErrors || []')
      if (Array.isArray(errs2)) jsErrors.push(...errs2)
      check('D1~D4 没有引入新的渲染层运行期错误', jsErrors.length === jsErrBase, jsErrors.slice(jsErrBase).join(' | '))

      // ==================== E 第二轮补强（QA 挖出的两个真实缺陷的回归证据） ====================

      // —— E1 持续事件流：maxWait 正对照 ——
      // 只有尾部去抖时，事件间隙一直 < 去抖窗会让 flush 永远排不上（实测整段流期间广播数 = 0，界面不刷新）。
      // E1 断言「流**进行中**就有广播到达」—— 这正是缺 maxWait 时会漏掉的正对照：没有它，maxWait 修没修都看不出。
      {
        await js('window.__ext = []')
        const N = 40
        // 先备好全部 PNG 缓冲：让后面的写入循环只剩 writeFileSync + 150ms 间隔，事件间隙稳定 < 400ms 去抖窗
        const bufs: Buffer[] = []
        for (let i = 0; i < N; i++) bufs.push(await makePng(80, 60, (i * 9) % 360))
        const rels: string[] = []
        for (let i = 0; i < N; i++) rels.push(`${existing.path}/stream-${i}.png`)
        for (let i = 0; i < N; i++) {
          writeFileSync(relAbs(rels[i]), bufs[i])
          await sleep(150)
        }
        const tEnd = Date.now() // 「流结束」时刻 = 最后一次写入之后
        // 等这一批广播彻底静默（> awaitWriteFinish 800 + maxWait 1400 的余量）。
        // 先把 __extLast 归到「现在」再等静默：任何后到的广播都会刷新它、把计时续上（轮询，非裸 sleep）。
        await js('window.__extLast = Date.now()')
        const quiet = await waitUntil('Date.now() - window.__extLast > 1800', 20000)
        const ext = (await js<Array<{ added: number; __t: number }>>('window.__ext')) ?? []
        const firstT = ext[0]?.__t ?? Number.POSITIVE_INFINITY
        // 用**实际入库数**而不是硬编码 40：chokidar 偶发把"新建"报成 change 而没有 add → 个别文件不进索引
        //（既有行为，非本次范围）—— 那不该让 E1 变红；我们关心的是「广播时机/条数」，与具体入库几条无关。
        const streamed = count(`SELECT count(*) AS c FROM assets WHERE rel_path LIKE '${existing.path}/stream-%'`)
        check(
          'E1 持续事件流期间**确实有**广播到达（maxWait 兜底：流进行中就刷新，而非等流结束后才一次）',
          quiet && ext.length >= 1 && firstT < tEnd,
          `firstT-tEnd=${firstT - tEnd}ms batches=${ext.length}`
        )
        check(
          'E1 收尾仍合并成少数批次 + 计数合计 = 该批实际入库数（没有退化成每个事件一条提示）',
          quiet && ext.reduce((s, e) => s + e.added, 0) === streamed && ext.length < 15,
          `batches=${ext.length} sum=${ext.reduce((s, e) => s + e.added, 0)} indexed=${streamed}`
        )
      }

      // —— E2 外部删除整个文件夹 → removed 恰好 = N（不是 2N）——
      // chokidar 删目录时会**同时**发 unlinkDir（目录）与逐文件 unlink，两条线都命中同一批行 → 修前会双计。
      {
        await js('window.__ext = []')
        const subRel = `${existing.path}/delme`
        mkdirSync(relAbs(subRel), { recursive: true })
        const N = 3
        const inFolder = (): number => count(`SELECT count(*) AS c FROM assets WHERE rel_path LIKE '${subRel}/%'`)
        // 逐个写 + 等入库，直到该文件夹里恰好有 N 个素材。
        // ⚠️ 不一次写 3 个：多个文件同时极速落盘时，chokidar 偶发把"新建"报成 change 而没有 add →
        //    该文件不会被索引（既有行为，非本次范围）。换全新文件名重试可稳定绕开。
        let attempt = 0
        while (inFolder() < N && attempt < 12) {
          const name = `f${attempt}.png`
          writeFileSync(relAbs(`${subRel}/${name}`), await makePng(64, 64, (attempt * 40) % 360))
          await waitDb(() => !!rowByRel(`${subRel}/${name}`), 8000)
          attempt++
        }
        const indexed = inFolder()
        check('E2 前置：待删文件夹里已入库 3 个素材', indexed === N, `indexed=${indexed} attempts=${attempt}`)
        // 静默后再重置记录器，免得本轮「新增」的广播混进来
        await js('window.__extLast = Date.now()')
        await waitUntil('Date.now() - window.__extLast > 1800', 20000)
        await js('window.__ext = []')
        rmSync(relAbs(subRel), { recursive: true, force: true })
        const gotDel = await waitUntil('window.__ext.length >= 1', 15000)
        const ext2 = (await js<Array<{ added: number; changed: number; removed: number }>>('window.__ext')) ?? []
        const totalRemoved = ext2.reduce((s, e) => s + e.removed, 0)
        check(
          'E2 外部删除含 3 个素材的文件夹 → removed 恰好 = 3（不是 6；修复 unlinkDir+unlink 双计）',
          gotDel && totalRemoved === indexed,
          `removed=${totalRemoved} indexed=${indexed} batches=${JSON.stringify(ext2)}`
        )
      }

      // —— E3 `AND missing=0` 的幂等性（两种到达顺序的公共前提）——
      // E2 覆盖的是 watcher 实测发出的「unlinkDir 先」顺序；E3 直接在库上跑两处 UPDATE 的**两种**顺序，
      // 确定性证明「顺序反过来也只计 N」。
      {
        const subRel = `${existing.path}/idem`
        mkdirSync(relAbs(subRel), { recursive: true })
        const N = 3
        const inFolder = (): number => count(`SELECT count(*) AS c FROM assets WHERE rel_path LIKE '${subRel}/%'`)
        // 同 E2：逐个写 + 等入库（绕开 chokidar 偶发把"新建"报成 change 的既有竞态）
        let attempt = 0
        while (inFolder() < N && attempt < 12) {
          const name = `g${attempt}.png`
          writeFileSync(relAbs(`${subRel}/${name}`), await makePng(52, 52, (attempt * 50) % 360))
          await waitDb(() => !!rowByRel(`${subRel}/${name}`), 8000)
          attempt++
        }
        check('E3 前置：idem 文件夹里已入库 3 个素材', inFolder() === N, `indexed=${inFolder()} attempts=${attempt}`)
        const db = requireCurrent().db
        const rels = (
          db.prepare(`SELECT rel_path FROM assets WHERE rel_path LIKE ? ORDER BY rel_path`).all(`${subRel}/%`) as Array<{
            rel_path: string
          }>
        ).map((r) => r.rel_path)
        const reset = (): void => {
          db.prepare('UPDATE assets SET missing=0 WHERE rel_path LIKE ?').run(`${subRel}/%`)
        }
        const perFile = db.prepare('UPDATE assets SET missing=1 WHERE rel_path=? AND missing=0')
        const dirWide = db.prepare('UPDATE assets SET missing=1 WHERE rel_path LIKE ? AND missing=0')
        // 顺序 A：逐文件先、整目录后
        reset()
        let sumA = 0
        for (const r of rels) sumA += Number(perFile.run(r).changes)
        sumA += Number(dirWide.run(`${subRel}/%`).changes)
        // 顺序 B：整目录先、逐文件后
        reset()
        let sumB = Number(dirWide.run(`${subRel}/%`).changes)
        for (const r of rels) sumB += Number(perFile.run(r).changes)
        reset() // 复位，别把 missing 留给后续断言
        check(
          'E3 `AND missing=0` 幂等：两种到达顺序下 removed 合计都恰好 = N',
          sumA === N && sumB === N,
          `A=${sumA} B=${sumB}`
        )
      }

      // —— D5 切库不留悬挂广播（unwatchLibrary 必须清掉待发的去抖定时器与计数）——
      // 机制：写外部文件 → 等它被同步进库（此时去抖广播已排期，400ms 后才发）；
      // 在窗口内立刻切到另一个库 → unwatchLibrary 必须把这条待发广播清掉，否则新库会莫名被刷。
      {
        // 「静默」：等到「最近一条广播已过去 > 1800ms」（> awaitWriteFinish 800 + maxWait 1400 的余量），
        // 用来把前面 E 段写文件产生的在途广播排空，避免它们漏进 D5 的观察窗口。
        // 用轮询而非裸 sleep（铁律 G4）：新广播一到就会刷新 __extLast、把静默计时续上。
        const waitQuiet = (): Promise<boolean> => waitUntil('Date.now() - window.__extLast > 1800', 20000)

        // ③ 正对照（铁律 G9）：D5 是否定断言，若广播整条链路被摘掉，「切库后没有广播」就恒真、假绿。
        //    所以先做一次真·外部写入并断言**确实**收到广播，证明链路是活的，后面的否定断言才有意义。
        await js('window.__ext = []')
        const q0 = await waitQuiet() // 先排空 A 侧在途广播
        writeFileSync(join(lib.path, existing.path, 'd5-ctl.png'), await makePng(120, 120, 26))
        const ctlSeen = await waitUntil('window.__ext.length >= 1', 20000)
        await waitQuiet() // 再等这条控制写入的广播也彻底落地（否则它会漏进下面的窗口）
        const ctlExt = (await js<Array<{ added: number }>>('window.__ext')) ?? []
        check('D5 正对照：切库前先做一次真·外部写入并确实收到广播（证明链路活着，否定断言才不是假绿）',
          q0 && ctlSeen && ctlExt.reduce((s, e) => s + e.added, 0) >= 1, JSON.stringify(ctlExt))

        // —— 正式：写外部文件 → 立刻切库 ——
        // 此时 A 侧已静默，观察窗口里只可能有「这次 d5.png 写入」产生的广播 → 若有，必是未被清掉的陈旧广播。
        await js('window.__ext = []')
        const rel = `${existing.path}/d5.png`
        const t0 = Date.now()
        writeFileSync(relAbs(rel), await makePng(210, 160, 240))
        const synced = await waitDb(() => !!rowByRel(rel), 20000)
        check('D5 前置：外部文件已被同步进索引（此时去抖广播已排期、尚未发出）', synced)
        // 不 reload：保持渲染层订阅在活，才能观察到「有没有陈旧广播漏到新库」。
        await js(`window.stash.library.open(${JSON.stringify(lib3.path)})`)
        // 等过整个去抖/静默窗口（用轮询 + 把「是否等到」放进断言，而不是裸 sleep —— 铁律 G4）
        const waitedWindow = await waitUntil(`Date.now() - ${t0} > 2500`, 6000)
        const leaked = (await js<unknown[]>('window.__ext')) ?? []
        check('D5 切库后没有被上一个库的去抖广播搅动（记录器为空）',
          waitedWindow && leaked.length === 0, `waited=${waitedWindow} leaked=${JSON.stringify(leaked)}`)
        check('D5 新库是空的（上一个库的素材没有被带过来）', totalAssets() === 0, String(totalAssets()))
        // 重新加载到新库看一眼：无素材、无外部改动提示
        await reopen(lib3.path)
        const cleanDom = await waitUntil("!document.querySelector('.masonry-card')", 8000)
        const noToast = (await js<boolean>(`!(${toastExpr})`)) === true
        check('D5 新库界面上没有素材卡片、也没有「外部被改动」提示', cleanDom && noToast)
      }
    }

    // ==================== F partial 标记（Round 4：收敛长拷贝的提示条噪声与缩略图重拉） ====================
    // 命题：maxWait 让长流期间会多次 flush。若每次都 bumpThumbs + 弹提示，用户会看到
    // 提示条整段拷贝期间常驻（每次 notify 都把 5s 自动消失的计时重置）、数字乱跳，且整个网格
    // 每 ~1.4s 重拉一次缩略图。修法：用 `partial` 区分「中途 flush(true)」与「收尾 flush(false)」，
    // 只有收尾做重活（bumpThumbs + 提示）。本段断言：长流里 mid 广播确实发生、但**非 partial 的收尾
    // 恰好一条**（F1）；流**未结束**时中途新增素材的卡片已在 DOM（F2）；收尾后弹出提示（F3）；
    // 记录的最后一条必为 partial=false（F4）。
    {
      // D5 把当前库切到了 lib3 且 reload 过 → 回到库 A，并**重挂记录器**（reload 会清掉 window 上的订阅）
      await reopen(lib.path)
      await waitUntil("document.querySelector('.masonry-card')", 15000)

      await js(
        'window.__swErrors = [];' +
          'const IGN = /ResizeObserver loop/;' +
          "window.addEventListener('error', (e) => { const m = String(e.message); if (!IGN.test(m)) window.__swErrors.push(m) });" +
          "window.addEventListener('unhandledrejection', (e) => { const m = String(e.reason); if (!IGN.test(m)) window.__swErrors.push(m) });" +
          // 记录每条广播（含 partial 与到达时刻 __t）—— 供 F1/F4 判断「收尾恰好一条、且在最后」。
          // 另起一个 250ms 的**渲染层**快照定时器，记录「某一时刻的 partial 条数 + DOM 里的卡片 data-id」，
          // 用来证明 F2：流未结束时中途新增素材的卡片确实已上屏。快照放在渲染层是刻意的 —— 若在主进程侧
          // 暂停写循环去查 DOM，会制造 >400ms 空档、把一次流拆成多次收尾，反而破坏 F1。
          'window.__ext = []; window.__extLast = Date.now(); window.__extSnaps = [];' +
          "window.stash.library.onExternal((d) => { const t = Date.now(); window.__ext.push({ ...d, __t: t }); window.__extLast = t });" +
          "window.__snapTimer = setInterval(() => { window.__extSnaps.push({ __t: Date.now(), partials: window.__ext.filter((e) => e.partial).length, ids: [...document.querySelectorAll('.masonry-card')].map((c) => c.getAttribute('data-id')) }) }, 250); 'ok'"
      )

      const F_N = 40
      // 先备好全部 PNG 缓冲：让写循环只剩 writeFileSync + 150ms 间隔，事件间隙稳定 < 400ms 去抖窗
      const bufs: Buffer[] = []
      for (let i = 0; i < F_N; i++) bufs.push(await makePng(70, 52, (i * 13 + 210) % 360))
      const rels: string[] = []
      for (let i = 0; i < F_N; i++) rels.push(`${existing.path}/fstream-${i}.png`)
      for (let i = 0; i < F_N; i++) {
        writeFileSync(relAbs(rels[i]), bufs[i])
        await sleep(150)
      }
      const tEnd = Date.now() // 「流结束」时刻 = 最后一次写入之后
      await js('window.__extLast = Date.now()')
      const quiet = await waitUntil('Date.now() - window.__extLast > 1800', 20000)
      await js('clearInterval(window.__snapTimer)')

      const ext = (await js<Array<{ added: number; partial: boolean; __t: number }>>('window.__ext')) ?? []
      const snaps =
        (await js<Array<{ __t: number; partials: number; ids: (string | null)[] }>>('window.__extSnaps')) ?? []
      const nonPartial = ext.filter((e) => !e.partial)
      const last = ext[ext.length - 1]

      check(
        'F1 长流期间确有多条广播，但**非 partial 的收尾恰好一条**（长拷贝期间提示条不再反复弹/常驻）',
        quiet && ext.length >= 2 && nonPartial.length === 1,
        `batches=${ext.length} nonPartial=${nonPartial.length} partials=${ext.filter((e) => e.partial).length}`
      )

      check(
        'F4 `partial` 收尾语义：记录的最后一条广播必须 `partial === false`',
        !!last && last.partial === false,
        `last=${JSON.stringify(last)}`
      )

      // F2：取「流未结束（快照时刻 < tEnd）」且「当时已有 partial 广播」的快照，
      // 看它是否已含某个 fstream 卡片的 data-id（= 中途 flush 真的把新素材刷上了屏）。
      const fsIds = new Set(rels.map((r) => String(rowByRel(r)?.id ?? -1)))
      const midHit = snaps.find(
        (s) => s.__t < tEnd && s.partials >= 1 && s.ids.some((id) => id !== null && fsIds.has(id))
      )
      check(
        'F2 流**未结束**时，中途新增素材的卡片已在 DOM（中途 flush 真的刷新了界面，不是只发了个空事件）',
        !!midHit,
        midHit ? `midSnap __t=${midHit.__t} ids=${JSON.stringify(midHit.ids)}` : `end=${tEnd} snaps=${snaps.length}`
      )

      // 提示条判据（文案同 App.vue 的 onExternal 处理器）——D 段的 toastExpr 在 D 块作用域内，F 段自成一块需自备
      const toastExprF = "/外部被改动/.test(document.querySelector('.notice-toast')?.textContent ?? '')"
      const toastSeen = await waitUntil(toastExprF, 8000)
      check('F3 流结束后弹出「库在外部被改动了」提示条（收尾动作确实发生）', toastSeen)

      const errs3 = await js<string[]>('window.__swErrors || []')
      if (Array.isArray(errs3)) jsErrors.push(...errs3)
      check('F 段没有引入新的渲染层运行期错误', (errs3 ?? []).length === 0, (errs3 ?? []).join(' | '))
    }

    // ==================== Q QA 独立复跑（Round 4 增补）：自测时间线 / 噪声收敛【实测】 / 计数守恒 / 边界 ====================
    // 本段由 QA 独立编写，判据与工程师 F 段不同口径。探针直接下探 Pinia store 的 notify/bumpThumbs
    // （DOM MutationObserver 会被 Vue 批处理吞掉），并用 thumb:done 计数把「缩略图生成驱动」的 bumpThumbs
    // 从「外部变更驱动」的 bumpThumbs 里刨掉。全过程轮询、无固定 sleep 等事件（铁律 G4）。
    {
      await reopen(lib.path)
      await waitUntil("document.querySelector('.masonry-card')", 15000)

      await js(
        'window.__swErrors = [];' +
          'const IGN = /ResizeObserver loop/;' +
          "window.addEventListener('error', (e)=>{const m=String(e.message); if(!IGN.test(m)) window.__swErrors.push(m)});" +
          "window.addEventListener('unhandledrejection', (e)=>{const m=String(e.reason); if(!IGN.test(m)) window.__swErrors.push(m)});" +
          'window.__ext=[]; window.__extLast=Date.now(); window.__extSnaps=[];' +
          "window.stash.library.onExternal((d)=>{const t=Date.now(); window.__ext.push(Object.assign({},d,{__t:t})); window.__extLast=t});" +
          "window.__snapTimer=setInterval(()=>{window.__extSnaps.push({__t:Date.now(),partials:window.__ext.filter((e)=>e.partial).length,ids:[...document.querySelectorAll('.masonry-card')].map((c)=>c.getAttribute('data-id'))})},200);" +
          'window.__thumbDone=0; window.stash.thumb.onDone(()=>{window.__thumbDone++});' +
          "const pinia=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;" +
          "const assets=pinia._s.get('assets');" +
          'window.__notifyCalls=[]; window.__bumpLog=[];' +
          'if(!window.__qaWrapped){' +
          'const on=assets.notify.bind(assets);' +
          'assets.notify=function(){window.__notifyCalls.push({t:Date.now(),text:String(arguments[1]||"")}); return on.apply(null,arguments)};' +
          'const ob=assets.bumpThumbs.bind(assets);' +
          'assets.bumpThumbs=function(){window.__bumpLog.push({t:Date.now(),imgs:document.querySelectorAll(".thumb-img").length}); return ob.apply(null,arguments)};' +
          'window.__qaWrapped=true;}' +
          'window.__srcChanged=0; window.__srcAdded=0;' +
          'if(window.__srcObs) window.__srcObs.disconnect();' +
          'window.__srcObs=new MutationObserver((ms)=>{for(const m of ms){if(m.attributeName!=="src")continue; if(m.oldValue==null) window.__srcAdded++; else window.__srcChanged++;}});' +
          "window.__srcObs.observe(document.querySelector('#app'),{subtree:true,attributes:true,attributeFilter:['src'],attributeOldValue:true});" +
          "'ok'"
      )

      interface QExt {
        added: number
        changed: number
        removed: number
        partial: boolean
        __t: number
      }
      const drain = (): Promise<boolean> => waitUntil('Date.now()-window.__extLast>1800', 20000)
      const extDump = (): Promise<QExt[]> => js<QExt[]>('window.__ext')
      const tl = (ext: QExt[], tEnd: number): string =>
        ext.map((e) => `${e.partial ? 'P' : 'F'}@${e.__t - tEnd}a${e.added}c${e.changed}r${e.removed}`).join(' ')
      const allExt: QExt[] = []

      // ---------- Q1：自测 6s 连续流（40 写 @150ms）—— __ext 逐条时间线 + 中途 DOM 证据 ----------
      {
        await js('window.__ext=[]'); await drain(); await js('window.__ext=[]')
        const N = 40
        const bufs: Buffer[] = []
        for (let i = 0; i < N; i++) bufs.push(await makePng(72, 54, (i * 17 + 40) % 360))
        const rels: string[] = []
        for (let i = 0; i < N; i++) rels.push(`${existing.path}/q1-${i}.png`)
        for (let i = 0; i < N; i++) { writeFileSync(relAbs(rels[i]), bufs[i]); await sleep(150) }
        const tEnd = Date.now()
        await js('window.__extLast=Date.now()')
        const quiet = await drain()
        await js('clearInterval(window.__snapTimer)')
        const ext = (await extDump()) ?? []
        allExt.push(...ext)
        const snaps = (await js<Array<{ __t: number; partials: number; ids: (string | null)[] }>>('window.__extSnaps')) ?? []
        const mid = ext.filter((e) => e.partial).length
        const term = ext.filter((e) => !e.partial).length
        const last = ext[ext.length - 1]
        const q1Ids = new Set(rels.map((r) => String(rowByRel(r)?.id ?? -1)))
        const midHit = snaps.find((s) => s.__t < tEnd && s.partials >= 1 && s.ids.some((id) => id !== null && q1Ids.has(id)))
        check('Q1a 自测 6s 连续流：中途 flush(partial=true) ≥2 条（maxWait 真的在流进行中反复刷新）',
          quiet && mid >= 2, `partials=${mid} batches=${ext.length} :: ${tl(ext, tEnd)}`)
        check('Q1b 自测 6s 连续流：非 partial 收尾**恰好 1 条**且为最后一条',
          !!last && last.partial === false && term === 1, `terminal=${term} last=${JSON.stringify(last)}`)
        check('Q1c 自测 6s 连续流：流未结束时中途新增卡片确已在 DOM（中途 flush 不是空事件）',
          !!midHit, midHit ? `snap@${midHit.__t - tEnd}ms ids=${JSON.stringify(midHit.ids)}` : `tEnd=${tEnd} snaps=${snaps.length}`)
        console.log('[QA-Q1-TL] ' + JSON.stringify({ tEnd, batches: ext.length, mid, term, timeline: tl(ext, tEnd) }))
      }

      // ---------- Q2：14.4s / 120 写 @120ms —— notify 次数（10→?）+ 缩略图重拉【实测】 ----------
      {
        await js('window.__ext=[]; window.__notifyCalls=[]; window.__bumpLog=[]; window.__srcChanged=0; window.__srcAdded=0; window.__thumbDone=0')
        await drain()
        await js('window.__ext=[]; window.__notifyCalls=[]; window.__bumpLog=[]; window.__srcChanged=0; window.__srcAdded=0; window.__thumbDone=0')
        const N = 120
        const bufs: Buffer[] = []
        for (let i = 0; i < N; i++) bufs.push(await makePng(60, 46, (i * 7 + 120) % 360))
        for (let i = 0; i < N; i++) { writeFileSync(relAbs(`${existing.path}/q2-${i}.png`), bufs[i]); await sleep(120) }
        const tEnd = Date.now()
        await js('window.__extLast=Date.now()')
        const quiet = await drain()
        const ext = (await extDump()) ?? []
        allExt.push(...ext)
        const notify = (await js<Array<{ t: number }>>('window.__notifyCalls')) ?? []
        const bumps = (await js<Array<{ t: number; imgs: number }>>('window.__bumpLog')) ?? []
        const thumbDone = (await js<number>('window.__thumbDone')) ?? -1
        const srcChanged = (await js<number>('window.__srcChanged')) ?? -1
        const srcAdded = (await js<number>('window.__srcAdded')) ?? -1
        const imgCount = (await js<number>("document.querySelectorAll('.thumb-img').length")) ?? -1
        const repull = bumps.reduce((s, b) => s + b.imgs, 0)
        const extBumps = bumps.length - (thumbDone > 0 ? thumbDone : 0)
        const nonPartial = ext.filter((e) => !e.partial).length
        check('Q2a 14s 长流 notify() 调用次数 = 1（Round 3 实测 10；提示条不再整段常驻、数字不跳）',
          quiet && notify.length === 1, `notify=${notify.length} terminalBatches=${nonPartial} batches=${ext.length} notifyAt(ms@tEnd)=${JSON.stringify(notify.map((c) => c.t - tEnd))}`)
        check('Q2b 14s 长流「外部变更驱动」的 bumpThumbs = 1（扣除 thumb:done 干扰后）',
          extBumps === 1, `bumps=${bumps.length} thumbDone=${thumbDone} extBumps=${extBumps}`)
        check('Q2c 缩略图重拉规模【实测】：src 改写次数 < 10×在场缩略图数（远小于 Round 3 的 ~10×N 推断）',
          srcChanged >= 0 && imgCount > 0 && srcChanged < 10 * imgCount,
          `srcChanged=${srcChanged} repull(Σimgs@bump)=${repull} imgCount=${imgCount} srcAdded=${srcAdded} bumps=${bumps.length}`)
        console.log('[QA-Q2-M] ' + JSON.stringify({ tEnd, batches: ext.length, nonPartial, notify: notify.length, notifyAt: notify.map((c) => c.t - tEnd), bumps: bumps.length, thumbDone, extBumps, repull, srcChanged, srcAdded, imgCount }))
      }

      // ---------- Q3：A 质疑 —— 计数守恒（sum(added) 是否 == DB 侧独立口径的实际入库数）----------
      {
        const sub = `${existing.path}/qaA`
        mkdirSync(relAbs(sub), { recursive: true })
        const rowsIn = (): number => count(`SELECT count(*) AS c FROM assets WHERE rel_path LIKE '${sub}/%'`)
        await js('window.__ext=[]'); await drain(); await js('window.__ext=[]')
        const N = 30
        const bufs: Buffer[] = []
        for (let i = 0; i < N; i++) bufs.push(await makePng(50, 50, (i * 11 + 5) % 360))
        for (let i = 0; i < N; i++) { writeFileSync(relAbs(`${sub}/qaA-${i}.png`), bufs[i]); await sleep(130) }
        const tEnd = Date.now()
        await js('window.__extLast=Date.now()')
        const quiet = await drain()
        const ext = (await extDump()) ?? []
        allExt.push(...ext)
        const sumAdded = ext.reduce((s, e) => s + e.added, 0)
        const sumChanged = ext.reduce((s, e) => s + e.changed, 0)
        const indexed = rowsIn()
        // 独立 DB 口径：按 imported_at 时间窗计（区别于 E1 的 rel_path 计数）
        const indexedByTime = count(`SELECT count(*) AS c FROM assets WHERE rel_path LIKE '${sub}/%' AND imported_at >= ${tEnd - 60000}`)
        check('Q3(A) 计数守恒：sum(added) 恰好 == DB 侧实际入库数（无漏计/多计，含被 maxWait 切在边界的事件）',
          quiet && sumAdded === indexed && indexed === indexedByTime,
          `sumAdded=${sumAdded} indexed=${indexed} indexedByTime=${indexedByTime} N=${N} sumChanged=${sumChanged} batches=${JSON.stringify(ext.map((e) => ({ a: e.added, c: e.changed, r: e.removed, p: e.partial })))}`)
        console.log('[QA-Q3] ' + JSON.stringify({ tEnd, sumAdded, indexed, indexedByTime, N, sumChanged, batches: ext.length }))
      }

      // ---------- Q4：B 质疑 —— 零计数非 partial flush 在真实场景是否会发生 ----------
      {
        const zeroNonPartial = allExt.filter((e) => !e.partial && e.added === 0 && e.changed === 0 && e.removed === 0)
        check('Q4(B) 全程未观测到「零计数非 partial」广播（flush-before-add 下安全网不可达；若真出现会白触发一次 bumpThumbs）',
          zeroNonPartial.length === 0, `scanned=${allExt.length} zeroNonPartial=${zeroNonPartial.length} ${JSON.stringify(zeroNonPartial)}`)
      }

      // ---------- Q5：C 质疑 —— 末次 maxWait flush 后流立刻停 → 收尾必须带剩余计数 ----------
      // 关键区分：flush-before-add 下「触发中途 flush 的那个事件」落进新批次，故收尾必带 ≥1 计数；
      // 若实现退化成 flush-after-add，这几个 trial 的收尾会变成 added:0 的空收尾（→ 界面刷新了却没有提示条）。
      {
        const trials: Array<{ n: number; iv: number }> = [
          { n: 12, iv: 130 },
          { n: 13, iv: 130 },
          { n: 24, iv: 130 }
        ]
        const results: string[] = []
        let allGood = true
        for (const t of trials) {
          await js('window.__ext=[]'); await drain(); await js('window.__ext=[]')
          const bufs: Buffer[] = []
          for (let i = 0; i < t.n; i++) bufs.push(await makePng(48, 48, (i * 23 + 77) % 360))
          for (let i = 0; i < t.n; i++) { writeFileSync(relAbs(`${existing.path}/q5-${t.n}-${i}.png`), bufs[i]); await sleep(t.iv) }
          const tEnd = Date.now()
          await js('window.__extLast=Date.now()')
          const quiet = await drain()
          const ext = (await extDump()) ?? []
          allExt.push(...ext)
          const last = ext[ext.length - 1]
          const lastN = last ? last.added + last.changed + last.removed : -1
          const ok = quiet && !!last && last.partial === false && lastN >= 1
          if (!ok) allGood = false
          results.push(`n${t.n}@${t.iv}: ${tl(ext, tEnd)} | last=${JSON.stringify(last)}`)
        }
        check('Q5(C) 末次 maxWait flush 后流立刻停：收尾仍为非 partial 且**带剩余计数≥1**（不会退化成空收尾→无提示）',
          allGood, results.join(' || '))
        console.log('[QA-Q5] ' + JSON.stringify(results))
      }

      const errsQ = await js<string[]>('window.__swErrors || []')
      if (Array.isArray(errsQ)) jsErrors.push(...errsQ)
      check('Q 段没有引入新的渲染层运行期错误', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '))
    }

    // ==================== I3 删库前必须停掉 chokidar 监听器（审计 §1.3） ====================
    // 缺陷：`library:delete` 只调 deleteLibrary → 走 closeCurrent 后直接 rmSync，**从不** unwatchLibrary
    // （对比 `library:close` 是先 unwatch 再 close）。chokidar 因此一直持有已删目录的句柄 ——
    // 回调因 current 为 null 抛错、被内部 try/catch 吞掉，所以**不崩、只是泄漏**，要等下次 library:open
    // 才被顺带回收；Windows 上还可能让紧随的 rmSync 撞 EBUSY。修法在 main.ts 的 deleteLibrarySafely 收口
    // （`--smoke-del` argv 分支 与 `library:delete` IPC 两个调用点都走它）。
    // 本段走**生产路径**：经 IPC open 挂上 watcher、再经 IPC delete 触发那个收口入口。
    {
      // 前置正对照（铁律 G9）：先证明「开库确实挂上了监听器」，否则后面的否定断言（删后 isWatching=false）
      // 会因为 isWatching 恒为 false 而假绿。
      const libDel = createLibrary({ name: 'watch-lib-del', parentDir: dir })
      await js(`window.stash.library.open(${JSON.stringify(libDel.path)})`)
      const before = isWatching()
      check(
        'I3 正对照：经 IPC 开库后 chokidar 确实在监听（否则「删后监听器已停」是空转断言）',
        before === true,
        `isWatching=${before}`
      )

      // 通过 IPC 删除**当前库** → 必须走 main.ts 收口的 deleteLibrarySafely（先 unwatch 再删目录）。
      await js(`window.stash.library.delete(${JSON.stringify(libDel.path)})`)
      const after = isWatching()
      check(
        'I3 删除当前库后监听器已停（isWatching=false，不再泄漏已删目录的 chokidar 句柄）',
        after === false,
        `isWatching=${after}`
      )
      check(
        'I3 库目录确实已从磁盘删除（收口入口没妨碍删除本身）',
        !existsSync(libDel.path),
        `exists=${existsSync(libDel.path)}`
      )
    }

    // ==================== I3b 对抗用例：删「别的库」绝不能停掉当前库的监听器 ====================
    // 工程师的 isCurrentLib 守卫本身正确，但他的 I3 断言只覆盖「删当前库」，「删非当前库」没有断言。
    // 这条防的回归正是「不管删谁都 unwatch」：界面上表现为「删掉一个不相干的库后，当前库不再同步外部变更」。
    {
      const libA = createLibrary({ name: 'watch-adv-A', parentDir: dir })
      // createLibrary 会把 current 设为最后创建的那个；再建一个 B，为「删非当前库」造出对照前提
      const libB = createLibrary({ name: 'watch-adv-B', parentDir: dir })
      // 走生产路径把 current 切回 A 并挂上监听器（createLibrary 本身不挂 watcher）
      await js(`window.stash.library.open(${JSON.stringify(libA.path)})`)
      const wA = isWatching()
      check(
        'I3b(前置) 打开库 A 后监听器在（否则后面的「仍在」是空转断言，铁律 G9）',
        wA === true,
        `isWatching=${wA}`
      )

      // 通过 IPC 删除「另一个库 B」：isCurrentLib=false → 绝不能 unwatch
      await js(`window.stash.library.delete(${JSON.stringify(libB.path)})`)
      const wAfter = isWatching()
      check(
        'I3b(对抗) 删除非当前库 B 后 A 的监听器必须仍在（防「删谁都停监听」回归）',
        wAfter === true,
        `isWatching=${wAfter}`
      )
      check(
        'I3b 库 B 目录确实已删（收口入口不妨碍删非当前库）',
        !existsSync(libB.path),
        `existsB=${existsSync(libB.path)}`
      )
      check(
        'I3b 当前库仍是 A（删 B 不能误清当前库）',
        curPath() === libA.path,
        `current=${curPath()} A=${libA.path}`
      )

      // A 必须仍能收到外部变更：往 A 库根目录写一张图 → watcher 移进「未分类」并落行
      writeFileSync(join(libA.path, 'adv.png'), await makePng(200, 200, 300))
      const gotAdv = await waitDb(
        () => curPath() === libA.path && count("SELECT count(*) AS c FROM assets WHERE name='adv.png'") === 1,
        20000
      )
      check(
        'I3b(对抗) 删掉 B 之后 A 仍能同步外部新增（写文件进 A → 入库，证明监听没被误停）',
        gotAdv
      )
      const advRow = rowByRel(`${UNCAT}/adv.png`)
      check(
        'I3b A 的新增素材落在「未分类/」且 hash 非空（链路完整，不只是「多了一行」）',
        !!advRow && HEX20.test(advRow.content_hash ?? ''),
        JSON.stringify(advRow)
      )
    }

    // ==================== I3c 自愈分支：目标是当前库、但 deleteLibrary 抛错 ====================
    // 本机没有「deleteLibrary 通过两条校验后必抛」的真实路径，故用注入构造：临时在 library.ts
    // 的 deleteLibrary 通过校验后加 `if (process.env.STASH_INJECT_DELETE_THROW) throw`（跑完即还原，见报告）。
    // 期望：deleteLibrarySafely 的 catch 把「已被 unwatch 的当前库」重新挂回监听器，且 current 不被清。
    // 仅在注入环境下执行（正常跑本套时该段 0 断言，计数不变）。
    if (process.env.STASH_INJECT_DELETE_THROW === '1') {
      const libC = createLibrary({ name: 'watch-adv-C', parentDir: dir })
      await js(`window.stash.library.open(${JSON.stringify(libC.path)})`)
      const wBefore = isWatching()
      check('I3c(前置) 打开库 C 后监听器在', wBefore === true, `isWatching=${wBefore}`)

      // 删当前库 → deleteLibrary 抛错 → 收口入口自愈重新挂监听
      await js(`window.stash.library.delete(${JSON.stringify(libC.path)})`)
      const wHeal = isWatching()
      check(
        'I3c(自愈) 删当前库抛错后监听器被重新挂回（isWatching=true，绝不留在「当前库裸奔」中间态）',
        wHeal === true,
        `isWatching=${wHeal}`
      )
      check(
        'I3c(自愈) current 未被清掉（仍指向 C，未进入「无当前库」中间态）',
        curPath() === libC.path,
        `current=${curPath()} C=${libC.path}`
      )
      check(
        'I3c 库 C 目录未被误删（抛错发生在 rmSync 之前）',
        existsSync(join(libC.path, '.stash')),
        `stashExists=${existsSync(join(libC.path, '.stash'))}`
      )
      // 自愈后的监听器必须真的在工作
      writeFileSync(join(libC.path, 'heal.png'), await makePng(180, 180, 90))
      const gotHeal = await waitDb(
        () => curPath() === libC.path && count("SELECT count(*) AS c FROM assets WHERE name='heal.png'") === 1,
        20000
      )
      check('I3c(自愈) 自愈后的监听器确实在工作（写文件进 C → 入库）', gotHeal)
    }

    // ==================== I4-D1 独立计数：result.added == 另一条只读连接看到的新增行数 ====================
    // 独立口径：不复用 importFiles 的 added 自证，也不走当前写连接（写连接在收尾 COMMIT 失败时
    // 仍能看到「尚未落盘」的行）；用一条全新的只读连接数总行数（本库是新建的，总行数=新增行数）。
    {
      const libI = createLibrary({ name: 'watch-adv-I4', parentDir: dir })
      await js(`window.stash.library.open(${JSON.stringify(libI.path)})`)
      const srcI = join(dir, 'i4src')
      mkdirSync(srcI, { recursive: true })
      const paths: string[] = []
      for (let i = 0; i < 5; i++) {
        const p = join(srcI, `i4-${i}.png`)
        writeFileSync(p, await makePng(64, 64, (i * 47) % 360))
        paths.push(p)
      }
      const res = await new Promise<{ added: number; failed: Array<{ path: string; error: string }> }>(
        (resolve) => {
          importFiles({ paths, mode: 'copy', onDone: (r) => resolve(r) })
        }
      )
      const rows = rowsViaFreshReadonly(libI.path)
      check(
        'I4-D1 正常导入 result.added == 独立只读连接数出的行数（且无 failed），不靠 added 自证',
        res.added === paths.length && res.added === rows && res.failed.length === 0,
        `added=${res.added} rows=${rows} expect=${paths.length} failed=${JSON.stringify(res.failed)}`
      )
    }

    // ==================== E3 F3 真实链路：注入 commitBatch 抛错 → 真实导入 → 取 failed 与渲染层文案 ====================
    // 目的（报告 E3）：不只看工程师给的那串字，而是走**真实链路**取出两样东西：
    //   ① 主进程 `importFiles` 的 `onDone` 收到的 `failed` 记录（真形状：batch/count）；
    //   ② 渲染层 `assets.importNotice` 实际要渲染的那句话（App.vue 的 onDone → importFailedText）。
    // 注入方式：临时在 importer.ts 的 commitBatch 里按 `process.env.STASH_QA_E3_PHASE==='1'` 抛错（跑完按备份还原）。
    // ⚠️ 为什么注入读的是 **PHASE** 而不是这个外层门控 `STASH_QA_E3`：同一个 watch 进程里，本段**之前**还有
    //    I4-D1 的正常导入（必须成功）。若注入直接读 `STASH_QA_E3`，那次导入也会被连坐抛错、并级联污染后面
    //    的断言（实测过一版：E3 段自身根本没跑到）。所以「是否跑 E3 段」用外层 `STASH_QA_E3` 门控，
    //    而「是否让 commitBatch 抛错」只在**真正发起 E3 那次 import 的前后**用 PHASE 单独开关——两次导入
    //    互不影响。正常回归（env 未设、importer 已还原）整段跳过，断言计数不变。
    // 关键点：用 `createLibrary`（会 setCurrent、但**不挂 watcher**）+ 直接读 Pinia store 的 importNotice，
    // 免得被「物理拷贝进来的失败批」触发的 library:external 广播把这条 error 提示覆盖掉。
    if (process.env.STASH_QA_E3 === '1') {
      const libE = createLibrary({ name: 'watch-e3', parentDir: dir })
      const srcE = join(dir, 'e3src')
      mkdirSync(srcE, { recursive: true })
      const pathsE: string[] = []
      for (let i = 0; i < 5; i++) {
        const p = join(srcE, `e3-${i}.png`)
        writeFileSync(p, await makePng(64, 64, (i * 29 + 60) % 360))
        pathsE.push(p)
      }
      // 只在这一次 import 期间打开 PHASE 开关，让 commitBatch 抛错；随后立刻关掉，避免影响后续任何导入。
      process.env.STASH_QA_E3_PHASE = '1'
      const resE = await new Promise<{
        added: number
        failed: Array<{ path: string; error: string; batch?: boolean; count?: number }>
      }>((resolve) => importFiles({ paths: pathsE, mode: 'copy', onDone: (r) => resolve(r) }))
      delete process.env.STASH_QA_E3_PHASE
      check(
        `E3(注入) 整批提交失败：added 扣回为 0、failed 恰 1 条且带 batch:true/count:${pathsE.length}（真形状，非渲染层自造）`,
        resE.added === 0 &&
          resE.failed.length === 1 &&
          resE.failed[0].batch === true &&
          resE.failed[0].count === pathsE.length,
        JSON.stringify(resE)
      )
      // 渲染层实际要展示的那句话（直接读 store 的 importNotice，不依赖 DOM 视图）
      const noticeExpr = `(() => { const a = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('assets'); return a.importNotice ? String(a.importNotice.text) : null })()`
      const noticeShown = await waitUntil(
        `(() => { const a = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('assets'); return !!(a.importNotice && /索引未写入/.test(a.importNotice.text)) })()`,
        15000
      )
      const noticeText = (await js<string | null>(noticeExpr)) ?? null
      check(
        'E3(注入) 渲染层实际文案说清「1 批共 5 个文件…索引未写入」且**不含**「首个：」（与 importer 契约一致）',
        noticeShown &&
          !!noticeText &&
          noticeText.includes(String(pathsE.length)) &&
          noticeText.includes('索引未写入') &&
          !noticeText.includes('首个：'),
        `notice=${JSON.stringify(noticeText)}`
      )
      console.log('[QA-E3] ' + JSON.stringify({ failed: resE.failed, notice: noticeText, lib: libE.path }))
    }

    // ==================== F1 缩略图自愈必须能「重新武装」：同一素材连续两次外部改写（不重开库）====================
    // 命题（对应审计 §2.4 / 铁律 A9）：`GalleryGrid.thumbRetried` 原以**素材 id** 为键，同一素材
    // 内容被**就地改写**时 id 不变，于是「第 1 次改写把 id 记进集合 → 第 2 次改写（同一 id、新 hash）
    // 一进 onImgErr 就被挡住、再也不补生成」→ 卡片**永久**停在破图，直到用户重开库。
    //
    // 为什么这条断言有鉴别力（而不是两条都可能绿的空转）：
    //   · 第 1 次改写时「新 hash 的缩略图尚未生成」，按 id 键与按 hash 键**都会**补生成成功（两种实现都绿）；
    //   · 第 2 次改写时哈希又变 → 按 **id** 键的实现因 id 已在集合里而**直接 return、永久卡死**；
    //     按 **hash** 键的实现则「新 hash = 新键」→ 正常自愈。→ **只有正确实现能绿。**
    // ⚠️ 两次改写之间**绝不 reopen**：reopen 会重建组件、thumbRetried 变新实例，从而掩盖这个 bug
    //    （这正是它此前只偶发 1/9、难以稳定复现的根因）。
    {
      // 用一个全新的库，避免与前面各段的资产/DOM 相互干扰。
      const libF1 = createLibrary({ name: 'watch-f1-rearm', parentDir: dir })
      // ⚠️ 目标文件夹必须在**开监听之前**建好：chokidar 只会在既有的目录上可靠地建立 watch，
      // 「监听建立后才新建的目录 / 被 watcher 自己 move 进来的文件」会让首个 change 事件被吞
      // （纯测试伪影）。所以这里先 mkdirRel('素材')，再 reopen 挂监听。
      const f1Folder = mkdirRel('素材')
      await reopen(libF1.path)

      // 正对照探针（铁律 G9/G11）：记录渲染层 onImgErr 是否真的触发过。
      // onImgErr 里 `console.warn('IMG_ERR', it.name, key=...)` 打在「是否已补过」判断**之前**，
      // 所以只要该素材的缩略图 404 过一次，这里就会留下它的名字。用来断言「初始加载确实走了
      // 404 → 补生成」这条路，即 `thumbRetried` 真的被占过。
      // 为什么必须有这条前置：下面对同一素材连续两次改写、断言「两次都能恢复新 hash 的缩略图」，
      // 其鉴别力隐含一个前提 —— 集合里已经有一把旧键。若首次请求时缩略图就已存在（根本没有 404），
      // 集合是空的：第 1 次改写才把键写进空集合、第 2 次才可能被挡。缺这条前置，「两次都恢复」就
      // 可能在「自愈链压根没被触发」的时序下恒真 —— 这正是 G9/G11 那一族的「负向/空转假绿」。
      await js(
        `window.__imgErr=[];
         if(!window.__imgErrHooked){const ow=console.warn.bind(console);
           console.warn=function(){if(String(arguments[0])==="IMG_ERR")window.__imgErr.push(String(arguments[1]||""));return ow.apply(null,arguments)};
           window.__imgErrHooked=true;}
         'ok'`
      )

      // 外部写进这个既有文件夹（不经过根目录 → 未分类 的移动，行为最干净），随后**不重开库**等卡片上屏。
      const targetRel = `${f1Folder.path}/rearm-f1.png`
      writeFileSync(relAbs(targetRel), await makePng(300, 200, 18))
      const inDb = await waitDb(() => !!rowByRel(targetRel), 20000)
      const id = rowByRel(targetRel)?.id ?? -1
      const h0 = rowByRel(targetRel)?.content_hash ?? ''
      // ⚠️ 对抗开关（默认关，仅 STASH_QA_F1P=1 时开）：在初始 <img> 加载**之前**就把缩略图生成好，
      //    人为制造「首次请求时缩略图已存在、没有 404」的时序，用来证伪「集合为空 → 按 id 键也会全绿」
      //    这个假绿担忧（报告 B1）。
      if (process.env.STASH_QA_F1P === '1') {
        await js(`window.stash.thumb.ensure(${id}, 'grid')`)
        await waitDb(() => existsSync(join(lib.path, '.thumbs', h0, 'grid.webp')), 20000)
      }
      const cardSeen = await waitUntil(`!!document.querySelector('.masonry-card[data-id="${id}"]')`, 25000)
      // 让初始缩略图真正加载出来（把「外部新增 → 广播 → 补生成」整条链跑完）。
      const h0Loaded = await waitImgLoaded(id, h0, 25000)
      // —— 正对照断言（铁律 G9/G11）：初始加载确实 404 过 → thumbRetried 被占过 ——
      // 若这条红，说明本段赖以成立的前提没满足（首次请求时缩略图已存在），整段断言不具备鉴别力；
      // 宁可直接红（不静默假绿）。STASH_QA_F1P=1 时本条**预期为红**，正是为了证明它真的能拦住假绿。
      const imgErrNames = (await js<string[]>('window.__imgErr')) ?? []
      check(
        'F1-D 前置⓪（正对照）：初始加载确实走了「404 → 补生成」（thumbRetried 被占过）——否则两次改写是空转、按 id 键也会假绿',
        imgErrNames.includes('rearm-f1.png'),
        `imgErr=${JSON.stringify(imgErrNames)}${process.env.STASH_QA_F1P === '1' ? ' [STASH_QA_F1P=1 对抗模式：本条预期红]' : ''}`
      )
      // 同目录**正对照**：改写前先写一个控制文件并等它入库 —— 证明 chokidar 已把这批事件追平，
      // 从而目标文件的 awaitWriteFinish 窗口也已关闭。否则紧接着的改写可能与「初始新增」的
      // write-finish 窗口重叠、被 chokidar 合并而没有 change 事件（纯测试伪影，非产品缺陷）。
      writeFileSync(relAbs(`${f1Folder.path}/ctl.png`), await makePng(120, 120, 40))
      const ctlOk = await waitDb(() => !!rowByRel(`${f1Folder.path}/ctl.png`), 20000)
      check(
        'F1-D 前置：目标素材已入库上屏 + 初始缩略图已加载 + 同目录正对照已入库（证明 chokidar 已追平，未重开库）',
        inDb && id !== -1 && cardSeen && HEX20.test(h0) && h0Loaded && ctlOk,
        `id=${id} h0=${h0} card=${cardSeen} h0Loaded=${h0Loaded} ctl=${ctlOk}`
      )

      // —— 第 1 次外部就地改写 ——
      writeFileSync(relAbs(targetRel), await makePng(340, 220, 130))
      const d1 = hashOf(relAbs(targetRel))
      const sync1 = await waitDb(() => rowByRel(targetRel)?.content_hash === d1, 20000)
      check(
        'F1-D 前置①：第 1 次外部改写已同步，且 hash 真的变了（≠ 初值）——否则后续是空转',
        sync1 && HEX20.test(d1) && d1 !== h0,
        `${h0} -> ${d1}`
      )
      const ok1 = await waitImgLoaded(id, d1, 25000)
      check(
        'F1-D 第 1 次改写后卡片恢复到新 hash 的缩略图（naturalWidth>0）',
        ok1,
        ok1 ? `id=${id} hash=${d1}` : `id=${id} hash=${d1} ${await imgDiag(id, d1)}`
      )

      // —— 第 2 次外部就地改写（同一 id、又一个新 hash；绝不 reopen）——
      writeFileSync(relAbs(targetRel), await makePng(360, 240, 280))
      const d2 = hashOf(relAbs(targetRel))
      const sync2 = await waitDb(() => rowByRel(targetRel)?.content_hash === d2, 20000)
      check(
        'F1-D 前置②：第 2 次外部改写已同步，且 hash 又变了（≠ 第 1 次的 hash）——否则是空转',
        sync2 && HEX20.test(d2) && d2 !== d1,
        `${d1} -> ${d2}`
      )
      const ok2 = await waitImgLoaded(id, d2, 25000)
      check(
        'F1-D【核心】第 2 次改写（不重开库）后卡片仍能恢复到新 hash 的缩略图（旧实现按 id 作键会永久卡死）',
        ok2,
        ok2 ? `id=${id} hash=${d2}` : `id=${id} hash=${d2} ${await imgDiag(id, d2)}`
      )
    }

  } catch (e) {
    check('套件执行未抛异常', false, String((e as Error)?.message ?? e))
  } finally {
    try {
      closeCurrent()
    } catch {
      /* 库已关 */
    }
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* Windows 句柄未释放，忽略 */
      }
    }
    const failed = checks.filter((c) => !c.pass)
    console.log('[SMOKE-WATCH] ' + JSON.stringify({ checks, failed, ok: failed.length === 0, diag: R }, null, 2))
    app.exit(0)
  }
}
