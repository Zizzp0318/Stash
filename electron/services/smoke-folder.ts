// 文件夹管理冒烟：多级新建 / 重命名（子树 path 与 assets.rel_path 同步）/ 物理删除（不进回收站）
// 前半段直接调服务层核对磁盘与数据库，后半段用真实鼠标/键盘事件驱动侧栏右键菜单走一遍 UI。
import { app, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { closeCurrent, createLibrary, deleteFolder, deleteLibrary, mkdirChild, renameFolder, requireCurrent } from './library'
import { createTag, setTags } from './assets'
import { importFiles } from './importer'
import { ensureBatch } from './thumbs'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
function onceLoaded(win: BrowserWindow): Promise<void> {
  return new Promise((resolve) => win.webContents.once('did-finish-load', () => resolve()))
}

export async function runSmokeFolder(win: BrowserWindow): Promise<void> {
  const R: Record<string, unknown> = {}
  const jsErrors: Array<{ code: string; error: string }> = []
  const rendererLogs: string[] = []
  win.webContents.on('console-message', (_e, _lvl, message) => {
    rendererLogs.push(message.slice(0, 300))
    if (rendererLogs.length > 40) rendererLogs.shift()
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
  /**
   * 每次都从 requireCurrent() 取实时手柄，不要把 db 缓存下来 ——
   * 渲染层的 bootstrap() 可能在我们建库之后又 openLibrary 一次（它会 setCurrent → closeCurrent），
   * 缓存下来的旧手柄会变成 "database is not open"。
   */
  const D = (): ReturnType<typeof requireCurrent>['db'] => requireCurrent().db

  const abs = (rel: string): string => join(libPath, ...rel.split('/'))
  const onDisk = (rel: string): boolean => existsSync(abs(rel))
  const folderRows = (): Array<{ id: number; parent_id: number | null; path: string; name: string }> =>
    D().prepare('SELECT id, parent_id, path, name FROM folders ORDER BY path').all() as never
  const folderPaths = (): string[] => folderRows().map((f) => f.path).sort()
  const assetRels = (): string[] =>
    (D().prepare('SELECT rel_path FROM assets ORDER BY rel_path').all() as Array<{ rel_path: string }>).map((a) => a.rel_path)
  const byPath = (p: string): { id: number; parent_id: number | null; path: string; name: string } | undefined =>
    folderRows().find((f) => f.path === p)
  /** 捕获抛出的错误码（用来验证负例都被拦住） */
  const nah = (fn: () => unknown): string => {
    try {
      fn()
      return 'NO_ERROR'
    } catch (e) {
      return String((e as Error).message ?? e)
    }
  }
  const step = (s: string): void => console.log('[SMOKE-FOLDER-STEP] ' + s)
  const importTo = (paths: string[], folderId: number): Promise<{ added: number }> =>
    new Promise((resolve) => importFiles({ paths, folderId, mode: 'copy', onDone: (x) => resolve(x) }))

  try {
    // 先等渲染层的 bootstrap() 跑完（它可能在最近列表里自动开库，会把我们的手柄换掉）
    await sleep(1200)
    dir = mkdtempSync(join(tmpdir(), 'stash-smoke-folder-'))
    libPath = createLibrary({ name: 'folderlib', parentDir: dir }).path

    // ==================== A. 多级新建子文件夹 ====================
    step("A")
    const lv1 = mkdirChild('', '一级')
    const lv2 = mkdirChild('一级', '二级')
    const lv3 = mkdirChild('一级/二级', '三级')
    mkdirChild('', '对照') // 对照组：删除时应毫发无伤
    const f1 = byPath('一级')!
    const f2 = byPath('一级/二级')!
    R.a_create = {
      paths: [lv1.path, lv2.path, lv3.path],
      // 三层都要真的在磁盘上（mkdirSync recursive + ensureFolderRows 逐级建行）
      disk: [onDisk('一级'), onDisk('一级/二级'), onDisk('一级/二级/三级')],
      rows: folderPaths(),
      // 父子链不能断
      parentChain: [
        f1.parent_id === null,
        f2.parent_id === f1.id,
        byPath('一级/二级/三级')!.parent_id === f2.id
      ]
    }

    // ==================== B. 负例：非法名一律拦住 ====================
    step("B")
    const thumbsId = D().prepare('INSERT INTO folders(parent_id,path,name,created_at) VALUES(NULL,?,?,?)').run('.thumbs', '.thumbs', Date.now()).lastInsertRowid
    R.b_negative = {
      slash: nah(() => mkdirChild('一级', 'a/b')),
      colon: nah(() => mkdirChild('一级', 'a:b')),
      reserved: nah(() => mkdirChild('一级', 'con')),
      trailingDot: nah(() => mkdirChild('一级', 'x.')),
      dotdot: nah(() => mkdirChild('一级', '..')),
      empty: nah(() => mkdirChild('一级', '   ')),
      dup: nah(() => mkdirChild('一级', '二级')),
      missingParent: nah(() => mkdirChild('不存在的父级', 'x')),
      // 隐藏目录受保护：即使被塞进 folders 表也不允许当普通文件夹删掉
      protectedDir: nah(() => deleteFolder(Number(thumbsId)))
    }
    D().prepare('DELETE FROM folders WHERE id=?').run(thumbsId)

    // ==================== C. 导入素材到深层 + 打标签（验证 CASCADE）====================
    step("C")
    const src = join(dir, 'src')
    mkdirSync(src)
    const paths: string[] = []
    for (let i = 0; i < 4; i++) {
      const p = join(src, `img-${i}.png`)
      await sharp({ create: { width: 200 + i * 40, height: 160, channels: 3, background: { r: 40 + i * 40, g: 80, b: 160 } } })
        .png()
        .toFile(p)
      paths.push(p)
    }
    const impA = await importTo(paths.slice(0, 2), f2.id)
    const impB = await importTo(paths.slice(2), byPath('一级/二级/三级')!.id)
    const tag = createTag({ name: '冒烟标签' })
    setTags((D().prepare('SELECT id FROM assets ORDER BY id LIMIT 1').get() as { id: number }).id, [tag.id])
    R.c_import = {
      added: [impA.added, impB.added],
      relPaths: assetRels(),
      tagLinks: (D().prepare('SELECT count(*) AS c FROM asset_tags').get() as { c: number }).c
    }

    // ==================== D. 生成缩略图（供删除时核对缓存回收）====================
    step("D")
    const hashes = (D().prepare('SELECT content_hash FROM assets WHERE content_hash IS NOT NULL').all() as Array<{ content_hash: string }>).map(
      (a) => a.content_hash
    )
    const thumbDirsOnDisk = (): number => hashes.filter((h) => existsSync(join(libPath, '.thumbs', h))).length
    const thumbRows = D().prepare('SELECT id, type, ext, content_hash, rel_path FROM assets').all() as Array<{
      id: number; type: string; ext: string; content_hash: string | null; rel_path: string
    }>
    const runThumbs = (size: 'grid' | 'detail'): Promise<boolean> =>
      new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 15000)
        ensureBatch(thumbRows, size, () => { clearTimeout(t); resolve(true) })
      })
    const gridOk = await runThumbs('grid')
    const detailOk = await runThumbs('detail')
    step(`D-thumbs grid=${gridOk} detail=${detailOk} dirs=${thumbDirsOnDisk()}`)
    R.d_thumbs = { assets: hashes.length, cacheDirs: thumbDirsOnDisk(), gridOk, detailOk }
    // grid 与 detail 两个文件都要在（dirs 存在不代表里面文件齐）
    R.d_files = {
      grid: hashes.filter((h) => existsSync(join(libPath, '.thumbs', h, 'grid.webp'))).length,
      detail: hashes.filter((h) => existsSync(join(libPath, '.thumbs', h, 'detail.webp'))).length
    }

    // ==================== E. 重命名顶层：整棵子树都要跟着走 ====================
    step("E")
    const renamed = renameFolder(f1.id, '已重命名')
    R.e_renameTop = {
      result: renamed,
      oldGone: !onDisk('一级'),
      newTree: [onDisk('已重命名'), onDisk('已重命名/二级'), onDisk('已重命名/二级/三级')],
      folderPaths: folderPaths(),
      assetRels: assetRels(),
      // 物理文件必须真的在新位置（不是只改了索引）
      filesInMid: onDisk('已重命名/二级') ? readdirSync(abs('已重命名/二级')).sort() : [],
      filesInLeaf: onDisk('已重命名/二级/三级') ? readdirSync(abs('已重命名/二级/三级')).sort() : [],
      thumbsStillThere: thumbDirsOnDisk(),
      childParentOk: byPath('已重命名/二级')!.parent_id === renamed.id
    }

    // ==================== F. 重命名中间层 ====================
    step("F")
    const ren2 = renameFolder(byPath('已重命名/二级')!.id, '中层改名')
    R.f_renameMid = {
      result: ren2,
      folderPaths: folderPaths(),
      assetRels: assetRels(),
      grandOk: onDisk('已重命名/中层改名/三级'),
      oldMidGone: !onDisk('已重命名/二级')
    }

    // ==================== G. 删除整棵子树：物理删除 + 索引清理 + 缓存回收 ====================
    step("G")
    const thumbsBeforeDelete = thumbDirsOnDisk()
    const del = deleteFolder(byPath('已重命名')!.id)
    R.g_delete = {
      result: del,
      diskGone: !onDisk('已重命名'),
      foldersLeft: folderPaths(),
      assetsLeft: assetRels(),
      // 标签关联靠外键 CASCADE 自动清，但标签本身要留着
      orphanTagLinks: (D().prepare('SELECT count(*) AS c FROM asset_tags').get() as { c: number }).c,
      tagsLeft: (D().prepare('SELECT count(*) AS c FROM tags').get() as { c: number }).c,
      thumbsBeforeDelete,
      thumbsLeft: thumbDirsOnDisk(),
      // 对照组必须毫发无伤
      siblingIntact: onDisk('对照')
    }

    // ==================== H. UI：侧栏右键菜单 ====================
    step("H")
    await rawJs(`window.stash.library.open(${JSON.stringify(libPath)}).then(() => location.reload())`)
    await onceLoaded(win)
    await sleep(2600)

    /** 侧栏里某个文件夹行的位置（selector 在页面内拼接，folder 名不含引号所以安全） */
    const rowAt = async (path: string): Promise<{ text: string; cx: number; cy: number; x: number; y: number } | null> =>
      (await js(`(() => {
        const el = document.querySelector('.side-item[data-folder-path="' + ${JSON.stringify(path)} + '"]')
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { text: el.textContent.trim(), cx: r.left + r.width / 2, cy: r.top + r.height / 2, x: r.left + 30, y: r.top + r.height / 2 }
      })()`)) as { text: string; cx: number; cy: number; x: number; y: number } | null

    const rowPaths = async (): Promise<string[]> =>
      ((await js(`[...document.querySelectorAll('.side-item[data-folder-path]')].map(e => e.dataset.folderPath)`)) as string[] | null) ?? []

    /** 当前侧栏高亮项：文件夹路径 或 'ALL'（所有素材）；无高亮返回 null */
    const activeKey = async (): Promise<string | null> =>
      (await js(`(() => {
        const el = document.querySelector('.side-item.active')
        return el ? (el.dataset.folderPath ?? 'ALL') : null
      })()`)) as string | null

    /** 右键某文件夹行打开菜单；优先真实右键，失败再退回 dispatchEvent */
    const openCtx = async (path: string): Promise<string> => {
      const p = await rowAt(path)
      if (!p) return 'ROW_NOT_FOUND'
      const m = []
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(p.x), y: Math.round(p.y), modifiers: m })
      win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(p.x), y: Math.round(p.y), button: 'right', clickCount: 1, modifiers: m })
      win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(p.x), y: Math.round(p.y), button: 'right', clickCount: 1, modifiers: m })
      await sleep(300)
      if (await js(`!!document.querySelector('.folder-ctx')`)) return 'real'
      await js(`(() => {
        const el = document.querySelector('.side-item[data-folder-path="' + ${JSON.stringify(path)} + '"]')
        if (!el) return false
        const r = el.getBoundingClientRect()
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + r.height / 2 }))
        return true
      })()`)
      await sleep(300)
      return (await js(`!!document.querySelector('.folder-ctx')`)) ? 'dispatch' : 'FAILED'
    }
    const clickMenuItem = async (label: string): Promise<boolean> =>
      (await js(`(() => {
        const b = [...document.querySelectorAll('.folder-ctx .ctx-item')].find(x => x.textContent.trim() === ${JSON.stringify(label)})
        if (!b) return false
        b.click(); return true
      })()`)) as boolean | null ?? false
    /** 输入框里打字并回车（insertText 走真实输入管线，v-model 才会收到） */
    const typeAndEnter = async (sel: string, text: string): Promise<{ valueBefore: string; valueAfter: string }> => {
      const dom = `document.querySelector(${JSON.stringify(sel)})`
      await js(`(() => { const i = ${dom}; if (i) { i.focus(); i.select && i.select() } })()`)
      await sleep(120)
      win.webContents.insertText(text)
      await sleep(200)
      const before = (await js(`${dom}?.value ?? null`)) as string | null
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
      win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
      await sleep(900)
      const after = (await js(`${dom}?.value ?? null`)) as string | null
      return { valueBefore: before ?? '', valueAfter: after ?? '' }
    }

    R.h0_rows = await rowPaths()
    const capture = async (name: string): Promise<void> => {
      try {
        const img = await win.webContents.capturePage()
        writeFileSync(join(process.cwd(), name), img.toPNG())
      } catch (e) {
        R.shotError = String((e as Error).message ?? e)
      }
    }

    // H1 右键「对照」→ 新建子文件夹 → 输入 sub-a → 回车
    R.h1_ctxMode = await openCtx('对照')
    R.h1_menuItems = await js(`[...document.querySelectorAll('.folder-ctx .ctx-item')].map(x => x.textContent.trim())`)
    await capture('shot-folder-menu.png')
    R.h1_clicked = await clickMenuItem('新建子文件夹')
    await sleep(350)
    R.h1_inputShown = await js(`!!document.querySelector('.side-item[data-folder-path="对照"] + .inline-form input')`)
    await capture('shot-folder-newchild.png')
    R.h1_typed = await typeAndEnter('.side-item[data-folder-path="对照"] + .inline-form input', 'sub-a')
    R.h1_result = {
      rowsAfter: await rowPaths(),
      onDiskAfter: onDisk('对照/sub-a'),
      dbPaths: folderPaths()
    }

    // H2 右键 sub-a → 重命名 → 输入 sub-b → 回车（输入框应预填原名并全选）
    R.h2_ctxMode = await openCtx('对照/sub-a')
    R.h2_clicked = await clickMenuItem('重命名')
    await sleep(350)
    R.h2_prefilled = (await js(`document.querySelector('.side-rename')?.value ?? null`)) as string | null
    await capture('shot-folder-rename.png')
    R.h2_typed = await typeAndEnter('.side-rename', 'sub-b')
    R.h2_result = {
      rowsAfter: await rowPaths(),
      oldGone: !onDisk('对照/sub-a'),
      newOnDisk: onDisk('对照/sub-b'),
      dbPaths: folderPaths()
    }

    // H3 让筛选指向该文件夹，再右键删除 → 确认 → 行消失、磁盘消失、筛选回到「所有素材」
    const target = await rowAt('对照/sub-b')
    if (target) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(target.cx), y: Math.round(target.cy) })
      win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(target.cx), y: Math.round(target.cy), button: 'left', clickCount: 1 })
      win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(target.cx), y: Math.round(target.cy), button: 'left', clickCount: 1 })
      await sleep(500)
    }
    R.h3_selectedBefore = await activeKey()
    R.h3_ctxMode = await openCtx('对照/sub-b')
    R.h3_clicked = await clickMenuItem('删除文件夹')
    await sleep(400)
    R.h3_modal = await js(`(() => {
      const m = document.querySelector('.modal')
      return m ? { title: m.querySelector('.modal-title')?.textContent.trim(), body: m.querySelector('.modal-text')?.textContent.replace(/\\s+/g, ' ').trim() } : null
    })()`)
    await capture('shot-folder-delete.png')
    await js(`(() => { const b = [...document.querySelectorAll('.modal .w-btn')].find(x => x.textContent.trim() === '删除'); if (b) b.click() })()`)
    await sleep(1600)
    await capture('shot-folder.png')
    R.h3_result = {
      rowsAfter: await rowPaths(),
      diskGone: !onDisk('对照/sub-b'),
      parentIntact: onDisk('对照'),
      dbPaths: folderPaths(),
      // 删掉的正是当前筛选目标 → 应回到「所有素材」
      activeAfter: await activeKey(),
      notice: await js(`document.querySelector('.notice-toast')?.textContent.trim() ?? null`)
    }


    // ==================== I. 侧栏文件夹折叠 ====================
    step('I')
    // 造出「对照/树A/树B」三级，折叠才有意义；再建一个拖拽落点「对照/目标」
    mkdirChild('对照', '树A')
    mkdirChild('对照/树A', '树B')
    mkdirChild('对照', '目标')
    await rawJs(`location.reload()`)
    await onceLoaded(win)
    await sleep(2600)

    /** 折叠箭头的位置 */
    const foldAt = async (path: string): Promise<{ x: number; y: number } | null> =>
      (await js(`(() => {
        const el = document.querySelector('.fold-toggle[data-fold-path="' + ${JSON.stringify(path)} + '"]')
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      })()`)) as { x: number; y: number } | null

    const clickAt = async (p: { x: number; y: number }): Promise<void> => {
      const x = Math.round(p.x)
      const y = Math.round(p.y)
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      await sleep(450)
    }

    /** 折叠状态是按库存的：key 里带库路径，避免不同库互相污染 */
    const collapsedSaved = async (): Promise<string[]> =>
      ((await js(`(() => { try { return JSON.parse(localStorage.getItem('stash.collapsed:' + ${JSON.stringify(libPath)}) ?? '[]') } catch { return [] } })()`)) as
        | string[]
        | null) ?? []

    R.i_rowsBefore = await rowPaths()
    const foldA = await foldAt('对照/树A')
    R.i_foldToggleFound = !!foldA
    if (foldA) await clickAt(foldA)
    R.i_afterCollapse = {
      rows: await rowPaths(),
      foldedClass: await js(`!!document.querySelector('.fold-toggle[data-fold-path="对照/树A"].folded')`),
      saved: await collapsedSaved()
    }
    await capture('shot-folder-collapsed.png')

    // 折叠状态要跨重启保留（存 localStorage），reload 一次核对
    await rawJs(`location.reload()`)
    await onceLoaded(win)
    await sleep(2600)
    R.i_afterReload = { rows: await rowPaths(), saved: await collapsedSaved() }

    const foldA2 = await foldAt('对照/树A')
    if (foldA2) await clickAt(foldA2)
    R.i_afterExpand = {
      rows: await rowPaths(),
      foldedClass: await js(`!!document.querySelector('.fold-toggle[data-fold-path="对照/树A"].folded')`),
      saved: await collapsedSaved()
    }

    // ==================== J. 拖拽素材到文件夹 ====================
    step('J')
    const jSrc = join(dir, 'jsrc')
    mkdirSync(jSrc, { recursive: true })
    const jPaths: string[] = []
    for (let i = 0; i < 3; i++) {
      const p = join(jSrc, `drag-${i}.png`)
      await sharp({ create: { width: 220 + i * 30, height: 170, channels: 3, background: { r: 200, g: 70 + i * 50, b: 90 } } })
        .png()
        .toFile(p)
      jPaths.push(p)
    }
    await importTo(jPaths, byPath('对照/树A')!.id)
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => resolve(), 12000)
      ensureBatch(
        D().prepare('SELECT id, type, ext, content_hash, rel_path FROM assets').all() as never,
        'grid',
        () => { clearTimeout(t); resolve() }
      )
    })
    await js(`location.reload()`)
    await onceLoaded(win)
    await sleep(2600)

    const assetRow = (id: number): { id: number; name: string; rel_path: string; folder_id: number | null } | undefined =>
      D().prepare('SELECT id, name, rel_path, folder_id FROM assets WHERE id=?').get(id) as never

    /** 第 idx 张卡片的位置（取卡片上部，避免落在信息文字上） */
    const cardXY = async (idx: number): Promise<{ id: number; x: number; y: number } | null> =>
      (await js(`(() => {
        const c = document.querySelectorAll('.masonry-card')[${idx}]
        if (!c) return null
        const r = c.getBoundingClientRect()
        return { id: Number(c.dataset.id), x: r.left + r.width / 2, y: r.top + Math.min(26, r.height / 2) }
      })()`)) as { id: number; x: number; y: number } | null

    /**
     * 真实鼠标拖拽：按下 → 分步移动 → 松手。
     * 移动事件必须带 `leftButtonDown` modifier —— 否则 Chromium 认为按键已松开（buttons=0），
     * 而代码里有一条「buttons 为 0 说明鼠标在窗口外松了手」的兜底，会立刻中断拖拽。
     */
    const dragBetween = async (
      from: { x: number; y: number },
      to: { x: number; y: number },
      opts: { ctrl?: boolean; midway?: () => Promise<unknown> } = {}
    ): Promise<void> => {
      const downMods = opts.ctrl ? ['control'] : []
      const moveMods = opts.ctrl ? ['leftButtonDown', 'control'] : ['leftButtonDown']
      const at = (t: number): { x: number; y: number } => ({
        x: Math.round(from.x + (to.x - from.x) * t),
        y: Math.round(from.y + (to.y - from.y) * t)
      })
      const p0 = at(0)
      win.webContents.sendInputEvent({ type: 'mouseMove', x: p0.x, y: p0.y, modifiers: downMods })
      win.webContents.sendInputEvent({ type: 'mouseDown', x: p0.x, y: p0.y, button: 'left', clickCount: 1, modifiers: downMods })
      await sleep(90)
      for (const t of [0.15, 0.35, 0.6, 0.85, 1]) {
        const p = at(t)
        win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y, modifiers: moveMods })
        await sleep(80)
      }
      await sleep(160)
      if (opts.midway) await opts.midway()
      const pEnd = at(1)
      win.webContents.sendInputEvent({ type: 'mouseUp', x: pEnd.x, y: pEnd.y, button: 'left', clickCount: 1 })
      await sleep(1500)
    }

    /** 拖拽过程中的即时状态：ghost 是否出现、哪些文件夹行高亮、卡片是否压暗 */
    const dragSnapshot = async (): Promise<Record<string, unknown>> =>
      (await js(`({
        ghost: !!document.querySelector('.drag-ghost'),
        ghostText: document.querySelector('.drag-ghost .dg-count')?.textContent.trim() ?? null,
        dropOn: [...document.querySelectorAll('.side-item.drop-on')].map(x => x.dataset.folderPath),
        dimmed: document.querySelectorAll('.card.dragging, .list-row.dragging').length,
        marquee: !!document.querySelector('.marquee')
      })`)) as Record<string, unknown>

    // J1 单张卡片 → 「对照/目标」
    const c0 = await cardXY(0)
    const goalRow = await rowAt('对照/目标')
    R.j_cardsFound = await js(`document.querySelectorAll('.masonry-card').length`)
    if (c0 && goalRow) {
      const before = assetRow(c0.id)
      await dragBetween(c0, { x: goalRow.cx, y: goalRow.cy }, {
        midway: async () => {
          R.j1_midway = await dragSnapshot()
          // 拖动进行中：这张要能看到 ghost 浮层与落点文件夹的高亮
          await capture('shot-folder-drag.png')
        }
      })
      const after = assetRow(c0.id) ?? null
      R.j1_drop = {
        name: before?.name,
        beforeRel: before?.rel_path,
        afterRel: after?.rel_path,
        diskGone: !onDisk(before!.rel_path),
        diskNew: onDisk(after?.rel_path ?? ''),
        fileInTarget: readdirSync(abs('对照/目标')).sort(),
        notice: await js(`document.querySelector('.notice-toast')?.textContent.trim() ?? null`),
        selectedAfter: await js(`document.querySelectorAll('.card.selected').length`),
        ghostGone: !(await js(`!!document.querySelector('.drag-ghost')`)),
        bodyClassGone: !(await js(`document.body.classList.contains('drag-moving')`))
      }
    }

    // J2 拖回素材原本所在的文件夹：无效落点，不该有任何变化
    const c1 = await cardXY(1)
    const treeRow = await rowAt('对照/树A')
    if (c1 && treeRow) {
      const before = assetRow(c1.id)
      await dragBetween(c1, { x: treeRow.cx, y: treeRow.cy }, { midway: async () => { R.j2_midway = await dragSnapshot() } })
      const after = assetRow(c1.id)
      R.j2_noop = {
        relUnchanged: before?.rel_path === after?.rel_path,
        stillOnDisk: onDisk(before!.rel_path),
        movedInto: readdirSync(abs('对照/目标')).sort()
      }
    }

    // J3 Ctrl + 拖动仍是框选（不能变成移动）
    const goalRow2 = await rowAt('对照/目标')
    if (c1 && goalRow2) {
      const before = assetRow(c1.id)
      await dragBetween(c1, { x: goalRow2.cx, y: goalRow2.cy }, { ctrl: true, midway: async () => { R.j3_midway = await dragSnapshot() } })
      R.j3_ctrlStillBand = {
        relUnchanged: before?.rel_path === assetRow(c1.id)?.rel_path,
        stillOnDisk: onDisk(before!.rel_path),
        filesInTarget: readdirSync(abs('对照/目标')).sort()
      }
    }

    // J4 先清空选择，再 Ctrl 点选两张，然后拖其中一张 → 整批一起走
    const cards4 = await js(`[...document.querySelectorAll('.masonry-card')].slice(0, 3).map(c => {
      const r = c.getBoundingClientRect(); return { id: Number(c.dataset.id), x: r.left + r.width / 2, y: r.top + Math.min(26, r.height / 2) }
    })`)
    const list4 = ((cards4 ?? []) as Array<{ id: number; x: number; y: number }>).slice(0, 2)
    const goalRow3 = await rowAt('对照/目标')
    if (list4.length >= 2 && goalRow3) {
      // 上一轮 Ctrl 框选留下的选中会干扰下面的 Ctrl 点选（toggle 语义），先用 Esc 清干净
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await sleep(400)
      for (const c of list4) {
        win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(c.x), y: Math.round(c.y), modifiers: ['control'] })
        win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(c.x), y: Math.round(c.y), button: 'left', clickCount: 1, modifiers: ['control'] })
        win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(c.x), y: Math.round(c.y), button: 'left', clickCount: 1, modifiers: ['control'] })
        await sleep(320)
      }
      R.j4_selectedBefore = await js(`document.querySelectorAll('.card.selected').length`)
      const beforeRels = list4.map((c) => assetRow(c.id)?.rel_path)
      await dragBetween(list4[0], { x: goalRow3.cx, y: goalRow3.cy }, { midway: async () => { R.j4_midway = await dragSnapshot() } })
      const afterRels = list4.map((c) => assetRow(c.id)?.rel_path)
      R.j4_batch = {
        movedCount: afterRels.filter((r, i) => r && r !== beforeRels[i]).length,
        allInTarget: afterRels.every((r) => (r ?? '').startsWith('对照/目标/')),
        filesInTarget: readdirSync(abs('对照/目标')).sort(),
        notice: await js(`document.querySelector('.notice-toast')?.textContent.trim() ?? null`)
      }
    }
    await capture('shot-folder-done.png')


    const a = R.a_create as { disk: boolean[]; parentChain: boolean[]; rows: string[] }
    const b = R.b_negative as Record<string, string>
    const c = R.c_import as { added: number[]; relPaths: string[]; tagLinks: number }
    const d = R.d_thumbs as { assets: number; cacheDirs: number; gridOk: boolean; detailOk: boolean }
    const df = R.d_files as { grid: number; detail: number }
    const e = R.e_renameTop as {
      oldGone: boolean; newTree: boolean[]; folderPaths: string[]; assetRels: string[]
      filesInMid: string[]; filesInLeaf: string[]; thumbsStillThere: number; childParentOk: boolean
    }
    const f2r = R.f_renameMid as { folderPaths: string[]; assetRels: string[]; grandOk: boolean; oldMidGone: boolean }
    const g = R.g_delete as {
      diskGone: boolean; foldersLeft: string[]; assetsLeft: string[]; orphanTagLinks: number
      tagsLeft: number; thumbsBeforeDelete: number; thumbsLeft: number; siblingIntact: boolean
    }
    const h1 = R.h1_result as { rowsAfter: string[]; onDiskAfter: boolean; dbPaths: string[] }
    const h2 = R.h2_result as { rowsAfter: string[]; oldGone: boolean; newOnDisk: boolean; dbPaths: string[] }
    const h3 = R.h3_result as {
      rowsAfter: string[]; diskGone: boolean; parentIntact: boolean; dbPaths: string[]; activeAfter: string | null
    }
    const h3modal = R.h3_modal as { title: string; body: string } | null
    const h3ctx = R.h3_ctxMode as string
    const h2pre = R.h2_prefilled as string | null

    const iCollapse = R.i_afterCollapse as { rows: string[]; foldedClass: boolean; saved: string[] }
    const iReload = R.i_afterReload as { rows: string[]; saved: string[] }
    const iExpand = R.i_afterExpand as { rows: string[]; foldedClass: boolean; saved: string[] }
    const j1m = (R.j1_midway ?? {}) as { ghost?: boolean; dropOn?: string[]; dimmed?: number }
    const j1 = R.j1_drop as {
      beforeRel?: string; afterRel?: string; diskGone?: boolean; diskNew?: boolean
      ghostGone?: boolean; bodyClassGone?: boolean; selectedAfter?: number; notice?: string | null
    } | undefined
    const j2m = (R.j2_midway ?? {}) as { dropOn?: string[] }
    const j2 = R.j2_noop as { relUnchanged?: boolean; stillOnDisk?: boolean } | undefined
    const j3m = (R.j3_midway ?? {}) as { marquee?: boolean; ghost?: boolean }
    const j3 = R.j3_ctrlStillBand as { relUnchanged?: boolean; stillOnDisk?: boolean } | undefined
    const j4 = R.j4_batch as { movedCount?: number; allInTarget?: boolean } | undefined

    R.checks = {
      // A 多级新建
      deepCreate: a?.disk?.every(Boolean) === true && a.parentChain?.every(Boolean) === true && a.rows.length === 4,
      // B 负例全部被拦（返回的不是 NO_ERROR）
      negativesRejected: Object.values(b ?? {}).every((x) => x !== 'NO_ERROR'),
      protectedFolder: (b?.protectedDir ?? '').includes('ERR_PROTECTED_FOLDER'),
      // C 导入与标签关联
      importedDeep: c?.added?.[0] === 2 && c?.added?.[1] === 2 && c.tagLinks === 1,
      // D 缩略图缓存真的落盘了（否则 G 的回收验证没有意义）；
      // 同时覆盖 thumbs.ts 的批次进度：两批（grid/detail）各自独立完成，onDone 都要触发
      thumbsGenerated: d?.assets === 4 && d.cacheDirs === 4 && df?.grid === 4 && df?.detail === 4 &&
        d.gridOk === true && d.detailOk === true,
      // E 重命名顶层：子树 path / rel_path / 物理文件全部同步
      renameTop: e?.oldGone === true && e.newTree.every(Boolean) && e.childParentOk === true &&
        e.folderPaths.join('|') === '对照|已重命名|已重命名/二级|已重命名/二级/三级' &&
        e.assetRels.every((r) => r.startsWith('已重命名/')) &&
        // 中层目录里应有 2 个素材 + 子目录「三级」
        e.filesInMid.join('|') === 'img-0.png|img-1.png|三级' &&
        e.filesInLeaf.join('|') === 'img-2.png|img-3.png' &&
        e.thumbsStillThere === 4,
      // F 重命名中间层：子孙跟着改
      renameMid: f2r?.grandOk === true && f2r.oldMidGone === true &&
        f2r.folderPaths.join('|') === '对照|已重命名|已重命名/中层改名|已重命名/中层改名/三级' &&
        f2r.assetRels.every((r) => r.startsWith('已重命名/中层改名/')),
      // G 物理删除整棵 + 索引与缓存都清干净，且不碰对照组
      deleteWholeTree: g?.diskGone === true && g.siblingIntact === true &&
        g.foldersLeft.join('|') === '对照' && g.assetsLeft.length === 0 &&
        g.orphanTagLinks === 0 && g.tagsLeft === 1 &&
        g.thumbsBeforeDelete === 4 && g.thumbsLeft === 0,
      // H UI：菜单 / 新建子级 / 重命名 / 删除
      uiMenu: R.h1_menuItems !== null &&
        (R.h1_menuItems as string[]).join('|') === '新建子文件夹|重命名|删除文件夹',
      uiCreateChild: h1?.onDiskAfter === true && h1.dbPaths.includes('对照/sub-a') && h1.rowsAfter.includes('对照/sub-a'),
      uiRenamePrefilled: h2pre === 'sub-a',
      uiRename: h2?.oldGone === true && h2.newOnDisk === true &&
        h2.dbPaths.includes('对照/sub-b') && !h2.dbPaths.includes('对照/sub-a') && h2.rowsAfter.includes('对照/sub-b'),
      uiDeleteConfirm: !!h3modal && /没有回收站/.test(h3modal.body),
      // 删除的文件夹正是当前筛选目标 → 筛选应自动回到「所有素材」（activeKey 返回 'ALL'）
      uiDeleteWasFiltered: R.h3_selectedBefore === '对照/sub-b',
      uiDelete: h3?.diskGone === true && h3.parentIntact === true &&
        h3.dbPaths.join('|') === '对照' && !h3.rowsAfter.includes('对照/sub-b') &&
        h3.activeAfter === 'ALL',
      // 右键菜单真的出现了（记录走的是真实右键还是 fallback）
      ctxMenuOpened: h3ctx === 'real' || h3ctx === 'dispatch',

      // I 折叠：后代行消失、箭头转向、状态落进 localStorage（按库隔离）
      collapseHidesDescendants: iCollapse?.rows.includes('对照/树A') === true &&
        !iCollapse.rows.includes('对照/树A/树B') && iCollapse.foldedClass === true &&
        iCollapse.saved.includes('对照/树A'),
      // 折叠状态要跨重启保留
      collapsePersists: iReload?.rows.includes('对照/树A') === true &&
        !iReload.rows.includes('对照/树A/树B') && iReload.saved.includes('对照/树A'),
      collapseExpands: iExpand?.rows.includes('对照/树A/树B') === true &&
        iExpand.foldedClass === false && !iExpand.saved.includes('对照/树A'),

      // J1 拖拽移动：物理文件与索引一起搬到目标文件夹（提示里带的是文件夹名，不是完整路径）
      dragMove: !!j1 && j1.diskGone === true && j1.diskNew === true &&
        (j1.afterRel ?? '').startsWith('对照/目标/') && j1.notice?.includes('目标') === true,
      // 拖动过程中的即时反馈：ghost 跟手、落点行高亮、被拖卡片压暗
      dragFeedback: j1m.ghost === true && j1m.dropOn?.includes('对照/目标') === true && (j1m.dimmed ?? 0) >= 1,
      // 松手后 ghost 与 body 状态都要收干净，否则会一直留在界面上
      dragCleansUp: j1?.ghostGone === true && j1?.bodyClassGone === true && j1?.selectedAfter === 0,
      // J2 拖回素材原本所在的文件夹 = 无效落点：不高亮、不搬动
      dragNoopOnOrigin: j2?.relUnchanged === true && j2.stillOnDisk === true && (j2m.dropOn ?? []).length === 0,
      // J3 Ctrl + 拖动仍然是框选，不能退化成移动
      ctrlDragStillBand: j3m.marquee === true && j3m.ghost !== true &&
        j3?.relUnchanged === true && j3?.stillOnDisk === true,
      // J4 拖动已多选中的一张 → 整批一起走
      dragBatch: j4?.allInTarget === true && (j4?.movedCount ?? 0) >= 1
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
    console.log('[SMOKE-FOLDER] ' + JSON.stringify(R))
    app.exit(0)
  }
}
