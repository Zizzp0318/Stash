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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { closeCurrent, createLibrary, deleteLibrary, mkdirRel, openLibrary, requireCurrent } from './library'
import { readFiles, writeFiles } from './clipboard'
import { copyAssets, createTag, pastePaths, renameAsset, renameTag, updateAsset } from './assets'
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
    await sleep(3000)

    // 先选一张：批量条要出现，才能验证「浮标让开批量条」不是空断言
    await clickSel('.masonry-card', 0)
    await sleep(700)
    R.u8_selected = (await js(`document.querySelectorAll('.masonry-card.selected').length`)) as number

    // 滚到最下方（瀑布视图）
    await js(`(() => { const w = document.querySelector('.grid-wrap'); if (w) w.scrollTop = w.scrollHeight })()`)
    await sleep(600)
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
      // 前提守卫：页面得真的滚得起来，否则「滚到底浮标还在」这种断言是没有意义的
      topBtnFixtureScrollable: (u8bulk?.added as number) >= 20 && (u8m?.maxScroll ?? 0) > 300,
      topBtnAppearsOnScroll: u8m?.hasBtn === true && (u8m?.scrollTop ?? 0) > 240,
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
      topBtnTestSelectionReset: R.u8_selected === 1 && R.u8_cleared === 0,

      noJsErrors: jsErrors.length === 0
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
        deleteLibrary(libPath)
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
