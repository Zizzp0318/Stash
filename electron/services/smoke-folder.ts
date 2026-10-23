// 文件夹管理冒烟：多级新建 / 重命名（子树 path 与 assets.rel_path 同步）/ 物理删除（不进回收站）
// 前半段直接调服务层核对磁盘与数据库，后半段用真实鼠标/键盘事件驱动侧栏右键菜单走一遍 UI。
// 末尾 M 段是「重命名一个**正在被我们自己预览**的文件夹」（用户报的「一级文件夹改不了名」的原形）：
// 必须先把 preview 的读流放掉，否则 Windows 上 rename(目录) 恒 EPERM。
import { app, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { spawn } from 'child_process'
import { randomFillSync } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import {
  closeCurrent, createLibrary, deleteFolder, forgetLibrary, mkdirChild, openLibrary, renameFolder, requireCurrent
} from './library'
import { createTag, setTags } from './assets'
import { importFiles } from './importer'
import { ensureBatch, ensureThumb, pumpState } from './thumbs'
import { renameWithRetry } from './fsutil'
import {
  __testForceNullFolderId, isWatching, reconcileLibrary, suspendWatchingAsync, unwatchLibrary, watchLibrary,
  watchedDirCount, whenWatcherReady
} from './watcher'
import {
  __testAddUnclosableStream, activeMediaStreamCount, clearMediaSuppression, mediaSuppressionActivations,
  releaseMediaUnderAsync, serveMedia, suppressMediaUnder
} from './preview'
import { lastRenameIsolation, watcherActive, watcherSuspensions } from './handles'
import { makeWaitUntil, type InputModifiers } from './smoke-util'

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
  /** 有界轮询（G4）：共享实现见 smoke-util.ts —— 超时返回 false，调用方必须把结果并入断言/诊断 */
  const waitUntil = makeWaitUntil(js)

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
  /** readdir 的安全版：目录不存在/被占用时返回空数组（诊断探针用） */
  const readdirSyncSafely = (p: string): string[] => {
    try {
      return readdirSync(p).sort()
    } catch {
      return []
    }
  }
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
  /**
   * 同 `nah`，但接受**异步**操作（`deleteFolder` 现在是 async：错误在 Promise 里，
   * 用同步版 `nah` 会得到 `NO_ERROR` —— 那会让 B 段「隐藏目录受保护」变成假绿）。
   */
  const nahAsync = async (fn: () => Promise<unknown>): Promise<string> => {
    try {
      await fn()
      return 'NO_ERROR'
    } catch (e) {
      return String((e as Error).message ?? e)
    }
  }
  const step = (s: string): void => console.log('[SMOKE-FOLDER-STEP] ' + s)
  const importTo = (paths: string[], folderId: number): Promise<{ added: number }> =>
    new Promise((resolve) => importFiles({ paths, folderId, mode: 'copy', onDone: (x) => resolve(x) }))

  /** 造一张**内容唯一**的小 PNG（每张色彩/尺寸都不同 → content_hash 不同，不会被导入去重） */
  const makePng = async (seed: number): Promise<Buffer> =>
    sharp({
      create: {
        width: 24 + (seed % 5),
        height: 24,
        channels: 3,
        background: { r: (seed * 23) % 256, g: (seed * 47) % 256, b: (seed * 91) % 256 }
      }
    }).png().toBuffer()

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
      protectedDir: await nahAsync(() => deleteFolder(Number(thumbsId)))
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
    const renamed = await renameFolder(f1.id, '已重命名')
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
    const ren2 = await renameFolder(byPath('已重命名/二级')!.id, '中层改名')
    R.f_renameMid = {
      result: ren2,
      folderPaths: folderPaths(),
      assetRels: assetRels(),
      grandOk: onDisk('已重命名/中层改名/三级'),
      oldMidGone: !onDisk('已重命名/二级')
    }

    // ==================== G. 删除整棵子树：物理删除 + 索引清理 + 缓存回收 ====================
    //
    // ⚠️ QA 第四轮点出这里以前是**假绿**：G 紧接 F 段改名之后「零等待」就删，而那一刻
    // 根本没有监听器（冒烟从没启过），删含子目录的目录当然成功。
    // 现在**先真起监听器并等 ready**，让这条断言真的覆盖「watcher 在场时删含子目录的文件夹」——
    // 那正是会抛 ENOTEMPTY 且文件已被删光（无回收站）的高危场景。
    step("G")
    watchLibrary(libPath, D())
    const gReady = await whenWatcherReady(15000)
    const suspBeforeG = watcherSuspensions()
    const thumbsBeforeDelete = thumbDirsOnDisk()
    // ⚠️ 自己 catch：不隔离时 rmSync 会抛 ENOTEMPTY（且文件已被删光）。
    // 让异常冒到最外层的话，整轮只剩一个 `R.error`、所有具名断言消失 —— 那不是可归档的红。
    let del: Awaited<ReturnType<typeof deleteFolder>> | null = null
    let delErr: string | null = null
    try {
      del = await deleteFolder(byPath('已重命名')!.id)
    } catch (e) {
      delErr = String((e as Error).message ?? e)
    }
    R.g_delete = {
      delErr,
      // 数据丢失探针：报错但文件已经没了（= 用户看到的「点了删除，图没了」）
      filesAlreadyGone: delErr !== null && readdirSyncSafely(abs('已重命名/中层改名/三级')).length === 0,
      watcherReady: gReady,
      suspDelta: watcherSuspensions() - suspBeforeG,
      watchingAfter: isWatching(),
      // 「半状态」探针：文件没了但空目录还在（rmSync 中途抛 ENOTEMPTY 的痕迹）
      leftoverDirs: ['已重命名', '已重命名/中层改名', '已重命名/中层改名/三级'].filter((p) => onDisk(p)),
      result: del,
      diskGone: !onDisk('已重命名'),
      foldersLeft: folderPaths(),
      assetsLeft: assetRels(),
      // 标签关联靠外键 CASCADE 自动清；标签本体若因此一个素材都不剩，会被自动清理
      orphanTagLinks: (D().prepare('SELECT count(*) AS c FROM asset_tags').get() as { c: number }).c,
      tagsLeft: (D().prepare('SELECT count(*) AS c FROM tags').get() as { c: number }).c,
      // 自动清理掉的标签名 —— 唯一那个标签挂在被删的素材上，应当随素材一起消失
      prunedTags: (del?.pruned ?? []).map((p) => p.name),
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
      const m: InputModifiers = []
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
      opts: { ctrl?: boolean; midway?: () => Promise<unknown>; feedback?: string } = {}
    ): Promise<boolean> => {
      const downMods: InputModifiers = opts.ctrl ? ['control'] : []
      const moveMods: InputModifiers = opts.ctrl ? ['leftbuttondown', 'control'] : ['leftbuttondown']
      const at = (t: number): { x: number; y: number } => ({
        x: Math.round(from.x + (to.x - from.x) * t),
        y: Math.round(from.y + (to.y - from.y) * t)
      })
      const p0 = at(0)
      win.webContents.sendInputEvent({ type: 'mouseMove', x: p0.x, y: p0.y, modifiers: downMods })
      win.webContents.sendInputEvent({ type: 'mouseDown', x: p0.x, y: p0.y, button: 'left', clickCount: 1, modifiers: downMods })
      await sleep(90)
      // ⚠️ 循环里的这些 sleep 是**模拟真实鼠标移动的定速节奏**（拖拽识别靠连续 mousemove），
      // 属于「模拟输入节奏」而不是「等状态」—— 保留，删了反而会让拖拽识别不到。
      for (const t of [0.15, 0.35, 0.6, 0.85, 1]) {
        const p = at(t)
        win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y, modifiers: moveMods })
        await sleep(80)
      }
      // 松手前：原来固定 sleep(160) 等「拖动反馈渲染出来」—— 机器一忙反馈还没出，midway() 就抓了空快照
      // → dragFeedback 偶发红（G12）。改成有界轮询「拖动反馈真的出现在 DOM 里」再调 midway()。
      // 通用条件 = 「ghost 或 marquee 出现」二者之一：
      //   · 不能固定等 ghost —— J3 是 Ctrl 框选，按设计就没有 ghost；
      //   · 不能固定等落点行高亮 —— J2 的落点是无效目标，按设计就不高亮。
      // J1 另外传入更严的 feedback（要求目标行同时高亮）。返回值由调用方并入断言/诊断，别丢（G11）。
      const feedbackOk = await waitUntil(
        opts.feedback ?? 'document.querySelector(".drag-ghost") || document.querySelector(".marquee")',
        3000
      )
      if (opts.midway) await opts.midway()
      const pEnd = at(1)
      win.webContents.sendInputEvent({ type: 'mouseUp', x: pEnd.x, y: pEnd.y, button: 'left', clickCount: 1 })
      await sleep(1500)
      return feedbackOk
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
      R.j1_feedbackReady = await dragBetween(c0, { x: goalRow.cx, y: goalRow.cy }, {
        // J1 的反馈要更严：拖到**有效**落点时，目标行必须同时高亮出来再抓快照
        feedback:
          '!!document.querySelector(".drag-ghost") && [...document.querySelectorAll(".side-item.drop-on")].some((x) => (x.dataset.folderPath || "").includes("对照/目标"))',
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
      R.j2_feedbackReady = await dragBetween(c1, { x: treeRow.cx, y: treeRow.cy }, { midway: async () => { R.j2_midway = await dragSnapshot() } })
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
      R.j3_feedbackReady = await dragBetween(c1, { x: goalRow2.cx, y: goalRow2.cy }, { ctrl: true, midway: async () => { R.j3_midway = await dragSnapshot() } })
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
      await dragBetween(list4[0], { x: goalRow3.cx, y: goalRow3.cy }, { midway: async () => { R.j4_midway = await dragSnapshot() } }).then(
        (fb) => { R.j4_feedbackReady = fb }
      )
      const afterRels = list4.map((c) => assetRow(c.id)?.rel_path)
      R.j4_batch = {
        movedCount: afterRels.filter((r, i) => r && r !== beforeRels[i]).length,
        allInTarget: afterRels.every((r) => (r ?? '').startsWith('对照/目标/')),
        filesInTarget: readdirSync(abs('对照/目标')).sort(),
        notice: await js(`document.querySelector('.notice-toast')?.textContent.trim() ?? null`)
      }
    }
    await capture('shot-folder-done.png')

    // ==================== K. 侧栏计数与列表口径：都含整棵子树 ====================
    // 素材全在「对照」的子目录里，所以「对照」直属 0、子树 >0 —— 两种口径必然不同，
    // 只断言「侧栏 == 某个数」在两边都是 0 时是恒真的假绿，必须同时验证两种口径不相等。
    step('K')
    await sleep(700)

    /** 侧栏每个文件夹行显示的计数（fmtCount 用空格做千分位，去掉再转数字） */
    const sidebarCounts = async (): Promise<Record<string, number>> =>
      ((await js(`(() => {
        const out = {}
        for (const el of document.querySelectorAll('.side-item[data-folder-path]')) {
          const raw = el.querySelector('.n')?.textContent ?? ''
          out[el.dataset.folderPath] = Number(String(raw).replace(/\\s/g, '')) || 0
        }
        return out
      })()`)) as Record<string, number> | null) ?? {}

    const kFolders = folderRows()
    const kIdToPath = new Map(kFolders.map((f) => [f.id, f.path]))
    /** 后端直属计数：path → count（与 `folder_id = ?` 筛选同源；无素材的文件夹补 0） */
    const directByPath = (): Record<string, number> => {
      const rows = D()
        .prepare('SELECT folder_id, count(*) AS c FROM assets WHERE folder_id IS NOT NULL GROUP BY folder_id')
        .all() as Array<{ folder_id: number; c: number }>
      // SQL 只会返回「有素材」的分组；侧栏却每个文件夹都有数字，
      // 不补 0 的话对比时会拿 undefined 去比 0，断言假红
      const out: Record<string, number> = {}
      for (const f of kFolders) out[f.path] = 0
      for (const r of rows) {
        const p = kIdToPath.get(r.folder_id)
        if (p) out[p] = r.c
      }
      return out
    }
    const kDirect = directByPath()
    /** 期望值（新口径）：自身 + 所有路径前缀子目录 —— 与后端 `folderDeep` 一致 */
    const subtreeOf = (p: string): number => {
      let n = kDirect[p] ?? 0
      for (const f of kFolders) if (f.path.startsWith(p + '/')) n += kDirect[f.path] ?? 0
      return n
    }
    const kSubtree: Record<string, number> = {}
    for (const f of kFolders) kSubtree[f.path] = subtreeOf(f.path)

    R.k_ui = await sidebarCounts()
    R.k_backend = kSubtree
    R.k_directOnly = kDirect
    R.k_mismatch = Object.entries(R.k_ui as Record<string, number>)
      .filter(([p, n]) => (kSubtree[p] ?? 0) !== n)
      .map(([p, n]) => `${p}: 侧栏${n} != 子树${kSubtree[p] ?? 0}`)
    R.k_treeDiff = { direct: kDirect['对照'] ?? 0, subtree: subtreeOf('对照') }
    step(`K direct=${JSON.stringify(kDirect)} subtree=${JSON.stringify(kSubtree)} ui=${JSON.stringify(R.k_ui)} mismatch=${JSON.stringify(R.k_mismatch)}`)

    // ==================== K2. 点文件夹 → 列表含整棵子树的素材 ====================
    const cardIds = async (): Promise<number[]> =>
      ((await js(`[...document.querySelectorAll('.masonry-card')].map(c => Number(c.dataset.id)).sort((a, b) => a - b)`)) as
        | number[]
        | null) ?? []
    /** DB 里落在某目录（含其子孙目录）下的素材 id —— 与后端按 rel_path 前缀取子树的判定同源 */
    const dbIdsUnder = (p: string): number[] =>
      (D().prepare('SELECT id, rel_path FROM assets ORDER BY id').all() as Array<{ id: number; rel_path: string }>)
        .filter((a) => a.rel_path === p || a.rel_path.startsWith(p + '/'))
        .map((a) => a.id)
        .sort((a, b) => a - b)
    /** 目录（含子孙）+ 文件名包含关键词的素材数 —— 用来核对「X / 共 Y 个匹配」的分子 */
    const dbMatchesUnder = (p: string, kw: string): number =>
      (D().prepare('SELECT name, rel_path FROM assets').all() as Array<{ name: string; rel_path: string }>)
        .filter((a) => (a.rel_path === p || a.rel_path.startsWith(p + '/')) && a.name.includes(kw)).length
    /** 把「12 个文件」/「3 / 共 12 个匹配」解析成数字 */
    const parseTotal = (raw: string | null): { shown: number[] } => ({
      shown: [...String(raw ?? '').matchAll(/(\d+)/g)].map((m) => Number(m[1]))
    })

    const clickRow = async (path: string): Promise<boolean> => {
      const r = await rowAt(path)
      if (!r) return false
      await clickAt({ x: r.cx, y: r.cy })
      await sleep(900)
      return true
    }

    // ① 点父文件夹「对照」：列表里要出现子目录里的素材（递归），数量与侧栏数字一致
    const kParentClicked = await clickRow('对照')
    R.k2_parent = {
      clicked: kParentClicked,
      active: await activeKey(),
      cards: await cardIds(),
      expect: dbIdsUnder('对照'),
      // 侧栏数字要从 **DOM** 采（不是拿测试端的计算值），否则「数字 == 卡片数」会变成自证
      sidebarUi: (await sidebarCounts())['对照'] ?? -1,
      direct: kDirect['对照'] ?? 0,
      treeTotal: kSubtree['对照'] ?? -1,
      total: parseTotal((await js(`document.querySelector('.toolbar .total')?.textContent.trim() ?? null`)) as string | null),
      totalText: await js(`document.querySelector('.toolbar .total')?.textContent.trim() ?? null`)
    }
    await capture('shot-folder-recursive.png')

    // ② 叠一个关键词筛选：分母必须是**子树**数（旧口径会显示「X / 共 0」）
    await js(`(() => { const i = document.querySelector('.search-input'); if (i) { i.focus(); i.select() } })()`)
    await sleep(150)
    win.webContents.insertText('png')
    await sleep(900)
    R.k2_filter = {
      totalText: await js(`document.querySelector('.toolbar .total')?.textContent.trim() ?? null`),
      parsed: parseTotal((await js(`document.querySelector('.toolbar .total')?.textContent.trim() ?? null`)) as string | null),
      numerator: dbMatchesUnder('对照', 'png'),
      denominator: kSubtree['对照'] ?? 0
    }
    await js(`(() => { const c = document.querySelector('.search-clear'); if (c) c.click() })()`)
    await sleep(800)

    // ③ 再点一个**叶子**子文件夹：递归不能退化成一味显示全部
    const kLeafPath = '对照/目标'
    const kLeafClicked = await clickRow(kLeafPath)
    R.k2_leaf = {
      clicked: kLeafClicked,
      active: await activeKey(),
      cards: await cardIds(),
      expect: dbIdsUnder(kLeafPath),
      parentExpect: dbIdsUnder('对照')
    }
    await capture('shot-folder-leaf.png')
    step(`K2 parent=${JSON.stringify(R.k2_parent)} filter=${JSON.stringify(R.k2_filter)} leaf=${JSON.stringify(R.k2_leaf)}`)

    // ==================== L. 重命名重试助手（缺陷 1）====================
    // 用**可注入的假 renameFn** 确定性造 EPERM（真实占用无法确定性复现，铁律 G13/G11）：
    //   ① 前两次抛 EPERM、第三次成功 → 断言最终成功**且只尝试了 3 次**
    //   ② 始终抛 EPERM → 断言抛 ERR_FOLDER_BUSY**且尝试次数 == 上限**
    //   ③ EXDEV（非瞬时）→ 断言**立即抛、只尝试 1 次**（不会白等）
    // 删掉重试逻辑后：① 会抛出 EPERM（threw 非空）、② 的尝试次数会变成 1 → 三条全红。
    step('L')
    {
      const eperm = (): never => {
        const e = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException
        e.code = 'EPERM'
        throw e
      }
      let callsA = 0
      let threwA: string | null = null
      try {
        await renameWithRetry('a', 'b', {
          attempts: 6, delays: [0, 0, 0, 0, 0],
          renameFn: () => { callsA++; if (callsA < 3) eperm() }
        })
      } catch (e) { threwA = String((e as Error).message ?? e) }
      let callsB = 0
      let threwB: string | null = null
      try {
        await renameWithRetry('a', 'b', { attempts: 4, delays: [0, 0, 0], renameFn: () => { callsB++; eperm() } })
      } catch (e) { threwB = String((e as Error).message ?? e) }
      let callsC = 0
      let threwC: string | null = null
      try {
        await renameWithRetry('a', 'b', {
          attempts: 4, delays: [0, 0, 0],
          renameFn: () => { callsC++; const e = new Error('EXDEV: cross-device link') as NodeJS.ErrnoException; e.code = 'EXDEV'; throw e }
        })
      } catch (e) { threwC = String((e as Error).message ?? e) }
      R.l_retry = { callsA, threwA, callsB, threwB, callsC, threwC }
      step(`L retry=${JSON.stringify(R.l_retry)}`)
    }

    // ==================== M. 重命名「正在被我们预览」的文件夹（本工单的 bug 形态）====================
    // 用户报的现象：一级文件夹一直改不了名，弹「该文件夹正被占用…请稍后重试」。
    // 根因是**我们自己**：详情栏默认展开，选中素材就有一个 `createReadStream(原文件)` 开着
    // （`stash://media/{id}` → preview.streamBody），Windows 上目录内任一文件被打开 → rename EPERM。
    //
    // 这条断言必须**端到端**，而且要真的把流开在盘上（不能 mock）：
    //   ① 造一个几 MB 的图（小文件一次就读完了，句柄会自己关掉 → 断言会变成空转）；
    //   ② 走真正的 `serveMedia()` 拿 Response，`getReader()` 读一块**就停**（背压把流挂在盘上）；
    //   ③ 前置断言「此刻登记表里确实有 ≥1 个活跃流」—— 否则后面的「释放成 0」是拿 0 比 0（G11）；
    //   ④ `await renameFolder(...)`，断言改名成功 + 磁盘换成新名 + 索引同步；
    //   ⑤ 断言流真的被销毁（登记表 0 + 读者只能拿到 done/错误），而不是「恰好自己跑完了」。
    // 注入验证：把 `library.renameFolder` 里的释放那两行去掉 → 这条必红（rename 会耗尽重试抛
    // ERR_FOLDER_BUSY，整个套件 catch 到 R.error），实测记录见 `.workbuddy/audit/`。
    step('M')
    {
      /**
       * 整段包在 60s 总闸门里：**冒烟绝不允许因为被测链路卡死而"无结论地"挂死**（G4）。
       * 实测（注入验证：去掉 library 里的释放/抑制）时，第 5 次 `serveMedia` 会长时间不返回 ——
       * 那不是产品的错，但那会让整轮只留下一个超时退出码。加了闸门之后，同样的注入态会
       * 稳定表现为「renameError=ERR_FOLDER_BUSY → renameWhilePreviewing 红 + ok=false」，可读可归档。
       */
      const mBody = async (): Promise<Record<string, unknown>> => {
        // 抑制窗口的机制自检（先做，避免与下面那条长驻流互相干扰）：
        // 窗口内必须拒（409），窗口过期后必须恢复（200）——「窗口永不失效」会让预览永久黑屏。
        const mFolder = mkdirChild('', '预览中改名')
        const mAbs = abs('预览中改名')
        // 箭头函数里 `dir`（外层 `string | null`）的收窄会丢，这里显式取一次并断言
        const workDir = dir
        if (!workDir) throw new Error('M 段需要临时目录')
        const bigDir = join(workDir, 'bigsrc')
        mkdirSync(bigDir, { recursive: true })
        const BIG = 'big.png'
        const bigPath = join(bigDir, BIG)
        {
          // 随机像素 → PNG 压不动 → 几 MB，保证一次 read 读不完
          const w = 1400
          const h = 1400
          const raw = Buffer.alloc(w * h * 3)
          randomFillSync(raw)
          await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toFile(bigPath)
        }
        await importTo([bigPath], mFolder.id)
        const mId = (D().prepare('SELECT id FROM assets WHERE folder_id=?').get(mFolder.id) as { id: number }).id
        const mRelBefore = (D().prepare('SELECT rel_path FROM assets WHERE id=?').get(mId) as { rel_path: string }).rel_path

        // —— D2 用：**另一个子树**里也放一个素材。改名 A 之后 B 的流必须还活着 ——
        // 一条断言同时锁两件事：① 释放按子树收敛（不是「释放全部」）；② `renameFolder` 不误伤无关素材的播放。
        const bFolder = mkdirChild('', '旁观者')
        const bAbs = abs('旁观者')
        const big2Path = join(bigDir, 'big2.png')
        {
          const w = 900
          const h = 900
          const raw = Buffer.alloc(w * h * 3)
          randomFillSync(raw)
          await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toFile(big2Path)
        }
        await importTo([big2Path], bFolder.id)
        const bId = (D().prepare('SELECT id FROM assets WHERE folder_id=?').get(bFolder.id) as { id: number }).id
        const serveB = async (): Promise<Response> => serveMedia(new Request(`stash://media/${bId}`), String(bId))
        const serveThis = async (): Promise<Response> => serveMedia(new Request(`stash://media/${mId}`), String(mId))
        /**
         * 有界地取一次状态码并立刻 cancel 掉响应体。
         * ⚠️ 每个 await 都要有界（G4）：注入验证（去掉释放）时「流还开着」这种态下，
         * `serveMedia` 的某一步会长时间不返回 —— 那会让整轮冒烟**无结论地挂死**，
         * 而我们要的是「这条断言变红」。5s 上限对本地文件服务足够宽松。
         */
        const serveStatus = async (): Promise<number | null> => {
          const r = await Promise.race([serveThis(), sleep(5000).then(() => null)])
          if (!r) return null
          await Promise.race([(r.body?.cancel() ?? Promise.resolve()).catch(() => undefined), sleep(2000)])
          return r.status
        }

        // —— ① 抑制窗口：开 → 409 → 过期 → 200 ——
        suppressMediaUnder(mAbs, 300)
        const blockedStatus = await serveStatus()
        await sleep(450) // 等窗口自动过期（G4：这里是在测「过期」这个时间语义，不是等状态）
        const afterExpireStatus = await serveStatus()
        clearMediaSuppression() // 万一上面的等待不够，别把抑制带进后面的真实改名

        // —— ② 把流真的打开并读一块（不读完 → 句柄挂在盘上）——
        const resp = await Promise.race([serveThis(), sleep(5000).then(() => null)])
        const reader = resp?.body?.getReader() ?? null
        const firstChunk = reader ? await Promise.race([reader.read(), sleep(5000).then(() => null)]) : null
        // 首块字节数也是判据：> 0 才说明「字节真的从磁盘流出来了」（句柄确实开着），
        // 否则「登记表里有一条」可能只是个还没读到数据的空壳。
        const firstBytes = firstChunk?.value?.byteLength ?? 0
        const openBefore = activeMediaStreamCount(mAbs)
        // —— D2：B 子树也开一条流（读一块后停住，句柄挂在盘上）——
        const respB = await Promise.race([serveB(), sleep(5000).then(() => null)])
        const readerB = respB?.body?.getReader() ?? null
        const firstChunkB = readerB ? await Promise.race([readerB.read(), sleep(5000).then(() => null)]) : null
        const bystanderOpenBefore = activeMediaStreamCount(bAbs)
        const bystanderFirstBytes = firstChunkB?.value?.byteLength ?? 0

        const suppressBefore = mediaSuppressionActivations()
        const tRename = Date.now()
        step(`M-stream open before=${openBefore} firstBytes=${firstBytes} bystander=${bystanderOpenBefore}/${bystanderFirstBytes}`)

        // —— ③ 前置：此刻必须有活跃流，否则后面的「释放为 0」是 0===0 的空转 ——
        // 这里**自己 catch** 而不是让异常冒到最外层：让「改名失败」表现为一条具名断言为红
        // （带 ERR_FOLDER_BUSY 原文），而不是整轮只有一个 R.error。
        let renamedM: { id: number; path: string; folders: number; assets: number } | null = null
        let renameError: string | null = null
        // 15s 护栏：renameWithRetry 的预算 ≈3.3s，再长就说明卡住了 ——
        // 冒烟**绝不允许**因为被测链路卡死而整轮无结论地挂着（G4 有界）。
        const renamed = await Promise.race([
          renameFolder(mFolder.id, '已改名').then(
            (r) => ({ r, e: null as string | null }),
            (e) => ({ r: null, e: String((e as Error).message ?? e) })
          ),
          sleep(15000).then(() => ({ r: null, e: 'TIMEOUT' }))
        ])
        renamedM = renamed.r
        renameError = renamed.e
        const renameMs = Date.now() - tRename
        const suppressDelta = mediaSuppressionActivations() - suppressBefore
        step(`M-rename 完成：error=${renameError ?? 'null'} ms=${renameMs} suppressDelta=${suppressDelta}`)
        const openAfter = activeMediaStreamCount(abs('已改名'))
        // 同时数旧路径：改名**失败**时目录还叫旧名，只数新路径会恒为 0（那会让这条判据失去鉴别力）。
        const openAfterOld = activeMediaStreamCount(mAbs)

        // —— D2：B 子树的流必须还活着（计数 + 真的还能读出字节）——
        const bystanderAfter = activeMediaStreamCount(bAbs)
        let bystanderReadAlive = false
        let bystanderRead = 'not-read'
        if (readerB) {
          const rb = await Promise.race([
            readerB.read().then(
              (r) => ({ kind: 'ok' as const, r }),
              (e) => ({ kind: 'err' as const, e })
            ),
            sleep(3000).then(() => ({ kind: 'timeout' as const }))
          ])
          if (rb.kind === 'ok') {
            bystanderRead = rb.r.done ? 'done' : `chunk:${rb.r.value?.byteLength ?? 0}`
            bystanderReadAlive = !rb.r.done && (rb.r.value?.byteLength ?? 0) > 0
          } else if (rb.kind === 'err') {
            bystanderRead = 'ERR:' + String((rb.e as Error).message ?? rb.e).slice(0, 60)
          } else {
            bystanderRead = 'timeout'
          }
        }
        step(`M-bystander after=${bystanderAfter} read=${bystanderRead}`)

        // —— D3：`releaseMediaUnderAsync` 的 300ms 上限必须**真的**在起作用 ——
        // 造「B 子树的一条真流 + 一条永不 close 的流」，直接量释放耗时（机制断言）：
        //   · 上限被改成 0 → 耗时塌到 <250ms（根本没在等）→ red
        //   · 上限被删掉（直接 await 全部 close）→ 永远不返回 → 这里 3s 闸门给 -1 → red
        // ⚠️ 刻意**不**在「有卡住的流在场」时再调 `serveMedia`：实测那样会把主进程事件循环挂死
        //    （假流留登记表里时，后续 serveMedia 的异步续体会卡住，ticker 停摆；见 `.workbuddy/audit/g14/folder4~9.log`），
        //    而冒烟绝不允许无结论挂死（G4）。
        const detachStuck = __testAddUnclosableStream(join(bAbs, 'stuck.bin'))
        const tRelease = Date.now()
        const releasedCount = await Promise.race([
          releaseMediaUnderAsync(bAbs),
          sleep(3000).then(() => -1)
        ])
        const releaseMs = Date.now() - tRelease
        detachStuck()
        step(`M-release cap: count=${releasedCount} ms=${releaseMs}`)
        if (readerB) await Promise.race([readerB.cancel().catch(() => undefined), sleep(2000)])

        // —— ④ 流必须是被销毁的：再读一次只能拿到 done 或错误 ——
        // ⚠️ 必须给 `read()` 加**超时**：注入验证（去掉释放）时流还开着且停在背压上，
        // 没有新数据也没有错误 → `await reader.read()` 会**永远挂着**，整轮冒烟无结论地挂死。
        // 超时既保住「有界」（G4），也能把「流还活着」这件事如实记成 `readAfter='timeout'`。
        let streamKilled = false
        let readAfter: string = 'not-read'
        if (reader) {
          const r2 = await Promise.race([
            reader.read().then(
              (r) => ({ kind: 'ok' as const, r }),
              (e) => ({ kind: 'err' as const, e })
            ),
            sleep(2000).then(() => ({ kind: 'timeout' as const }))
          ])
          if (r2.kind === 'timeout') {
            readAfter = 'timeout'
            streamKilled = false // 还能继续挂着 = 流没被销毁
          } else if (r2.kind === 'err') {
            readAfter = 'ERR:' + String((r2.e as Error).message ?? r2.e).slice(0, 60)
            streamKilled = true // 被 destroy 的流会以错误终结
          } else {
            readAfter = r2.r.done ? 'done' : `chunk:${r2.r.value?.byteLength ?? 0}`
            streamKilled = r2.r.done === true
          }
          await Promise.race([reader.cancel().catch(() => undefined), sleep(2000)])
        }

        step(`M-stream killed=${streamKilled} readAfter=${readAfter}`)
        // —— ⑤ 改名结束后抑制必须已解除，否则预览会永久 409 ——
        // 只在**改名成功**时才查：失败时路径没变，没有「新路径」可查；
        // 而且实测在「流还开着」的注入态下这次请求会卡住（会让整段闸门超时）。
        const reopenStatus = renamedM ? await serveStatus() : null
        step(`M-reopen status=${reopenStatus}`)

        return {
          blockedStatus,
          afterExpireStatus,
          openBefore,
          firstBytes,
          openAfter,
          openAfterOld,
          renameMs,
          suppressDelta,
          bystanderOpenBefore,
          bystanderFirstBytes,
          bystanderAfter,
          bystanderRead,
          bystanderReadAlive,
          releasedCount,
          releaseMs,
          readAfter,
          streamKilled,
          renameError,
          renamedPath: renamedM?.path ?? null,
          oldGone: !onDisk('预览中改名'),
          fileOnDisk: onDisk(`已改名/${BIG}`),
          dbRel: (D().prepare('SELECT rel_path FROM assets WHERE id=?').get(mId) as { rel_path: string }).rel_path,
          relBefore: mRelBefore,
          reopenStatus
        }
      }

      const raced = await Promise.race([
        mBody().then((v) => ({ finished: true as const, v })),
        sleep(60000).then(() => ({ finished: false as const }))
      ])
      R.m_previewRename = raced.finished ? raced.v : { timeout: true }
      step(`M ${JSON.stringify(R.m_previewRename)}`)
    }

    // ==================== M2. 真实 watcher 在场时改顶层目录（第三轮根因：chokidar 逐目录句柄）====================
    //
    // 用户报的「一级文件夹永远改不了名」，第三轮实测根因是**我们自己的目录监听器**：
    // chokidar 在 Windows 上逐目录建 `fs.watch`，只要某个**子目录**上挂着句柄，改它**祖先目录**的名就必 EPERM
    // （`.workbuddy/audit/probe-watch-shape.mts`：顶层目录只含文件 → OK；含 1 个 / 11 个子目录 → EPERM；
    //   停 watcher → 全 OK）。上一轮只修了「释放预览读流」，所以用户环境里仍然失败。
    //
    // 本段必须**端到端**且**真实 watcher 在场**：
    //   ① 造与用户库同构的形状（顶层目录 + 子目录 + 真导入的文件）；
    //   ② 真 `watchLibrary()` 并等 chokidar ready（用户在 dev 里就是长开着监听）；
    //   ③ 记录一个**诊断**基线：此时裸 `renameSync` 一个同形的物理目录是否真的被挡（本机能否复现）；
    //   ④ `renameFolder` 顶层目录 → 必须成功，索引与磁盘同步；
    //   ⑤ 恢复自证：改名后往新目录里写一个外部文件，watcher 必须还能索引到它（监听器真恢复了）；
    //      再让缩略图泵给它出图（泵真恢复了），并核对「重挂没有产生重复 watcher」（目录数不变）。
    //   ⑥ 第 2 级隔离的**确定性**覆盖：注入一个「watcher 还在就抛 EPERM、watcher 停了就真改名」的 renameFn，
    //      强制走到「停监听器再试」这一步，断言它确实成功、确实停/重挂过。
    //      —— 注入验证：把 `library.renameFolder` 里 `suspendWatcherForRename()` 那段删掉 → ⑥ 立刻变红。
    step('M2')
    {
      const workDir = dir

      /** 有界轮询 DB（G4）：超时返回 false，调用方必须把结果并入断言 */
      const waitDbRow = async (rel: string, ms: number): Promise<boolean> => {
        const t0 = Date.now()
        while (Date.now() - t0 < ms) {
          if (D().prepare('SELECT id FROM assets WHERE rel_path=?').get(rel)) return true
          await sleep(200)
        }
        return false
      }

      const m2Body = async (): Promise<Record<string, unknown>> => {
        if (!workDir) throw new Error('M2 段需要临时目录')

        // ③ 诊断基线用的物理目录。**必须在 `watchLibrary` 之前建好**：
        // chokidar 只给「启动时扫描到的 + 之后通过事件发现的」目录挂 watch，
        // 建晚了那一刻它还没挂上句柄 → 探针会假报「未复现」（第一版就踩了这个坑）。
        // 内含一个文件是为了贴近用户库的形状（纯空目录在部分分支上不会被逐层挂 watch）。
        const probeDir = join(libPath, '__m2_probe__')
        mkdirSync(join(probeDir, 'sub'), { recursive: true })
        // ⚠️ 扩展名必须是**非素材**（.bin）：chokidar 的 watch 是按目录挂的，与文件类型无关，
        // 但盲窗对账会按 `EXT_TYPE` 过滤 —— 用 .png 的话这个探针文件本身会被对账「补」进索引，
        // 凭空多出一行素材 + 一个 folders 行（第一版实测：M2 之后对账日志报「补回 1 个」）。
        writeFileSync(join(probeDir, 'sub', 'x.bin'), Buffer.from([0x00, 0x01, 0x02]))

        // ① 用户库同构形状：顶层目录 + 3 个子目录 + 每个 3 个真文件
        const top = mkdirChild('', '隔离测试')
        for (let d = 0; d < 3; d++) {
          const sub = mkdirChild('隔离测试', `层${d}`)
          const paths: string[] = []
          for (let k = 0; k < 3; k++) {
            const p = join(workDir, `iso-${d}-${k}.png`)
            writeFileSync(p, await makePng(d * 3 + k))
            paths.push(p)
          }
          await importTo(paths, sub.id)
        }

        // ② 真 watcher（用户 dev 实例长开着的那个）
        watchLibrary(libPath, D())
        await sleep(1500) // chokidar 逐目录建立 watch 需要一轮扫描，太短测不到占用
        const watchingBefore = isWatching()

        // ③ 诊断基线（**不并入断言**）：此刻裸 renameSync 一个同形的物理目录是否真的被挡？
        // 若为 'OK'，说明本机这一刻没复现出占用 —— 那么 ④ 的「成功」就不足以证明隔离链有鉴别力，
        // 而要靠 ⑥（注入）来覆盖。这条只进报告，不让它变红（环境差异不该判产品坏）。
        let baselineRaw = 'n/a'
        try {
          renameSync(probeDir, `${probeDir}_x`)
          baselineRaw = 'OK(未复现占用)'
          renameSync(`${probeDir}_x`, probeDir) // 没被挡 → 改回去，保持目录结构
        } catch (e) {
          baselineRaw = String((e as NodeJS.ErrnoException).code ?? e)
        }
        // ⚠️ 探针目录**留到本段最后再删**：它在 watchLibrary 之前就存在，所以 `watchedBefore`
        // 把它（和它的 sub）算在内；若在这里就删掉，`watchedAfter` 会凭空少 2 → 「目录数不变」的
        // 判据变成假红（第一版实测就是这么红的）。

        const watchedBefore = watchedDirCount()
        const pumpBefore = pumpState()
        const trailBefore = lastRenameIsolation()

        // ④ 改名
        const tRename = Date.now()
        let err: string | null = null
        let renamed: { id: number; path: string; folders: number; assets: number } | null = null
        try {
          renamed = await renameFolder(top.id, '隔离测试-改')
        } catch (e) {
          err = String((e as Error).message ?? e)
        }
        const renameMs = Date.now() - tRename
        const trail = lastRenameIsolation()
        const watchingAfter = isWatching()
        const pumpAfterRename = pumpState()

        // ⑤ 恢复自证：先等重挂后的 chokidar ready（否则写入会被 ignoreInitial 吞掉，这不是产品缺陷），
        // 再写一个外部文件 → 必须被索引；再让泵给它出缩略图。
        // ⚠️ 只在**改名成功**时做：改名失败（注入验证态）时新目录根本不存在，写它会抛 ENOENT，
        // 整轮就只剩一个 `R.error`、看不到具名红（本段第一版实测就是这样，改后才有可归档的红）。
        let externalIndexed = false
        let thumbUrl: string | null = null
        let thumbErr: string | null = null
        if (err === null) {
          await sleep(1500)
          const extRel = '隔离测试-改/层0/外部新增.png'
          try {
            writeFileSync(abs(extRel), await makePng(99))
            externalIndexed = await waitDbRow(extRel, 10000)
            if (externalIndexed) {
              const row = D().prepare('SELECT id FROM assets WHERE rel_path=?').get(extRel) as { id: number }
              const r = await Promise.race([ensureThumb(row.id, 'grid'), sleep(10000).then(() => null)])
              thumbUrl = r ? r.url : null
              if (!r) thumbErr = 'TIMEOUT'
            }
          } catch (e) {
            thumbErr = String((e as Error).message ?? e)
          }
        } else {
          thumbErr = 'SKIPPED(改名失败)'
        }
        const watchedAfter = watchedDirCount()
        const pumpAfter = pumpState()
        const isoRow = D().prepare('SELECT rel_path FROM assets WHERE rel_path=?').get('隔离测试-改/层0/iso-0-0.png') as
          | { rel_path: string }
          | undefined

        // ⑥ 注入：强制走第 2 级隔离（watcher 在场就 EPERM，watcher 被停掉才放行到真 renameSync）
        const injTop = mkdirChild('', '注入隔离')
        const injSub = mkdirChild('注入隔离', '子')
        const injSrc = join(workDir, 'inj.png')
        writeFileSync(injSrc, await makePng(123))
        await importTo([injSrc], injSub.id)
        if (!isWatching()) {
          watchLibrary(libPath, D())
          await sleep(1500)
        }
        const eperm = (): never => {
          const e = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException
          e.code = 'EPERM'
          throw e
        }
        const injectedRename = (from: string, to: string): void => {
          if (watcherActive()) eperm() // watcher 还在 = 句柄还在 = Windows 会拒
          renameSync(from, to) // watcher 已停 = 放行（与真实语义一致）
        }
        const suspBefore = watcherSuspensions()
        let injErr: string | null = null
        try {
          await renameFolder(injTop.id, '注入隔离-改', {
            renameAttempts: 2,
            renameDelays: [0],
            renameFn: injectedRename
          })
        } catch (e) {
          injErr = String((e as Error).message ?? e)
        }
        const injTrail = lastRenameIsolation()

        // 清理探针目录（放在所有观测量之后，理由见 ③ 结尾）
        try {
          rmSync(probeDir, { recursive: true, force: true })
          rmSync(`${probeDir}_x`, { recursive: true, force: true })
        } catch { /* ignore */ }

        return {
          baselineRaw,
          watchingBefore,
          watchingAfter,
          watchedBefore,
          watchedAfter,
          pumpBefore,
          pumpAfterRename,
          pumpAfter,
          err,
          renamedPath: renamed?.path ?? null,
          renameMs,
          oldGone: !onDisk('隔离测试'),
          newOnDisk: onDisk('隔离测试-改/层0/iso-0-0.png'),
          dbRel: isoRow?.rel_path ?? null,
          externalIndexed,
          thumbUrl,
          thumbErr,
          trail,
          trailBefore: trailBefore?.successAt ?? null,
          injection: {
            err: injErr,
            suspDelta: watcherSuspensions() - suspBefore,
            trail: injTrail,
            diskNew: onDisk('注入隔离-改/子/inj.png'),
            watching: isWatching()
          }
        }
      }

      // 60s 总闸门（G4）：注入态下任何一环卡住，都要给出可归档的红，而不是无结论挂死
      const raced = await Promise.race([
        m2Body().then((v) => ({ finished: true as const, v })),
        sleep(60000).then(() => ({ finished: false as const }))
      ])
      R.m2_watcherRename = raced.finished ? raced.v : { timeout: true }
      step(`M2 ${JSON.stringify(R.m2_watcherRename)}`)
    }

    // ==================== N. 盲窗对账 / 删除隔离 / 4 处顺序与边界契约（QA 第四轮）====================
    //
    // QA 第四轮用自设计注入证明这些点**生产套件抓不住**，逐条补：
    //   ① **盲窗对账**：停监听 → 重挂到 ready 之间的文件会被 `ignoreInitial` 静默吞掉
    //      （窗口随库规模线性增长，305 目录 1540ms），全库没有第二个「磁盘 → 索引」入口。
    //      这里用注入的 renameFn **确定性**造出盲窗：第一次尝试时先往目标目录写 3 个文件再抛 EPERM
    //      （此刻 chokidar 的 `awaitWriteFinish` 800ms 还没到，紧接着就停监听器 → 事件被彻底丢掉）。
    //   ② **对账幂等**：连跑两次，第二次 `inserted=0` 且行数不变。
    //   ③ **E2 恢复顺序契约**：`restore-watcher` 必须排在 `resume-pump` 之前（拆成两个 step 才测得出）。
    //   ④ **E3 非忙错误不该升级隔离**：注入 EXDEV → 不许白停一次 watcher（`suspDelta===0`），错误原样上抛。
    //   ⑤ **E4 失败路径也要恢复状态**：三级全失败后泵必须已恢复、监听器必须还在。
    //   ⑥ **并发同 id 改名**：双击回车不能泄漏裸 ENOENT（串行锁 + 二次读行早返回）。
    step('N')
    {
      const workDir = dir
      const nBody = async (): Promise<Record<string, unknown>> => {
        if (!workDir) throw new Error('N 段需要临时目录')
        const countAssets = (): number => (D().prepare('SELECT count(*) AS c FROM assets').get() as { c: number }).c
        /** 有界轮询：这些 rel_path 是否全部进了索引（G4） */
        const waitAllRows = async (rels: string[], ms: number): Promise<boolean> => {
          const t0 = Date.now()
          while (Date.now() - t0 < ms) {
            const hit = rels.every((r) => !!D().prepare('SELECT id FROM assets WHERE rel_path=?').get(r))
            if (hit) return true
            await sleep(200)
          }
          return false
        }
        const eperm = (): never => {
          const e = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException
          e.code = 'EPERM'
          throw e
        }
        /** 一次「改名失败」调用的统一收口：把异常转成字符串，绝不冒到最外层 */
        const tryRename = async (
          id: number,
          name: string,
          opts: { renameAttempts?: number; renameDelays?: number[]; renameFn?: (f: string, t: string) => void }
        ): Promise<string | null> => {
          try {
            await renameFolder(id, name, opts)
            return null
          } catch (e) {
            return String((e as Error).message ?? e)
          }
        }

        // 监听器必须在场且 ready（M2 段结束时是挂着的；这里确认一次，避免依赖段间状态）
        if (!isWatching()) watchLibrary(libPath, D())
        const readyBefore = await whenWatcherReady(15000)

        // ① 盲窗对账
        const bw = mkdirChild('', '盲窗测试')
        const bwSub = mkdirChild('盲窗测试', '层0')
        const bwSrc = join(workDir, 'bw-base.png')
        writeFileSync(bwSrc, await makePng(201))
        await importTo([bwSrc], bwSub.id)
        const assetsBefore = countAssets()
        const windowPng = await makePng(202)
        let wroteWindowFiles = false
        /**
         * 注入：**只要监听器还在就抛 EPERM**，停了才放行到真 `renameSync`。
         *
         * ⚠️ 第一版写成「只在第一次抛 EPERM，之后放行」，结果第二次就真改成功了 ——
         * 因为 `盲窗测试` 这个目录是**监听器启动之后**才建的，chokidar 还没来得及给它挂 watch
         * （实测日志：steps 里根本没有 `suspend-watcher`，`restoreIdx=-1` 直接红）。
         * 必须像 M2 的注入那样「按 watcher 是否在场」来决定，才能**确定性**走到停监听器那一步。
         */
        const bwInjected = (from: string, to: string): void => {
          if (watcherActive()) {
            if (!wroteWindowFiles) {
              wroteWindowFiles = true
              // 真实盲窗形态：文件落在磁盘上，但监听器紧接着被停掉、重挂时被 ignoreInitial 吞掉
              for (let i = 0; i < 3; i++) writeFileSync(join(from, '层0', `窗口内-${i}.png`), windowPng)
            }
            eperm() // 逼出「升级隔离 → 停监听器」这条路径
          }
          renameSync(from, to)
        }
        const bwErr = await tryRename(bw.id, '盲窗测试-改', {
          renameAttempts: 2,
          renameDelays: [0],
          renameFn: bwInjected
        })
        const bwTrail = lastRenameIsolation()
        const windowRels = [0, 1, 2].map((i) => `盲窗测试-改/层0/窗口内-${i}.png`)
        const windowIndexed = await waitAllRows(windowRels, 20000)
        const assetsAfterWindow = countAssets()

        // ② 对账幂等：此刻应当都补完了 → 连跑两次都应为 0 插入、行数不变
        const rc1 = await reconcileLibrary(D(), libPath)
        const rc2 = await reconcileLibrary(D(), libPath)
        const assetsAfterReconcile = countAssets()

        // ③ E2 恢复顺序契约（用上面那次**真的升级过隔离**的轨迹）
        const steps = bwTrail?.steps ?? []
        const iRestore = steps.indexOf('restore-watcher')
        const iResume = steps.indexOf('resume-pump')

        // ④ E3：非瞬时错误（EXDEV）不该升级隔离
        const ex = mkdirChild('', '异常测试')
        const exSub = mkdirChild('异常测试', '子')
        const exSrc = join(workDir, 'ex.png')
        writeFileSync(exSrc, await makePng(210))
        await importTo([exSrc], exSub.id)
        const suspBeforeEx = watcherSuspensions()
        const exErr = await tryRename(ex.id, '异常测试-改', {
          renameAttempts: 3,
          renameDelays: [0, 0],
          renameFn: () => {
            const e = new Error('EXDEV: cross-device link not permitted') as NodeJS.ErrnoException
            e.code = 'EXDEV'
            throw e
          }
        })
        const exSuspDelta = watcherSuspensions() - suspBeforeEx
        const exStillOnDisk = onDisk('异常测试/子/ex.png')

        // ⑤ E4：三级全失败后，状态必须已恢复
        const fl = mkdirChild('', '失败测试')
        const flSub = mkdirChild('失败测试', '子')
        const flSrc = join(workDir, 'fl.png')
        writeFileSync(flSrc, await makePng(220))
        await importTo([flSrc], flSub.id)
        const flErr = await tryRename(fl.id, '失败测试-改', {
          renameAttempts: 1,
          renameDelays: [],
          renameFn: () => eperm()
        })
        const pumpAfterFailure = pumpState()
        const watchingAfterFailure = isWatching()

        // ⑥ 并发同 id 改名（双击回车）：两次都不许抛出、第二次必须是早返回
        const cc = mkdirChild('', '并发测试')
        const ccSub = mkdirChild('并发测试', '子')
        const ccSrc = join(workDir, 'cc.png')
        writeFileSync(ccSrc, await makePng(230))
        await importTo([ccSrc], ccSub.id)
        const ccRes = await Promise.all([
          renameFolder(cc.id, '并发-改').then(
            (r) => ({ r, e: null as string | null }),
            (e) => ({ r: null, e: String((e as Error).message ?? e) })
          ),
          renameFolder(cc.id, '并发-改').then(
            (r) => ({ r, e: null as string | null }),
            (e) => ({ r: null, e: String((e as Error).message ?? e) })
          )
        ])
        const ccPaths = folderPaths().filter((p) => p.startsWith('并发'))
        const ccRows = (D().prepare("SELECT count(*) AS c FROM folders WHERE name='并发-改'").get() as { c: number }).c

        return {
          readyBefore,
          bwErr,
          bwSteps: steps,
          windowIndexed,
          assetsBefore,
          assetsAfterWindow,
          assetsAfterReconcile,
          reconcile1: rc1.inserted,
          reconcile2: rc2.inserted,
          reconcileScanned: rc2.scanned,
          restoreIdx: iRestore,
          resumeIdx: iResume,
          exErr,
          exSuspDelta,
          exStillOnDisk,
          flErr,
          pumpAfterFailure,
          watchingAfterFailure,
          ccErr: [ccRes[0].e, ccRes[1].e],
          ccFolders: [ccRes[0].r?.folders ?? -1, ccRes[1].r?.folders ?? -1],
          ccPaths,
          ccRows,
          ccDisk: onDisk('并发-改/子/cc.png')
        }
      }

      // 90s 总闸门（G4）：本段要等两次 ready + 多次轮询，给足但仍必须有界
      const raced = await Promise.race([
        nBody().then((v) => ({ finished: true as const, v })),
        sleep(90000).then(() => ({ finished: false as const }))
      ])
      R.n_contracts = raced.finished ? raced.v : { timeout: true }
      step(`N ${JSON.stringify(R.n_contracts)}`)
    }

    // ==================== O. 残余三项：NOT NULL 不许静默 / 对账分片 / 删除中断收口（QA 第五轮）====================
    //
    // 三条都是 QA 用自设计注入证明「现实现抓不住/不够」的点：
    //   ① **A**：`INSERT OR IGNORE` 会连 `folder_id NOT NULL` 违反一起静默吞掉
    //      （无异常、无 warn、`changes=0` 被当成"已存在"）→ 换成 `ON CONFLICT(rel_path) DO NOTHING` 后
    //      必须**真的抛错**并由调用方 warn。这里用测试缝把 folder_id 置 null 来验证「不再静默」。
    //   ② **B**：对账最坏情况（首次全量）是同步 DFS + 同步 SQLite，会把主进程冻 4.3s（3900 文件）。
    //      这里造 2000 个「磁盘有、库里没有」的文件（= 最坏路径：每行都要算 hash + 插入），
    //      用心跳法量**最大让位间隔**；再验证「中途切库立刻中止」。
    //   ③ **C**：外部进程用**独占锁**持有目录里某个文件 → rmSync 必失败（且文件已被删掉一部分）。
    //      必须收口成：报明确错误码 + 已消失的行 `missing=1`（不许留「DB 说存在、卡片照常」）。
    step('O')
    {
      const workDir = dir
      const oBody = async (): Promise<Record<string, unknown>> => {
        if (!workDir) throw new Error('O 段需要临时目录')
        const countAssets = (): number => (D().prepare('SELECT count(*) AS c FROM assets').get() as { c: number }).c
        const msg = (e: unknown): string => String((e as Error).message ?? e)

        // —— ① A：NOT NULL 违反必须留痕（不许静默） ——
        const nn = mkdirChild('', 'NOTNULL测试')
        mkdirChild('NOTNULL测试', '子')
        // 只写磁盘、不进索引 → 对账会尝试插入它（正是我们要观察的那一条路径）
        writeFileSync(abs('NOTNULL测试/子/孤儿.png'), await makePng(241))
        const nnWarns: string[] = []
        const origWarn = console.warn
        let nnRes: { inserted: number; aborted: boolean } | null = null
        let nnErr: string | null = null
        const seamPrev = __testForceNullFolderId(true)
        console.warn = (...args: unknown[]): void => {
          nnWarns.push(args.map((x) => String(x)).join(' '))
          ;(origWarn as (...a: unknown[]) => void)(...args)
        }
        try {
          nnRes = await reconcileLibrary(D(), libPath)
        } catch (e) {
          nnErr = msg(e)
        } finally {
          __testForceNullFolderId(seamPrev)
          console.warn = origWarn
        }
        const nnRow = D().prepare('SELECT id FROM assets WHERE rel_path=?').get('NOTNULL测试/子/孤儿.png')
        const nnWarned = nnWarns.some((w) => /孤儿\.png/.test(w) && /NOT NULL|folder_id/i.test(w))
        // 这条孤儿文件只用来触发 NOT NULL，**用完就删**：留着的话它会在后面的对账里被正常补进索引
        // （测试缝已关），让 `bigInserted` 变成 2001 —— 断言会因夹具而红，而不是因产品（实测过一次）。
        rmSync(abs('NOTNULL测试/子/孤儿.png'), { force: true })
        void nn

        // —— ② B1：分片让位（2000 个「库里没有」的文件 = 最坏路径） ——
        //
        // ⚠️ **必须先停监听器再铺文件**（第一版没停，实测 bigInserted=0 / bigMaxGap=1353ms 而红）：
        // 监听器在场时，2000 条 add 事件会在对账让位的那一刻被 chokidar **一次性**投递，
        // 2000 次 hash+INSERT 挤在同一个宏任务里 → 心跳量到的是「watcher 批量插入」的间隔，
        // 不是「对账分片」的间隔；而且文件已被 watcher 抢先索引，对账 inserted=0、断言恒假。
        // 停掉之后才等于 QA 描述的真实触发场景：**用户关着 App 往库里拷了一批文件**。
        mkdirChild('', '大库测试') // 顶层目录（名字空是非法名，别写成 mkdirChild('大库测试','')）
        await suspendWatchingAsync()
        const bigData = await makePng(250)
        const BIG_N = 2000
        for (let i = 0; i < BIG_N; i++) writeFileSync(abs(`大库测试/b-${i}.png`), bigData)
        const gaps: number[] = []
        let lastTick = Date.now()
        const ticker = setInterval(() => {
          const now = Date.now()
          gaps.push(now - lastTick)
          lastTick = now
        }, 10)
        const tBig = Date.now()
        const bigRes = await reconcileLibrary(D(), libPath)
        clearInterval(ticker)
        const bigMs = Date.now() - tBig
        const maxGap = gaps.length ? Math.max(...gaps) : -1
        // 挂回监听器：C 段要验证「删除前确实 suspend 过」，B2 之后也要靠它
        watchLibrary(libPath, D())
        await whenWatcherReady(15000)
        void bigData

        // —— ③ C：外部独占锁 → 删除中断的收口 ——
        const dp = mkdirChild('', '删除中断测试')
        const dpSub1 = mkdirChild('删除中断测试', '子1')
        const dpSub2 = mkdirChild('删除中断测试', '子2')
        const dpPaths: string[] = []
        for (let i = 0; i < 3; i++) {
          const p = join(workDir, `dp-${i}.png`)
          writeFileSync(p, await makePng(260 + i))
          dpPaths.push(p)
        }
        await importTo(dpPaths.slice(0, 2), dpSub1.id)
        await importTo(dpPaths.slice(2), dpSub2.id)
        const lockedRel = '删除中断测试/子2/dp-2.png'
        const lockedAbs = abs(lockedRel)
        const marker = join(workDir, 'lock-ready.txt')
        // PowerShell 以**独占**方式（share=None）打开该文件 —— Node 的 fs.open 做不到这一点
        // （libuv 打开时带 FILE_SHARE_DELETE），QA 第四轮就是用这招拿到确定性的 EBUSY。
        const lockScript =
          `$ErrorActionPreference='Stop';` +
          `$f=[IO.File]::Open('${lockedAbs.replace(/'/g, "''")}','Open','ReadWrite','None');` +
          `Set-Content -Path '${marker.replace(/'/g, "''")}' -Value 'ok';` +
          `Start-Sleep -Seconds 40; $f.Close()`
        const lockProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', lockScript], {
          windowsHide: true
        })
        let lockReady = false
        for (let i = 0; i < 60; i++) {
          if (existsSync(marker)) {
            lockReady = true
            break
          }
          await sleep(200)
        }
        const suspBeforeDp = watcherSuspensions()
        let dpErr: string | null = null
        try {
          await deleteFolder(dp.id)
        } catch (e) {
          dpErr = msg(e)
        }
        const suspDp = watcherSuspensions() - suspBeforeDp
        // 关掉独占进程（否则后面的清理会一直被挡）
        try {
          lockProc.kill()
        } catch {
          /* ignore */
        }
        await sleep(300)
        const dpRows = D()
          .prepare('SELECT rel_path, missing FROM assets WHERE rel_path LIKE ?')
          .all('删除中断测试/%') as Array<{ rel_path: string; missing: number }>
        const goneRows = dpRows.filter((r) => !existsSync(abs(r.rel_path)))
        const aliveRows = dpRows.filter((r) => existsSync(abs(r.rel_path)))
        const goneMarked = goneRows.length > 0 && goneRows.every((r) => r.missing === 1)
        const aliveUntouched = aliveRows.every((r) => r.missing === 0)
        const dpFilesGone = dpPaths.some((p, i) => i < 2 && !existsSync(join(libPath, '删除中断测试/子1', `dp-${i}.png`)))

        // —— ④ B2：对账中途切库 → 立刻中止、不报错 ——
        // 再铺 800 个文件（同样先停监听器，理由见 B1），保证对账有足够时长跑到中途
        await suspendWatchingAsync()
        for (let i = 0; i < 800; i++) writeFileSync(abs(`大库测试/m-${i}.png`), bigData)
        const running = reconcileLibrary(D(), libPath) // 故意不 await
        await sleep(30) // 让它先跑几片
        const lib2 = createLibrary({ name: 'switchlib', parentDir: workDir }) // 切库 → 关闭旧连接
        let abortRes: { inserted: number; aborted: boolean } | null = null
        let abortErr: string | null = null
        try {
          abortRes = await Promise.race([running, sleep(20000).then(() => null)])
        } catch (e) {
          abortErr = msg(e)
        }
        // 切回主库并确认「中止后能自愈」：再跑一次必须跑完（aborted=false）
        openLibrary(libPath)
        watchLibrary(libPath, D())
        await whenWatcherReady(15000)
        let recoverRes: { inserted: number; aborted: boolean } | null = null
        try {
          recoverRes = await reconcileLibrary(D(), libPath)
        } catch {
          /* 记在下面 */
        }
        void lib2

        return {
          nnErr,
          nnInserted: nnRes?.inserted ?? -1,
          nnRowExists: !!nnRow,
          nnWarned,
          nnWarnSample: nnWarns.slice(0, 3),
          bigFiles: BIG_N,
          bigInserted: bigRes.inserted,
          bigMs,
          bigTicks: gaps.length,
          bigMaxGap: maxGap,
          lockReady,
          dpErr,
          suspDp,
          dpRowCount: dpRows.length,
          dpGoneRows: goneRows.length,
          dpAliveRows: aliveRows.length,
          goneMarked,
          aliveUntouched,
          dpFilesGone,
          abortErr,
          abortHandled: abortRes !== null,
          abortFlag: abortRes?.aborted ?? null,
          abortInserted: abortRes?.inserted ?? -1,
          recoverAborted: recoverRes?.aborted ?? null,
          assetsTotal: countAssets()
        }
      }

      // 150s 总闸门（G4）：2000+800 个文件 + PowerShell 起停，给足但仍必须有界
      const raced = await Promise.race([
        oBody().then((v) => ({ finished: true as const, v })),
        sleep(150000).then(() => ({ finished: false as const }))
      ])
      R.o_residuals = raced.finished ? raced.v : { timeout: true }
      step(`O ${JSON.stringify(R.o_residuals)}`)
    }



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
      tagsLeft: number; prunedTags: string[]
      thumbsBeforeDelete: number; thumbsLeft: number; siblingIntact: boolean
      watcherReady?: boolean; suspDelta?: number; watchingAfter?: boolean; leftoverDirs?: string[]
      delErr?: string | null; filesAlreadyGone?: boolean
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
    const k2p = (R.k2_parent ?? {}) as {
      clicked?: boolean; active?: string | null; cards?: number[]; expect?: number[]
      sidebarUi?: number; direct?: number; treeTotal?: number
      total?: { shown: number[] }; totalText?: string | null
    }
    const k2f = (R.k2_filter ?? {}) as {
      totalText?: string | null; parsed?: { shown: number[] }; numerator?: number; denominator?: number
    }
    const k2l = (R.k2_leaf ?? {}) as {
      clicked?: boolean; active?: string | null; cards?: number[]; expect?: number[]; parentExpect?: number[]
    }
    const lRetry = (R.l_retry ?? {}) as {
      callsA?: number; threwA?: string | null; callsB?: number; threwB?: string | null
      callsC?: number; threwC?: string | null
    }
    const mpr = (R.m_previewRename ?? {}) as {
      blockedStatus?: number; afterExpireStatus?: number; openBefore?: number; openAfter?: number
      firstBytes?: number
      openAfterOld?: number
      readAfter?: string; streamKilled?: boolean; renamedPath?: string | null; oldGone?: boolean
      fileOnDisk?: boolean; dbRel?: string; relBefore?: string; reopenStatus?: number | null
      renameMs?: number; suppressDelta?: number; bystanderOpenBefore?: number; bystanderFirstBytes?: number
      bystanderAfter?: number; bystanderRead?: string; bystanderReadAlive?: boolean
      releasedCount?: number; releaseMs?: number
      renameError?: string | null
    }
    const n = (R.n_contracts ?? {}) as {
      timeout?: boolean
      readyBefore?: boolean
      bwErr?: string | null
      bwSteps?: string[]
      windowIndexed?: boolean
      assetsBefore?: number
      assetsAfterWindow?: number
      assetsAfterReconcile?: number
      reconcile1?: number
      reconcile2?: number
      reconcileScanned?: number
      restoreIdx?: number
      resumeIdx?: number
      exErr?: string | null
      exSuspDelta?: number
      exStillOnDisk?: boolean
      flErr?: string | null
      pumpAfterFailure?: { paused: boolean; running: number; queued: number }
      watchingAfterFailure?: boolean
      ccErr?: Array<string | null>
      ccFolders?: number[]
      ccPaths?: string[]
      ccRows?: number
      ccDisk?: boolean
    }
    const o = (R.o_residuals ?? {}) as {
      timeout?: boolean
      nnErr?: string | null
      nnInserted?: number
      nnRowExists?: boolean
      nnWarned?: boolean
      nnWarnSample?: string[]
      bigFiles?: number
      bigInserted?: number
      bigMs?: number
      bigTicks?: number
      bigMaxGap?: number
      lockReady?: boolean
      dpErr?: string | null
      suspDp?: number
      dpRowCount?: number
      dpGoneRows?: number
      dpAliveRows?: number
      goneMarked?: boolean
      aliveUntouched?: boolean
      dpFilesGone?: boolean
      abortErr?: string | null
      abortHandled?: boolean
      abortFlag?: boolean | null
      abortInserted?: number
      recoverAborted?: boolean | null
      assetsTotal?: number
    }
    const m2 = (R.m2_watcherRename ?? {}) as {
      timeout?: boolean
      baselineRaw?: string
      watchingBefore?: boolean
      watchingAfter?: boolean
      watchedBefore?: number
      watchedAfter?: number
      pumpBefore?: { paused: boolean; running: number; queued: number }
      pumpAfterRename?: { paused: boolean; running: number; queued: number }
      pumpAfter?: { paused: boolean; running: number; queued: number }
      err?: string | null
      renamedPath?: string | null
      renameMs?: number
      oldGone?: boolean
      newOnDisk?: boolean
      dbRel?: string | null
      externalIndexed?: boolean
      thumbUrl?: string | null
      thumbErr?: string | null
      trail?: {
        steps?: string[]
        directAttempted?: boolean
        directFailed?: boolean
        pumpPaused?: boolean
        pumpResumed?: boolean
        watcherSuspended?: boolean
        watcherRestarted?: boolean
        successAt?: string | null
        failed?: boolean
      } | null
      trailBefore?: string | null
      injection?: {
        err?: string | null
        suspDelta?: number
        diskNew?: boolean
        watching?: boolean
        trail?: {
          steps?: string[]
          successAt?: string | null
          watcherSuspended?: boolean
          watcherRestarted?: boolean
          failed?: boolean
        } | null
      }
    }

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
      //
      // `tagsLeft` 是 0 而不是 1：唯一那个标签（「冒烟标签」）挂在被删的素材上，
      // 素材一删它就归零 → 被 `pruneUnlinkedTags` 自动清掉。这是有意为之的行为
      // （空标签会让侧栏显示一个计数 0 的假行），别再改回期望 1。
      deleteWholeTree: g?.diskGone === true && g.siblingIntact === true &&
        g.foldersLeft.join('|') === '对照' && g.assetsLeft.length === 0 &&
        g.orphanTagLinks === 0 && g.tagsLeft === 0 &&
        g.thumbsBeforeDelete === 4 && g.thumbsLeft === 0,
      // 且清掉的正是挂在被删素材上的那个标签
      deleteFolderPrunesTag: (g?.prunedTags ?? []).join('|') === '冒烟标签',
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
      // `R.j1_feedbackReady` = 松手前那次「等反馈出现」的轮询结果（防假绿闸门，G11）：超时 → 这条必红，
      // 红因直接指向「反馈没等到」，而不是让 6 条断言以「同生共死」的方式模糊变红
      dragFeedback: (R.j1_feedbackReady as boolean) === true &&
        j1m.ghost === true && j1m.dropOn?.includes('对照/目标') === true && (j1m.dimmed ?? 0) >= 1,
      // 松手后 ghost 与 body 状态都要收干净，否则会一直留在界面上
      dragCleansUp: j1?.ghostGone === true && j1?.bodyClassGone === true && j1?.selectedAfter === 0,
      // J2 拖回素材原本所在的文件夹 = 无效落点：不高亮、不搬动
      dragNoopOnOrigin: j2?.relUnchanged === true && j2.stillOnDisk === true && (j2m.dropOn ?? []).length === 0,
      // J3 Ctrl + 拖动仍然是框选，不能退化成移动
      ctrlDragStillBand: j3m.marquee === true && j3m.ghost !== true &&
        j3?.relUnchanged === true && j3?.stillOnDisk === true,
      // J4 拖动已多选中的一张 → 整批一起走
      dragBatch: j4?.allInTarget === true && (j4?.movedCount ?? 0) >= 1,

      // K 侧栏文件夹计数 = 后端子树计数（与列表同口径），逐行比对无一例外
      sidebarCountIsSubtree: (R.k_mismatch as string[]).length === 0 &&
        (R.k_ui as Record<string, number>)['对照'] === ((R.k_backend as Record<string, number>)['对照'] ?? 0),
      // 且必须与旧口径（只算直属）不同 —— 否则「显示==子树」在两者相等时测不出回归
      sidebarCountDiffersFromDirect: (R.k_treeDiff as { direct: number; subtree: number }).subtree >
        (R.k_treeDiff as { direct: number; subtree: number }).direct &&
        (R.k_ui as Record<string, number>)['对照'] === (R.k_treeDiff as { direct: number; subtree: number }).subtree &&
        (R.k_ui as Record<string, number>)['对照'] !== (R.k_directOnly as Record<string, number>)['对照'],
      // K2 点父文件夹：列表含子目录里的素材，且卡片数 == 侧栏数字 == DB 子树集合
      folderClickShowsSubtree: k2p?.clicked === true && k2p?.active === '对照' &&
        (k2p?.cards ?? []).join('|') === (k2p?.expect ?? []).join('|') &&
        (k2p?.expect?.length ?? 0) > (k2p?.direct ?? 0),
      // 侧栏数字（DOM）与列表里实际渲染的卡片数一致（数字不再虚高/虚低）。
      // 左边必须取自 DOM：若拿测试端算出来的子树数去比，就成了拿同一份 DB 自证。
      folderCountMatchesCards: (k2p?.sidebarUi ?? -1) === (k2p?.cards?.length ?? -2) &&
        (k2p?.sidebarUi ?? -1) === (k2p?.treeTotal ?? -3) &&
        (k2p?.cards?.length ?? 0) > 0,
      // 不带筛选时工具栏总数也走同一条口径：「N 个文件」的 N == 卡片数（按数字比，不用 includes 防串位）
      folderTotalTextMatches: (k2p?.total?.shown?.length ?? 0) === 1 &&
        k2p?.total?.shown?.[0] === k2p?.expect?.length,
      // K2 叠关键词后「X / 共 Y 个匹配」的格式与分子分母都要对：
      // 关键是 Y 必须是**子树**数 —— 旧口径（只看直属）这里会渲染成「3 / 共 0」。
      // 注意别断言 X < Y：本用例里素材全是 .png，关键词 png 命中全部，分子分母相等是正常的。
      scopeDenominatorIsSubtree: (k2f?.parsed?.shown?.length ?? 0) === 2 &&
        k2f?.parsed?.shown?.[0] === k2f?.numerator &&
        k2f?.parsed?.shown?.[1] === k2f?.denominator &&
        (k2f?.numerator ?? 0) > 0 &&
        (k2f?.denominator ?? 0) === (k2p?.treeTotal ?? -1) &&
        (k2f?.denominator ?? 0) > (k2p?.direct ?? 0),
      // K2 点叶子文件夹：只剩它自己的素材，递归不能退化成一味显示全部
      leafFolderStaysDirect: k2l?.clicked === true && k2l?.active === '对照/目标' &&
        (k2l?.cards ?? []).join('|') === (k2l?.expect ?? []).join('|') &&
        (k2l?.expect?.length ?? 0) > 0 &&
        (k2l?.parentExpect?.length ?? 0) > (k2l?.expect?.length ?? 0),

      // L 重命名重试助手（缺陷 1）：注入假 renameFn 确定性验证
      // ① 前两次 EPERM、第三次成功 → 不抛错 + 恰好 3 次（删掉重试会变成 1 次且抛错 → 红）
      renameRetrySucceeds: lRetry?.threwA === null && lRetry?.callsA === 3,
      // ② 始终 EPERM → 抛 ERR_FOLDER_BUSY + 尝试次数 == 上限 4（删掉重试会变成 1 次 → 红）
      renameRetryBusy: /ERR_FOLDER_BUSY/.test(lRetry?.threwB ?? '') && lRetry?.callsB === 4,
      // ②b 裸码契约（QA 在渲染层实测否证过带后缀的写法）：耗尽时 message 必须**恰好**是
      //     'ERR_FOLDER_BUSY'。渲染层两张映射表是**精确查表**，带任何后缀都会变死键 →
      //     用户看到原始 `EPERM …+完整路径`。谁再往 message 加后缀，这条 `===` 立刻变红
      //     （用 startsWith/正则就照不出来，所以**必须** `===`）。同步版走同一个 busyRenameError，一并覆盖。
      renameRetryBareCode: lRetry?.threwB === 'ERR_FOLDER_BUSY',
      // ③ EXDEV 非瞬时 → 立即抛、只尝试 1 次（不白等）
      renameRetryNonTransient: /EXDEV/.test(lRetry?.threwC ?? '') && lRetry?.callsC === 1,

      // —— M. 重命名「正在被我们预览」的文件夹（用户报的「一级文件夹改不了名」的原形）——
      // 前置 `openBefore >= 1` 是**不可省的**：没有它，「改名后登记表为 0」就成了 0===0 的空转（G11）。
      // 注入验证（实测记录见 `.workbuddy/audit/g14-m-inject-folder.log`）：把 `library.renameFolder`
      // 里 `releaseMediaUnderAsync` + `suppressMediaUnder` 两行去掉 → 这条立刻变红，
      // 且 `renameError` 就是用户看到的 `ERR_FOLDER_BUSY`。
      renameWhilePreviewing: (mpr.openBefore ?? 0) >= 1 && (mpr.firstBytes ?? 0) > 0 && mpr.renameError === null &&
        mpr.renamedPath === '已改名' &&
        mpr.oldGone === true && mpr.fileOnDisk === true &&
        mpr.relBefore === '预览中改名/big.png' && mpr.dbRel === '已改名/big.png' &&
        (mpr.openAfter ?? -1) === 0 && (mpr.openAfterOld ?? -1) === 0,
      // 释放是**真的**发生了：读流被销毁（后续 read 只能拿到 done/错误），而不是恰好自己跑完了
      renameReleasesStream: mpr.streamKilled === true,
      // 抑制窗口本身有效：窗口内拒（409）、过期后恢复（200）。
      // 「窗口开了不失效」会让预览永久黑屏，「窗口根本不生效」会让渲染层立刻把句柄重开 → 改名再次 EPERM。
      suppressWindowWorks: mpr.blockedStatus === 409 && mpr.afterExpireStatus === 200,
      // 改名动作结束必须已解除抑制（成功 → 按新路径重取；失败 → 继续允许预览）
      suppressClearedAfterRename: mpr.reopenStatus === 200,
      // D1 **接线**断言（不是行为断言）：`library.renameFolder` 改名前必须真的开过一次抑制窗口。
      // 为什么必须单独锁：`suppressWindowWorks` 是直接调 `suppressMediaUnder` 测机制，
      // 把 renameFolder 里那行调用删掉它照样绿（QA 的 D1 注入实测）。
      renameSuppressionWired: (mpr.suppressDelta ?? 0) === 1,
      // D2 释放必须**按子树收敛**：改 A 之后，无关子树 B 的流要还活着（计数 + 还能读出字节）。
      // 把 `collectStreamsUnder` 的子树判断去掉（改成释放全部）→ 这条红。
      releaseIsSubtreeScoped: (mpr.bystanderOpenBefore ?? 0) >= 1 && (mpr.bystanderFirstBytes ?? 0) > 0 &&
        (mpr.bystanderAfter ?? 0) >= 1 && mpr.bystanderReadAlive === true,
      // D3a **有界**：A 子树里有一条真流在场时，rename 必须成功且远小于重试预算（3.3s）就收尾。
      renameCompletesBounded: mpr.renameError === null && (mpr.renameMs ?? 1e9) >= 0 && (mpr.renameMs ?? 1e9) < 2000,
      // D3b **上限真的在起作用**（机制断言）：一条真流 + 一条「永不 close」的流，
      // 释放必须在上限内返回（≥250ms 说明它**确实等了**那个卡住的流，<2000ms 说明等到上限就放弃）。
      // 上限改成 0 → 耗时 <250ms → 红；上限删掉（直接 await 全部 close）→ 3s 闸门 → -1 → 红。
      releaseCapBounded: (mpr.releasedCount ?? 0) >= 2 && (mpr.releaseMs ?? 1e9) >= 250 && (mpr.releaseMs ?? 1e9) < 2000,

      // —— M2. 真实 watcher 在场时改顶层目录（第三轮根因：chokidar 在 Windows 上逐目录建 fs.watch，
      //        子目录上的句柄会挡住**祖先目录**改名；上一轮只修了媒体读流，所以用户环境里仍然失败）——
      //
      // 判据刻意写成「最终成功 + 状态恢复」，而**不是**「必须走到第 2 级隔离」：
      // 直改就成功的环境（本机这一刻没复现出占用）里，这条也必须绿 —— 否则断言会变成
      // 「只有慢机器才能通过」的伪条件。第 2 级隔离的覆盖交给下面两条（接线断言 + 注入断言）。
      watcherPresentRenameOk: m2?.timeout !== true && m2?.watchingBefore === true && m2?.err === null &&
        m2?.renamedPath === '隔离测试-改' && m2?.oldGone === true && m2?.newOnDisk === true &&
        m2?.dbRel === '隔离测试-改/层0/iso-0-0.png' && m2?.watchingAfter === true,
      // 接线断言（不是行为断言）：隔离链**确实被执行过** —— 每一步都只有真走到那行代码才会置位。
      // 注意 `directAttempted` 会先被置位再试，所以这条同时能抓「整段隔离被绕开」的回归
      // （例如有人把 rename 直接写成 `renameWithRetry(oldAbs,newAbs)` 而不进隔离块）。
      watcherIsolationWired: m2?.trail?.directAttempted === true && m2?.trail?.pumpPaused === true &&
        m2?.trail?.pumpResumed === true && m2?.trail?.failed === false &&
        (m2?.trail?.steps ?? []).includes('media-release') &&
        (m2?.trail?.steps ?? []).includes('pump-pause') &&
        (m2?.trail?.steps ?? []).includes('probe-rename'),
      // 恢复自证（幂等/可恢复）：改名结束后
      //   ① watcher 还能索引外部新增文件（不是「停完就再也没挂回去」）；
      //   ② 缩略图泵还能出图（不是「暂停完就永久停掉」，用户会看到一片灰卡片）；
      //   ③ 泵状态回到「未暂停」；
      //   ④ 重挂**没有留下重复 watcher**（目录数与改名前的同一棵树相等；漏掉旧 close 会接近翻倍）。
      watcherRestoredAfterRename: m2?.externalIndexed === true && !!m2?.thumbUrl &&
        m2?.pumpAfter?.paused === false && (m2?.watchedBefore ?? 0) > 0 &&
        m2?.watchedAfter === m2?.watchedBefore,
      // 第 2 级隔离的**确定性**覆盖（注入）：强制「watcher 在场就 EPERM」，只有停掉监听器才能通过。
      // 若有人删掉 `suspendWatcherForRename()` 那段，这里会抛 ERR_FOLDER_BUSY → 立刻变红。
      watcherIsolationEscalates: m2?.injection?.err === null && m2?.injection?.trail?.successAt === 'after-unwatch' &&
        m2?.injection?.trail?.watcherSuspended === true && m2?.injection?.trail?.watcherRestarted === true &&
        (m2?.injection?.suspDelta ?? 0) >= 1 && m2?.injection?.diskNew === true &&
        m2?.injection?.watching === true,

      // —— N. QA 第四轮：盲窗对账 / 删除隔离 / 4 处顺序与边界契约 ——
      //
      // 删除隔离（G 段，**真实 watcher 已 ready** 才删）：磁盘整棵没了 + 没有「文件没了空目录还在」的半状态
      // + 确实停过监听器（suspDelta>=1）+ 删完监听器还在。
      // 注入验证：把 `deleteFolderUnlocked` 里的 `suspendWatcherForRename()` 去掉 → suspDelta=0，
      // 且 rmSync 抛 ENOTEMPTY（文件已删光、目录留着）→ leftoverDirs 非空 → 这条红。
      deleteFolderIsolated: g?.watcherReady === true && (g?.suspDelta ?? 0) >= 1 && g?.watchingAfter === true &&
        (g?.leftoverDirs ?? ['x']).length === 0 && g?.diskGone === true && g?.siblingIntact === true,
      // 盲窗对账：注入态下 3 个「窗口内写入」的文件必须全部被补进索引，且总行数 == 改名前 + 3。
      // 注入验证：去掉 finally 里的 `reconcileAfterWindow()` → windowIndexed=false、行数少 3 → 红。
      blindWindowReconciled: n?.bwErr === null && n?.windowIndexed === true &&
        (n?.assetsAfterWindow ?? -1) === (n?.assetsBefore ?? -2) + 3,
      // 对账幂等：连着再跑两次 `reconcileLibrary`，都不该再插入行、行数也不许变。
      // （同时钉住「已有行一律跳过、不算 hash、不动用户字段」这条契约。）
      reconcileIdempotent: n?.reconcile1 === 0 && n?.reconcile2 === 0 &&
        (n?.assetsAfterReconcile ?? -1) === (n?.assetsAfterWindow ?? -2) &&
        (n?.reconcileScanned ?? 0) > 0,
      // E2 恢复顺序契约：`restore-watcher` 必须排在 `resume-pump` 之前。
      // 把 finally 里两段对调 → 这条红（以前两件事合成一个 step，是测不出来的）。
      restoreOrderContract: (n?.restoreIdx ?? -1) >= 0 && (n?.resumeIdx ?? -1) >= 0 &&
        (n?.restoreIdx ?? 99) < (n?.resumeIdx ?? -2),
      // E3 非忙错误不该升级隔离：EXDEV 必须原样上抛，且**不许白停一次监听器**（suspDelta 必须为 0）。
      // 把 `isBusyRenameError(e)` 改成恒真 → suspDelta=1（白开一次 1.5s 盲窗）→ 这条红。
      nonBusyErrorSkipsWatcher: /EXDEV/.test(n?.exErr ?? '') && n?.exSuspDelta === 0 &&
        n?.exStillOnDisk === true,
      // E4 失败路径也要恢复状态：三级全失败（ERR_FOLDER_BUSY）之后泵必须已恢复、监听器必须还在。
      // 只在成功路径查泵的实现下，这条会红。
      failurePathRestoresState: n?.flErr === 'ERR_FOLDER_BUSY' &&
        n?.pumpAfterFailure?.paused === false && n?.watchingAfterFailure === true,
      // 并发同 id 改名（双击回车）：两次都不许抛出（尤其不许泄漏裸 ENOENT），
      // 且磁盘/索引只改一次（folders 表里只有一个「并发-改」，第二次是早返回 folders=0）。
      concurrentRenameNoLeak: (n?.ccErr ?? ['x', 'x']).every((e) => e === null) &&
        (n?.ccPaths ?? []).join('|') === '并发-改|并发-改/子' && n?.ccRows === 1 &&
        n?.ccDisk === true && (n?.ccFolders ?? [-1, -2]).some((x) => x === 0),

      // —— O. 残余三项（QA 第五轮）——
      //
      // A：`ON CONFLICT(rel_path) DO NOTHING` 之后，`folder_id NOT NULL` 违反必须**真的抛错并留痕**，
      // 不许像 `INSERT OR IGNORE` 那样静默吞掉（无异常、无 warn、changes=0 被当成"已存在"）。
      // 判据三条一起：对账本身不抛（被单文件 catch 住了）、该行**没有**入库、warn 里带 rel_path 与 NOT NULL。
      // 注入验证：把 SQL 改回 `INSERT OR IGNORE` → nnWarned=false（零痕迹）→ 这条红。
      notNullViolationNotSilent: o?.nnErr === null && o?.nnRowExists === false && o?.nnWarned === true,
      // B1：最坏路径（2000 个「库里没有」的文件，每行都要算 hash+插入）必须分片让位：
      // 心跳法量到的**最大间隔**不得超过 120ms（同步实现实测 4300~4900ms 整段冻住）。
      // 注入验证：把让位检查点去掉（改回同步 readdirSync）→ bigMaxGap 上千 ms → 红。
      reconcileYieldsPromptly: o?.bigInserted === 2000 && (o?.bigTicks ?? 0) > 5 &&
        (o?.bigMaxGap ?? 1e9) >= 0 && (o?.bigMaxGap ?? 1e9) <= 120,
      // B2：对账跑到一半用户切库 → 必须**立刻中止**（aborted=true）、不抛错、不写坏数据；
      // 并且切回原库后能再跑一次完整对账（aborted=false）= 中止后自愈。
      // 注入验证：把 `isDbAlive` 检查点删掉 → 拿已关闭的连接继续跑，abortFlag 为 false → 红。
      reconcileAbortsOnSwitch: o?.abortErr === null && o?.abortHandled === true &&
        o?.abortFlag === true && o?.recoverAborted === false,
      // C：外部**独占锁**（share=None，Node 的 fs.open 做不到）下删除必须收口：
      // ① 报**明确错误码**（不是裸 EBUSY/EPERM/ENOTEMPTY，也不是假装成功）；
      // ② 磁盘上已消失的行 `missing=1`（不许留「DB 说存在、卡片照常」）；
      // ③ 还活着的行保持 missing=0（不许一刀切把整个子树标记失效）。
      // 注入验证：去掉删除失败分支里的 `markMissingOnDisk` → goneMarked=false → 红。
      deletePartialMarksMissing: o?.lockReady === true && (o?.suspDp ?? 0) >= 1 &&
        o?.dpErr === 'ERR_FOLDER_DELETE_PARTIAL' && !/EBUSY|EPERM|ENOTEMPTY/i.test(o?.dpErr ?? '') &&
        (o?.dpGoneRows ?? 0) >= 1 && o?.goneMarked === true && o?.aliveUntouched === true
    }
    R.ok = Object.values(R.checks as Record<string, boolean>).every(Boolean)
  } catch (e) {
    R.ok = false
    R.error = String((e as Error).stack ?? e)
  } finally {
    R.jsErrors = jsErrors
    if (jsErrors.length) R.rendererLogs = rendererLogs.filter((l) => /error|Error|warn|Warn/.test(l)).slice(-8)
    // ⚠️ 先停 chokidar 再删目录：它还持有库目录的句柄，Windows 上会让 rmSync 抛 EPERM
    // （与 `library:close` 同一条纪律；H 段的 library.open 已经把 watcher 挂上了）。
    // 守则不变：不停的话外层的 rmSync(dir) 会抛出去 —— 而它抛在 finally 里，
    // 会把下面的结果 JSON 与 `app.exit(0)` 一起吞掉（整轮冒烟"无结论地"挂死，只能靠超时杀）。
    // `forgetLibrary` 只清 `config.json` 里的最近库记录（不再物理删库，删目录由外层 rmSync(dir) 负责），
    // 目的是别让临时库的死记录在 config.json 里越积越多。
    unwatchLibrary()
    try {
      if (libPath) forgetLibrary(libPath)
    } catch (e) {
      R.cleanupError = String(e)
    }
    closeCurrent()
    // 临时目录清理失败只记录、不抛：它不影响本轮断言的结论，
    // 而抛在 finally 里会让整轮报告消失（见上）。
    try {
      if (dir) rmSync(dir, { recursive: true, force: true })
    } catch (e) {
      R.cleanupError = `${R.cleanupError ? `${R.cleanupError}；` : ''}临时目录清理失败：${String((e as Error).message ?? e)}`
    }
    console.log('[SMOKE-FOLDER] ' + JSON.stringify(R))
    app.exit(0)
  }
}
