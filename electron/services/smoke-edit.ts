// 编辑能力冒烟：**重命名素材文件 / 重命名标签 / 提示词（备注）/ 复制粘贴源文件**
//
// 覆盖四条新增链路，全都「服务层 + UI」双跑，断言同时核对数据库与 DOM
// （本项目出过「DB 写成功、UI 不刷新」的假绿，只查 DB 会漏）。
//
// 几个容易踩的点记在这里：
//   - **扩展名不可改**：`renameAsset` 会拒绝改后缀（内容没变，改了只会让 type / 缩略图对不上），
//     所以弹窗里后缀是独立的只读片段，输入框只编辑主名；
//   - **重名 / 非法名 / 空名**都要有明确错误码，UI 侧翻成人话提示；
//   - **粘贴必须放开内容去重**（`dedupe:false`）：同一张图在另一个文件夹再放一份是正常操作，
//     被 `content_hash` 去重挡掉会表现成「点了粘贴没反应」；
//   - 粘贴读的是系统剪贴板，冒烟里必须先 `clipboard.clear()` 把不确定的系统内容清掉，
//     让它落到「内部剪贴板」这条确定性路径上（复制时写入的那份记录）。
import { app, BrowserWindow, clipboard } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { closeCurrent, createLibrary, forgetLibrary, mkdirRel, openLibrary, requireCurrent } from './library'
import { readFiles, writeFiles } from './clipboard'
import { copyAssets, createTag, moveAssets, pastePaths, renameAsset, renameTag, setTags, updateAsset } from './assets'
import { importFiles, type ImportResult } from './importer'
import { getSettings, patchSettings } from './config'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
function onceLoaded(win: BrowserWindow): Promise<void> {
  return new Promise((resolve) => win.webContents.once('did-finish-load', () => resolve()))
}

const IMAGES: Array<[string, number]> = [
  ['红.png', 40],
  ['蓝.png', 60],
  ['绿.png', 80]
]

export async function runSmokeEdit(win: BrowserWindow): Promise<void> {
  const R: Record<string, unknown> = {}
  const jsErrors: Array<{ code: string; error: string }> = []
  win.webContents.on('console-message', (_e, _lvl, message) => {
    void message
  })
  const rawJs = (code: string): Promise<unknown> => win.webContents.executeJavaScript(code)
  const js = async (code: string): Promise<unknown> => {
    try {
      return await rawJs(code)
    } catch (e) {
      jsErrors.push({ code: code.replace(/\s+/g, ' ').slice(0, 160), error: String(e).slice(0, 160) })
      return null
    }
  }
  /**
   * 渲染层**运行期错误**收集（`error` / `unhandledrejection`）。
   *
   * ⚠️ 上面那条 `console-message` 监听在本项目的 Electron 版本下拿不到级别（`_lvl` 已废弃），
   * 等于空转：`noJsErrors` 过去只能证明「我们注入的脚本没抛」，证明不了「点菜单没引发运行时异常」。
   * 与 smoke-settings / smoke-preview 同口径，改为在**页面内**收（reload 会清掉数组，靠 `__seArmed`
   * 标记重新挂一次，不会重复注册监听）。
   */
  const armErrors = async (): Promise<void> => {
    await js(
      'if (!window.__seArmed) { window.__seArmed = 1; window.__seErrors = [];' +
        "window.addEventListener('error', (e) => window.__seErrors.push('error: ' + String(e.message)));" +
        "window.addEventListener('unhandledrejection', (e) => window.__seErrors.push('reject: ' + String(e.reason))); }"
    )
  }
  const pageErrors = async (): Promise<string[]> => ((await js('window.__seErrors ?? []')) as string[] | null) ?? []

  let dir: string | null = null
  let libPath = ''
  const D = (): ReturnType<typeof requireCurrent>['db'] => requireCurrent().db
  const step = (s: string): void => console.log('[SMOKE-EDIT-STEP] ' + s)

  /** 轮询等待（异步导入完成、DOM 刷新等） */
  const waitFor = async (fn: () => boolean | Promise<boolean>, timeout = 8000, stepMs = 120): Promise<boolean> => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      if (await fn()) return true
      await sleep(stepMs)
    }
    return await fn()
  }

  // ==================== 数据层助手 ====================
  const assetIdOf = (name: string): number =>
    (D().prepare('SELECT id FROM assets WHERE name=?').get(name) as { id: number } | undefined)?.id ?? -1
  const assetNames = (): string[] =>
    (D().prepare('SELECT name FROM assets ORDER BY name').all() as Array<{ name: string }>).map((r) => r.name)
  const assetRow = (id: number): { name: string; rel_path: string; note: string | null } | undefined =>
    D().prepare('SELECT name, rel_path, note FROM assets WHERE id=?').get(id) as never
  const tagRows = (): Array<{ id: number; name: string }> =>
    D().prepare('SELECT id, name FROM tags ORDER BY name').all() as never
  const assetCount = (): number => (D().prepare('SELECT count(*) AS c FROM assets').get() as { c: number }).c

  const errOf = (fn: () => unknown): string => {
    try {
      fn()
      return 'NO_ERROR'
    } catch (e) {
      return String((e as Error).message ?? e)
    }
  }

  /**
   * 期望**成功**的调用：出错时返回 `{ error }` 而不是抛出去。
   * 冒烟里一旦某步抛异常就会跳到 catch，后面所有断言都拿不到数据 ——
   * 那样只能看到「ok:false」，却看不出是哪条断言在盯这件事（做注入验证时尤其吃亏）。
   */
  const tryCall = <T>(fn: () => T): T | { error: string } => {
    try {
      return fn()
    } catch (e) {
      return { error: String((e as Error).message ?? e) }
    }
  }

  // ==================== DOM 助手 ====================
  const click = (x: number, y: number): void => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) })
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
  }
  const rightClick = (x: number, y: number): void => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) })
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'right', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'right', clickCount: 1 })
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
  const clickSel = async (selector: string, index = 0): Promise<boolean> => {
    const p = await elPoint(selector, index)
    if (!p) return false
    click(p.x, p.y)
    await sleep(260)
    return true
  }
  /** 点 DOM 里某个按钮（不改状态的选择器优先用真实鼠标，按钮用 .click() 足够稳） */
  const clickJs = async (selector: string): Promise<boolean> =>
    ((await js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.click(); return true })()`)) as
      | boolean
      | null) ?? false

  const noticeText = async (): Promise<string | null> =>
    (await js(`document.querySelector('.notice-toast')?.textContent.trim() ?? null`)) as string | null

  const cardNames = async (): Promise<string[]> =>
    ((await js(`[...document.querySelectorAll('.masonry-card')].map(c => c.querySelector('.ci-name')?.textContent ?? '')`)) as
      | string[]
      | null) ?? []

  /** 输入框里打字并敲回车 */
  const typeInto = async (selector: string, text: string): Promise<void> => {
    await js(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); if (i) { i.focus(); i.select && i.select() } })()`)
    await sleep(140)
    win.webContents.insertText(text)
    await sleep(200)
  }

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
    dir = mkdtempSync(join(tmpdir(), 'stash-smoke-edit-'))
    libPath = createLibrary({ name: 'editlib', parentDir: dir }).path

    // ==================== S. 服务层 ====================
    step('S-服务层')
    const srcFiles: string[] = []
    for (const [name, size] of IMAGES) {
      const p = join(dir, name)
      await sharp({ create: { width: size, height: size, channels: 3, background: { r: 90, g: 130, b: 170 } } })
        .png()
        .toFile(p)
      srcFiles.push(p)
    }
    await new Promise((resolve) => importFiles({ paths: srcFiles, folderId: null, mode: 'copy', onDone: resolve }))

    // —— S1 重命名素材：磁盘 + 索引同步 ——
    const redId = assetIdOf('红.png')
    const libDir = join(libPath, '未分类')
    const renamed = renameAsset(redId, '红日.png')
    R.s1_rename = {
      ret: renamed,
      row: assetRow(redId),
      diskNew: existsSync(join(libDir, '红日.png')),
      diskOld: existsSync(join(libDir, '红.png')),
      names: assetNames()
    }

    // —— S2 重命名的拒绝分支（真正非法的输入才拒绝）——
    // 注意：**重名不在拒绝之列** —— 目标名被占用时会自动加 ` (n)`（见 S2b）
    R.s2_reject = {
      extChanged: errOf(() => renameAsset(redId, '红日.jpg')),
      noExt: errOf(() => renameAsset(redId, '红日')),
      empty: errOf(() => renameAsset(redId, '   ')),
      slash: errOf(() => renameAsset(redId, 'a/b.png')),
      reserved: errOf(() => renameAsset(redId, 'CON.png')),
      // 以点结尾：Windows 会静默裁掉尾点，磁盘名与索引名会对不上，必须拦
      tailDot: errOf(() => renameAsset(redId, '红日.')),
      // 结尾空格在 trim 阶段就被吃掉了，最终落到「没扩展名」这条上
      tailSpace: errOf(() => renameAsset(redId, '红日 ')),
      missing: errOf(() => renameAsset(99999, 'x.png')),
      // 拒绝之后世界必须原样不动（不能出现「改名成功一半」）
      namesAfter: assetNames(),
      diskStillThere: existsSync(join(libDir, '红日.png'))
    }

    // —— S2b 重名 → **自动改名**（不是报错、更不是覆盖）——
    // 拿「绿.png」当靶子改名成已存在的「蓝.png」，避免污染后面所有以红日.png 为基准的断言。
    // 关键：先用复制把 `蓝 (1).png` 也占住 —— 否则改名走的是「同一个文件从 (1) 挪到 (2)」，
    // `蓝 (1).png` 会随之消失，「跳过已占用名」这条根本没被测到。
    const greenId = assetIdOf('绿.png')
    const occupy = copyAssets([assetIdOf('蓝.png')], null) // 落到「未分类」，生成 蓝 (1).png
    const auto1 = tryCall(() => renameAsset(greenId, '蓝.png')) // 蓝.png / 蓝 (1).png 都被占 → 蓝 (2).png
    const diskAfterAuto1 = ['蓝.png', '蓝 (1).png', '蓝 (2).png', '绿.png'].map(
      (n) => [n, existsSync(join(libDir, n))] as [string, boolean]
    )
    // 收尾：绿.png 这个名字现在空出来了，改回去，别影响后面
    const autoBack = tryCall(() => renameAsset(greenId, '绿.png'))
    const diskAfterBack = ['蓝.png', '蓝 (1).png', '蓝 (2).png', '绿.png'].map(
      (n) => [n, existsSync(join(libDir, n))] as [string, boolean]
    )
    R.s2b_autoRename = {
      occupy,
      auto1,
      autoBack,
      rowAfter: D().prepare('SELECT name, rel_path FROM assets WHERE id=?').get(greenId) as never,
      diskAfterAuto1,
      diskAfterBack,
      // 被占用的原名必须原封不动（自动改名 ≠ 覆盖）
      blueIntact: (D().prepare('SELECT count(*) AS c FROM assets WHERE name=?').get('蓝.png') as { c: number }).c,
      names: assetNames()
    }

    // —— S2c 仅大小写变化是合法改名，不能当成冲突 ——
    const caseRes = tryCall(() => renameAsset(greenId, '绿.PNG'))
    R.s2c_caseOnly = { ret: caseRes, disk: existsSync(join(libDir, '绿.PNG')) }
    tryCall(() => renameAsset(greenId, '绿.png')) // 改回来

    // —— S3 重命名标签：只改文本，关联不受影响 ——
    const tScenery = createTag({ name: '风景' })
    const tSky = createTag({ name: '天空' })
    D().prepare('INSERT INTO asset_tags(asset_id, tag_id) VALUES(?,?)').run(redId, tScenery.id)
    const tagRenamed = renameTag(tScenery.id, '自然')
    R.s3_tagRename = {
      ret: tagRenamed,
      tags: tagRows().map((t) => t.name),
      links: (
        D()
          .prepare(
            `SELECT a.name AS asset, t.name AS tag FROM asset_tags at
               JOIN assets a ON a.id=at.asset_id JOIN tags t ON t.id=at.tag_id ORDER BY a.name, t.name`
          )
          .all() as Array<{ asset: string; tag: string }>
      ).map((x) => `${x.asset}→${x.tag}`),
      sameName: errOf(() => renameTag(tScenery.id, '自然')),
      dup: errOf(() => renameTag(tScenery.id, '天空')),
      empty: errOf(() => renameTag(tScenery.id, ' ')),
      unknown: errOf(() => renameTag(99999, 'x')),
      finalTags: tagRows().map((t) => t.name),
      skyStillThere: tSky.id > 0 && tagRows().some((t) => t.name === '天空')
    }

    // —— S4 提示词：写入、纯空白归一成 NULL ——
    updateAsset(redId, { note: '一只橘猫，坐在窗台上' })
    const noteSet = assetRow(redId)?.note ?? null
    updateAsset(redId, { note: '   \n  ' })
    const noteBlank = assetRow(redId)?.note ?? null
    updateAsset(redId, { note: '恢复的内容' })
    R.s4_note = { noteSet, noteBlank, noteBack: assetRow(redId)?.note ?? null }

    // —— S5 库内复制：副本要带上评分/喜欢/备注/标签，重名自动加 (n) ——
    updateAsset(redId, { rating: 4, isFav: true })
    const target = mkdirRel('粘贴目标')
    const c1 = copyAssets([redId], target.id)
    const c2 = copyAssets([redId], target.id)
    const rowOf = (id: number): Record<string, unknown> | undefined =>
      D().prepare('SELECT id, name, rating, is_fav, note, content_hash FROM assets WHERE id=?').get(id) as never
    const copyRows = D()
      .prepare('SELECT id, name, rating, is_fav, note, content_hash FROM assets WHERE folder_id=? ORDER BY name')
      .all(target.id) as Array<{ id: number; name: string; rating: number; is_fav: number; note: string | null; content_hash: string }>
    const tagNamesOf = (assetId: number): string[] =>
      (
        D()
          .prepare('SELECT t.name AS name FROM asset_tags at JOIN tags t ON t.id=at.tag_id WHERE at.asset_id=? ORDER BY t.name')
          .all(assetId) as Array<{ name: string }>
      ).map((r) => r.name)
    R.s5_copy = {
      c1,
      c2,
      src: rowOf(redId),
      copyRows,
      srcTags: tagNamesOf(redId),
      copyTags: tagNamesOf(copyRows[0]?.id ?? -1),
      disk: copyRows.map((r) => existsSync(join(libPath, '粘贴目标', r.name)))
    }

    // —— S6 剪贴板往返 + pastePaths 分流 ——
    // 库内路径 → 生成副本；库外路径 → 走导入管线
    const inLibPath = join(libDir, '红日.png')
    await writeFiles([inLibPath])
    const backInLib = await readFiles()
    const target2 = mkdirRel('粘贴目标2')
    const pasteInLib = pastePaths(backInLib, target2.id)

    // 库外新文件（内容与库里任何一张都不同，免得被导入查重挡掉）
    const outsideFile = join(dir, '外部.png')
    await sharp({ create: { width: 120, height: 120, channels: 3, background: { r: 200, g: 120, b: 60 } } })
      .png()
      .toFile(outsideFile)
    await writeFiles([outsideFile])
    const backOutside = await readFiles()
    const target3 = mkdirRel('外部分流')
    const pasteOutside = pastePaths(backOutside, target3.id)
    const outsideImported = await waitFor(
      () => (D().prepare('SELECT count(*) AS c FROM assets WHERE folder_id=?').get(target3.id) as { c: number }).c === 1,
      8000
    )
    R.s6_clipboard = {
      backInLibMapped: backInLib.map((p) => p.toLowerCase() === inLibPath.toLowerCase()),
      pasteInLib,
      copiedRow: D()
        .prepare('SELECT name, rating, is_fav, note FROM assets WHERE folder_id=?')
        .get(target2.id) as never,
      backOutsideMapped: backOutside.map((p) => p.toLowerCase() === outsideFile.toLowerCase()),
      pasteOutside,
      outsideImported,
      outsideName: (
        D().prepare('SELECT name FROM assets WHERE folder_id=?').get(target3.id) as { name: string } | undefined
      )?.name,
      totalAfter: assetCount()
    }

    // 让「最新的一张」落在**有兄弟文件**的目录里 —— U2 要拿同目录的兄弟名当「重名必须被拒」的靶子
    copyAssets([redId], target.id)

    // —— S8 导入同名文件：目标目录已有同名 → 自动改成 `名字 (1).ext`，并回传 renamed ——
    const srcA = join(dir, 'src-a')
    const srcB = join(dir, 'src-b')
    mkdirSync(srcA, { recursive: true })
    mkdirSync(srcB, { recursive: true })
    // 两张同名但内容不同的图（内容不同才不会被 content_hash 查重挡掉，重名处理才可见）
    await sharp({ create: { width: 150, height: 150, channels: 3, background: { r: 10, g: 200, b: 10 } } })
      .png()
      .toFile(join(srcA, '同名.png'))
    await sharp({ create: { width: 160, height: 160, channels: 3, background: { r: 200, g: 10, b: 10 } } })
      .png()
      .toFile(join(srcB, '同名.png'))
    const importTarget = mkdirRel('导入同名')
    const imp = await new Promise<ImportResult>((resolve) =>
      importFiles({
        paths: [join(srcA, '同名.png'), join(srcB, '同名.png')],
        folderId: importTarget.id,
        mode: 'copy',
        onDone: resolve
      })
    )
    R.s8_import = {
      imp,
      names: (
        D().prepare('SELECT name FROM assets WHERE folder_id=? ORDER BY name').all(importTarget.id) as Array<{
          name: string
        }>
      ).map((r) => r.name),
      disk: ['同名.png', '同名 (1).png'].map((n) => [n, existsSync(join(libPath, '导入同名', n))])
    }

    // 给被自动改名的那张打上标注：U3 的「复制要带上标注」断言需要有非零值才有意义
    // （全 0 的副本与源相等是恒真的，测不出「标注有没有被拷过去」）。
    // 加 >0 守卫：万一上面的重名处理坏掉导致这张不存在，也不要让整条链路抛错中断，
    // 那样后面的断言全都拿不到数据，反而看不出真正失败的是哪一条。
    const imported2Id = assetIdOf('同名 (1).png')
    if (imported2Id > 0) {
      updateAsset(imported2Id, { rating: 5, isFav: true, note: '导入的图' })
      D().prepare('INSERT OR IGNORE INTO asset_tags(asset_id,tag_id) VALUES(?,?)').run(imported2Id, tScenery.id)
    }

    // —— S7 老库迁移：把 note 列删掉再开库，migrate() 必须自动补回来且数据不丢 ——
    // 其余冒烟用的都是新建库（SCHEMA 里直接带 note），走不到这条迁移路径，所以单独造一次
    const colsOf = (): string[] =>
      (D().prepare('PRAGMA table_info(assets)').all() as Array<{ name: string }>).map((r) => r.name)
    const rowBefore = D().prepare('SELECT name, rating, is_fav FROM assets WHERE id=?').get(redId) as never
    D().exec('ALTER TABLE assets DROP COLUMN note')
    const colsBefore = colsOf()
    const countBefore = assetCount()
    closeCurrent()
    openLibrary(libPath)
    const colsAfter = colsOf()
    R.s7_migrate = {
      colsBefore,
      colsAfter,
      countBefore,
      countAfter: assetCount(),
      rowBefore,
      rowAfter: D().prepare('SELECT name, rating, is_fav FROM assets WHERE id=?').get(redId) as never,
      noteIsNull: (assetRow(redId) as { note: string | null } | undefined)?.note ?? null
    }
    await capture('shot-edit-service.png')

    // ==================== U. UI 段 ====================
    step('U-UI')
    // 前置状态隔离：右侧信息栏的收起状态是**全局偏好**（userData/config.json），跨冒烟共享同一份 ——
    // 上一轮万一在「收起」之后崩掉，别的套件（m4 要读 .detail 里的星标）会莫名其妙全红。
    // 开跑前先复位，收尾再复一次（见 finally）。
    // ⚠️ 它以前存在 localStorage，现在搬进了 config —— 复位/读取都必须走 config，
    // 否则复位是个空操作、断言永远读到 null（这个坑在改动当期就踩到过）。
    patchSettings({ detailCollapsed: false })
    await rawJs(`window.stash.library.open(${JSON.stringify(libPath)}).then(() => location.reload())`)
    await onceLoaded(win)
    await sleep(2800)

    // —— U0 preload 桥接自检 ——
    // 拖文件导入没法在冒烟里真的从资源管理器拖过来，至少盯住「桥」本身没断：
    // 少暴露一个方法时渲染层只会静默报 undefined，这里能立刻发现。
    R.u0_bridge = (await js(`JSON.stringify({
      pathForFile: typeof window.stash.pathForFile,
      clipboardWrite: typeof window.stash.clipboard.writeFiles,
      clipboardRead: typeof window.stash.clipboard.readFiles,
      assetCopy: typeof window.stash.asset.copy,
      assetPaste: typeof window.stash.asset.paste,
      assetRename: typeof window.stash.asset.rename,
      tagRename: typeof window.stash.tag.rename
    })`)) as string | null
    // 合成 File（没有真实磁盘路径）不能抛错，否则真实 drop 会整条链路挂掉
    R.u0_fileProbe = (await js(`(() => {
      try { return typeof window.stash.pathForFile(new File(['x'], 'a.txt')) } catch (e) { return 'THREW:' + e.message }
    })()`)) as string | null

    // —— U1 右键素材 → 菜单里有重命名 / 复制 / 粘贴 ——
    const cardPt = await elPoint('.masonry-card', 0)
    if (cardPt) rightClick(cardPt.x, cardPt.y)
    await sleep(360)
    R.u1_menuItems = (await js(`JSON.stringify([...document.querySelectorAll('.ctx-menu .ctx-item')].map(b => b.textContent.trim()))`)) as
      | string
      | null
    await capture('shot-edit-ctxmenu.png')

    // —— U2 打开重命名弹窗：主名可编辑、后缀是只读片段 ——
    R.u2_open = await clickJs('[data-ctx="rename"]')
    await sleep(360)
    R.u2_dialog = (await js(`(() => {
      const i = document.querySelector('[data-rename-input]')
      const e = document.querySelector('[data-rename-ext]')
      const card = document.querySelector('.masonry-card.selected .ci-name')
      if (!i) return 'null'
      return JSON.stringify({
        value: i.value,
        ext: e?.textContent.trim() ?? null,
        extTag: e?.tagName ?? null,
        focused: document.activeElement === i,
        cardName: card?.textContent.trim() ?? null
      })
    })()`)) as string | null

    // 输入一个**已存在**的名字 → 不报错，自动改成 `名字 (1).png`，弹窗关闭
    const selIdForDup = (await js(`Number(document.querySelector('.masonry-card.selected')?.dataset.id ?? -1)`)) as number
    const nameBefore = (
      D().prepare('SELECT name FROM assets WHERE id=?').get(selIdForDup) as { name: string } | undefined
    )?.name
    const sib = D()
      .prepare('SELECT name FROM assets WHERE folder_id=(SELECT folder_id FROM assets WHERE id=?) AND id<>? LIMIT 1')
      .get(selIdForDup, selIdForDup) as { name: string } | undefined
    const sibBase = (sib?.name ?? '').replace(/\.png$/i, '')
    if (sib) {
      await typeInto('[data-rename-input]', sibBase)
      await clickJs('[data-rename-ok]')
      await sleep(1500)
    }
    R.u2_dup = {
      inputBase: sibBase,
      target: sib?.name ?? null,
      nameBefore,
      nameAfter: (
        D().prepare('SELECT name FROM assets WHERE id=?').get(selIdForDup) as { name: string } | undefined
      )?.name,
      // 被占用的原名必须原样还在（自动改名 ≠ 覆盖）
      targetStillThere:
        sib == null
          ? null
          : (D().prepare('SELECT count(*) AS c FROM assets WHERE name=?').get(sib.name) as { c: number }).c,
      dialogClosed: (await js(`!!document.querySelector('[data-rename-input]')`)) === false,
      notice: await noticeText()
    }
    R.u2_done = {
      cards: await cardNames(),
      dbNames: assetNames()
    }
    await capture('shot-edit-renamed.png')

    // —— U3 选中卡片后 Ctrl+C 复制、Ctrl+V 粘贴 ——
    await clickSel('.masonry-card', 0)
    await sleep(400)
    R.u3_selected = (await js(`document.querySelectorAll('.masonry-card.selected').length`)) as number

    // 「正在粘贴…」会在几十毫秒内被「导入完成」覆盖，靠轮询读 DOM 必然丢，
    // 所以装一个 MutationObserver 把所有出现过的轻提示按序记下来
    await js(`(() => {
      window.__notices = []
      const push = () => {
        const t = document.querySelector('.notice-toast')?.textContent.trim()
        if (t && window.__notices[window.__notices.length - 1] !== t) window.__notices.push(t)
      }
      window.__mo = new MutationObserver(push)
      window.__mo.observe(document.body, { childList: true, subtree: true, characterData: true })
      return true
    })()`)

    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'c', modifiers: ['control'] })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'c', modifiers: ['control'] })
    await sleep(700)
    R.u3_copyNotices = (await js(`JSON.stringify(window.__notices ?? [])`)) as string

    const beforePaste = assetCount()
    const selectedId = (await js(`Number(document.querySelector('.masonry-card.selected')?.dataset.id ?? -1)`)) as number
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'v', modifiers: ['control'] })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'v', modifiers: ['control'] })
    R.u3_pasted = await waitFor(() => assetCount() > beforePaste, 9000)
    await sleep(1400)
    R.u3_pasteNotices = (await js(`JSON.stringify(window.__notices ?? [])`)) as string
    await js(`(() => { window.__mo?.disconnect(); return true })()`)
    R.u3_afterCards = await cardNames()
    // 粘贴出来的是**带标注的副本**：同 content_hash、同备注/评分/喜欢，且是新素材行
    const srcMeta = D()
      .prepare('SELECT id, name, rating, is_fav, note, content_hash FROM assets WHERE id=?')
      .get(selectedId) as { id: number; rating: number; is_fav: number; note: string | null; content_hash: string }
    const newest = D()
      .prepare('SELECT id, name, rating, is_fav, note, content_hash FROM assets ORDER BY id DESC LIMIT 1')
      .get() as { id: number; rating: number; is_fav: number; note: string | null; content_hash: string }
    const tagNamesOf2 = (assetId: number): string[] =>
      (
        D()
          .prepare('SELECT t.name AS name FROM asset_tags at JOIN tags t ON t.id=at.tag_id WHERE at.asset_id=? ORDER BY t.name')
          .all(assetId) as Array<{ name: string }>
      ).map((r) => r.name)
    R.u3_copy = {
      src: srcMeta,
      newest,
      isNewRow: newest.id !== srcMeta.id,
      srcTags: tagNamesOf2(selectedId),
      newestTags: tagNamesOf2(newest.id)
    }
    await capture('shot-edit-pasted.png')

    // —— U4 侧栏标签右键 → 重命名标签 ——
    const tagPt = await elPoint('.side-item[data-tag-id]', 0)
    if (tagPt) rightClick(tagPt.x, tagPt.y)
    await sleep(360)
    R.u4_menuItems = (await js(`JSON.stringify([...document.querySelectorAll('.tag-ctx .ctx-item')].map(b => b.textContent.trim()))`)) as
      | string
      | null
    R.u4_clicked = await clickJs('[data-ctx="rename-tag"]')
    await sleep(420)
    R.u4_inputShown = (await js(`!!document.querySelector('.side-item .side-rename')`)) === true
    await typeInto('.side-item .side-rename', '自然风光')
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await sleep(1400)
    R.u4_done = {
      sidebarTags: (
        (await js(`[...document.querySelectorAll('.side-item[data-tag-id]')].map(e => e.textContent.trim())`)) as
          | string[]
          | null
      )?.map((s) => s.replace(/\d+$/, '').trim()),
      dbTags: tagRows().map((t) => t.name),
      notice: await noticeText()
    }
    await capture('shot-edit-tagrenamed.png')

    // —— U5 提示词：预览 → 双击编辑 → 提交 → 复制按钮 ——
    await clickSel('.masonry-card', 0)
    await sleep(1200)
    R.u5_preview = (await js(`(() => {
      const v = document.querySelector('[data-note-view]')
      if (!v) return 'null'
      return JSON.stringify({ text: v.textContent.trim(), empty: v.classList.contains('empty'), input: !!document.querySelector('[data-note-input]') })
    })()`)) as string | null
    // 真实双击（clickCount 2 才会派发 dblclick）
    const notePt = await elPoint('[data-note-view]')
    if (notePt) {
      win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(notePt.x), y: Math.round(notePt.y), button: 'left', clickCount: 1 })
      win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(notePt.x), y: Math.round(notePt.y), button: 'left', clickCount: 1 })
      win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(notePt.x), y: Math.round(notePt.y), button: 'left', clickCount: 2 })
      win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(notePt.x), y: Math.round(notePt.y), button: 'left', clickCount: 2 })
    }
    await sleep(500)
    R.u5_editShown = (await js(`!!document.querySelector('[data-note-input]')`)) === true
    await typeInto('[data-note-input]', '一只橘猫｜柔光｜35mm')
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers: ['control'] })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers: ['control'] })
    await sleep(1200)
    const selId = (await js(`Number(document.querySelector('.masonry-card.selected')?.dataset.id ?? -1)`)) as number
    R.u5_saved = {
      view: (await js(`document.querySelector('[data-note-view]')?.textContent.trim() ?? null`)) as string | null,
      inputGone: (await js(`!!document.querySelector('[data-note-input]')`)) === false,
      db: selId > 0 ? (assetRow(selId)?.note ?? null) : null
    }
    await capture('shot-edit-note.png')

    // 复制按钮：点一下应进入「已复制」态，并把内容放进系统剪贴板
    clipboard.clear()
    await clickSel('[data-note-copy]')
    await sleep(420)
    R.u5_copy = {
      okClass: (await js(`document.querySelector('[data-note-copy]')?.classList.contains('ok')`)) === true,
      clipboard: (await clipboard.readText()).trim(),
      dbNote: selId > 0 ? (assetRow(selId)?.note ?? null) : null
    }

    // —— U6 换素材时不该把上一张的草稿带过去 ——
    await clickSel('.masonry-card', 1)
    await sleep(900)
    const selId2 = (await js(`Number(document.querySelector('.masonry-card.selected')?.dataset.id ?? -1)`)) as number
    R.u6_switch = {
      switched: selId2 !== selId,
      inputGone: (await js(`!!document.querySelector('[data-note-input]')`)) === false,
      copiedCleared: (await js(`document.querySelector('[data-note-copy]')?.classList.contains('ok')`)) === false,
      noteOfOther: selId2 > 0 ? (assetRow(selId2)?.note ?? null) : null
    }
    await capture('shot-edit-done.png')

    // —— U6b 详情预览图：圆角边框包裹 + 与面板/边框都留出间隙 ——
    // 纯 CSS 行为（有没有留白、圆角多大）只能靠几何与计算样式断言，内容断言看不出来
    R.u6b_preview = (await js(`(() => {
      const panel = document.querySelector('.detail')
      const box = document.querySelector('.detail-preview')
      const img = document.querySelector('.detail-img')
      if (!panel || !box) return 'null'
      // 先把面板滚回顶部再量：.detail 是滚动容器，前面 elPoint() 的 scrollIntoView
      // 会把它滚下去，于是「预览区上边距」会随滚动变化，断言就不稳定了。
      // 注意：这段脚本本身是模板字符串，注释里**不能出现反引号**，否则字符串会被提前截断
      const scrolledBefore = panel.scrollTop
      panel.scrollTop = 0
      const pr = panel.getBoundingClientRect()
      const br = box.getBoundingClientRect()
      const ir = img ? img.getBoundingClientRect() : null
      const cs = getComputedStyle(box)
      const ics = img ? getComputedStyle(img) : null
      return JSON.stringify({
        scrolledBefore,
        leftGap: Math.round(br.left - pr.left),
        rightGap: Math.round(pr.right - br.right),
        topGap: Math.round(br.top - pr.top),
        radius: Math.round(parseFloat(cs.borderTopLeftRadius)),
        borderW: Math.round(parseFloat(cs.borderTopWidth)),
        padLeft: Math.round(parseFloat(cs.paddingLeft)),
        imgRadius: ics ? Math.round(parseFloat(ics.borderTopLeftRadius)) : null,
        imgInsetLeft: ir ? Math.round(ir.left - br.left) : null,
        imgInsetTop: ir ? Math.round(ir.top - br.top) : null,
        hasImg: !!img
      })
    })()`)) as string | null

    // —— U6c 色板：点色块复制十六进制 ——
    // 挑一张**确实有调色板**的素材（调色板是缩略图生成时回写的，不能假设任意一张都有）
    const palId =
      (
        D().prepare('SELECT id FROM assets WHERE palette IS NOT NULL ORDER BY id LIMIT 1').get() as
          | { id: number }
          | undefined
      )?.id ?? -1
    R.u6c_paletteCount = (D().prepare('SELECT count(*) AS c FROM assets WHERE palette IS NOT NULL').get() as {
      c: number
    }).c

    let u6cPal: Record<string, unknown> | null = null
    if (palId > 0) {
      await clickSel(`.masonry-card[data-id="${palId}"]`)
      await sleep(1200)
      clipboard.clear()
      const swatch = await elPoint('.palette .swatch', 0)
      const color = (await js(`document.querySelector('.palette .swatch')?.dataset.color ?? null`)) as string | null
      const swatchCount = (await js(`document.querySelectorAll('.palette .swatch').length`)) as number
      if (swatch) click(swatch.x, swatch.y)
      await sleep(450)
      u6cPal = {
        color,
        swatchCount,
        clipboard: (await clipboard.readText()).trim(),
        copiedClass: (await js(`document.querySelector('.palette .swatch')?.classList.contains('copied')`)) === true,
        checkDrawn: (await js(`!!document.querySelector('.palette .swatch svg')`)) === true,
        notice: await noticeText()
      }
    }
    R.u6c_palette = u6cPal
    await capture('shot-edit-palette.png')

    // —— U7 右上角「收起侧栏」按钮：收起后点素材也不展开；四个按钮几何一致 ——
    R.u7_buttons = (await js(`(() => {
      const els = [...document.querySelectorAll('.win-controls .wc-btn')]
      return JSON.stringify(els.map((b) => {
        const r = b.getBoundingClientRect()
        const svg = b.querySelector('svg')
        const sr = svg ? svg.getBoundingClientRect() : null
        return {
          key: b.dataset.wc ?? null,
          w: Math.round(r.width),
          h: Math.round(r.height),
          cy: Math.round((r.top + r.height / 2) * 10) / 10,
          icon: sr ? Math.round(sr.width) : 0,
          text: b.textContent.trim()
        }
      }))
    })()`)) as string | null
    R.u7_before = (await js(`!!document.querySelector('.detail')`)) === true

    const detailBtn = await elPoint('.wc-btn[data-wc="detail"]')
    if (detailBtn) click(detailBtn.x, detailBtn.y)
    await sleep(450)
    R.u7_collapsed = {
      detailGone: (await js(`!!document.querySelector('.detail')`)) === false,
      flag: getSettings().detailCollapsed ? '1' : '0', // 读数从 localStorage 改到 config（同上）
      title: (await js(`document.querySelector('.wc-btn[data-wc="detail"]')?.getAttribute('title') ?? null`)) as
        | string
        | null
    }
    await capture('shot-edit-detail-collapsed.png')

    // 收起是「锁定」状态：点素材只换选中项，不该把信息栏拉回来
    await clickSel('.masonry-card', 1)
    await sleep(700)
    R.u7_afterSelect = {
      detailGone: (await js(`!!document.querySelector('.detail')`)) === false,
      selected: (await js(`document.querySelectorAll('.masonry-card.selected').length`)) as number
    }

    // 再点一次 → 恢复展开
    const detailBtn2 = await elPoint('.wc-btn[data-wc="detail"]')
    if (detailBtn2) click(detailBtn2.x, detailBtn2.y)
    await sleep(700)
    R.u7_expanded = {
      detailBack: (await js(`!!document.querySelector('.detail')`)) === true,
      flag: getSettings().detailCollapsed ? '1' : '0'
    }
    await capture('shot-edit-detail-expanded.png')

    // —— U8 回到顶部浮标：滚到下方才出现、点击回顶、两种视图都要有、且不压住批量条 ——
    //
    // 这一步的前提是**页面真的能滚**。当前素材量在 1280x820 下瀑布视图都够不到 240px 阈值
    // （列表视图更短），所以先灌一批图把两种视图都撑长。
    // 放在这里做是安全的：前面所有「按第几张卡片取素材」的断言都已经跑完了，加素材影响不到它们。
    const bulkDir = join(dir, 'bulk')
    mkdirSync(bulkDir, { recursive: true })
    const bulkPaths: string[] = []
    for (let i = 1; i <= 30; i++) {
      const p = join(bulkDir, `批量 ${i}.png`)
      await sharp({
        create: { width: 200, height: 200 + i * 4, channels: 3, background: { r: (i * 8) % 256, g: 90, b: (i * 17) % 256 } }
      })
        .png()
        .toFile(p)
      bulkPaths.push(p)
    }
    // 30 张颜色/尺寸各不相同的图：内容哈希天然不同，不会被导入管线的查重挡掉
    const bulkImp = await new Promise<ImportResult>((resolve) =>
      importFiles({ paths: bulkPaths, folderId: null, mode: 'copy', onDone: resolve })
    )
    R.u8_bulk = { added: bulkImp.added, total: assetCount() }
    await rawJs(`window.stash.library.open(${JSON.stringify(libPath)}).then(() => location.reload())`)
    await onceLoaded(win)
    // 原来固定 sleep(3000) 等「reload 后网格渲染完」—— U8 的 6 条断言全靠这一步。
    // 机器一忙 3s 不够 → 夹具没撑起滚动高度 → topBtnFixtureScrollable 及其级联一起红（G12）。
    // 改成有界轮询「网格已渲染且容器**真的滚得动**（maxScroll > 300）」，上限给足 20s。
    const u8ScrollT0 = Date.now()
    const u8ScrollReady = await waitFor(
      async () =>
        ((await js(
          `(() => { const w = document.querySelector('.grid-wrap'); return w ? Math.round(w.scrollHeight - w.clientHeight) : 0 })()`
        )) as number) > 300,
      20000
    )
    const u8ScrollMs = Date.now() - u8ScrollT0 // 诊断：实际等了多久（只增字段，不改判据/阈值）

    // 先选一张：批量条要出现，才能验证「浮标让开批量条」不是空断言
    // 原来固定 sleep(700) —— 改成轮询「选中真的生效」（.masonry-card.selected 出现）
    await clickSel('.masonry-card', 0)
    const u8SelT0 = Date.now()
    const u8SelReady = await waitFor(
      async () => ((await js(`document.querySelectorAll('.masonry-card.selected').length`)) as number) > 0,
      8000
    )
    const u8SelMs = Date.now() - u8SelT0 // 诊断：实际等了多久（只增字段，不改判据/阈值）
    R.u8_selected = (await js(`document.querySelectorAll('.masonry-card.selected').length`)) as number

    // 滚到最下方（瀑布视图）
    await js(`(() => { const w = document.querySelector('.grid-wrap'); if (w) w.scrollTop = w.scrollHeight })()`)
    // 原来固定 sleep(600) 等「滚动生效 + 浮标渲染出来」。
    // ⚠️ 光等 `scrollTop > 240` **不够**：浮标是 `v-if="scrolledDown"`、由 scroll 事件回调里置位再渲染的，
    // 而 `w.scrollTop = …` 是同步赋值 —— 立刻读会「滚动到了、但浮标还没渲染」→ hasBtn=false（实测踩到）。
    // 所以要等「滚动位置到位 **且** 浮标状态确定（已出现）」，上限 8s；真等不到（产线 bug）则这条轮询为 false、
    // 由 topBtnAppearsOnScroll 的闸门明确变红。
    const u8ScrollPosT0 = Date.now()
    const u8ScrollPosReady = await waitFor(
      async () =>
        ((await js(
          `(() => { const w = document.querySelector('.grid-wrap'); return !!w && w.scrollTop > 240 && !!document.querySelector('[data-to-top]') })()`
        )) as boolean) === true,
      8000
    )
    const u8ScrollPosMs = Date.now() - u8ScrollPosT0 // 诊断：实际等了多久（只增字段，不改判据/阈值）
    // 三步轮询的成败必须被消费：存进诊断字段，并各自并入对应断言（G11：超时必须能红）
    R.u8_ready = { scrollReady: u8ScrollReady, selReady: u8SelReady, scrollPosReady: u8ScrollPosReady }
    // ② 诊断（只增字段，不改任何判据/阈值）：下次 U8 偶发红时，能区分「没等到（耗时≈轮询上限）」还是「等到了但值不对」。
    R.u8_diag = { scrollMs: u8ScrollMs, selMs: u8SelMs, scrollPosMs: u8ScrollPosMs }
    R.u8_masonry = (await js(`(() => {
      const b = document.querySelector('[data-to-top]')
      const g = document.querySelector('.gallery')
      const wrap = document.querySelector('.grid-wrap')
      if (!g || !wrap) return 'null'
      if (!b) return JSON.stringify({ hasBtn: false, scrollTop: Math.round(wrap.scrollTop) })
      const br = b.getBoundingClientRect()
      const gr = g.getBoundingClientRect()
      const cs = getComputedStyle(b)
      return JSON.stringify({
        hasBtn: true,
        isList: !!document.querySelector('.list'),
        scrollTop: Math.round(wrap.scrollTop),
        maxScroll: Math.round(wrap.scrollHeight - wrap.clientHeight),
        rightInset: Math.round(gr.right - br.right),
        bottomInset: Math.round(gr.bottom - br.bottom),
        topInset: Math.round(br.top - gr.top),
        gh: Math.round(gr.height),
        w: Math.round(br.width),
        h: Math.round(br.height),
        radius: cs.borderTopLeftRadius,
        label: b.getAttribute('aria-label'),
        icon: !!b.querySelector('svg')
      })
    })()`)) as string | null

    // 与底部悬浮批量条是否重叠：批量条是居中定位的，窄窗口下最容易撞上
    R.u8_overlap = (await js(`(() => {
      const b = document.querySelector('[data-to-top]')
      const bar = document.querySelector('.batchbar')
      if (!b) return JSON.stringify({ hasBtn: false, bar: !!bar })
      const br = b.getBoundingClientRect()
      if (!bar) return JSON.stringify({ hasBtn: true, bar: false })
      const rr = bar.getBoundingClientRect()
      return JSON.stringify({
        hasBtn: true,
        bar: true,
        gap: Math.round(rr.top - br.bottom),
        sameRow: br.bottom > rr.top && br.top < rr.bottom
      })
    })()`)) as string | null
    await capture('shot-edit-totop.png')

    // 点一下：平滑回顶，浮标自己收起来
    await clickSel('[data-to-top]')
    const backTop = await waitFor(
      async () =>
        ((await js(`(() => { const w = document.querySelector('.grid-wrap'); return w ? (w.scrollTop < 2 && !document.querySelector('[data-to-top]')) : false })()`)) as
          | boolean
          | null) === true,
      5000,
      150
    )
    R.u8_back = {
      ok: backTop,
      scrollTop: (await js(`Math.round(document.querySelector('.grid-wrap').scrollTop)`)) as number,
      hasBtn: (await js(`!!document.querySelector('[data-to-top]')`)) === true
    }

    // 列表视图：同一个滚动容器，浮标必须同样可用
    await clickJs('.viewtoggle button[title="列表视图"]')
    await sleep(600)
    await js(`(() => { const w = document.querySelector('.grid-wrap'); if (w) w.scrollTop = w.scrollHeight })()`)
    await sleep(600)
    R.u8_list = (await js(`(() => {
      const b = document.querySelector('[data-to-top]')
      const wrap = document.querySelector('.grid-wrap')
      if (!wrap) return 'null'
      return JSON.stringify({
        hasBtn: !!b,
        isList: !!document.querySelector('.list'),
        rows: document.querySelectorAll('.list-row').length,
        scrollTop: Math.round(wrap.scrollTop)
      })
    })()`)) as string | null
    await capture('shot-edit-totop-list.png')

    await clickSel('[data-to-top]')
    const backTopList = await waitFor(
      async () => ((await js(`Math.round(document.querySelector('.grid-wrap').scrollTop)`)) as number) < 2,
      5000,
      150
    )
    R.u8_back_list = {
      ok: backTopList,
      scrollTop: (await js(`Math.round(document.querySelector('.grid-wrap').scrollTop)`)) as number
    }
    // 复位：回到瀑布视图 + Esc 取消选中（点空白处会误点到卡片）
    await clickJs('.viewtoggle button[title="瀑布视图"]')
    await sleep(400)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await sleep(400)
    R.u8_cleared = (await js(`document.querySelectorAll('.masonry-card.selected').length`)) as number

    // ==================== U9 右键菜单：系统打开 / 系统定位 / 跳库内文件夹 ====================
    // 需求：在「复制 / 粘贴」这一组**上方**插入三项。这里盯住四件最容易悄悄坏掉的事：
    //   ① 三项在场且顺序在「复制」之上（追加到菜单末尾是最常见的返工点）；
    //   ② 单选可见 / 多选**隐藏**（多选时「用默认应用打开」会弹 N 个窗口、「定位」会开 N 个资源管理器，
    //      所以是隐藏而不是禁用 —— 禁用还得额外解释原因）；
    //   ③ 点第 3 项后**真的能看见这张素材**（文件夹定位 + 侧栏展开且 active + 清掉挡路的筛选 + 选中）；
    //   ④ 第 1、2 项点了不报错。
    //      ⚠️ 真实弹系统窗口不在冒烟里做（会把 Photos / 资源管理器糊到用户脸上）。做法：先把靶子的
    //      **文件**从磁盘删掉、索引行留着 —— 主进程在 `assetAbsPath` 里就抛 ERR_ASSET_MISSING
    //      （发生在 `shell.openPath` / `showItemInFolder` 之前），于是这一下走的是完整链路
    //      「菜单 → IPC → 主进程 → 错误码 → 中文提示」，却一个窗口都不会弹，
    //      顺带把失败分支的提示文案也验了。真正的 openPath/showItemInFolder 由主进程负责，不在冒烟范围。
    step('U9-右键三项')
    const gotoInner = mkdirRel('跳转目标/内层')
    const gotoA = assetIdOf('批量 30.png') // U8 灌进来的：尺寸/颜色各异，不会撞名
    const goneB = assetIdOf('批量 29.png') // ④ 的靶子（文件待会儿会被删掉）
    R.u9_setup = {
      id: gotoA,
      folderId: gotoInner.id,
      folderPath: gotoInner.path,
      moved: gotoA > 0 ? tryCall(() => moveAssets([gotoA], gotoInner.id)) : { error: 'ERR_ASSET_NOT_FOUND' },
      relPath: gotoA > 0 ? (assetRow(gotoA)?.rel_path ?? null) : null,
      goneB
    }

    // 服务层的改动渲染层不会自己知道 → 重开库 + reload，让新文件夹 / 搬过去的素材进入侧栏与列表
    await rawJs(`window.stash.library.open(${JSON.stringify(libPath)}).then(() => location.reload())`)
    await onceLoaded(win)
    // reload 把页面里的收集数组清了 → 从这里开始重新挂监听（覆盖 U9 之后的全部交互 + U10）
    await armErrors()
    await waitFor(async () => ((await js(`document.querySelectorAll('.masonry-card').length`)) as number) > 5, 15000)

    // 把二级文件夹的**父级**折叠起来：这样「内层」那一行根本渲染不出来，
    // 正好用来验证 ③ 里的 `lib.expandTo`（祖先不展开就跳不过去，用户会以为点了没反应）
    R.u9_foldClicked = await clickJs('[data-fold-path="跳转目标"]')
    await sleep(320)
    R.u9_collapsed = {
      innerHidden: (await js(`!!document.querySelector('.side-item[data-folder-path="跳转目标/内层"]')`)) === false,
      parentShown: (await js(`!!document.querySelector('.side-item[data-folder-path="跳转目标"]')`)) === true
    }

    // —— ① 单选时三项在场，且都排在「复制」之上 ——
    await clickSel(`.masonry-card[data-id="${gotoA}"]`)
    await sleep(420)
    let u9pt = await elPoint(`.masonry-card[data-id="${gotoA}"]`)
    if (u9pt) rightClick(u9pt.x, u9pt.y)
    await sleep(360)
    R.u9_menu = (await js(`JSON.stringify({
      items: [...document.querySelectorAll('.ctx-menu .ctx-item')].map(b => b.textContent.trim()),
      order: [...document.querySelectorAll('.ctx-menu .ctx-item')].map(b => b.dataset.ctx ?? ''),
      icons: document.querySelectorAll('.ctx-menu [data-ctx="open-shell"] svg, .ctx-menu [data-ctx="reveal"] svg, .ctx-menu [data-ctx="goto-folder"] svg').length,
      openTitle: document.querySelector('.ctx-menu [data-ctx="open-shell"]')?.getAttribute('title') ?? null,
      revealTitle: document.querySelector('.ctx-menu [data-ctx="reveal"]')?.getAttribute('title') ?? null,
      gotoTitle: document.querySelector('.ctx-menu [data-ctx="goto-folder"]')?.getAttribute('title') ?? null
    })`)) as string | null
    await capture('shot-edit-ctxmenu3.png')
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await sleep(300)

    // —— ② 多选（Ctrl 点第二张）时三项必须**消失** ——
    await clickSel(`.masonry-card[data-id="${gotoA}"]`)
    await sleep(260)
    const u9bPt = await elPoint(`.masonry-card[data-id="${goneB}"]`)
    if (u9bPt) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(u9bPt.x), y: Math.round(u9bPt.y), modifiers: ['control'] })
      win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(u9bPt.x), y: Math.round(u9bPt.y), button: 'left', clickCount: 1, modifiers: ['control'] })
      win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(u9bPt.x), y: Math.round(u9bPt.y), button: 'left', clickCount: 1, modifiers: ['control'] })
    }
    await sleep(420)
    u9pt = await elPoint(`.masonry-card[data-id="${gotoA}"]`)
    if (u9pt) rightClick(u9pt.x, u9pt.y)
    await sleep(360)
    R.u9_multi = (await js(`JSON.stringify({
      selected: document.querySelectorAll('.masonry-card.selected').length,
      head: document.querySelector('.ctx-menu .ctx-head')?.textContent.trim() ?? null,
      open: document.querySelectorAll('.ctx-menu [data-ctx="open-shell"]').length,
      reveal: document.querySelectorAll('.ctx-menu [data-ctx="reveal"]').length,
      goto: document.querySelectorAll('.ctx-menu [data-ctx="goto-folder"]').length,
      copy: document.querySelectorAll('.ctx-menu [data-ctx="copy"]').length
    })`)) as string | null
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await sleep(300)

    // —— ④ 第 1、2 项「点了不报错」：删掉靶子的文件后走完整链路（不弹窗口，见本段开头说明）——
    if (goneB > 0) {
      const bRel = assetRow(goneB)?.rel_path ?? ''
      if (bRel) {
        try {
          unlinkSync(join(libPath, ...bRel.split('/')))
        } catch {
          /* 删不掉就退化成「真的会开窗口」，下面的断言会明确变红，不静默 */
        }
      }
    }
    // 先把上一段可能残留的轻提示点掉，否则接着读到的会是旧文案
    await js(`(() => { document.querySelector('.notice-toast')?.click(); return true })()`)
    await clickSel(`.masonry-card[data-id="${goneB}"]`)
    await sleep(360)
    const u9bErrPt = await elPoint(`.masonry-card[data-id="${goneB}"]`)
    if (u9bErrPt) rightClick(u9bErrPt.x, u9bErrPt.y)
    await sleep(300)
    const u9OpenClicked = await clickJs('.ctx-menu [data-ctx="open-shell"]')
    // 轮询等提示出现（比固定 sleep 稳，也不会把断言拖慢）
    await waitFor(async () => (await noticeText()) != null, 4000, 60)
    const u9OpenNotice = await noticeText()
    const u9OpenClosed = (await js(`!!document.querySelector('.ctx-menu')`)) === false
    if (u9bErrPt) rightClick(u9bErrPt.x, u9bErrPt.y)
    await sleep(300)
    const u9RevealClicked = await clickJs('.ctx-menu [data-ctx="reveal"]')
    await waitFor(async () => (await noticeText()) != null, 4000, 60)
    const u9RevealNotice = await noticeText()
    const u9RevealClosed = (await js(`!!document.querySelector('.ctx-menu')`)) === false
    R.u9_errPath = {
      openClicked: u9OpenClicked,
      openNotice: u9OpenNotice,
      openClosed: u9OpenClosed,
      revealClicked: u9RevealClicked,
      revealNotice: u9RevealNotice,
      revealClosed: u9RevealClosed
    }

    // —— ③ 在所在文件夹中显示：跳到库内该素材所在的文件夹 ——
    await clickSel(`.masonry-card[data-id="${gotoA}"]`)
    await sleep(400)
    // 先加一道「会跟着跳过去」的筛选：按名字搜「批量」。目标仍可见，但列表被收窄 ——
    // 跳转后这条必须被清掉，否则搜索框还留着词，用户会以为「筛选没清干净」（另一个版本的「点了没反应」）
    await typeInto('.search-input', '批量')
    await sleep(900) // TitleBar 里是 300ms 防抖 + 一次 refresh
    R.u9_filtered = {
      search: (await js(`document.querySelector('.search-input')?.value ?? null`)) as string | null,
      cards: (await js(`document.querySelectorAll('.masonry-card').length`)) as number,
      targetShown: (await js(`!!document.querySelector('.masonry-card[data-id="${gotoA}"]')`)) === true
    }
    const u9gotoPt = await elPoint(`.masonry-card[data-id="${gotoA}"]`)
    if (u9gotoPt) rightClick(u9gotoPt.x, u9gotoPt.y)
    await sleep(340)
    const u9GotoClicked = await clickJs('.ctx-menu [data-ctx="goto-folder"]')
    await sleep(1200)
    R.u9_goto = {
      clicked: u9GotoClicked,
      title: (await js(`document.querySelector('.toolbar h1')?.textContent.trim() ?? null`)) as string | null,
      // 侧栏 active 行 = `assets.query.folderId` 的**视觉等价物**（SideBar 就是拿它判 active 的）
      activeId: Number((await js(`document.querySelector('.side-item[data-folder-id].active')?.dataset.folderId ?? -1`)) as number),
      activePath: (await js(`document.querySelector('.side-item[data-folder-id].active')?.dataset.folderPath ?? null`)) as
        | string
        | null,
      innerShown: (await js(`!!document.querySelector('.side-item[data-folder-path="跳转目标/内层"]')`)) === true,
      search: (await js(`document.querySelector('.search-input')?.value ?? null`)) as string | null,
      cardIds: (await js(`[...document.querySelectorAll('.masonry-card')].map(c => Number(c.dataset.id))`)) as number[],
      selectedId: Number((await js(`document.querySelector('.masonry-card.selected')?.dataset.id ?? -1`)) as number),
      menuClosed: (await js(`!!document.querySelector('.ctx-menu')`)) === false,
      notice: await noticeText()
    }
    await capture('shot-edit-gotofolder.png')

    // ==================== U10 右键三项的边界（QA 补强）====================
    // U9 验的是「在不在、顺序对不对、跳过去看不看得见」。这一段补 U9 结构上覆盖不到的边角：
    //   ① 菜单几何：`onCardContext` 的预留高度 h 是**手写常数**，两个方向都会坏 ——
    //      预留少了 → 贴着窗口底边时最后一项「删除」被裁；预留多了 → 菜单离鼠标很远（"飘")。
    //      只截一张图看不出来，必须量矩形。
    //   ② 多选态菜单比单选矮 3 行，同一份预留会让它飘得更远（多选态内容根本撑不满 h）。
    //   ③ 第 3 项在**标签筛选**（`query.tagId`）下是否也清 —— `clearFilters()` 不含 tagId，
    //      靠的是 `menuGotoFolder` 里那行显式 `query.tagId = null`（U9 只验了关键词）。
    //   ④ 排序偏好不被跳转改动（U9 只验了筛选被清，没验「排序没被动」）。
    //   ⑤ 脏数据：`folder_id` 在 `folderById` 里查不到时必须出声，不能静默。
    //   ⑥ Esc 关菜单（U9 只发了 Esc，从没断言它真的关掉）+ 连点两次 goto-folder。
    step('U10-右键菜单边界')

    type MenuGeom = {
      iw: number
      ih: number
      x: number
      y: number
      w: number
      h: number
      right: number
      bottom: number
      lastText: string | null
      lastBottom: number | null
      lastVisible: boolean
      head: string | null
    }
    /** 菜单几何快照：矩形 + 最后一项（单选态=「删除」）是否完整落在视口内 */
    const menuGeom = async (): Promise<MenuGeom | null> => {
      const s = (await js(`(() => {
        const m = document.querySelector('.ctx-menu')
        if (!m) return 'null'
        const r = m.getBoundingClientRect()
        const items = [...m.querySelectorAll('.ctx-item')]
        const last = items[items.length - 1] ?? null
        const lr = last ? last.getBoundingClientRect() : null
        return JSON.stringify({
          iw: window.innerWidth, ih: window.innerHeight,
          x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom,
          lastText: last ? last.textContent.trim() : null,
          lastBottom: lr ? lr.bottom : null,
          lastVisible: !!lr && lr.top >= -0.5 && lr.bottom <= window.innerHeight + 0.5,
          head: m.querySelector('.ctx-head')?.textContent.trim() ?? null
        })
      })()`)) as string | null
      if (!s || s === 'null') return null
      try {
        return JSON.parse(s) as MenuGeom
      } catch {
        return null
      }
    }
    /**
     * 在**指定的视口坐标**上触发右键（靶卡片由选择器指定）。
     *
     * 为什么合成事件：`clientX/Y` 要精确压在 `innerWidth-2 / innerHeight-2` 这种角上，
     * 而那里没有卡片，真实鼠标送不进去；被断言的也正是 `onCardContext` 对 `clientX/Y` 的收边逻辑。
     * 靶子必须选「已选中」的那张卡，否则 `onCardContext` 里「右键的卡不在选中集合 → 改成单选」
     * 会把多选态打散，量到的就不是多选态的菜单了。
     */
    const ctxAt = async (clientX: number, clientY: number, sel: string): Promise<boolean> => {
      const ok =
        (await js(`(() => {
          const el = document.querySelector(${JSON.stringify(sel)})
          if (!el) return false
          el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ${clientX}, clientY: ${clientY} }))
          return true
        })()`)) === true
      await sleep(340)
      return ok
    }
    const pressEsc = async (): Promise<void> => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await sleep(300)
    }
    /** 通知是单槽位、info 也活 5 秒 → 读之前先点掉，免得读到上一条的文案 */
    const dismissNotice = async (): Promise<void> => {
      await js(`(() => { document.querySelector('.notice-toast')?.click(); return true })()`)
      await sleep(120)
    }
    const pickAllFolders = async (): Promise<void> => {
      await js(`[...document.querySelectorAll('.side-item')].find(e => e.textContent.includes('所有素材'))?.click()`)
      await sleep(700)
    }
    /** 点侧栏某个文件夹行（虚拟滚动下「列表里有没有这张卡」取决于当前导航，必须显式定位过去） */
    const clickFolderRow = async (path: string): Promise<void> => {
      await js(`document.querySelector('.side-item[data-folder-path="${path}"]')?.click()`)
      await sleep(700)
    }
    const clickTagRow = async (id: number): Promise<void> => {
      await js(`document.querySelector('.side-item[data-tag-id="${id}"]')?.click()`)
      await sleep(800)
    }

    // —— ① 贴边几何：找「视口里最靠近底边、且真的还能命中卡片」的那个点 ——
    // 只取 getBoundingClientRect().bottom 最大的卡是不够的：卡片可能被网格容器裁掉一部分，
    // 那段矩形还在、点上去命中的却是别的元素（右键会完全没反应 —— 这本身也得能看出来）。
    // 所以用 elementFromPoint 自上而下探，取「命中卡片」的最大 y。
    await pickAllFolders()
    const hitRaw = (await js(`(() => {
      let best = null
      for (const c of document.querySelectorAll('.masonry-card')) {
        const r = c.getBoundingClientRect()
        const x = Math.round(r.left + 14)
        const top = Math.max(0, Math.round(r.top))
        for (let y = Math.min(Math.round(r.bottom) - 2, window.innerHeight - 2); y > top; y -= 4) {
          const el = document.elementFromPoint(x, y)
          if (el && el.closest('.masonry-card') === c) {
            if (!best || y > best.y) best = { x, y, id: Number(c.dataset.id) }
            break
          }
        }
      }
      return best ? JSON.stringify(best) : 'null'
    })()`)) as string | null
    const hit = hitRaw && hitRaw !== 'null' ? (JSON.parse(hitRaw) as { x: number; y: number; id: number }) : null
    R.u10_hit = hit
    if (hit) {
      await clickSel(`.masonry-card[data-id="${hit.id}"]`)
      await sleep(300)
      // 真实鼠标：打在卡片上「最靠视口底边」的位置
      rightClick(hit.x, hit.y)
      await sleep(380)
      const gBottom = await menuGeom()
      // 再展开删除确认（菜单的最高态）—— 这决定 h 该预留多少，也是「最后一项被裁」最容易出事的形态
      const confirmOpened = await clickJs('.ctx-menu .ctx-item.danger')
      await sleep(320)
      const gConfirm = await menuGeom()
      R.u10_geomBottom = { cursorX: hit.x, cursorY: hit.y, menu: gBottom, confirmOpened, confirmMenu: gConfirm }
      // Esc 必须真的关掉（U9 只发过 Esc，一次都没断言结果）
      await pressEsc()
      R.u10_escClosed =
        (await js(`!!document.querySelector('.ctx-menu')`)) === false &&
        (await js(`!!document.querySelector('.ctx-confirm')`)) === false
    }

    // —— ①b 极端角落：clientX/Y 压在右下角 2px 处，x 与 y 的收边同时被推到极限 ——
    const vp = (await js(`JSON.stringify({ iw: window.innerWidth, ih: window.innerHeight })`)) as string | null
    const vw = JSON.parse(vp ?? '{"iw":0,"ih":0}') as { iw: number; ih: number }
    const cornerSel = hit ? `.masonry-card[data-id="${hit.id}"]` : '.masonry-card'
    const cornerOpened = await ctxAt(vw.iw - 2, vw.ih - 2, cornerSel)
    R.u10_geomCorner = { cursorX: vw.iw - 2, cursorY: vw.ih - 2, opened: cornerOpened, menu: await menuGeom() }
    await pressEsc()

    // —— ② 多选态：三项不渲染（U9 已断）+ 菜单实际高度比单选矮，同一份预留会把它推得更远 ——
    const secondCard = (await js(`(() => {
      const el = [...document.querySelectorAll('.masonry-card')].find(c => Number(c.dataset.id) !== ${hit?.id ?? -1})
      if (!el) return 'null'
      const r = el.getBoundingClientRect()
      return JSON.stringify({ id: Number(el.dataset.id), x: r.left + r.width / 2, y: r.top + r.height / 2 })
    })()`)) as string | null
    const second = secondCard && secondCard !== 'null' ? (JSON.parse(secondCard) as { id: number; x: number; y: number }) : null
    if (second) {
      const sx = Math.round(second.x)
      const sy = Math.round(second.y)
      win.webContents.sendInputEvent({ type: 'mouseMove', x: sx, y: sy, modifiers: ['control'] })
      win.webContents.sendInputEvent({ type: 'mouseDown', x: sx, y: sy, button: 'left', clickCount: 1, modifiers: ['control'] })
      win.webContents.sendInputEvent({ type: 'mouseUp', x: sx, y: sy, button: 'left', clickCount: 1, modifiers: ['control'] })
      await sleep(420)
    }
    const multiOpened = await ctxAt(vw.iw - 2, vw.ih - 2, cornerSel)
    const multiGeom = await menuGeom()
    R.u10_geomMulti = {
      opened: multiOpened,
      cursorX: vw.iw - 2,
      cursorY: vw.ih - 2,
      secondId: second?.id ?? -1,
      selected: (await js(`document.querySelectorAll('.masonry-card.selected').length`)) as number,
      menu: multiGeom
    }
    await pressEsc()

    // —— ②b 多选态下右键**没被选中的那张卡**：选中集合 N → 1，三项在同一帧里出现，
    //        菜单高度会从 263 长到 380。动态收边量的是「patch 之后」的尺寸，
    //        靠的是 `select()` 先把 `selectedIds` 赋掉、与 `menu` 赋值同帧 flush ——
    //        这个顺序一旦被后人改掉（比如 select 里先 await），贴底展开就会静默裁掉「删除」。
    const unselSel = (await js(`(() => {
      const el = [...document.querySelectorAll('.masonry-card')].find(c => !c.classList.contains('selected'))
      return el ? '.masonry-card[data-id="' + el.dataset.id + '"]' : null
    })()`)) as string | null
    if (unselSel) {
      const flipOpened = await ctxAt(vw.iw - 2, vw.ih - 2, unselSel)
      R.u10_geomFlip = {
        opened: flipOpened,
        sel: unselSel,
        triple: (await js(`document.querySelectorAll('.ctx-menu [data-ctx="open-shell"]').length`)) as number,
        head: (await js(`document.querySelector('.ctx-menu .ctx-head')?.textContent.trim() ?? null`)) as string | null,
        menu: await menuGeom()
      }
      await pressEsc()
    }

    // —— ③ 标签筛选下跳转：tagId 必须被显式清掉（`clearFilters()` 不含它）——
    // 标签名用 U4 里改名后的「自然风光」（`风景` 早被 S3/U4 改掉了，写死旧名会静默跳过整段）
    const tagName = '自然风光'
    const tagId = tagRows().find((t) => t.name === tagName)?.id ?? -1
    R.u10_tagSetup = {
      tagName,
      tagId,
      attach: tagId > 0 && gotoA > 0 ? tryCall(() => setTags(gotoA, [tagId])) : { error: 'ERR_TAG_NOT_FOUND' }
    }
    // 先回「内层」把 gotoA 渲染出来（虚拟滚动：换导航后旧 DOM 节点就没了），再点标签筛选
    await clickFolderRow('跳转目标/内层')
    await clickTagRow(tagId)
    R.u10_tagFiltered = {
      active: (await js(`!!document.querySelector('.side-item[data-tag-id="${tagId}"].active')`)) === true,
      targetShown: (await js(`!!document.querySelector('.masonry-card[data-id="${gotoA}"]')`)) === true,
      cards: (await js(`document.querySelectorAll('.masonry-card').length`)) as number
    }
    // 顺手把排序换成非默认值：「跳转不动排序」只有在排序**不是默认值**时才算验过
    await clickJs('[data-chip="sort"]')
    await sleep(240)
    await clickJs('.chip-menu [data-sort="name"]')
    await sleep(700)
    const sortBefore = (await js(`document.querySelector('[data-chip="sort"]')?.getAttribute('title') ?? null`)) as string | null
    await dismissNotice()
    const u10pt = await elPoint(`.masonry-card[data-id="${gotoA}"]`)
    if (u10pt) rightClick(u10pt.x, u10pt.y)
    await sleep(340)
    const u10GotoClicked = await clickJs('.ctx-menu [data-ctx="goto-folder"]')
    await sleep(1300)
    R.u10_gotoTag = {
      clicked: u10GotoClicked,
      tagActive: (await js(`!!document.querySelector('.side-item[data-tag-id].active')`)) === true,
      search: (await js(`document.querySelector('.search-input')?.value ?? null`)) as string | null,
      sortBefore,
      sortAfter: (await js(`document.querySelector('[data-chip="sort"]')?.getAttribute('title') ?? null`)) as string | null,
      activePath: (await js(`document.querySelector('.side-item[data-folder-id].active')?.dataset.folderPath ?? null`)) as
        | string
        | null,
      targetShown: (await js(`!!document.querySelector('.masonry-card[data-id="${gotoA}"]')`)) === true,
      selectedId: Number((await js(`document.querySelector('.masonry-card.selected')?.dataset.id ?? -1`)) as number),
      notice: await noticeText()
    }

    // —— ④ 脏数据：folder_id 指向库里不存在的文件夹（索引与列表不同步）——
    // 构造方式：临时关外键约束改一行（SQLite 默认就是关的，本项目在 db.ts 里显式打开），改完立刻恢复。
    // 列表行照样查得到（`listAssets` 是 `SELECT a.*`，不 join folders），`folderById` 却查不到 ——
    // 正是「索引过期」在渲染层的表现，也是这条分支唯一现实的触发方式。
    R.u10_dirtyWrite = tryCall(() => {
      D().exec('PRAGMA foreign_keys = OFF')
      D().prepare('UPDATE assets SET folder_id=? WHERE id=?').run(999999, gotoA)
      D().exec('PRAGMA foreign_keys = ON')
      return { ok: true }
    })
    // 刷新列表但**不改导航**：标签筛选不看 folder_id，所以素材仍在列表里；
    // 换成「所有素材」会撞上虚拟滚动（换导航后 gotoA 不一定在窗口里，elPoint 会直接返回 null）
    await clickTagRow(tagId)
    await dismissNotice()
    const u10pt2 = await elPoint(`.masonry-card[data-id="${gotoA}"]`)
    if (u10pt2) rightClick(u10pt2.x, u10pt2.y)
    await sleep(340)
    const u10DirtyClicked = await clickJs('.ctx-menu [data-ctx="goto-folder"]')
    await waitFor(async () => (await noticeText()) != null, 4000, 60)
    R.u10_dirty = {
      clicked: u10DirtyClicked,
      notice: await noticeText(),
      menuClosed: (await js(`!!document.querySelector('.ctx-menu')`)) === false,
      // 失败时不该顺手把侧栏/列表定位改掉（那会表现成「跳到了一个空文件夹」）
      activePath: (await js(`document.querySelector('.side-item[data-folder-id].active')?.dataset.folderPath ?? null`)) as
        | string
        | null,
      selectedId: Number((await js(`document.querySelector('.masonry-card.selected')?.dataset.id ?? -1`)) as number)
    }
    R.u10_dirtyRestore = tryCall(() => {
      D().exec('PRAGMA foreign_keys = OFF')
      D().prepare('UPDATE assets SET folder_id=? WHERE id=?').run(gotoInner.id, gotoA)
      D().exec('PRAGMA foreign_keys = ON')
      return { ok: true }
    })

    // —— ⑤ 连点两次 goto-folder：首点即收菜单（第二次点不到），重开再点一次仍要正确 ——
    // 回「内层」（gotoA 唯一所在地）保证卡片在 DOM 里；跳转目标与当前位置相同也能验证幂等
    await clickFolderRow('跳转目标/内层')
    await dismissNotice()
    const dc1 = await elPoint(`.masonry-card[data-id="${gotoA}"]`)
    if (dc1) rightClick(dc1.x, dc1.y)
    await sleep(300)
    const dcFirst = await clickJs('.ctx-menu [data-ctx="goto-folder"]')
    const dcWhileClosed = await clickJs('.ctx-menu [data-ctx="goto-folder"]')
    await sleep(1300)
    const dc2 = await elPoint(`.masonry-card[data-id="${gotoA}"]`)
    if (dc2) rightClick(dc2.x, dc2.y)
    await sleep(300)
    const dcThird = await clickJs('.ctx-menu [data-ctx="goto-folder"]')
    await sleep(1300)
    R.u10_double = {
      first: dcFirst,
      whileClosed: dcWhileClosed,
      third: dcThird,
      activePath: (await js(`document.querySelector('.side-item[data-folder-id].active')?.dataset.folderPath ?? null`)) as
        | string
        | null,
      selectedId: Number((await js(`document.querySelector('.masonry-card.selected')?.dataset.id ?? -1`)) as number),
      menuClosed: (await js(`!!document.querySelector('.ctx-menu')`)) === false,
      notice: await noticeText()
    }
    R.pageErrors = await pageErrors()

    // ==================== 断言 ====================
    const u1 = (() => {
      try {
        return JSON.parse((R.u1_menuItems as string) ?? '[]') as string[]
      } catch {
        return []
      }
    })()
    const u2d = (() => {
      const s = R.u2_dialog as string | null
      try {
        return s && s !== 'null'
          ? (JSON.parse(s) as { value: string; ext: string | null; extTag: string | null; focused: boolean; cardName: string | null })
          : null
      } catch {
        return null
      }
    })()
    const u5p = (() => {
      const s = R.u5_preview as string | null
      try {
        return s && s !== 'null' ? (JSON.parse(s) as { text: string; empty: boolean; input: boolean }) : null
      } catch {
        return null
      }
    })()
    const u4m = (() => {
      try {
        return JSON.parse((R.u4_menuItems as string) ?? '[]') as string[]
      } catch {
        return []
      }
    })()
    const s1 = R.s1_rename as Record<string, unknown>
    const s2 = R.s2_reject as Record<string, unknown>
    const s2b = R.s2b_autoRename as Record<string, unknown>
    const s2c = R.s2c_caseOnly as Record<string, unknown>
    const s3 = R.s3_tagRename as Record<string, unknown>
    const s4 = R.s4_note as Record<string, unknown>
    const s5 = R.s5_copy as Record<string, unknown>
    const s6 = R.s6_clipboard as Record<string, unknown>
    const s7 = R.s7_migrate as Record<string, unknown>
    const s8 = R.s8_import as Record<string, unknown>
    const u2r = R.u2_dup as Record<string, unknown>
    const u2n = R.u2_done as Record<string, unknown>
    const u3 = R.u3_afterCards as string[]
    const u4 = R.u4_done as Record<string, unknown>
    const u5s = R.u5_saved as Record<string, unknown>
    const u5c = R.u5_copy as Record<string, unknown>
    const u6 = R.u6_switch as Record<string, unknown>
    /** U8 的三段几何/状态快照共用这一个解析器（注入脚本返回的是 JSON 字符串） */
    const u8p = <T>(key: string): T | null => {
      const s = R[key] as string | null
      try {
        return s && s !== 'null' ? (JSON.parse(s) as T) : null
      } catch {
        return null
      }
    }
    const u8m = u8p<{
      hasBtn: boolean
      isList?: boolean
      scrollTop: number
      maxScroll?: number
      rightInset?: number
      bottomInset?: number
      topInset?: number
      gh?: number
      w?: number
      h?: number
      radius?: string
      label?: string | null
      icon?: boolean
    }>('u8_masonry')
    const u8o = u8p<{ hasBtn: boolean; bar: boolean; gap?: number; sameRow?: boolean }>('u8_overlap')
    const u8l = u8p<{ hasBtn: boolean; isList: boolean; rows: number; scrollTop: number }>('u8_list')
    const u8b = R.u8_back as Record<string, unknown>
    const u8bl = R.u8_back_list as Record<string, unknown>
    const u8bulk = R.u8_bulk as Record<string, unknown>
    /** U8 三步有界轮询的成败（防假绿闸门，见 G11）：超时 → 对应断言必须红 */
    const u8ready = R.u8_ready as { scrollReady: boolean; selReady: boolean; scrollPosReady: boolean } | undefined
    const u6b = (() => {
      const s = R.u6b_preview as string | null
      try {
        return s && s !== 'null'
          ? (JSON.parse(s) as {
              scrolledBefore: number
              leftGap: number
              rightGap: number
              topGap: number
              radius: number
              borderW: number
              padLeft: number
              imgRadius: number | null
              imgInsetLeft: number | null
              imgInsetTop: number | null
              hasImg: boolean
            })
          : null
      } catch {
        return null
      }
    })()
    const u7b = (() => {
      try {
        return JSON.parse((R.u7_buttons as string) ?? '[]') as Array<{
          key: string | null
          w: number
          h: number
          cy: number
          icon: number
          text: string
        }>
      } catch {
        return []
      }
    })()
    const u7c = R.u7_collapsed as Record<string, unknown>
    const u7s = R.u7_afterSelect as Record<string, unknown>
    const u7e = R.u7_expanded as Record<string, unknown>
    const u6c = R.u6c_palette as Record<string, unknown> | null
    /** U9：单选态右键菜单快照（注入脚本返回的是 JSON 字符串，解析失败一律当「没拿到」） */
    const u9m1 = (() => {
      const s = R.u9_menu as string | null
      try {
        return s && s !== 'null'
          ? (JSON.parse(s) as {
              items: string[]
              order: string[]
              icons: number
              openTitle: string | null
              revealTitle: string | null
              gotoTitle: string | null
            })
          : null
      } catch {
        return null
      }
    })()
    const u9s = R.u9_setup as Record<string, unknown>
    const u9c = R.u9_collapsed as Record<string, unknown>
    /** U9：多选态菜单快照（注入脚本返回 JSON 字符串，必须解析后才能读字段） */
    const u9multi = (() => {
      const s = R.u9_multi as string | null
      try {
        return s && s !== 'null'
          ? (JSON.parse(s) as {
              selected: number
              head: string | null
              open: number
              reveal: number
              goto: number
              copy: number
            })
          : null
      } catch {
        return null
      }
    })()
    const u9filtered = R.u9_filtered as Record<string, unknown>
    const u9err = R.u9_errPath as Record<string, unknown>
    const u9goto = R.u9_goto as Record<string, unknown>

    /** U10：从 `{ cursorY, menu }` 快照里取菜单矩形（拿不到一律 null，断言里按失败处理） */
    type Geom = {
      iw: number
      ih: number
      x: number
      y: number
      w: number
      h: number
      right: number
      bottom: number
      lastText: string | null
      lastBottom: number | null
      lastVisible: boolean
      head: string | null
    }
    const geomOf = (snap: unknown): Geom | null => {
      const m = (snap as { menu?: Geom | null } | null)?.menu
      return m && typeof m.bottom === 'number' ? m : null
    }
    const u10b = R.u10_geomBottom as {
      cursorX?: number
      cursorY?: number
      menu?: Geom | null
      confirmOpened?: boolean
      confirmMenu?: Geom | null
    } | null
    const u10c = R.u10_geomCorner as { cursorX?: number; cursorY?: number; menu?: Geom | null } | null
    const u10m = R.u10_geomMulti as { selected?: number; cursorY?: number; menu?: Geom | null } | null
    const u10f = R.u10_geomFlip as { opened?: boolean; triple?: number; head?: string | null; menu?: Geom | null } | null
    const gB = geomOf(u10b)
    const gC = geomOf(u10c)
    const gM = geomOf(u10m)
    const gF = geomOf(u10f)
    /** 删除确认展开后的菜单矩形 = 菜单的**最高态**，`h` 至少要预留这么多 */
    const gBc = (u10b?.confirmMenu ?? null) as Geom | null
    /** 菜单底边到右键坐标的距离：菜单收边时应当紧贴鼠标（正常 ≤ 十几像素） */
    const cursorGap = (snap: { cursorY?: number } | null, g: Geom | null): number | null =>
      g && typeof snap?.cursorY === 'number' ? Math.round(snap.cursorY - g.bottom) : null
    const u10tag = R.u10_tagFiltered as Record<string, unknown>
    const u10tg = R.u10_gotoTag as Record<string, unknown>
    const u10dirty = R.u10_dirty as Record<string, unknown>
    const u10dbl = R.u10_double as Record<string, unknown>
    const u10dirtyWrite = R.u10_dirtyWrite as Record<string, unknown>

    const checks: Record<string, boolean> = {
      // U0 preload 桥接
      bridgeExposesAll: (() => {
        const s = R.u0_bridge as string | null
        try {
          const m = s ? (JSON.parse(s) as Record<string, string>) : {}
          return Object.keys(m).length === 7 && Object.values(m).every((v) => v === 'function')
        } catch {
          return false
        }
      })(),
      bridgeFileProbeSafe: R.u0_fileProbe === 'string',

      // S1 重命名素材：索引与磁盘一起变，且旧文件真的没了
      renameUpdatesIndex: (s1?.row as { name: string })?.name === '红日.png' && (s1?.row as { rel_path: string })?.rel_path === '未分类/红日.png',
      renameMovesDisk: s1?.diskNew === true && s1?.diskOld === false,
      renameListShowsNew: (s1?.names as string[])?.includes('红日.png') === true,

      // S2 非法输入才拒绝，且世界不变
      rejectExtChanged: s2?.extChanged === 'ERR_EXT_CHANGED',
      rejectNoExt: s2?.noExt === 'ERR_EXT_CHANGED',
      rejectEmpty: s2?.empty === 'ERR_EMPTY_NAME',
      rejectSlash: s2?.slash === 'ERR_INVALID_NAME',
      rejectReserved: s2?.reserved === 'ERR_INVALID_NAME',
      rejectTailDot: s2?.tailDot === 'ERR_INVALID_NAME',
      rejectTailSpace: s2?.tailSpace === 'ERR_EXT_CHANGED',
      rejectMissing: s2?.missing === 'ERR_ASSET_NOT_FOUND',
      rejectKeepsState: (s2?.namesAfter as string[])?.includes('红日.png') === true && s2?.diskStillThere === true,

      // S2b 重名 → 自动改名（不是报错、更不是覆盖）
      autoRenameSuffix:
        (s2b?.auto1 as { name: string; renamedFrom: string | null })?.name === '蓝 (2).png' &&
        (s2b?.auto1 as { renamedFrom: string | null })?.renamedFrom === '蓝.png',
      autoRenameKeepsOriginal: s2b?.blueIntact === 1,
      // 蓝.png 与 蓝 (1).png 都被占，所以落到 (2)；绿.png 已被改走
      autoRenameSkipsTaken:
        (s2b?.diskAfterAuto1 as Array<[string, boolean]>)?.map(([n, ok]) => `${n}:${ok}`).join('|') ===
        '蓝.png:true|蓝 (1).png:true|蓝 (2).png:true|绿.png:false',
      // 收尾改回绿.png 之后：蓝 (2).png 随改名消失，绿.png 回来了
      autoRenameBackRestores:
        (s2b?.diskAfterBack as Array<[string, boolean]>)?.map(([n, ok]) => `${n}:${ok}`).join('|') ===
        '蓝.png:true|蓝 (1).png:true|蓝 (2).png:false|绿.png:true',
      autoRenameChainIsStable:
        (s2b?.autoBack as { name: string })?.name === '绿.png' &&
        (s2b?.rowAfter as { name: string })?.name === '绿.png' &&
        (s2b?.rowAfter as { rel_path: string })?.rel_path === '未分类/绿.png',
      // 仅大小写变化是合法改名（Windows 上同一个文件），不能被当成冲突加 (1)
      caseOnlyRenameAllowed:
        (s2c?.ret as { name: string; renamedFrom: string | null })?.name === '绿.PNG' &&
        (s2c?.ret as { renamedFrom: string | null })?.renamedFrom === null &&
        s2c?.disk === true,

      // S8 导入同名文件 → 第二个自动改成 `同名 (1).png`，并回报 renamed
      importRenamesDuplicate:
        (s8?.imp as { added: number; renamed: number })?.added === 2 &&
        (s8?.imp as { renamed: number })?.renamed === 1,
      importNamesUnique: (s8?.names as string[])?.join('|') === '同名 (1).png|同名.png',
      importWritesBothFiles: ((s8?.disk as Array<[string, boolean]>) ?? []).every(([, ok]) => ok === true),

      // S3 标签重命名：只改文本，关联照旧
      tagRenameUpdatesRow: (s3?.ret as { name: string })?.name === '自然',
      tagRenameKeepsLink: (s3?.links as string[])?.join('|') === '红日.png→自然',
      tagRenameSameNameOk: s3?.sameName === 'NO_ERROR',
      tagRenameDupRejected: s3?.dup === 'ERR_TAG_EXISTS',
      tagRenameEmptyRejected: s3?.empty === 'ERR_EMPTY_NAME',
      tagRenameUnknown: s3?.unknown === 'ERR_TAG_NOT_FOUND',
      tagRenameDoesNotTouchOther: (s3?.finalTags as string[])?.includes('天空') === true && s3?.skyStillThere === true,

      // S4 提示词：写入 / 纯空白归一成 NULL
      noteWrites: s4?.noteSet === '一只橘猫，坐在窗台上',
      noteBlankBecomesNull: s4?.noteBlank === null,
      noteRewrites: s4?.noteBack === '恢复的内容',

      // S5 库内复制：副本带全标注，重名自动加 (n)，磁盘上真的多了两个文件
      copyCreatesRows: (s5?.c1 as { copied: number })?.copied === 1 && (s5?.c2 as { copied: number })?.copied === 1,
      copyNamesUnique: (s5?.copyRows as Array<{ name: string }>)?.map((r) => r.name).join('|') === '红日 (1).png|红日.png',
      copyKeepsMeta:
        (s5?.copyRows as Array<{ rating: number; is_fav: number; note: string | null }>)?.every(
          (r) => r.rating === 4 && r.is_fav === 1 && r.note === '恢复的内容'
        ) === true,
      copyKeepsTags: ((s5?.copyTags as string[]) ?? []).join('|') === ((s5?.srcTags as string[]) ?? []).join('|'),
      copyWritesDisk: ((s5?.disk as boolean[]) ?? []).every(Boolean) === true && (s5?.disk as boolean[])?.length === 2,
      copyKeepsHash: (s5?.copyRows as Array<{ content_hash: string }>)?.every(
        (r) => r.content_hash === (s5?.src as { content_hash: string })?.content_hash
      ) === true,

      // S6 剪贴板往返 + 分流
      clipboardRoundTrip: (s6?.backInLibMapped as boolean[])?.every(Boolean) === true,
      pasteInLibCopies: (s6?.pasteInLib as { copied: number; importing: number })?.copied === 1 &&
        (s6?.pasteInLib as { importing: number })?.importing === 0,
      pasteInLibKeepsMeta: (s6?.copiedRow as { note: string | null; rating: number })?.note === '恢复的内容' &&
        (s6?.copiedRow as { rating: number })?.rating === 4,
      clipboardRoundTripOutside: (s6?.backOutsideMapped as boolean[])?.every(Boolean) === true,
      pasteOutsideImports: (s6?.pasteOutside as { copied: number; importing: number })?.importing === 1 &&
        (s6?.pasteOutside as { copied: number })?.copied === 0,
      pasteOutsideLands: s6?.outsideImported === true && s6?.outsideName === '外部.png',

      // S7 老库迁移：note 列被删掉后，开库时要自动 ALTER 回来，且原有数据一行不少
      migrateAddsNote:
        (s7?.colsBefore as string[])?.includes('note') === false &&
        (s7?.colsAfter as string[])?.includes('note') === true,
      migrateKeepsRows: s7?.countBefore === s7?.countAfter && (s7?.countBefore as number) > 0,
      // 别的列的数据必须原样保留（DROP COLUMN 只该影响本列）
      migrateKeepsOtherData:
        JSON.stringify(s7?.rowBefore) === JSON.stringify(s7?.rowAfter) &&
        (s7?.rowAfter as { name: string })?.name === '红日.png' &&
        (s7?.rowAfter as { rating: number })?.rating === 4,
      // 老库的既有行没有备注，补列后应为 NULL（不是空串）
      migrateSetsNoteNull: s7?.noteIsNull === null,

      // U1 菜单项齐全
      menuHasRename: u1.includes('重命名文件'),
      menuHasCopy: u1.some((x) => x.startsWith('复制')),
      menuHasPaste: u1.some((x) => x.startsWith('粘贴')),

      // U2 弹窗：主名 + 只读后缀拼回原文件名；重名自动加序号并说明；改名结果落到卡片与 DB
      renameDialogSplitsName: u2d != null && u2d.value + (u2d.ext ?? '') === u2d.cardName,
      renameDialogLocksExt: u2d?.ext === '.png' && u2d?.extTag === 'SPAN',
      renameDialogAutofocus: u2d?.focused === true,
      renameUiAutoSuffix: (() => {
        const r = u2r
        const after = String(r?.nameAfter ?? '')
        const before = String(r?.nameBefore ?? '')
        const base = String(r?.inputBase ?? '')
        // 输入的是已存在的名字 → 结果既不是原名，也 ≠ 被占用的那个名字，而是 `base (n).png`
        return (
          !!base &&
          after !== before &&
          after !== r?.target &&
          after.startsWith(base) &&
          /\(\d+\)\.png$/.test(after)
        )
      })(),
      renameUiSuffixNotifies: /已存在/.test(String(u2r?.notice ?? '')),
      renameUiClosesDialog: u2r?.dialogClosed === true,
      renameUiKeepsOriginal: u2r?.targetStillThere === 1,
      renameUiApplies:
        u2r?.nameAfter != null &&
        (u2n?.dbNames as string[])?.includes(String(u2r.nameAfter)) === true &&
        (u2n?.dbNames as string[])?.includes(String(u2r.nameBefore)) === false,
      renameUiCardText: (u2n?.cards as string[])?.includes(String(u2r?.nameAfter ?? '')) === true,

      // U3 Ctrl+C / Ctrl+V
      ctrlCSelectedFirst: (R.u3_selected as number) >= 1,
      ctrlCCopies: /已复制/.test(String(R.u3_copyNotices ?? '')),
      ctrlVPastes: /已创建|正在粘贴/.test(String(R.u3_pasteNotices ?? '')),
      ctrlVAddsFile: R.u3_pasted === true && u3.length > (u2n?.cards as string[])?.length,
      // 粘贴出来的是带标注的副本（新素材行 + 同备注/评分/喜欢 + 同标签），不是「内容重复被跳过」
      ctrlVCopiesKeepsMeta: (() => {
        const c = R.u3_copy as
          | {
              isNewRow: boolean
              src: { rating: number; is_fav: number; note: string | null; content_hash: string }
              newest: { rating: number; is_fav: number; note: string | null; content_hash: string }
            }
          | undefined
        if (!c?.isNewRow) return false
        return (
          c.newest.content_hash === c.src.content_hash &&
          c.newest.rating === c.src.rating &&
          c.newest.is_fav === c.src.is_fav &&
          c.newest.note === c.src.note
        )
      })(),
      ctrlVCopiesKeepsTags:
        ((R.u3_copy as { newestTags: string[] })?.newestTags ?? []).join('|') ===
        ((R.u3_copy as { srcTags: string[] })?.srcTags ?? []).join('|'),

      // U4 标签重命名
      tagMenuHasRename: u4m.includes('重命名标签'),
      tagRenameInputShown: R.u4_inputShown === true,
      tagRenameUiApplies:
        (u4?.sidebarTags as string[])?.some((s) => s.includes('自然风光')) === true &&
        (u4?.dbTags as string[])?.includes('自然风光') === true,

      // U5 提示词 UI
      notePreviewBeforeEdit: u5p != null && u5p.input === false,
      noteDblclickOpensEditor: R.u5_editShown === true,
      noteSavesToDbAndDom: u5s?.view === '一只橘猫｜柔光｜35mm' && u5s?.db === '一只橘猫｜柔光｜35mm' && u5s?.inputGone === true,
      noteCopyButtonWorks: u5c?.okClass === true && u5c?.clipboard === '一只橘猫｜柔光｜35mm',

      // U6 换素材不串草稿
      noteSwitchClearsEditor: u6?.switched === true && u6?.inputGone === true,
      noteSwitchClearsCopied: u6?.copiedCleared === true,

      // U6b 详情预览图：四周留白（不顶死面板）+ 图片与边框也有间隙 + 圆角边框包裹
      // ⚠️ 别断言「左右留白相等」：`.detail` 内容溢出时会冒出 10px 的竖滚动条
      //（`::-webkit-scrollbar { width: 10px }`），右侧留白就变成 12+10=22。
      // 真正要守的是「四周都有 ≥ 8px 的呼吸空间」，跟两侧是否对称无关。
      previewHasOuterGap:
        u6b != null && u6b.leftGap >= 8 && u6b.rightGap >= 8 && u6b.topGap >= 8,
      previewRounded: u6b != null && u6b.radius >= 10,
      previewHasBorder: u6b != null && u6b.borderW >= 1,
      previewHasInnerGap:
        u6b?.hasImg === true &&
        (u6b.imgInsetLeft ?? 0) >= u6b.padLeft &&
        (u6b.imgInsetLeft ?? 0) >= 5 &&
        (u6b.imgInsetTop ?? 0) >= 5,
      // 框要「细」：线不粗于 1px，且那圈让出间隙的 padding 也要克制
      previewBorderThin: u6b != null && u6b.borderW <= 1 && u6b.padLeft <= 4,
      // 图片圆角与外框**同心**：内 = 外 − 内缩（1 边框 + 4 padding）
      previewImgRounded:
        u6b?.imgRadius != null &&
        u6b.imgRadius >= 6 &&
        Math.abs(u6b.imgRadius - (u6b.radius - u6b.borderW - u6b.padLeft)) <= 1,

      // U6c 色板：点色块 → 复制十六进制（系统剪贴板为证）+ 对勾反馈
      paletteSwatches: (R.u6c_paletteCount as number) > 0 && (u6c?.swatchCount as number) >= 1,
      paletteColorIsHex: /^#[0-9A-F]{6}$/.test(String(u6c?.color ?? '')),
      paletteCopiesHex: u6c?.clipboard === u6c?.color && /^#[0-9A-F]{6}$/.test(String(u6c?.clipboard ?? '')),
      paletteShowsCheck: u6c?.copiedClass === true && u6c?.checkDrawn === true,
      paletteNotifies: /已复制颜色 #/.test(String(u6c?.notice ?? '')),

      // U7 右上角四个按钮：等宽等高 + 图标同尺寸同基线 + 纯图标无文字字形（旧版 ─ □ ✕ 就是靠这条盯住）
      wcButtonsUniform:
        u7b.length === 4 &&
        u7b.every((b) => b.w === u7b[0].w && b.h === u7b[0].h) &&
        Math.max(...u7b.map((b) => b.cy)) - Math.min(...u7b.map((b) => b.cy)) < 0.6,
      wcButtonsIconOnly: u7b.length === 4 && u7b.every((b) => b.text === '' && b.icon === 16),
      wcButtonsOrder: u7b.map((b) => b.key).join('|') === 'detail|min|max|close',
      // 收起侧栏：面板消失 + localStorage 记住 + 按钮 title 翻转
      detailCollapseWorks: R.u7_before === true && u7c?.detailGone === true,
      detailCollapsePersists: u7c?.flag === '1' && u7c?.title === '展开侧栏',
      // 收起是「锁定」状态：点素材只换选中项，不该把信息栏拉回来
      detailStaysCollapsedOnSelect: u7s?.detailGone === true && (u7s?.selected as number) >= 1,
      detailExpandWorks: u7e?.detailBack === true && u7e?.flag === '0',

      // U8 回到顶部浮标：滚到下方才出现、点击回顶、两种视图都有、不与批量条重叠
      // 前提守卫：页面得真的滚得起来，否则「滚到底浮标还在」这种断言是没有意义的。
      // `u8ready.scrollReady` = 「等容器滚得动」这一步的轮询结果（超时 → 这条明确红，红因不再是「同生共死」）
      topBtnFixtureScrollable: (u8bulk?.added as number) >= 20 && (u8m?.maxScroll ?? 0) > 300 &&
        u8ready?.scrollReady === true,
      topBtnAppearsOnScroll: u8m?.hasBtn === true && (u8m?.scrollTop ?? 0) > 240 &&
        u8ready?.scrollPosReady === true,
      // 必须待在 .gallery 的右下角（也就是中栏内部，不会压到右侧信息栏）。
      // topInset 两条盯的是「浮标真的在右下角」：一旦它变成参与布局的普通元素
      //（position 没给、或者被塞进某个定位子树里），位置就会跟着内容流跑，
      // 此时 DOM 里依然查得到（hasBtn 仍为 true），只有几何能抓到。
      topBtnInsideRightBottom:
        (u8m?.rightInset ?? 0) >= 8 &&
        (u8m?.bottomInset ?? 0) >= 8 &&
        (u8m?.topInset ?? 0) >= 8 &&
        (u8m?.topInset ?? 0) > (u8m?.gh ?? 0) / 2,
      // 圆角小圆钮 + 有图标 + 有可读标签（纯图标按钮必须给 aria-label，否则读屏只念「按钮」）
      topBtnIsRoundIcon: (() => {
        const w = u8m?.w ?? 0
        const r = String(u8m?.radius ?? '')
        // 计算样式给的是像素（19px）还是百分比（50%）都可能，两种写法都按「够不够圆」判
        const round = r.endsWith('%') ? parseFloat(r) >= 50 : parseFloat(r) >= w / 2 - 1
        return (
          w === (u8m?.h ?? 0) &&
          w >= 32 &&
          w <= 44 &&
          round &&
          u8m?.icon === true &&
          u8m?.label === '回到顶部'
        )
      })(),
      // 批量条在场时不能盖住它（窄窗口下两者最容易撞上）
      topBtnClearsBatchBar: u8o?.bar === true && (u8o?.gap ?? -1) >= 4 && u8o?.sameRow === false,
      topBtnScrollsBack: u8b?.ok === true && u8b?.scrollTop === 0 && u8b?.hasBtn === false,
      // 列表视图共用同一个滚动容器，浮标必须同样可用（用户明确要两种视图都有）
      topBtnAvailableInList: u8l?.isList === true && u8l?.hasBtn === true && (u8l?.scrollTop ?? 0) > 240,
      topBtnScrollsBackInList: u8bl?.ok === true && u8bl?.scrollTop === 0,
      // 收尾：选中确实发生过（批量条才真的在场，重叠断言才有意义）、Esc 又能干净复位
      // `u8ready.selReady` = 「点卡片后等选中生效」的轮询结果（超时 → 这条明确红）
      topBtnTestSelectionReset: R.u8_selected === 1 && R.u8_cleared === 0 && u8ready?.selReady === true,

      // ==================== U9 右键菜单三项（系统打开 / 系统定位 / 跳库内文件夹）====================
      // ① 三项在场（文案严格按用户给的三条）
      ctxMenuHasOpenShell: (u9m1?.items ?? []).includes('用系统默认应用打开'),
      ctxMenuHasReveal: (u9m1?.items ?? []).includes('在文件浏览器中显示'),
      ctxMenuHasGotoFolder: (u9m1?.items ?? []).includes('在所在文件夹中显示'),
      // 顺序：必须整组插在「复制」**上方**（这次需求的核心；追加到菜单末尾就不算做到）
      ctxMenuThreeAboveCopy: (() => {
        const order = (u9m1?.order ?? []).filter(Boolean)
        const iCopy = order.indexOf('copy')
        if (iCopy <= 0) return false
        // 复制之前紧邻的三项必须正好是这三项，且顺序一致
        return order.slice(iCopy - 3, iCopy).join('|') === 'open-shell|reveal|goto-folder'
      })(),
      // 每项一个 13×13 描边图标（菜单里不许用 emoji / 字符图标）
      ctxMenuThreeHaveIcons: u9m1?.icons === 3,
      // 两条文案接近（都是「显示」），必须靠 title 把「系统资源管理器」与「软件内文件夹」区分开
      ctxMenuTitlesDisambiguate:
        /资源管理器/.test(String(u9m1?.revealTitle ?? '')) && /软件内/.test(String(u9m1?.gotoTitle ?? '')),

      // ② 单选可见 / 多选**隐藏**（多选时「用默认应用打开」会弹 N 个窗口、「定位」会开 N 个资源管理器）
      ctxMenuThreeHiddenOnMulti:
        u9multi?.selected === 2 &&
        String(u9multi?.head ?? '').includes('已选 2 项') &&
        u9multi?.open === 0 &&
        u9multi?.reveal === 0 &&
        u9multi?.goto === 0 &&
        // 「复制」还在 → 证明菜单本身是开着且正常的，三项消失不是「菜单没渲染」
        u9multi?.copy === 1,

      // ④ 第 1、2 项：点下去不炸、菜单收掉、失败有中文提示
      //（靶子文件已被删 → 主进程在开窗口之前返回 ERR_ASSET_MISSING，全程不弹任何系统窗口）
      // 文案收紧到「打开失败 / 定位文件失败 + 磁盘上找不到该文件」：
      // 原来那条 `找不到该素材` 的备选是「列表里查不到这一行」分支的文案，留着会让**错的失败原因**也变绿。
      ctxMenuOpenFailsLoudly:
        u9err?.openClicked === true &&
        u9err?.openClosed === true &&
        /^打开失败：磁盘上找不到该文件/.test(String(u9err?.openNotice ?? '')),
      ctxMenuRevealFailsLoudly:
        u9err?.revealClicked === true &&
        u9err?.revealClosed === true &&
        /^定位文件失败：磁盘上找不到该文件/.test(String(u9err?.revealNotice ?? '')),

      // ③ 跳库内文件夹：定位正确（侧栏 active 行 = query.folderId 的视觉等价物）+ 祖先被展开
      ctxGotoSetsFolder:
        u9goto?.clicked === true &&
        u9goto?.activeId === u9s?.folderId &&
        u9goto?.activePath === '跳转目标/内层' &&
        u9goto?.title === '内层',
      // 祖先折叠时 expandTo 必须把它展开，否则侧栏里连目标那一行都没有（用户会以为没跳）
      ctxGotoExpandsAncestors: u9c?.innerHidden === true && u9goto?.innerShown === true,
      // 清筛选：跳转前输入框里确实有「批量」（不然「已清空」是空断言），跳完必须空
      ctxGotoClearsFilters:
        u9filtered?.search === '批量' && u9filtered?.targetShown === true && u9goto?.search === '',
      // 素材真的在列表里、且被重新选中（右侧详情栏跟着回来）
      ctxGotoShowsAndSelectsAsset:
        (u9s?.id as number) > 0 &&
        u9goto?.selectedId === u9s?.id &&
        ((u9goto?.cardIds as number[]) ?? []).includes(u9s?.id as number) === true,

      // ==================== U10 右键三项的边界（QA 补强）====================
      // ① 几何：贴着底边 / 右下角右键，菜单必须完整落在视口内（x、y、right、bottom 四条边都要看）
      ctxMenuFitsViewport: [gB, gC, gM].every(
        (g) => g != null && g.bottom <= g.ih + 0.5 && g.right <= g.iw + 0.5 && g.x >= -0.5 && g.y >= -0.5
      ),
      // ① 单选态最后一项就是「删除」→ 它完整可见，才说明预留高度没算少
      ctxMenuLastItemVisible:
        gB?.lastText === '删除' && gB?.lastVisible === true && gC?.lastText === '删除' && gC?.lastVisible === true,
      // ① 菜单最高态（展开删除确认后）也不能被裁：这个高度才是 h 该预留的下界
      ctxMenuMaxStateFits:
        u10b?.confirmOpened === true &&
        gBc != null &&
        gBc.bottom <= gBc.ih + 0.5 &&
        gBc.y >= -0.5 &&
        gBc.right <= gBc.iw + 0.5,
      // ① 反向：预留**算多了**会让菜单离鼠标很远（"飘"）。收边后底边应紧贴右键坐标（≤16px）
      ctxMenuAnchorsToCursor: (() => {
        const g1 = cursorGap(u10b, gB)
        const g2 = cursorGap(u10c, gC)
        const g3 = cursorGap(u10m, gM)
        if (g1 == null || g2 == null || g3 == null) return false
        return g1 <= 16 && g2 <= 16 && g3 <= 16
      })(),
      // ② 多选态确实少了 3 行（≈84px）→ 说明「隐藏而不是禁用」在 DOM 上真的生效，也给了"飘"的量化依据
      ctxMenuShorterOnMulti: gB != null && gM != null && gB.h - gM.h >= 70 && u10m?.selected === 2,
      // ②b 多选态右键「未选中的卡」→ 集合从 N 变 1、三项出现、菜单**同一帧长高**：
      // 动态收边必须量到长高之后的高度，否则贴底展开照样裁（钉住 select() 与 menu 的 flush 顺序）
      ctxMenuRegrowStaysVisible:
        u10f?.opened === true &&
        u10f?.triple === 1 &&
        String(u10f?.head ?? '') === '素材操作' &&
        gF != null &&
        gF.bottom <= gF.ih + 0.5 &&
        gF.lastVisible === true,
      // ③ 标签筛选：tagId 被显式清掉（clearFilters 不含 tagId），且素材可见并被重新选中
      ctxGotoClearsTagFilter:
        u10tag?.active === true &&
        u10tag?.targetShown === true &&
        u10tg?.clicked === true &&
        u10tg?.tagActive === false &&
        u10tg?.search === '' &&
        u10tg?.targetShown === true &&
        u10tg?.selectedId === u9s?.id &&
        /已跳到/.test(String(u10tg?.notice ?? '')),
      // ③ 排序是用户偏好：跳转只清筛选，不该顺手改排序（先换成非默认的「名称」再验）
      // ⚠️ 必须带 `clicked === true`：菜单没点开时「前后一样」是恒真的空断言
      ctxGotoKeepsSort:
        u10tg?.clicked === true && /名称/.test(String(u10tg?.sortBefore ?? '')) && u10tg?.sortAfter === u10tg?.sortBefore,
      // ④ 脏数据：folder_id 查不到文件夹时必须出声，且不许把侧栏/列表挪到一个不存在的位置
      ctxGotoDirtyFolderSpeaks:
        u10dirtyWrite?.ok === true &&
        u10dirty?.clicked === true &&
        u10dirty?.menuClosed === true &&
        /找不到「/.test(String(u10dirty?.notice ?? '')) &&
        /索引可能已过期/.test(String(u10dirty?.notice ?? '')) &&
        u10dirty?.activePath === null &&
        u10dirty?.selectedId === u9s?.id,
      // ⑤ 连点两次：首点即收（第二次点不到 → false），重开再点仍正确、不报错
      ctxGotoTwiceIsSafe:
        u10dbl?.first === true &&
        u10dbl?.whileClosed === false &&
        u10dbl?.third === true &&
        u10dbl?.activePath === '跳转目标/内层' &&
        u10dbl?.selectedId === u9s?.id &&
        u10dbl?.menuClosed === true &&
        !/失败/.test(String(u10dbl?.notice ?? '')),
      // ⑥ Esc 关菜单（U9 只发过按键，没断言结果）
      ctxMenuEscCloses: R.u10_escClosed === true,

      // 渲染层运行期错误：注入脚本抛错 + 页面 error / unhandledrejection 两路都算
      noJsErrors: jsErrors.length === 0 && ((R.pageErrors as string[] | undefined) ?? []).length === 0
    }

    R.checks = checks
    const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)
    R.ok = failed.length === 0
    R.failed = failed
    R.jsErrors = jsErrors
    console.log('[SMOKE-EDIT] ' + JSON.stringify(R))
    console.log(`[SMOKE-EDIT] ${R.ok ? 'PASS' : 'FAIL'} (${Object.keys(checks).length - failed.length}/${Object.keys(checks).length})`)
  } catch (e) {
    console.log('[SMOKE-EDIT] ERROR ' + String((e as Error).stack ?? e))
    R.ok = false
    R.checks = { noThrow: false }
    console.log('[SMOKE-EDIT] ' + JSON.stringify(R))
  } finally {
    // 复位右侧信息栏的折叠标记（理由见 U 段开头），别把状态留给下一个冒烟套件
    try {
      patchSettings({ detailCollapsed: false })
    } catch {
      /* 还原失败不挡住退出 */
    }
    try {
      if (libPath) {
        closeCurrent()
        // 只清 `config.json` 的最近库记录（不再物理删库），删目录由外层 rmSync(dir) 负责
        forgetLibrary(libPath)
      }
    } catch {
      /* 清理失败不影响结论 */
    }
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
    app.exit(0)
  }
}
