import chokidar, { type FSWatcher } from 'chokidar'
import { basename, extname, join, relative } from 'path'
import { renameSync, rmSync, statSync } from 'fs'
import { opendir } from 'fs/promises'
import { BrowserWindow } from 'electron'
import { contentHash, EXT_TYPE } from './importer'
import { ensureFolderRows, mkdirRel } from './library'
import { uniqueName } from './naming'
import { isThumbHash, relFromLib } from './paths'
import { escapeLike, type DB } from './db'

let watcher: FSWatcher | null = null

/**
 * 当前 watcher 是否已经 `ready`（chokidar 走完整棵树、所有 `fs.watch` 都建好了）。
 *
 * 为什么需要它（第三轮补）：改名/删除时我们会**整库停掉监听器**，重挂后 chokidar 要从头走一遍树
 * 才 ready；这段窗口里写进库的文件会被 `ignoreInitial: true` 当成「初始状态」直接吞掉
 * （实测 250 文件库 ≈1.5s，QA 实测 305 目录 1540ms）。所以重挂之后必须**等 ready**
 * 再做一次「磁盘 → 索引」对账（见 `reconcileWhenReady`），否则那些文件永远进不了索引。
 */
let watcherReady = false
/** `whenWatcherReady()` 的等待者；watcher 就绪（true）或被摘掉（false）时统一唤醒 */
let readyWaiters: Array<(ok: boolean) => void> = []

function settleReadyWaiters(ok: boolean): void {
  const list = readyWaiters
  readyWaiters = []
  for (const fn of list) fn(ok)
}

/**
 * 等到当前 watcher `ready`（或超时 / 被摘掉）。**没有 watcher 时立刻返回 false**。
 *
 * @param timeoutMs 上限兜底（默认 10s）：绝不让调用方（对账）永久悬着。
 * @returns `true` = 已 ready；`false` = 没有 watcher、或超时、或等待期间被摘掉
 */
export function whenWatcherReady(timeoutMs = 10_000): Promise<boolean> {
  if (!watcher) return Promise.resolve(false)
  if (watcherReady) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    readyWaiters.push((ok) => finish(ok))
  })
}

/** 压缩管线写的临时文件前缀（同目录、同盘，见 compress.ts 的 tmpPathFor） */
const TMP_PREFIX = '.stash-compress-'

/**
 * 「未归属素材」的约定目录名。
 * 必须与 `importer.ts` 未指定文件夹时的兜底目录一致（那里调 `mkdirRel('未分类')`）——
 * 否则「导入」和「外部拷入根目录」两条路径会把素材归到两个不同文件夹。
 */
const UNCATEGORIZED = '未分类'

/**
 * 「这次改动是我们自己造成的」——登记后，随后那次 add/unlink 不再同步索引。
 *
 * 为什么不能只靠 `awaitWriteFinish` 的 800ms：那是**时间**保证，而原地替换在这段窗口里
 * 还要哈希大文件 + 写 sqlite，慢机器 / 网络盘上完全可能超时。一旦超时，
 * `add` 会给新文件插一行重复素材、`unlink` 会把我们刚改好的那行标成 missing。
 * 所以顺序（见 compress.ts）与显式抑制两条都要。
 *
 * 一次性消费：外部后来真的又改了同一个路径，仍然会被正常同步到。
 */
const suppressed = new Map<string, number>()

/** 让下一次针对该 rel_path 的 add/unlink 事件被忽略（默认 10s 内有效） */
export function suppressRel(rel: string, ms = 10_000): void {
  suppressed.set(rel, Date.now() + ms)
}

function consumeSuppressed(rel: string): boolean {
  const until = suppressed.get(rel)
  if (until == null) return false
  suppressed.delete(rel)
  return Date.now() <= until
}

/**
 * 外部变更的**界面刷新广播**（去抖合并）。
 *
 * 背景：watcher 的三条线（add / change / unlink）以前只改索引，没有任何通道告诉渲染层
 * → 界面上必须「重开库」才看得到外部改动（`--smoke-watch` 的注释里也这么写着）。
 * 这里在**索引确实被改动**之后累计计数，去抖窗口结束后一次性广播给**所有**窗口。
 *
 * ⚠️ 计数只在「真的改动了索引」时才 +1：
 *   · add   —— 只有 INSERT 真的成功才计数（被 consumeSuppressed / rel_path 查重 /
 *              非素材扩展名 / `.` 开头目录拦掉的一律不计）；
 *   · change—— 两个分支（只刷 mtime / 内容真变）都算，被 consumeSuppressed / 查不到行 /
 *              非文件拦掉的不计；
 *   · unlink—— 只有 `UPDATE ... .run()` 的 `changes > 0` 才算。
 * 这三条一起保证了**应用自身的导入 / 压缩 / 重命名/移动**不会产生假广播
 * （它们在同一同步块内已经把索引改好了，watcher 回调触发时按 rel_path 查不到要改的行）。
 * 否则用户每导入一次就会收到「导入完成 + 库在外部被改动」两条重复提示。
 */
/** 一次外部批次在各条线上「真正改动了索引」的行数 */
interface ExternalCounts {
  added: number
  changed: number
  removed: number
}

/**
 * 广播 payload：计数 + `partial` 标记（`partial` **恒存在**，保持契约形状稳定，别做成可选字段）。
 *
 * `partial` 区分两种 flush：
 *   · `true` —— 流**进行中**由 maxWait 触发的中途 flush（长拷贝期间定期刷新界面，别让界面僵住）；
 *   · `false`—— 流静默后由尾部去抖定时器触发的**收尾** flush。
 * 渲染层据此把「轻量刷新」与「收尾动作（bumpThumbs + 弹提示）」分开：
 * 否则长拷贝期间提示条会全程常驻、数字乱跳，且整个网格每 ~1.4s 重拉一次缩略图。
 */
interface ExternalDelta extends ExternalCounts {
  partial: boolean
}

let pendingExternal: ExternalCounts | null = null
let externalTimer: ReturnType<typeof setTimeout> | null = null
/** 本批「第一个尚未 flush 的事件」的时刻（maxWait 的计时起点）；无待发批次时为 null */
let batchStartedAt: number | null = null

/**
 * 去抖窗口。一次外部批量操作（从资源管理器拖进一个目录、Ctrl+V 粘一批图）
 * 常常触发几十个 add/change 事件 —— 合并成一次广播，用户只被打扰一次。
 */
const EXTERNAL_DEBOUNCE_MS = 400

/**
 * 去抖的**兜底上限**（maxWait）：距「本批第一个尚未 flush 的事件」最多等这么久就必须 flush 一次。
 *
 * 为什么必须有：只有尾部去抖（每次事件都 `clearTimeout` 续命）时，**持续**的事件流
 * （大批拖拷、被同步软件持续改动的目录）会让 400ms 窗口永远排不上 flush ——
 * 实测往库里每 150ms 写一个文件、连写 40 个（≈6s）时，整段流期间渲染层收到的广播数为 **0**，
 * 界面在用户最需要反馈的那几秒里完全不刷新。
 * maxWait 只保证「流进行中也会定期刷新」；它**不改变**「流结束后收尾合并成少数几条」的行为
 * （流一旦停下，最后一次 setTimeout 的去抖窗自然会 flush 掉剩余计数）。
 */
const EXTERNAL_MAX_WAIT_MS = 1400

function bumpExternal(kind: keyof ExternalCounts, n = 1): void {
  if (n <= 0) return
  const now = Date.now()
  // maxWait 兜底：若**上一段**已积压超过上限 → 先把上一段以**中途 flush(partial=true)** 送走，
  // 再让本次事件开一个新批次。关键点：触发中途 flush 的那个事件**不算进被送走的上一段**——
  // 它落到新批次里，于是「流停下时的那次收尾」必然带着至少 1 条计数：
  //   · 否则会出现「中途 flush 恰好把最后一段吃干」的退化 → 收尾计数为 0 → 提示条不弹，界面收尾动作缺失；
  //   · 且每个事件只被计一次 → 各批计数之和仍恰好 = 该批实际改动数（E1 的 sum 断言不受影响）。
  if (batchStartedAt != null && now - batchStartedAt >= EXTERNAL_MAX_WAIT_MS) flushExternal(true)
  if (!pendingExternal) pendingExternal = { added: 0, changed: 0, removed: 0 }
  pendingExternal[kind] += n
  if (batchStartedAt == null) batchStartedAt = now
  // 每次事件都（重）排「收尾」定时器：idle 满 EXTERNAL_DEBOUNCE_MS 无新事件 → 非 partial 收尾。
  // 该定时器**只**由收尾 flush 清除；中途 flush 不动它 —— 所以流停下后一定还有一次非 partial 的收尾。
  if (externalTimer) clearTimeout(externalTimer)
  externalTimer = setTimeout(() => flushExternal(false), EXTERNAL_DEBOUNCE_MS)
}

/**
 * 送出一次广播。
 * @param partial `true` = maxWait 触发的中途 flush；`false` = 尾部去抖定时器触发的收尾 flush。
 *
 * 语义：
 *   · 中途 flush 后 `pendingExternal` 清空、`batchStartedAt` 归零 —— 流继续时下一事件开新批次计时；
 *     收尾定时器**保留**（见 bumpExternal 的说明）。
 *   · 收尾 flush 是终态：清掉收尾定时器。
 *   · 正常不会出现「收尾时已无积压计数」（见 bumpExternal 的 flush-before-add：触发中途 flush 的事件
 *     总会落进新批次）；万一出现，仍补发一条**零计数**的 `partial=false` 作安全网，
 *     它纯粹是「流已结束」的信号；`partial=true` 且无计数时则直接跳过（无意义）。
 */
function flushExternal(partial: boolean): void {
  if (!partial) {
    // 收尾：清掉尾部定时器（中途 flush 不走这里，故保留定时器）
    if (externalTimer) {
      clearTimeout(externalTimer)
      externalTimer = null
    }
  }
  const counts = pendingExternal
  pendingExternal = null
  batchStartedAt = null // 下一批重新计时
  // 广播风格与 settings:changed 一致（见 main.ts）：发给**所有**窗口，而不是 [0]
  const send = (delta: ExternalDelta): void => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('library:external', delta)
  }
  if (!counts) {
    if (!partial) send({ added: 0, changed: 0, removed: 0, partial: false }) // 纯收尾信号
    return
  }
  send({ added: counts.added, changed: counts.changed, removed: counts.removed, partial })
}

/**
 * 仅供冒烟断言：当前是否持有库监听器（生产代码不依赖它）。
 *
 * 为什么值得单独导出：`unwatchLibrary()` 的效果（chokidar 释放句柄）在进程外不可见，
 * 而「删库后监听器有没有真的停掉」正是一条纯泄漏、不崩不报错的缺陷 ——
 * 需要一个直接观测「监听器存不存在」的探针，否则断言无从下手（项目已有为冒烟导出内部能力的先例，
 * 如 library 的 `ensureFolderRows`）。返回 `watcher !== null`，不含任何副作用。
 */
export function isWatching(): boolean {
  return watcher !== null
}

/**
 * 当前 watcher 已建立 watch 的**目录数量**（`getWatched()` 的键数）；没在监听返回 0。
 *
 * 仅供冒烟断言：验证「改名期间停监听→重挂」**不会留下重复 watcher**。
 * `isWatching()` 只能回答「有没有」，回答不了「有没有两份」—— 而两份 watcher 的后果是
 * 事件双发（`bumpExternal` 双计、界面收到两次「库在外部被改动」），且句柄翻倍。
 * 判据取「改名前后的目录数相等」：重挂若漏掉了旧的 close，这个数会接近翻倍。
 * 切库后目录数变化是正常的（那是不同的库），所以只在「同一个库、刚重挂完」时比较。
 */
export function watchedDirCount(): number {
  if (!watcher) return 0
  try {
    return Object.keys(watcher.getWatched()).length
  } catch {
    return -1
  }
}

/**
 * 摘掉当前监听器，并清掉「属于上一个库」的全部待发状态。**不等待 `close()` 完成**。
 *
 * 抽出来的理由：停监听有两条需求完全不同的调用路径 ——
 *   · 切库 / 关库 / 删库 / 进程退出（`unwatchLibrary`）：只要不再产生新事件即可，不关心句柄几时释放；
 *   · **改名隔离**（`suspendWatchingAsync`）：必须**确认**底层句柄已释放，否则紧接着的 rename 还是 EPERM。
 * 两边的清理动作必须一模一样（否则「少清一样」只会在其中一条路径上暴露），所以清理收在这里，
 * 差别只在「要不要 await close()」。
 */
function detachWatcher(): FSWatcher | null {
  const w = watcher
  watcher = null
  // 就绪态一并归零，并唤醒所有等 ready 的人（返回 false）：否则对账会一直等到超时。
  watcherReady = false
  settleReadyWaiters(false) // 被摘掉 = 永远不会 ready，别让对账白等到超时
  suppressed.clear()
  // 清掉待发的去抖广播与计数（**故意丢掉，不 flush**）。
  //
  // 曾经在这里试过「先 flush 一次别丢用户提示」，被 `--smoke-watch` 的 D5 当场否证：
  // D5 的契约是「切库后**绝不能**收到上一个库的待发广播」，flush 恰好把它送到了新库上
  // （实测 `waited=true leaked=[{added:2,partial:false}]` 两条红）。
  // 代价可以接受：丢掉的只是**界面的刷新提示**（索引早在事件到达时就写好了），
  // 而且「改名」和「切库」这两个调用语境下界面本来就会重拉一次列表。
  // 谁再想加 flush，先看 D5 的注释。
  if (externalTimer) {
    clearTimeout(externalTimer)
    externalTimer = null
  }
  pendingExternal = null
  batchStartedAt = null
  return w
}

export function unwatchLibrary(): void {
  const w = detachWatcher()
  if (!w) return
  // 故意**不** await：本函数所有调用点（切库 / 关库 / 删库 / 退出）都不需要「句柄已释放」这个保证，
  // 而等待会让删库路径多一次让位、并把这些原本同步的调用点变成异步。
  // **需要「句柄已释放」的只有改名隔离**，它走下面的 `suspendWatchingAsync()`。
  try {
    void Promise.resolve(w.close()).catch((e) => console.warn('[watcher] 停监听时 close 失败：', e))
  } catch (e) {
    console.warn('[watcher] 停监听时 close 抛异常：', e)
  }
}

/**
 * 暂停库监听，并**等 chokidar 真的把底层 watcher 关掉**再 resolve。
 *
 * 为什么必须等（2026-10-16 第三轮实测，`.workbuddy/audit/probe-real-lib-rename.mts`）：
 *   chokidar 在 Windows 上**逐目录**建立 `fs.watch`（每个目录一个句柄）。只要某个**子目录**上挂着
 *   这样一个句柄，改它**祖先目录**的名就必定 `EPERM` —— 即使用户什么都没打开。
 *   实测形状判据（`probe-watch-shape.mts`）：
 *     · 顶层目录只有文件        → 改名 **OK**
 *     · 顶层目录含 1 个子目录   → 改名 **EPERM**
 *     · 顶层目录含 11 个子目录  → 改名 **EPERM**
 *     · 停掉 watcher 后三种形状 → 全部 **OK**
 *   ⇒ 这正是用户「一级文件夹永远改不了名」的**真正根因**（上一轮修的媒体读流只是另一条成因）。
 *   停监听还不够：`close()` 是异步的，句柄在它 resolve 之前仍可能在被释放 —— 所以这里 **await**。
 *
 * @returns 之前是否在监听（`false` = 本来就没在监听，调用方不必重启）
 */
export async function suspendWatchingAsync(): Promise<boolean> {
  const w = detachWatcher()
  if (!w) return false
  try {
    await w.close()
  } catch (e) {
    // 关不掉也得往下走：调用方还会重试 rename，且 finally 里一定会 watchLibrary 重挂，
    // 绝不能因为「关的时候抛了一下」就把改名流程和监听恢复一起中断。
    console.warn('[watcher] 暂停监听时 close 失败（继续尝试改名）：', e)
  }
  return true
}


/**
 * 「这个绝对路径是否属于不参与索引的东西」（`.stash*` / `.thumbs` / 压缩临时文件）。
 *
 * 抽成函数是为了让 **chokidar 的 `ignored` 与对账 `reconcileLibrary` 用同一份判据** ——
 * 两份判据迟早分叉（审计 §2.16 的老账），而对账多扫了 `.thumbs` 里的 webp 会直接往库里
 * 插进一堆「素材」；少扫了 `.stash-compress-*` 又会在压缩中途把临时文件索引成素材。
 *
 * ⚠️ 绝不能在这里把「库根目录本身」判为忽略（`rel === ''`）：chokidar 会对被监听的根目录
 * 求值 `ignored`，返回 true 会**直接不建立任何 watch**（chokidar 5.0.0 实测：
 * getWatched() 为空、写文件 0 事件、ready 0ms）→ 整个外部变更同步静默失效。
 */
function isIgnoredAbs(libPath: string, p: string): boolean {
  const rel = relative(libPath, p)
  return rel.startsWith('.stash') || rel.startsWith('.thumbs') || basename(rel).startsWith(TMP_PREFIX)
}

/** `indexFile` 的结局：插入了新行 / 跳过（已存在、非素材、隐藏目录、被抑制） */
type IndexOutcome = 'inserted' | 'skipped'

/**
 * **测试缝**（仅供冒烟）：把插入用的 `folder_id` 强制成 `null`。
 *
 * 为什么要这条缝：QA 第四轮证明 `INSERT OR IGNORE` 会把 `folder_id NOT NULL` 违反**静默吞掉**
 * （无异常、无 warn、`changes=0`）。换成 `ON CONFLICT(rel_path) DO NOTHING` 之后它必须真的抛错，
 * 并由调用方 warn。没有这条缝就只能靠「将来某次真实回归」来验证「不再静默」——那不叫验证。
 * 默认关闭，任何生产路径都不会打开它。
 */
let forceNullFolderId = false

/** 打开/关闭上面的测试缝（仅供冒烟；返回旧值便于恢复） */
export function __testForceNullFolderId(on: boolean): boolean {
  const prev = forceNullFolderId
  forceNullFolderId = on
  return prev
}

/**
 * 把一个库内文件按**索引规则**落库（watcher 的 `add` 与盲窗对账**共用这一条路径**）。
 *
 * ⚠️ 为什么必须抽出来而不是各写一份：QA 的第四轮要求「盲窗对账」不得改变索引语义 ——
 * 根目录文件要移进「未分类」、非素材扩展名要跳过、`.` 开头的目录要跳过、
 * 外部新建的子目录要 `ensureFolderRows` 补齐。任何一条在两条路径上不一致，
 * 就会出现「拷进来的文件被索引成素材 / 对账后凭空多出卡片」这类怪事。
 *
 * @param opts.external `true` = 来自 chokidar 的**外部**改动（要消费抑制标记、要计入待发广播）；
 *                      `false` = 对账补写（我们自己发起的，不需要广播，界面本来就会刷新）
 */
function indexFile(db: DB, libPath: string, abs: string, opts: { external: boolean }): IndexOutcome {
  let rel = relFromLib(libPath, abs)
  // 我们自己刚放进来的（压缩替换）→ 索引已经改好了，别再插一行重复素材
  if (opts.external && consumeSuppressed(rel)) return 'skipped'
  // 索引里已有该 rel_path → 不重复插行。
  // 这条同时兜住「根目录文件被我们移动后，chokidar 补发的新路径 add」：
  // 移动是同步完成的，本行的 INSERT 已先于那次 add 落库（详见下方根目录分支的注释）；
  // 也是**对账的幂等闸门**：连跑两次时第二次全部命中这里（不算 hash、不动任何列）。
  if (db.prepare('SELECT id FROM assets WHERE rel_path=?').get(rel)) return 'skipped'

  const ext = extname(abs).slice(1).toLowerCase()
  const type = EXT_TYPE[ext]
  // 非素材类型（含压缩临时文件 `.stash-compress-*` 等）：不索引
  if (!type) return 'skipped'

  let dirRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  // `.` 开头的目录一律不索引：与 deleteFolder/renameFolder 的 `path.startsWith('.')`
  // → `ERR_PROTECTED_FOLDER` 保护同一条线。否则会给它们造出「侧栏里看不见、
  // 却又因为受保护而永远删不掉/改不掉」的 folders 行（既不在册又受保护）。
  if (dirRel.split('/').some((p) => p.startsWith('.'))) return 'skipped'

  // 注意：用 `rel.slice(...)` 取文件名而不是 `path.basename` ——
  // rel 已被规范化成 `/` 分隔，而 Windows 上 basename 只认 `\\`，会原样返回整串路径。
  let name = rel.slice(dirRel.length ? dirRel.length + 1 : 0)
  let folderId: number | null = null

  if (!dirRel) {
    // ① 文件落在**库根目录**：folders 表里没有「根目录」这一行，folder_id 保持 null 会撞
    //    `assets.folder_id INTEGER NOT NULL`。按 importer 的既有约定，把它物理移动进
    //    「未分类」——索引与磁盘始终一致，且不需要动 schema（用户已知情并同意此行为）。
    const fallback = mkdirRel(UNCATEGORIZED)
    const destDir = join(libPath, ...fallback.path.split('/'))
    // 目标已存在同名文件 → 自动改名，绝不覆盖（规则唯一来源 naming.ts 的 uniqueName）
    const movedName = uniqueName(destDir, name)
    renameSync(abs, join(destDir, movedName)) // 同一目录树内移动 = 同盘，不会跨卷
    dirRel = fallback.path
    name = movedName
    rel = `${dirRel}/${name}`
    folderId = fallback.id
  } else {
    // ② 文件落在子目录：查 folders 行；查不到 = 外部（资源管理器）新建的目录，
    //    用 ensureFolderRows 逐级补齐（不建目录，目录已由用户建好）。
    const f = db.prepare('SELECT id FROM folders WHERE path=?').get(dirRel) as { id: number } | undefined
    folderId = f ? f.id : ensureFolderRows(db, dirRel.split('/')).id
  }

  const absPath = join(libPath, ...rel.split('/'))
  const st = statSync(absPath)
  // 测试缝（仅供冒烟，见 `__testForceNullFolderId`）：模拟「folderId 变 null」这类回归
  const folderIdForInsert: number | null = forceNullFolderId ? null : folderId
  // content_hash 必须与行在同一 INSERT 内落库：thumbs.ts 的 `ensureOne`/`ensureBatch`
  // 都以 `content_hash` 为过滤条件，缺了它这张卡永远没有缩略图、尺寸/色板也永不回填。
  const hash = contentHash(absPath)
  // ⚠️ **必须是 `ON CONFLICT(rel_path) DO NOTHING`，不能写 `INSERT OR IGNORE`**：
  // `OR IGNORE` 忽略的是**所有**约束违反，不只是 UNIQUE —— 连 `folder_id NOT NULL`、
  // `CHECK` 违反都会被静默跳过（`changes=0`，无异常、无 warn，看起来就像「这行已存在」）。
  // 那正是我们花两轮在消灭的「文件凭空不入库、日志零痕迹」。QA 第四轮用 E6/E2 注入实测到了：
  // 把 `folderId` 传 null 时，`OR IGNORE` 一声不响地跳过；改成 `ON CONFLICT(rel_path)` 之后
  // 只有 rel_path 冲突会被跳过，其余约束违反会**真的抛错** → 交给调用方 warn（见 add/reconcile）。
  //
  // `rel_path` 有 UNIQUE（db.ts schema），所以「chokidar 的 add」与「盲窗对账」同时看到同一个
  // 文件时，后到的那个走 DO NOTHING，不抛错、也不重复插行。
  const info = db
    .prepare(
      `INSERT INTO assets(folder_id,name,rel_path,source_path,type,ext,size,content_hash,file_mtime,imported_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(rel_path) DO NOTHING`
    )
    .run(folderIdForInsert, name, rel, null, type, ext, st.size, hash, Math.floor(st.mtimeMs), Date.now())
  if (Number(info.changes) <= 0) return 'skipped'
  // 走到这里 = 真的插了一行外部新增素材 → 才计入待广播的 added。
  // 上面任何一条 return（抑制 / 查重 / 非素材 / 隐藏目录）都不会执行到这里。
  if (opts.external) bumpExternal('added')
  return 'inserted'
}

/** 一次「盲窗对账」的结果（冒烟断言用：`inserted` 必须是可鉴别的数字） */
export interface ReconcileResult {
  /** 扫过的文件数（不含被忽略的目录/临时文件） */
  scanned: number
  /** 真正补回索引的文件数 */
  inserted: number
  /** 耗时（毫秒） */
  ms: number
  /** 是否因为「库已切换 / 连接已关闭」而**中途放弃**（此时 inserted 是已完成的部分） */
  aborted: boolean
}

/** 让位一次：给事件循环处理 IPC / 定时器 / 渲染层消息的机会（`setImmediate` 比 `setTimeout(0)` 更早） */
function yieldToLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

/**
 * 对账的让位节流参数（QA 第四轮：最坏情况会把主进程冻几秒）。
 *
 * 实测（300 目录 / 3900 文件）：稳态 69~71ms 没问题，但**首次全量**（3900 行都要算 hash + 插入）
 * 4303~4902ms ≈ 1.1ms/文件，而且是同步 DFS + 同步 SQLite ⇒ 主进程整段冻住、界面无响应。
 * 触发场景真实存在：用户关着 App 往库里拷一批文件（`openLibrary` 不重扫 + `ignoreInitial` 吞），
 * 下次改名时对账会把它们一次全补 → 冻 4.3s；2 万文件≈22s。
 *
 * 所以遍历改成异步 `opendir`（每个条目天然让出 I/O），再**每 50 个条目或累计 >50ms 显式
 * `setImmediate` 让位一次**。50ms 的取值：远小于人能感知的卡顿阈值（~100ms），
 * 又不会让 3900 个文件变成 3900 次事件循环往返（那会把总耗时抬得太多）。
 */
const RECONCILE_YIELD_EVERY = 50
const RECONCILE_YIELD_MS = 50

/** 连接是否还活着（对账是异步收尾，中途用户可能切库/关库 → `closeCurrent()` 会把连接关掉） */
function isDbAlive(db: DB): boolean {
  try {
    db.prepare('SELECT 1').get()
    return true
  } catch {
    return false
  }
}

/**
 * **盲窗对账**：把「磁盘上有、索引里没有」的文件补回来。
 *
 * 背景（QA 第四轮实测）：改名/删除必须整库停掉 watcher（`chokidar.unwatch(subtree)` 在 5.0.0
 * 上**不释放句柄**，实测 getWatched 仍列出该子树、rename 仍 EPERM）；重挂后 chokidar 要走完整棵树
 * 才 `ready`，这段窗口随库规模线性增长（23 目录 73ms / 95 目录 480ms / **305 目录 1540ms**）。
 * 窗口内写进库的文件会被 `ignoreInitial: true` 当成初始状态吞掉：`onDisk=true` 但永不入库，
 * 而且**全库没有第二个「磁盘 → 索引」入口**（`openLibrary` 不重扫、`meta:rescan` 只重排已有行），
 * 用户只能删掉再放回。所以这里补一次对账。
 *
 * 判据刻意**只做单向**：磁盘有、库里没有 → 插入。已有行**一律跳过**（不算 hash、不动任何列），
 * 所以它是幂等的（连跑两次第二次 `inserted=0`），也不会覆盖用户字段（评分/标签/备注/提示词）。
 *
 * ⚠️ 反向（库里有一行、磁盘上没了）**不处理**：那需要全表比对并 `missing=1`，
 * 与 `unlink` 那条线职责重叠，且误判代价（把正在拷的大文件标成失效）更高。记为已知边界。
 *
 * TODO(反向对账)：盲窗内**外部删除**的文件会留下 `missing=0` 的 stale 行（界面上是坏卡片）。
 *   要做的话正确形状是：同样只在隔离窗口结束后跑一次，遍历 `SELECT id, rel_path FROM assets`
 *   对 `existsSync` 为假的置 `missing=1`——但要先解决两个前提：
 *   ① 不能把「正在被拷入/正在被压缩替换的同名文件」误判（需要 mtime 宽限或二次确认）；
 *   ② 必须先让 `unlink` 那条线在同一窗口内停摆，否则两处互相覆盖。
 *   QA 判定为中危、本轮不做；将来谁做，务必先补「误判」的注入测试。
 *
 * 顺带记一笔**不是对账的**卡顿源：改名后 0~0.86s 内主线程还有 156~390ms 的卡顿，
 * 主因是 `watchLibrary` 重挂 + chokidar 首轮扫描（逐目录建 watch），不是对账 ——
 * 所以「把对账分片」并不能消掉它；要治得从 chokidar 的启动扫描下手（另开工单）。
 */
export async function reconcileLibrary(db: DB, libPath: string): Promise<ReconcileResult> {
  const t0 = Date.now()
  // 先探一次连接：对账是**异步收尾**（等 ready + setImmediate），这期间用户完全可能切库/关库
  // （`closeCurrent()` 会把连接关掉）。不探的话，遍历里每个文件都会抛 "database is not open"
  // 并被单文件 catch 成一条 warn —— 250 个文件就是 250 行噪音，还把「真的对账失败」埋在中间。
  if (!isDbAlive(db)) return { scanned: 0, inserted: 0, ms: 0, aborted: true }

  let scanned = 0
  let inserted = 0
  const insertedRels: string[] = []
  const stack: string[] = [libPath]
  let sinceYield = 0
  let lastYield = Date.now()

  while (stack.length) {
    const dirPath = stack.pop()!
    // `opendir` + `for await`：条目逐个异步取（每步都天然让出 I/O），且退出时自动 close。
    let dir: Awaited<ReturnType<typeof opendir>>
    try {
      dir = await opendir(dirPath)
    } catch {
      continue // 目录在遍历期间被删/被占用：跳过，下次对账再说
    }
    for await (const e of dir) {
      const abs = join(dirPath, e.name)
      if (isIgnoredAbs(libPath, abs)) continue
      if (e.isDirectory()) {
        // `.` 开头的目录整棵不索引（与 indexFile 的 dirRel 判据同源）
        if (!e.name.startsWith('.')) stack.push(abs)
        continue
      }
      if (!e.isFile()) continue
      scanned++
      try {
        if (indexFile(db, libPath, abs, { external: false }) === 'inserted') {
          inserted++
          if (insertedRels.length < 5) insertedRels.push(relFromLib(libPath, abs))
        }
      } catch (err) {
        // 单文件失败不中断对账（与 watcher 的 add 同一条纪律），但**必须带 rel_path 留痕**：
        // 换成 `ON CONFLICT(rel_path) DO NOTHING` 之后，非 UNIQUE 的约束违反会真的抛到这里。
        console.warn('[reconcile] 补写失败，该文件未入索引：', relFromLib(libPath, abs), err)
      }
      // —— 让位检查点（QA 第四轮：不加会把主进程冻几秒）——
      sinceYield++
      if (sinceYield >= RECONCILE_YIELD_EVERY || Date.now() - lastYield >= RECONCILE_YIELD_MS) {
        await yieldToLoop()
        sinceYield = 0
        lastYield = Date.now()
        // 让位之后立刻检查「库还是这个库吗」：切库/关库了就**立刻中止**，
        // 绝不拿旧连接继续写（那会往已关闭的连接上插行，或者更糟：写到新库的路径下）。
        if (!isDbAlive(db)) {
          return { scanned, inserted, ms: Date.now() - t0, aborted: true }
        }
      }
    }
  }

  const result = { scanned, inserted, ms: Date.now() - t0, aborted: false }
  if (inserted > 0) {
    // 带上文件名（最多 5 个）：万一对账补错了，日志里能直接看出补的是什么
    const sample = insertedRels.join('、') + (inserted > insertedRels.length ? ' …' : '')
    console.log(
      `[reconcile] 补回 ${inserted} 个盲窗内写入的文件（扫描 ${scanned}，耗时 ${result.ms}ms）：${sample}`
    )
  }
  return result
}

/**
 * 重挂监听器之后**等 ready 再对账**（不阻塞改名/删除的 IPC 返回）。
 *
 * 两件事都不急：① 等 ready 才有意义（ready 之前写进来的文件还没被 chokidar 吞完）；
 * ② `setImmediate` 让调用方（改名/删除）先 return —— 对账是收尾工作，
 *    不该算进用户等的那几百毫秒里。
 */
export function reconcileWhenReady(db: DB, libPath: string): void {
  void whenWatcherReady().then(async (ready) => {
    if (!ready) return // 没有监听器 / 超时：窗口不存在（或已放弃），没有要补的
    await yieldToLoop() // 先让调用方（改名/删除）的 IPC 返回
    try {
      await reconcileLibrary(db, libPath)
    } catch (e) {
      // 对账失败绝不能影响「改名/删除已经成功」这个结论
      console.warn('[reconcile] 对账失败（不影响改名/删除结果）：', e)
    }
  })
}

/** 监听库目录，外部改动增量同步索引（防抖由 awaitWriteFinish + 简单标记实现） */
export function watchLibrary(libPath: string, db: DB): void {
  unwatchLibrary()
  watcherReady = false
  watcher = chokidar.watch(libPath, {
    ignoreInitial: true,
    ignored: (p: string) => isIgnoredAbs(libPath, p),
    awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 100 }
  })

  watcher.once('ready', () => {
    watcherReady = true
    settleReadyWaiters(true)
  })

  watcher.on('add', (abs: string) => {
    try {
      indexFile(db, libPath, abs, { external: true })
    } catch (e) {
      // 保持「单文件失败不中断监听」的语义，但**必须留痕且带 rel_path**：
      // `ON CONFLICT(rel_path) DO NOTHING` 之后，非 UNIQUE 的约束违反会真的抛到这里
      // （以前 `OR IGNORE` 会把它吞成「已存在」，日志零痕迹 —— 那正是「文件凭空不入库」的成因）。
      console.warn('[watcher] add 同步失败，该文件未入索引：', relFromLib(libPath, abs), e)
    }
  })

  const markMissing = (abs: string) => {
    try {
      const rel = relFromLib(libPath, abs)
      // 旧文件是我们自己删的（压缩替换完成），别把已经改好的那行标成 missing
      if (consumeSuppressed(rel)) return
      // `AND missing=0` 让「标失效」幂等：整目录被删时 chokidar 会**同时**发 unlinkDir（目录）
      // 与逐文件 unlink，两条线都会命中同一批素材行。加上这个条件后，无论谁先到：
      //   · 先 unlinkDir → 整子树刷成 missing=1，随后逐文件命中 0 行 → changes=0；
      //   · 先逐文件   → 各自命中 1 行、共 N，随后 unlinkDir 命中 0 行。
      // 两种到达顺序的 removed 合计都恰好 = N（实测：以前是 2N，提示条会说「删除 6 个」而实际只删 3 个）。
      // 终态（missing=1）完全不变。
      const info = db.prepare('UPDATE assets SET missing=1 WHERE rel_path=? AND missing=0').run(rel)
      // 只有真的标到了行才广播。应用自身的重命名/移动/压缩在同一同步块内已经把那条行的
      // rel_path 改好了 —— 回调触发时按**旧** rel_path 查不到，changes 天然为 0 → 不会假广播。
      // Number(...)：node:sqlite 的 changes 类型是 number | bigint，统一成 number。
      if (Number(info.changes) > 0) bumpExternal('removed', Number(info.changes))
    } catch {
      /* ignore */
    }
  }
  const markDirMissing = (abs: string) => {
    try {
      // 同样 `AND missing=0`：与 markMissing 一起保证「unlinkDir + 逐文件 unlink」不会被双计（详见 markMissing）
      // ⚠️ `escapeLike` 不能省：目录名含 `_`/`%` 时（`报告_2024`），未转义的 LIKE 会把
      // `报告X2024/` 下的素材一并标成 missing（审计 §2.18；与「子树比较不用 LIKE 通配」的约定同源）。
      const info = db
        .prepare("UPDATE assets SET missing=1 WHERE rel_path LIKE ? ESCAPE '\\' AND missing=0")
        .run(escapeLike(relFromLib(libPath, abs)) + '/%')
      // 整目录被删会一次标到 N 行 → removed 计 N（提示条上的「删除 N 个」才说得通）
      if (Number(info.changes) > 0) bumpExternal('removed', Number(info.changes))
    } catch {
      /* ignore */
    }
  }

  /**
   * 外部**原地改写**了某个已有素材（路径没变、只有内容变了）。
   *
   * 为什么这一步不能省：`.thumbs/{hash}/grid|detail.webp`、`preview-{px}.webp`，
   * 以及 `width` / `height` / `duration_ms` / `palette` 全都以**文件内容**为前提。
   * 内容换了却不更新索引，用户看到的是：卡片还是旧图、按旧尺寸排版、提示词还是上一版
   * —— 而磁盘上那个文件早就不是它了。
   *
   * 分三种结局处理，为的是**别让没必要的失效发生**：
   *   · 内容与元数据都没变 → 什么都不做（chokidar 偶发重复上报、只改了权限）
   *   · 只有 size/mtime 变   → 只刷这两列。内容没变就不该动派生缓存（被 touch、
   *                            或被拷回一个内容相同的副本，都是常见情形）
   *   · `content_hash` 也变  → 才算「内容真的换了」，清掉一切以内容为前提的派生字段与缓存
   */
  const syncChanged = (abs: string) => {
    try {
      const rel = relFromLib(libPath, abs)
      // 我们自己刚写完的（压缩原地替换走 rename；文本编辑走 preview 的写回落库）→ 索引已改好
      if (consumeSuppressed(rel)) return

      const row = db
        .prepare('SELECT id, size, file_mtime, content_hash FROM assets WHERE rel_path=?')
        .get(rel) as
        | { id: number; size: number; file_mtime: number; content_hash: string | null }
        | undefined
      // 索引里没有这一行 → 这是「新增」而不是「修改」（chokidar 有时把新建报成 change），交给 add
      if (!row) return

      const st = statSync(abs)
      // 被换成同名目录之类 → 交给 unlink/unlinkDir 那两条线，这里不处理
      if (!st.isFile()) return
      const mtime = Math.floor(st.mtimeMs)

      // 先算内容哈希再决定，而不是拿 mtime/size 当「内容没变」的代理：
      // 同一毫秒内等长的两次改写会让 mtime+size 双双相同，那样会漏掉真正的改动。
      // 只需读前 64KB（见 importer.contentHash），代价可以忽略。
      const hash = contentHash(abs)

      if (hash === row.content_hash) {
        if (row.size === st.size && row.file_mtime === mtime) return // 真的什么都没变
        // 内容没变（touch / 拷回同内容副本）→ 只刷这两列，**不动任何派生缓存**
        db.prepare('UPDATE assets SET size=?, file_mtime=? WHERE id=?').run(st.size, mtime, row.id)
        bumpExternal('changed') // 只刷元数据也算「改动了索引」，界面上的大小/时间要跟着变
        return
      }

      // —— 内容真的换了 ——
      // 一条 UPDATE 原子地刷三列并清掉派生字段：
      // · width/height/duration_ms/palette 是从**旧内容**算出来的，留着就是错的；
      // · gen_state 归零 = 放回「待扫」状态，让提示词/来源被重新提取。
      //   位标记的代价正是「已扫过就永不重扫」（见 C7/C8），所以这里必须显式归零，
      //   否则换了一张图、详情栏还挂着上一张的提示词。
      // · note / rating / is_fav / 标签是**用户字段**，一律保留 —— 内容变了不代表用户标注作废。
      db.prepare(
        `UPDATE assets
            SET size=?, file_mtime=?, content_hash=?, missing=0,
                width=NULL, height=NULL, duration_ms=NULL, palette=NULL,
                gen_meta=NULL, ai_source=NULL, gen_state=0
          WHERE id=?`
      ).run(st.size, mtime, hash, row.id)
      // 内容真的换了 → 索引已改（size/hash/派生字段），界面必须刷新才不挂着旧图
      bumpExternal('changed')

      // 旧内容的缓存（缩略图与派生预览同住 `.thumbs/{hash}/`）已无人引用就删掉。
      // ⚠️ 必须在 UPDATE **之后**数引用：否则这一行自己还挂在旧 hash 上，永远显示「有人用」。
      // ⚠️ 也必须数引用：两份内容相同的素材共享同一个 hash 目录，删了会把另一张卡打成灰。
      const oldHash = row.content_hash
      if (isThumbHash(oldHash) && oldHash !== hash) {
        const still = db.prepare('SELECT count(*) AS c FROM assets WHERE content_hash=?').get(oldHash) as {
          c: number
        }
        if (!still.c) rmSync(join(libPath, '.thumbs', oldHash), { recursive: true, force: true })
      }
    } catch (e) {
      // 与 add 同一条纪律：单文件失败不中断监听，但必须留下可诊断的痕迹
      console.warn('[watcher] change 同步失败:', basename(abs), e)
    }
  }

  watcher.on('unlink', markMissing)
  watcher.on('unlinkDir', markDirMissing)
  watcher.on('change', syncChanged)
}
