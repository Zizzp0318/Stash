import { existsSync, mkdirSync, rmSync } from 'fs'
import { join, dirname, basename, relative, isAbsolute, resolve } from 'path'
import { openDatabase, SCHEMA_VERSION, type DB } from './db'
import { addRecentLibrary, listRecentLibraries, removeRecentLibrary } from './config'
import { isThumbHash, subtreeOfPath, validateName } from './paths'
import { isBusyRenameError, renameWithRetry } from './fsutil'
import {
  beginRenameIsolationTrail,
  clearMediaSuppression,
  pauseIsolatedPumps,
  reconcileAfterWindow,
  releaseMediaUnderAsync,
  restartWatcherAfterRename,
  resumeIsolatedPumps,
  suppressMediaUnder,
  suspendWatcherForRename
} from './handles'

/**
 * 改名隔离链第 2 步「暂停我方泵」的等待上限（毫秒）。
 *
 * 取值理由：缩略图 job 单张实测 3~50ms（用户库最大图 2.1MB，`readFileSync` 约 3ms + libvips 编码），
 * 并发 4，等一轮在场任务通常 <100ms。3s 是「电机卡住」时的兜底 ——
 * 到点仍在跑也照样往下走（改名是用户主动操作，不能因为一张大图没缩完就卡死）。
 */
const RENAME_PUMP_PAUSE_MS = 3000

let current: { db: DB; path: string } | null = null

export interface LibraryInfo {
  path: string
  name: string
}

function libName(db: DB): string {
  const row = db.prepare("SELECT value FROM meta WHERE key='library_name'").get() as { value: string } | undefined
  return row?.value ?? ''
}

export function getLibrary(): LibraryInfo | null {
  return current ? { path: current.path, name: libName(current.db) } : null
}

export function requireCurrent(): { db: DB; path: string } {
  if (!current) throw new Error('ERR_NO_LIBRARY')
  return current
}

/** 当前库的数据库连接（watcher 等模块用） */
export function getDatabase(): DB {
  return requireCurrent().db
}

function setCurrent(db: DB, path: string): void {
  if (current) closeCurrent()
  current = { db, path }
  addRecentLibrary(path)
}

export function closeCurrent(): void {
  if (current) {
    try {
      current.db.close()
    } catch {
      /* ignore */
    }
    current = null
  }
}

export function createLibrary({ name, parentDir }: { name: string; parentDir: string }): LibraryInfo {
  if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error('ERR_INVALID_NAME')
  const libPath = resolve(join(parentDir, name))
  if (existsSync(join(libPath, '.stash'))) throw new Error('ERR_LIBRARY_EXISTS')
  mkdirSync(join(libPath, '.thumbs'), { recursive: true })
  const db = openDatabase(join(libPath, '.stash'))
  const now = Date.now()
  // 版本号引用共享常量（单一真相源）。openDatabase 建新库时其实已经写过一次；
  // 这里再显式 WRITE 一遍是刻意为之：把「建库 = 当前版本」这条不变量钉在创建路径上，
  // 不依赖 openDatabase 的内部实现细节。meta.value 是 TEXT，所以要 String()。
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)").run(String(SCHEMA_VERSION))
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('library_name',?)").run(name)
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('created_at',?)").run(String(now))
  setCurrent(db, libPath)
  return { path: libPath, name }
}

export function openLibrary(target: string): LibraryInfo {
  const raw = target.toLowerCase().endsWith('.stash') ? dirname(target) : target
  const libPath = resolve(raw)
  if (!existsSync(join(libPath, '.stash'))) throw new Error('ERR_NOT_A_LIBRARY')
  const db = openDatabase(join(libPath, '.stash'))
  setCurrent(db, libPath)
  // 收掉老版本遗留的空标签（那时没有自动清理，库里可能躺着计数为 0 的标签）。
  // 这里静默处理、不通知：用户没做任何操作，弹提示反而莫名其妙。
  pruneAllEmptyTags(db)
  return { path: libPath, name: libName(db) }
}

export function listLibraries(): LibraryInfo[] {
  return listRecentLibraries().map((p) => ({
    path: p,
    name: basename(p)
  }))
}

/**
 * 把「库路径」的多种写法统一解析成**库目录**的绝对路径。
 *
 * 允许传入 `.stash` 索引文件本身或库目录本身 —— 两者都指向同一个库（与 openLibrary 同口径）。
 * 导出是为了让 `main.ts` 的 `library:forget` handler 能用**同一份**规范化结果判断
 * 「要移的是不是当前库」，避免两边各写一份路径比较而分叉
 * （Windows 路径大小写不敏感，比较口径必须只有一处）。
 */
export function normalizeLibraryPath(target: string): string {
  const raw = target.toLowerCase().endsWith('.stash') ? dirname(target) : target
  return resolve(raw)
}

/**
 * 把库从「软件里」移除：只删 `config.json` 的最近库记录，**绝不碰磁盘**。
 *
 * 为什么不做任何 `existsSync(.stash)` 校验：目录被外部删掉/移走的死记录**同样要能移除**，
 * 那正是用户最需要清掉它的时候。旧 `deleteLibrary` 的 `ERR_NOT_A_LIBRARY` /
 * `ERR_NOT_REGISTERED` 两个校验随之一起消失。
 *
 * 当前库的「停监听 + 关连接」不在这里做 —— `library.ts` 不能 import `watcher.ts`（会成环，
 * 见 handles.ts 的头注释）。由 `main.ts` 的 handler 先 unwatch 再 close，顺序与 `library:close` 一致。
 */
export function forgetLibrary(target: string): { removed: boolean } {
  return { removed: removeRecentLibrary(normalizeLibraryPath(target)) }
}

// —— 文件夹（与库目录真实文件夹 1:1）——

/**
 * 校验文件夹名。规则与素材名**完全同一套**（空 / `.` / `..` / 非法字符 / 保留设备名 /
 * 以点或空格结尾 —— 末者 Windows 会静默裁掉，导致磁盘目录名与索引 path 不一致），
 * 实现下沉到 `paths.ts` 的 `validateName`。审计 §2.16：此前两处各写一份、连常量都各维护一份，
 * 是「改一处漏一处 → 两个入口行为不一致」的温床。
 */
export function validateFolderName(raw: string): string {
  return validateName(raw)
}

/**
 * 库内相对路径 → 绝对路径，并做越界校验。
 * 用 path.relative 而不是 startsWith：库路径可能是正斜杠，与 join 产出的反斜杠永不相等。
 */
function resolveInLib(libPath: string, relPath: string): string {
  const parts = relPath.split(/[\\/]+/).filter(Boolean)
  const abs = join(libPath, ...parts)
  const rel = relative(libPath, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('ERR_OUTSIDE_LIBRARY')
  return abs
}

/**
 * 取某文件夹及其整棵子树的 folders 行。
 * 过滤规则共用 `paths.ts` 的 `subtreeOfPath`（与 `assets.ts` 的 `subtreeIds` 同一份，审计 §2.16）：
 * 内存 path 前缀比较，不用 SQL LIKE —— 文件夹名里含 `_` / `%` 时 LIKE 会误匹配。
 */
function subtreeRows(db: DB, rootPath: string): Array<{ id: number; path: string }> {
  const all = db.prepare('SELECT id, path FROM folders').all() as Array<{ id: number; path: string }>
  return subtreeOfPath(all, rootPath)
}

/** 在库内创建真实目录并同步索引，relPath 用 / 分隔 */
export function mkdirRel(relPath: string): { id: number; path: string } {
  const { db, path: libPath } = requireCurrent()
  const parts = relPath.split(/[\\/]+/).filter(Boolean)
  const abs = resolveInLib(libPath, relPath)
  mkdirSync(abs, { recursive: true })
  return ensureFolderRows(db, parts)
}

/**
 * 在指定父文件夹下新建子文件夹（parentPath 为空 = 库根目录）。
 * 逐级 mkdir + ensureFolderRows 天然支持多级，所以「新建多级子文件夹」只要嵌套调用即可。
 */
export function mkdirChild(parentPath: string, rawName: string): { id: number; path: string } {
  const { db } = requireCurrent()
  const name = validateFolderName(rawName)
  const parent = (parentPath ?? '').replace(/^[/\\]+|[/\\]+$/g, '')
  if (parent) {
    const p = db.prepare('SELECT id FROM folders WHERE path=?').get(parent)
    if (!p) throw new Error('ERR_FOLDER_NOT_FOUND')
  }
  const rel = parent ? `${parent}/${name}` : name
  if (db.prepare('SELECT id FROM folders WHERE path=?').get(rel)) throw new Error('ERR_FOLDER_EXISTS')
  return mkdirRel(rel)
}

/**
 * 重命名文件夹：物理目录先改名，成功后再在同一事务里同步
 * folders 子树的 path 与 assets.rel_path（否则素材会指向不存在的老路径）。
 * 索引写失败则把物理目录名改回去，避免磁盘与索引不一致。
 *
 * ⚠️ **异步**（返回 Promise）：正向改名走 `renameWithRetry` 的有界重试 —— Windows 上只要该目录内
 * 任一文件此刻被打开（我们自己的缩略图生成中、资源管理器生成缩略图、杀软扫描、索引器……），
 * `renameSync(目录)` 就会抛 `EPERM`（实测见 `.workbuddy/audit/probe-libvips-rename.mjs`）。
 * 这类占用多半是瞬时的，重试几次通常就好了；重试期间 `await` 让出主进程，界面不卡。
 *
 * ⚠️ **rename 之后的 DB 事务必须仍留在同一个同步块内、中间不得再有 await**：
 * 一旦事务里出现 await，事件循环里别的 IPC 就可能插进这半开的事务读到中间态。
 * 所以本函数的形状是：`await` 物理改名（事务外）→ 同步的 `BEGIN…COMMIT`（一个 await 都没有）。
 *
 * ==================== 三级隔离 + 分步自证（2026-10-16 第三轮）====================
 *
 * 前两轮各修了一条成因，但用户环境里仍然失败。第三轮用「形状像用户库」的临时库
 * **稳定复现**了（`.workbuddy/audit/probe-real-lib-rename.mts`：5 个一级目录，其中一个含 11 个子目录 /
 * 235 个文件 / 真 watchLibrary / 真 backfill → 顶层改名 **EPERM ×7 → ERR_FOLDER_BUSY**；
 * `unwatchLibrary()` 之后同一个改名 **5ms 成功**）。形状判据（`probe-watch-shape.mts`）：
 *   · 顶层目录**只含文件**        → 改名 OK
 *   · 顶层目录含 1 个 / 11 个子目录 → 改名 **EPERM**
 *   · 停掉 watcher 后三种形状      → 全部 **OK**
 * ⇒ 真凶是 **chokidar 的逐目录 `fs.watch` 句柄**（Windows 上「子目录被打开着」就会挡住祖先目录改名），
 * 与「谁打开了文件」无关 —— 这也解释了为什么「释放预览读流」在用户那儿没生效。
 *
 * 所以改名前按**代价从低到高**分级隔离，每级都留痕（`handles.beginRenameIsolationTrail`）：
 *   1) 释放我方预览读流（毫秒级，且用户可见收益：不打断播放）；
 *   2) 暂停我方后台泵（缩略图 / 元数据扫描）并**有界**等在场上收尾 —— 避免边改名边开新句柄；
 *   3) 试探改名：先给**短预算**（默认 3 次 × 0 延迟 ≈ 0ms）直改；
 *      失败才停掉目录监听器（**等 chokidar 真的 close**）再试一次。
 *      ⚠️ 绝不能靠「把重试预算加长」兜——对常驻的 watcher 句柄重试一万次也没用（本轮实测 3380ms 全失败）。
 *   4) finally 恢复：先重挂监听器 → 再恢复泵 → 最后解除媒体抑制。**顺序不能反**：
 *      监听器挂回去之后若还要再改一次名（索引失败回滚），又会撞同一批句柄。
 *      所以「索引事务 + 物理回滚」整段都在隔离窗口**之内**。
 *
 * 为什么先试探再升级（而不是一律先停 watcher）：绝大多数改名（平铺目录 / 没开库监听）一次就成，
 * 停监听器会让「改名这几百毫秒内的外部改动」丢事件（见下方取舍说明），能不停就不停。
 *
 * 取舍（明确记录，别默默忽略）：监听器停掉 → 重挂到 chokidar `ready` 之间的外部改动**不会**被索引。
 * 这个窗口不是「毫秒级」那么乐观：实测（`probe-real-lib-rename.mts`）停监听≈几毫秒，
 * 但重挂后 chokidar 要**走完整棵树**才 ready，250 个文件/12 个目录的库上约 1.5s；
 * 期间写进去的文件会被 `ignoreInitial: true` 当成「初始状态」直接吞掉（实测：改名后立刻写 → 未索引；
 * 等 ready 后写 → 正常索引）。**没有**在重挂后加全库 rescan：一次 rescan 要重算 250+ 文件的 hash
 * （用户库 259MB，秒级 IO），且与 watcher 的 add 回调之间存在「重复插行」的竞态
 * （`assets` 表没有 `rel_path` 唯一约束，靠 watcher 里先查后插来去重）。
 * 加一个半吊子 rescan 引入新 bug 的风险大于它省下的那点概率；风险留在这里，
 * 等真的出现「改完名立刻拖文件进去 → 没出现」的投诉，再做**带幂等键**的定向补扫。
 *
 * 依赖方向：本文件不能 import `preview` / `watcher` / `thumbs` / `genmeta`（都会经 library 成环，
 * MEMORY I3），全部走 `handles.ts` 的注册表。
 */

/**
 * 改名隔离链的可选项 —— **只给冒烟用的测试缝**（生产调用点是 IPC，只传两个参数）。
 *
 * 为什么需要：`EPERM` 的**真实**成因（watcher 句柄）在冒烟环境里未必每次都能复现（取决于盘速/时序），
 * 而「第 2 级隔离真的会被触发、触发后真的能成功」必须被**确定性**覆盖。
 * 注入一个「watcher 在场就抛 EPERM、watcher 停了就真改名」的 `renameFn`，
 * 就能稳定走到第 3b 步，且判据带鉴别力（把 suspend 那步删掉 → 立刻变红）。
 */
export interface RenameFolderOptions {
  /** 第 3a 步（直改试探）的最多尝试次数，默认 3 */
  renameAttempts?: number
  /** 第 3a 步每次重试前的等待（毫秒），默认 `[0, 0]` —— 试探就是**不该等** */
  renameDelays?: number[]
  /** 真正执行改名的函数（默认 `fs.renameSync`），测试缝 */
  renameFn?: (from: string, to: string) => void
}

/**
 * 文件夹**写操作**的串行闸门（promise 链）。
 *
 * 为什么必须有（QA 第四轮实测）：双击回车会让两次 `renameFolder` 并行进来 ——
 * 第一次改完名后第二次再去改，物理目录已不存在 → 抛**裸 `ENOENT`**，
 * 而渲染层的错误映射表里没有这个键，用户看到的是带完整路径的原始英文错误。
 * 串行之后，第二次调用会**重新读一次行**（`row.name === name`）→ 早返回 `{folders:0}`，
 * 用户看到的就是「已经改好了」，没有任何泄漏。
 *
 * 顺带收掉另外两个同源隐患：并发「改名 + 删除」、并发「删除 + 删除」——
 * 它们都在同一份 folders 行上做「读 → 改」而不是事务，交错时会撞 UNIQUE(path)。
 */
let folderWriteGate: Promise<unknown> = Promise.resolve()

/** 把一次文件夹写操作排进串行队列（内部用；`renameFolder` / `deleteFolder` 已自动排队） */
export async function withFolderWriteLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const prev = folderWriteGate
  let release: () => void = () => undefined
  folderWriteGate = new Promise<void>((r) => {
    release = r
  })
  // 前一个失败绝不能挡住后一个（每条链只 resolve，这里 catch 是纯保险）
  await prev.catch(() => undefined)
  try {
    return await fn()
  } finally {
    release()
  }
}

export async function renameFolder(
  id: number,
  rawName: string,
  opts: RenameFolderOptions = {}
): Promise<{ id: number; path: string; folders: number; assets: number }> {
  // ⚠️ 排队必须在**读行之前**：第二次并发调用要读到第一次的最终状态（row.name === name → 早返回）
  return withFolderWriteLock(() => renameFolderUnlocked(id, rawName, opts))
}

async function renameFolderUnlocked(
  id: number,
  rawName: string,
  opts: RenameFolderOptions
): Promise<{ id: number; path: string; folders: number; assets: number }> {
  const { db, path: libPath } = requireCurrent()
  const name = validateFolderName(rawName)
  const row = db.prepare('SELECT id, path, name FROM folders WHERE id=?').get(id) as
    | { id: number; path: string; name: string }
    | undefined
  if (!row) throw new Error('ERR_FOLDER_NOT_FOUND')
  if (row.path.startsWith('.')) throw new Error('ERR_PROTECTED_FOLDER')
  if (row.name === name) return { id, path: row.path, folders: 0, assets: 0 }

  const parentPath = row.path.includes('/') ? row.path.slice(0, row.path.lastIndexOf('/')) : ''
  const newRel = parentPath ? `${parentPath}/${name}` : name
  const oldAbs = resolveInLib(libPath, row.path)
  const newAbs = resolveInLib(libPath, newRel)
  // 仅大小写变化（Photos → photos）时 Windows 认为同一目录，existsSync 恒真，需要放行
  const caseOnly = oldAbs.toLowerCase() === newAbs.toLowerCase()
  if (!caseOnly) {
    if (db.prepare('SELECT id FROM folders WHERE path=?').get(newRel)) throw new Error('ERR_FOLDER_EXISTS')
    if (existsSync(newAbs)) throw new Error('ERR_FOLDER_EXISTS')
  }
  if (!existsSync(oldAbs)) throw new Error('ERR_FOLDER_MISSING')

  // 物理改名：有界重试（占用常见且多为瞬时），事务外
  //
  // ⚠️ 从这里到函数末尾全部包在「隔离窗口」里（见函数头的三级隔离说明）：
  //    媒体抑制开着、泵停着、（必要时）监听器停着 —— **索引事务与物理回滚也在窗口内**，
  //    否则回滚那次 rename 会再撞上刚挂回去的 watcher 句柄。
  const trail = beginRenameIsolationTrail(oldAbs, newAbs)
  const tStarted = Date.now()
  const directAttempts = Math.max(1, opts.renameAttempts ?? 3)
  const directDelays = opts.renameDelays ?? [0, 0]
  try {
    // —— 第 1 级：放掉我们自己的预览读流（见函数头）——
    // `releaseMediaUnderAsync` 会 destroy 并**等所有流 close**（探针 [b]：实测 1ms）——
    // 只 destroy 不等是**无效**的（探针 [c1]/[c2]：同一 tick 与下一个 setImmediate 都还是 EPERM）。
    trail.releaseStreams = await releaseMediaUnderAsync(oldAbs)
    trail.steps.push('media-release')
    if (trail.releaseStreams > 0) console.log(`[library] 重命名前释放了 ${trail.releaseStreams} 个预览读流：${oldAbs}`)
    // 再开抑制窗口，挡住「释放后渲染层立刻重开句柄」（探针 [d]），否则释放与 rename 之间会被插进来。
    suppressMediaUnder(oldAbs)

    // —— 第 2 级：暂停我方后台泵（缩略图 / 元数据扫描），有界等在场上收尾 ——
    trail.pumps = await pauseIsolatedPumps(RENAME_PUMP_PAUSE_MS)
    trail.pumpPaused = true
    trail.steps.push('pump-pause')
    if (trail.pumps.length)
      console.log(
        `[library] 改名隔离：已暂停 ${trail.pumps.map((p) => `${p.pump}(${p.inFlight} 在跑/${p.waitedMs}ms)`).join('、')}`
      )

    // —— 第 3 级：试探改名 → 失败则停掉目录监听器再试 ——
    trail.directAttempted = true
    trail.steps.push('probe-rename')
    try {
      await renameWithRetry(oldAbs, newAbs, {
        attempts: directAttempts,
        delays: directDelays,
        renameFn: opts.renameFn
      })
      trail.successAt = 'direct'
    } catch (e) {
      // 只有「重试耗尽的占用」才值得升级隔离；EXDEV / ENOENT 这类升到第几级都没用，直接抛。
      if (!isBusyRenameError(e)) throw e
      trail.directFailed = true
      console.warn(
        `[library] 改名试探失败（${directAttempts} 次短预算，占用未消失）→ 第 2 级隔离：停掉库监听器再试。${oldAbs}`
      )
      trail.watcherWasActive = await suspendWatcherForRename()
      trail.watcherSuspended = trail.watcherWasActive
      if (!trail.watcherWasActive) {
        // 本来就没在监听 → 没有第 2 级可做，把原错误（裸码 ERR_FOLDER_BUSY）如实抛出去
        console.warn(`[library] 隔离步骤已全部用尽（无监听器可停），改名仍失败：${oldAbs}`)
        throw e
      }
      trail.steps.push('suspend-watcher')
      await renameWithRetry(oldAbs, newAbs, {
        // 短退避只为「句柄释放的最后几毫秒」，**不是**靠加长预算兜底（那对常驻句柄无效）
        attempts: 5,
        delays: [0, 20, 50, 100, 200],
        renameFn: opts.renameFn
      })
      trail.successAt = 'after-unwatch'
      console.warn(
        `[library] 第 2 级隔离成功：停掉库监听器后改名通过 → 元凶是 chokidar 的逐目录句柄。${oldAbs}`
      )
    }

    // 父先子后更新，避免 UNIQUE(path) 出现暂时冲突
    const sub = subtreeRows(db, row.path).sort((a, b) => a.path.length - b.path.length)
    const subIds = sub.map((f) => f.id)
    const ph = subIds.map(() => '?').join(',')
    const assetRows = db
      .prepare(`SELECT id, name, folder_id FROM assets WHERE folder_id IN (${ph})`)
      .all(...subIds) as Array<{ id: number; name: string; folder_id: number }>

    let folders = 0
    let assets = 0
    try {
      db.exec('BEGIN')
      const setPath = db.prepare('UPDATE folders SET path=? WHERE id=?')
      const setName = db.prepare('UPDATE folders SET name=? WHERE id=?')
      for (const f of sub) {
        // 自身换成新名；子孙只换前缀
        const np = f.path === row.path ? newRel : newRel + f.path.slice(row.path.length)
        setPath.run(np, f.id)
        folders++
      }
      setName.run(name, row.id)

      const newPathById = new Map<number, string>()
      for (const f of sub) newPathById.set(f.id, f.path === row.path ? newRel : newRel + f.path.slice(row.path.length))
      const setRel = db.prepare('UPDATE assets SET rel_path=? WHERE id=?')
      for (const a of assetRows) {
        setRel.run(`${newPathById.get(a.folder_id)}/${a.name}`, a.id)
        assets++
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      // 索引没改成 → 物理目录名也改回去，保持两边一致。
      // 回滚是 best-effort，用**短重试**（2~3 次）：此刻目录刚被我们改过名，几乎没有占用来源，
      // 但保险起见仍给它一次瞬时占用的机会；失败也只是「磁盘目录名没改回来」，不影响抛出的原错误。
      // ⚠️ 这次回滚**在隔离窗口内**（监听器还没挂回去、泵还停着），否则它会再撞上同一批句柄。
      try {
        await renameWithRetry(newAbs, oldAbs, { attempts: 3, delays: [0, 80], renameFn: opts.renameFn })
      } catch {
        /* 回滚物理也失败，只能把错误抛出去 */
      }
      throw e
    }
    return { id, path: newRel, folders, assets }
  } catch (e) {
    trail.failed = true
    if (isBusyRenameError(e)) {
      // 结果仍抛**裸码** `ERR_FOLDER_BUSY`（渲染层的错误映射表是精确查表，见 fsutil.busyRenameError）——
      // 「已做过哪些隔离步骤」只进主进程日志，不进 message。
      console.warn(
        `[library] 文件夹改名失败，已做的隔离步骤：${trail.steps.join(' → ') || '（无）'} —— ${oldAbs}`
      )
    }
    throw e
  } finally {
    trail.elapsedMs = Date.now() - tStarted
    // 恢复顺序（别改）：先重挂监听器 → 再恢复泵 → 最后解除媒体抑制。
    //  - 监听器必须先回来：它停着的每一毫秒都在丢外部改动事件；
    //  - 泵其次：缩略图队列停久了用户会看到一片灰卡片；
    //  - 抑制最后：它只影响 `stash://media`，早一点解会允许渲染层重开句柄（改名已完成，无碍，
    //    但放在最后更安全：万一重挂监听器抛了，抑制仍在窗口内，不会出现「半恢复」）。
    // 每一步都单独 try：任何一步失败都不能让后面的恢复被跳过（否则「改一次名把预览/监听永久弄坏」）。
    if (trail.watcherSuspended) {
      try {
        trail.watcherRestarted = restartWatcherAfterRename(libPath, db)
      } catch (e) {
        trail.watcherRestarted = false
        console.warn('[library] 改名后重挂库监听器抛异常：', e)
      }
      // 'restore-watcher' 与下面的 'resume-pump' **必须是两个独立步骤**：
      // 顺序（先监听器、后泵）是恢复契约，合成一个就再也测不出「被写反」（QA 的 E2）。
      trail.steps.push('restore-watcher')
      if (!trail.watcherRestarted) {
        console.warn('[library] 改名后重挂库监听器失败：外部改动将不再自动同步（下次开库会恢复）')
      } else {
        // 重挂 → ready 之间的文件会被 ignoreInitial 吞掉，必须补一次「磁盘 → 索引」对账。
        // 不 await：对账是收尾，不该算进用户等的那几百毫秒。
        // ⚠️ 必须自己 try：`reconcileWhenReady` 自身是把异常吞了的，但**排程这一刻**也可能抛
        // （例如注册表里没有这个能力）。收尾动作一旦抛出去，就会把「改名已成功」变成一个失败返回。
        try {
          reconcileAfterWindow(libPath, db)
        } catch (e) {
          console.warn('[library] 排程盲窗对账失败（不影响改名结果）：', e)
        }
      }
    }
    try {
      resumeIsolatedPumps()
      trail.pumpResumed = true
    } catch (e) {
      console.warn('[library] 改名后恢复后台泵抛异常：', e)
    }
    trail.steps.push('resume-pump')
    clearMediaSuppression()
    // 自证一行：用户下次复现时，这行日志就能直接回答「到第几步才成功 / 是否全部失败」
    // ⚠️ 「监听器」一栏要分三种情况说清楚（这是本行存在的全部意义，别写成一坨）：
    //    · `已停→已重挂`：第 2 级隔离被触发且成功 → **元凶就是 chokidar 的逐目录句柄**；
    //    · `未触发(直改成功)`：第 3a 步就过了 → 本次改名没有目录句柄挡路；
    //    · `原本未监听`：第 3a 失败但根本没监听器可停（例如没开库/冒烟未启监听）→ 元凶不是我们。
    const watcherCol = trail.watcherSuspended
      ? trail.watcherRestarted
        ? '已停→已重挂'
        : '已停→重挂失败'
      : trail.directFailed
        ? '原本未监听(无可停)'
        : '未触发(直改成功)'
    console.warn(
      `[rename-isolation] ${trail.failed ? '失败' : '成功'}｜结果=${trail.successAt ?? '全部失败'}` +
        `｜流=${trail.releaseStreams}｜泵=${trail.pumpPaused ? '已暂停→已恢复' : '未暂停'}` +
        `｜监听器=${watcherCol}` +
        `｜步骤=${trail.steps.join(',')}｜耗时=${trail.elapsedMs}ms｜${oldAbs} -> ${newAbs}`
    )
  }
}

/**
 * 挑选并删除「一个素材都没挂」的标签，返回被删掉的标签（供 UI 提示）。
 *
 * 背景：标签的全部用途就是给素材分类，挂着 0 个素材的标签没有任何信息量 ——
 * 留在侧栏只会显示一个孤零零的 `0`，看起来像 bug（用户就是这么报上来的）。
 *
 * ⚠️ 分两种调用场景，别混：
 *  - **业务路径**（摘标签 / 删素材 / 删文件夹）用 `pruneUnlinkedTags(db, candidates)`，
 *    只在自己刚摘掉关联的那些标签里找。**绝对不能在这里全表扫「空的标签」**：
 *    `createTag` 与 `setTags` 之间有窗口期，新建的标签在挂上任何素材之前就是「空的」，
 *    全表扫会当场把它误删，紧接着 `setTags` 插关联就会撞 `FOREIGN KEY constraint failed`
 *    （这个坑是写冒烟时踩出来的：脚本先连建两个标签再逐个挂，第一个 `setTags` 就把
 *    第二个还没挂上的标签清掉了）。
 *  - **打开库时**用 `pruneAllEmptyTags(db)` 全量扫一次，收掉老版本遗留的脏数据 ——
 *    这个时点不存在「用户正在创建标签」的状态，安全。
 *
 * 两者都用 `NOT EXISTS` 而不是 `NOT IN`：后者在子查询结果含 NULL 时恒为空集（经典陷阱）。
 */
function selectEmptyTags(db: DB, candidates: number[] | null): Array<{ id: number; name: string }> {
  const listed = candidates && !candidates.length ? [] : candidates
  const ph = listed?.map(() => '?').join(',')
  const rows = (
    listed
      ? db
          .prepare(
            `SELECT t.id, t.name FROM tags t
              WHERE t.id IN (${ph})
                AND NOT EXISTS (SELECT 1 FROM asset_tags a WHERE a.tag_id = t.id)`
          )
          .all(...listed)
      : db
          .prepare(
            'SELECT t.id, t.name FROM tags t WHERE NOT EXISTS (SELECT 1 FROM asset_tags a WHERE a.tag_id = t.id)'
          )
          .all()
  ) as Array<{ id: number; name: string }>
  if (!rows.length) return []
  db.prepare(`DELETE FROM tags WHERE id IN (${rows.map(() => '?').join(',')})`).run(...rows.map((t) => t.id))
  return rows
}

/** 只清理「刚被摘掉关联」的那些标签（业务路径用，理由见 `selectEmptyTags`） */
export function pruneUnlinkedTags(db: DB, candidates: number[]): Array<{ id: number; name: string }> {
  return selectEmptyTags(db, candidates)
}

/** 全量清理空标签（打开库时用，理由见 `selectEmptyTags`） */
export function pruneAllEmptyTags(db: DB): Array<{ id: number; name: string }> {
  return selectEmptyTags(db, null)
}

/**
 * **同步**删除一个物理目录树（best-effort 重试一次）。
 *
 * 为什么要重试（QA 第四轮实测的数据丢失）：`rmSync(recursive)` 在 Windows 上是深度优先，
 * 删到某个**目录**时若它（或它的子目录）上还挂着 chokidar 的句柄，就会抛 `ENOTEMPTY`
 * —— 而此刻**文件已经全被删掉了**，只留下空目录。用户的表现就是「点了删除，报错，图没了」。
 * 隔离（停监听器）已经从根上消除该占用；这里再补一次重试，专门兜住「隔离之后仍有残余句柄」的
 * 最后一瞬 —— 第二次通常就干净删完，把「数据丢失」变成「删除成功」。
 */
function rmTreeWithRetry(abs: string, attempts = 2): void {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(abs, { recursive: true, force: true })
      return
    } catch (e) {
      last = e
      if (i < attempts - 1) console.warn('[library] 删除目录第一次失败（已隔离），立刻重试一次：', e)
    }
  }
  throw last
}

/**
 * 删除失败后的**索引侧收口**：把「磁盘上已经不存在、但索引里还 `missing=0`」的行标成失效。
 *
 * 为什么必须有（QA 第四轮用外部独占锁实测）：`rmTreeWithRetry` 只能救**瞬时**占用 ——
 * 两次尝试在同一个同步块里、中间没有让位，只要句柄被别的进程**常驻**持有就必然两次都失败。
 * 而 `rmSync(recursive)` 是深度优先：文件先被删光，撞到某个目录时才抛错。于是最坏形态是
 * **一部分文件已经没了 + DB 原封 + 卡片照常显示**（用户眼里的「点了删除，图没了，界面还在」）。
 * 既然「删失败」无法伪装成「删成功」，那就把能如实反映的部分如实反映：
 * 已消失的行标 `missing=1`（卡片变灰/失效），还活着的行保持原样。
 *
 * ⚠️ 只动 `missing` 一列，不删行、不动用户字段（评分/标签/备注）—— 用户还有机会把文件找回来。
 * ⚠️ 走 `subtreeOfPath` 做内存前缀比较，不用 SQL `LIKE`（目录名含 `_`/`%` 时会误匹配，见 escapeLike）。
 */
function markMissingOnDisk(db: DB, libPath: string, rootPath: string): number {
  const rows = db.prepare('SELECT id, rel_path FROM assets WHERE missing=0').all() as Array<{
    id: number
    rel_path: string
  }>
  const ids = new Set(subtreeOfPath(rows.map((r) => ({ id: r.id, path: r.rel_path })), rootPath).map((r) => r.id))
  if (!ids.size) return 0
  const stmt = db.prepare('UPDATE assets SET missing=1 WHERE id=? AND missing=0')
  let marked = 0
  for (const r of rows) {
    if (!ids.has(r.id)) continue
    if (existsSync(join(libPath, ...r.rel_path.split('/')))) continue
    marked += Number(stmt.run(r.id).changes)
  }
  return marked
}

/**
 * 删除整个文件夹：**直接从磁盘删除**，不进回收站，不可恢复。
 *
 * 顺序与 deleteAssets 保持一致：先把物理目录整棵 rmSync 掉，成功后才清索引；
 * 物理删除失败（被占用/权限）就抛错且不动索引，避免留下「有记录没文件」的幽灵条目。
 * 索引清理含三部分：该子树的 assets 行（asset_tags 靠外键 CASCADE 自动清）、
 * folders 行、以及无其他素材引用的 .thumbs/<hash> 缓存。
 *
 * ⚠️ **异步**（QA 第四轮的高危缺陷）：这里必须走和 `renameFolder` 同一套隔离 ——
 * `rmSync(recursive)` 删到**含子目录**的目录时会撞上 chokidar 的逐目录句柄，
 * 抛 `ENOTEMPTY` 时**文件已经被删光**（实测：3 层嵌套 files 3→0，DB 2 行未动，无回收站）。
 * 所以顺序是：释放媒体流 → 停泵 → **停监听器（等句柄释放）** → rmTreeWithRetry →
 * （索引清理也在隔离窗口内，避免 unlink 事件把即将删除的行刷成 missing）→
 * finally：重挂监听器 + 对账 → 恢复泵 → 解抑制。
 *
 * ⚠️ 因为连带删了素材，挂在那些素材上的标签可能归零，所以最后要清一次空标签。
 * 候选集必须在 `DELETE FROM assets` **之前**取，删完关联就查不到了。
 */
export async function deleteFolder(id: number): Promise<{
  folders: number
  assets: number
  thumbsRemoved: number
  pruned: Array<{ id: number; name: string }>
}> {
  // 与 renameFolder 共用一把串行锁：并发「删 + 改 / 删 + 删」会在同一份 folders 行上撞 UNIQUE(path)
  return withFolderWriteLock(() => deleteFolderUnlocked(id))
}

async function deleteFolderUnlocked(id: number): Promise<{
  folders: number
  assets: number
  thumbsRemoved: number
  pruned: Array<{ id: number; name: string }>
}> {
  const { db, path: libPath } = requireCurrent()
  const row = db.prepare('SELECT id, path FROM folders WHERE id=?').get(id) as { id: number; path: string } | undefined
  if (!row) throw new Error('ERR_FOLDER_NOT_FOUND')
  // 库内的隐藏目录（.thumbs 等）永远不该被当普通文件夹删掉
  if (row.path.startsWith('.')) throw new Error('ERR_PROTECTED_FOLDER')

  const sub = subtreeRows(db, row.path)
  const subIds = sub.map((f) => f.id)
  const ph = subIds.map(() => '?').join(',')

  const abs = resolveInLib(libPath, row.path)

  // —— 隔离窗口开始（与 renameFolder 同源，理由见函数头）——
  await releaseMediaUnderAsync(abs)
  suppressMediaUnder(abs)
  let watcherSuspended = false
  try {
    await pauseIsolatedPumps(RENAME_PUMP_PAUSE_MS)
    watcherSuspended = await suspendWatcherForRename()
    // ⚠️ 删除失败**不能静默**：rmSync 是深度优先，抛错时文件往往已经被删掉一部分。
    // 这里把「已消失的行」标成 missing=1（卡片失效），再抛一个**明确的错误码**给渲染层
    // （`ERR_FOLDER_DELETE_PARTIAL` → SideBar 的 FOLDER_ERR 有对应人话文案），
    // 绝不把原始 `EBUSY/ENOTEMPTY + 完整路径` 泄漏给用户，也绝不假装删除成功。
    try {
      if (existsSync(abs)) rmTreeWithRetry(abs)
    } catch (rmErr) {
      const marked = markMissingOnDisk(db, libPath, row.path)
      console.warn(
        `[library] 删除文件夹失败（已删除的文件已标记失效 ${marked} 条）：${row.path}`,
        rmErr
      )
      throw new Error('ERR_FOLDER_DELETE_PARTIAL')
    }

    const assetRows = db
      .prepare(`SELECT id, content_hash FROM assets WHERE folder_id IN (${ph})`)
      .all(...subIds) as Array<{ id: number; content_hash: string | null }>

    // 空标签清理的候选集：这些素材当前挂着的标签。**必须在 DELETE 之前取**，
    // 删完 asset_tags 就一起没了，事后无从知道该检查哪些标签
    const affectedTagIds = (
      db
        .prepare(
          `SELECT DISTINCT tag_id FROM asset_tags
            WHERE asset_id IN (SELECT id FROM assets WHERE folder_id IN (${ph}))`
        )
        .all(...subIds) as Array<{ tag_id: number }>
    ).map((r) => r.tag_id)

    try {
      db.exec('BEGIN')
      db.prepare(`DELETE FROM assets WHERE folder_id IN (${ph})`).run(...subIds)
      db.prepare(`DELETE FROM folders WHERE id IN (${ph})`).run(...subIds)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }

    // 缩略图缓存：hash 校验通过（同时防目录穿越）且已无任何素材引用时才删
    let thumbsRemoved = 0
    const stillUsed = db.prepare('SELECT count(*) AS c FROM assets WHERE content_hash=?')
    for (const a of assetRows) {
      const hash = a.content_hash
      if (!isThumbHash(hash)) continue
      if ((stillUsed.get(hash) as { c: number }).c) continue
      try {
        rmSync(join(libPath, '.thumbs', hash), { recursive: true, force: true })
        thumbsRemoved++
      } catch {
        /* 缓存清理失败不影响删除结果 */
      }
    }
    // 素材行删掉后，挂在它们身上的标签可能一个素材都不剩了
    const pruned = pruneUnlinkedTags(db, affectedTagIds)
    return { folders: sub.length, assets: assetRows.length, thumbsRemoved, pruned }
  } finally {
    // 恢复顺序与 renameFolder 一致（先监听器、后泵、最后解抑制），见那里的说明。
    if (watcherSuspended) {
      const restarted = restartWatcherAfterRename(libPath, db)
      if (!restarted) {
        console.warn('[library] 删除文件夹后重挂库监听器失败：外部改动将不再自动同步（下次开库会恢复）')
      } else {
        // 窗口内外部新增的文件同样会被 ignoreInitial 吞掉 → 对账兜底（同一份逻辑，别写第二份）
        // 同样自己 try：收尾失败不能污染「删除已成功」这个结果
        try {
          reconcileAfterWindow(libPath, db)
        } catch (e) {
          console.warn('[library] 排程盲窗对账失败（不影响删除结果）：', e)
        }
      }
    }
    resumeIsolatedPumps()
    clearMediaSuppression()
  }
}

/**
 * 为已存在的物理目录补齐 folders 表行（不建目录），返回最深层 id。
 * 导出供 watcher 复用：外部（资源管理器）新建的子目录物理上已存在，但 folders 表里没有行，
 * 直接 INSERT asset 会因 `folder_id NOT NULL` 违约 —— 这里把各级祖先一起补上。
 */
export function ensureFolderRows(db: DB, parts: string[]): { id: number; path: string } {
  let parentId: number | null = null
  let cur = ''
  let lastId = 0
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part
    const exist = db.prepare('SELECT id FROM folders WHERE path=?').get(cur) as { id: number } | undefined
    if (exist) {
      lastId = exist.id
    } else {
      const r = db.prepare('INSERT INTO folders(parent_id,path,name,created_at) VALUES(?,?,?,?)').run(parentId, cur, part, Date.now())
      lastId = Number(r.lastInsertRowid)
    }
    parentId = lastId
  }
  return { id: lastId, path: cur }
}

export function listFolders(): Array<{ id: number; parent_id: number | null; path: string; name: string }> {
  const { db } = requireCurrent()
  return db.prepare('SELECT id, parent_id, path, name FROM folders ORDER BY path').all() as never
}
