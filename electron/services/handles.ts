/**
 * 「媒体句柄」闸门的**注册表**（依赖方向的中转站）。
 *
 * 为什么需要这个文件（别合并进任何一个 service）：
 *   修复「重命名一级文件夹必定失败」需要 `library.renameFolder` 在改名前把**我们自己的**
 *   预览读流释放掉，而持有那些流的是 `preview.ts`。但依赖方向是
 *   `preview.ts → library.ts`（preview 要 `requireCurrent()` 取库路径），
 *   所以 `library.ts` **不能**反向 import `preview.ts` —— 那会立刻成 import 环
 *   （MEMORY.md I3 记过这个教训：`library ↔ watcher` 就是这么炸的）。
 *
 * 解法：本文件**不依赖任何 service**（连 `node:fs` 都不需要），只持有一份「接口实现」。
 *   `preview.ts` 在启动时把自己的实现注册上来（`main.ts` 明确接一次，理由见那里的注释），
 *   `library.ts` / `assets.ts` 只调本文件的转发函数。这样两者谁都不用认识谁。
 *
 * 所有转发函数在「没人注册」时都是**安全的空实现**（返回 0 / resolve 0）——
 *   这样任何单独 import `library.ts` 的场景（脚本、冒烟）都不会崩。
 */

import type { DB } from './db'

/** 媒体句柄的四个能力；实现方是 `preview.ts` */
export interface MediaHandleGuard {
  /** 同步释放：只 `destroy()`，不等句柄真的关掉（同步调用点用） */
  release(absPath: string): number
  /** 异步释放：`destroy()` + 等所有流的 `close` 事件（改名前用，见 preview.ts 的探针结论） */
  releaseAsync(absPath: string): Promise<number>
  /** 开一个抑制窗口：窗口内该子树下的媒体请求一律被拒（防止渲染层立刻把句柄重开） */
  suppress(absPath: string, ms: number): void
  /** 立刻解除所有抑制（改名动作结束就调，别让窗口悬着） */
  clearSuppression(): void
}

/**
 * 抑制窗口的默认时长（毫秒）。
 *
 * 取值理由：窗口只用来挡住「改名的这几百毫秒内渲染层重开句柄」，
 * 而 `renameWithRetry` 的最坏预算约 3.3s。取 10s 是**上限兜底**——
 * 真正的解除由 `clearSuppression()` 在改名动作结束时立刻完成，
 * 过期只是防止万一忘了 clear 时窗口永远悬着（那会让预览永久 409）。
 */
export const MEDIA_SUPPRESS_MS = 10_000

let guard: MediaHandleGuard | null = null

/** 由 `main.ts` 在启动时接入 `preview.mediaHandleGuard`（幂等，可重复调用） */
export function registerMediaHandleGuard(g: MediaHandleGuard | null): void {
  guard = g
}

/** 当前是否已接入实现（冒烟用来判别「释放链路真的连上了」而不是空转） */
export function hasMediaHandleGuard(): boolean {
  return guard !== null
}

/** 释放「该路径本身或其子树下」的所有活跃媒体流，返回释放数量（同步，只 destroy） */
export function releaseMediaUnder(absPath: string): number {
  return guard ? guard.release(absPath) : 0
}

/** 同上，但会等所有流真的 `close` 之后再 resolve（改名前用，避免首次 rename 撞 EPERM） */
export function releaseMediaUnderAsync(absPath: string): Promise<number> {
  return guard ? guard.releaseAsync(absPath) : Promise.resolve(0)
}

/** 开抑制窗口：窗口内该子树下的 `stash://media` 请求被拒（见 preview.serveMedia） */
export function suppressMediaUnder(absPath: string, ms: number = MEDIA_SUPPRESS_MS): void {
  guard?.suppress(absPath, ms)
}

/** 立刻解除所有抑制窗口（改名动作结束后调用，无论成功还是失败） */
export function clearMediaSuppression(): void {
  guard?.clearSuppression()
}

// ==================== 「改名期间隔离我方句柄」的注册表 ====================
//
// 第三轮实测根因（`.workbuddy/audit/probe-real-lib-rename.mts` / `probe-watch-shape.mts`）：
//   **chokidar 在 Windows 上逐目录建 `fs.watch`，只要子目录上挂着句柄，改它祖先的名就必 EPERM。**
//   形状判据：顶层目录只含文件 → 改名 OK；含 1 个 / 11 个子目录 → EPERM；停 watcher → 全 OK。
//   ⇒ 所以「改名期间必须把**我们自己的目录监听器**停掉」，这是上一轮（只释放媒体读流）漏掉的那一类句柄。
//
// 依赖方向仍然只能走本文件：`library → handles ← preview/watcher/thumbs/genmeta`。
// `library.ts` 不许 import `watcher`/`thumbs`/`genmeta`（都会经 library 成环，见 MEMORY.md I3）。

/** 一次「暂停泵」的观测量；两个泵（缩略图 / 元数据扫描）同形 */
export interface PumpPauseReport {
  /** 哪个泵 */
  pump: 'thumbs' | 'genmeta'
  inFlight: number
  waitedMs: number
  timedOut: boolean
}

/**
 * 改名隔离所需的四个能力。实现方由 `main.ts` 在启动时接上（只有它谁都 import 而不被 import）。
 *
 * 为什么 `restartWatcher` 需要 `libPath` / `db` 参数：监听器必须按**当前库**重建，
 * 而这两个值 `library.renameFolder` 手上现成有 —— 让实现方自己去 `requireCurrent()`
 * 会在「改名失败 + 事务回滚」这种中间态里读到不确定的值。
 */
export interface RenameIsolationGuard {
  /** 暂停我方所有会开句柄的后台泵，并**有界**等待在场任务收尾 */
  pausePumps(maxWaitMs: number): Promise<PumpPauseReport[]>
  /** 恢复所有泵（幂等；调用方必须放在 finally 里） */
  resumePumps(): void
  /** 暂停库监听并**等 chokidar 真的关掉底层 watcher**；返回「之前是否在监听」 */
  suspendWatcher(): Promise<boolean>
  /** 按库重建监听器；返回是否已重新挂上 */
  restartWatcher(libPath: string, db: DB): boolean
  /** 当前是否在监听（用于自证与断言） */
  watcherActive(): boolean
  /**
   * 隔离窗口结束后**等 watcher ready 再做一次「磁盘 → 索引」对账**（不阻塞调用方）。
   *
   * 为什么必须挂在隔离生命周期上：停监听 → 重挂到 `ready` 之间的文件会被
   * `ignoreInitial: true` 静默吞掉（窗口随库规模线性增长，QA 实测 305 目录 1540ms），
   * 而全库没有第二个「磁盘 → 索引」入口。对账是这条链的**收尾责任**，不是可选优化。
   */
  reconcileAfterWindow(libPath: string, db: DB): void
}

/**
 * 隔离链每一步的编号（写进 trail 的 `steps`，让日志能直接回答「到第几步才成功」）。
 *
 * ⚠️ `restore-watcher` 与 `resume-pump` **刻意分成两步**（QA 的 E2 缺口）：
 * 恢复顺序是契约 —— 监听器必须先回来（它停着的每一毫秒都在丢事件），泵其次。
 * 合成一个 `restore` 之后，「顺序被写反」这件事在测试里就完全观测不到（实测：把两段对调，全绿）。
 */
export type IsolationStep =
  | 'media-release'
  | 'pump-pause'
  | 'probe-rename'
  | 'suspend-watcher'
  | 'restore-watcher'
  | 'resume-pump'

/**
 * 一次改名的隔离轨迹（自证用）。
 *
 * 为什么要留轨迹：用户的真实环境里我们无法装探针，只能靠**日志**判断「是哪一类句柄在挡」。
 * 每次 `renameFolder` 都会在 `console.warn` 打一行汇总（成功/失败 + 走到第几步），
 * 下次复现时用户日志就能直接告诉我们：直改就成功（`successAt='direct'`）、
 * 还是「停了 watcher 才行」（`successAt='after-unwatch'`＝目录监听器是元凶）、还是全部失败。
 *
 * 冒烟也用它做**接线断言**（不是恒真）：`directAttempted` / `pumpPaused` / `watcherSuspended`
 * 这些标记只有真的走了那一行代码才会被置上。
 */
export interface RenameIsolationTrail {
  /** 物理路径（诊断用） */
  from: string
  to: string
  /** 释放掉的预览读流数量 */
  releaseStreams: number
  /** 是否真的调过暂停（泵） */
  pumpPaused: boolean
  /** 各泵的暂停观测量 */
  pumps: PumpPauseReport[]
  /** 是否真的尝试过「直接改名」这一步 */
  directAttempted: boolean
  /** 直接改名是否失败（= 触发了第 2 级隔离） */
  directFailed: boolean
  /** 暂停时是否本来就在监听 */
  watcherWasActive: boolean
  /** 是否真的暂停过监听器 */
  watcherSuspended: boolean
  /** 是否真的把监听器重新挂上了 */
  watcherRestarted: boolean
  /** 泵是否已恢复 */
  pumpResumed: boolean
  /** 最终在哪一级成功；`null` = 全部失败 */
  successAt: 'direct' | 'after-unwatch' | null
  /** 是否最终失败 */
  failed: boolean
  /** 走过的步骤（按顺序） */
  steps: IsolationStep[]
  /** 总耗时（毫秒） */
  elapsedMs: number
}

/** 上一次 `renameFolder` 的隔离轨迹（`null` = 还没跑过）。冒烟直接读它做断言。 */
let lastTrail: RenameIsolationTrail | null = null

/** 累计「暂停监听器」次数（只增不减，用来做**单调**接线断言） */
let watcherSuspendCount = 0

export function beginRenameIsolationTrail(from: string, to: string): RenameIsolationTrail {
  lastTrail = {
    from,
    to,
    releaseStreams: 0,
    pumpPaused: false,
    pumps: [],
    directAttempted: false,
    directFailed: false,
    watcherWasActive: false,
    watcherSuspended: false,
    watcherRestarted: false,
    pumpResumed: false,
    successAt: null,
    failed: false,
    steps: [],
    elapsedMs: 0
  }
  return lastTrail
}

/** 取上一次改名的隔离轨迹（拷贝一份，避免调用方改到内部状态） */
export function lastRenameIsolation(): RenameIsolationTrail | null {
  return lastTrail ? { ...lastTrail, pumps: lastTrail.pumps.map((p) => ({ ...p })), steps: [...lastTrail.steps] } : null
}

/** 累计暂停监听器次数（冒烟用来证明「第 2 级隔离确实被触发过」） */
export function watcherSuspensions(): number {
  return watcherSuspendCount
}

let iso: RenameIsolationGuard | null = null

/** 由 `main.ts` 在启动时接上实现（幂等，可重复调用） */
export function registerRenameIsolationGuard(g: RenameIsolationGuard | null): void {
  iso = g
}

/** 当前是否已接入隔离实现（没接入时全部转发函数都是安全空实现） */
export function hasRenameIsolationGuard(): boolean {
  return iso !== null
}

/** 暂停我方泵（缩略图 / 元数据扫描），有界等待在场任务收尾；未接入时返回空数组 */
export function pauseIsolatedPumps(maxWaitMs: number): Promise<PumpPauseReport[]> {
  return iso ? iso.pausePumps(maxWaitMs) : Promise.resolve([])
}

/** 恢复我方泵（幂等；必须在 finally 里调） */
export function resumeIsolatedPumps(): void {
  iso?.resumePumps()
}

/** 暂停库监听并等句柄释放；返回「之前是否在监听」。未接入时返回 false（= 没得停） */
export async function suspendWatcherForRename(): Promise<boolean> {
  if (!iso) return false
  const wasActive = await iso.suspendWatcher()
  if (wasActive) watcherSuspendCount++
  return wasActive
}

/** 重新挂上监听器；返回是否成功 */
export function restartWatcherAfterRename(libPath: string, db: DB): boolean {
  return iso ? iso.restartWatcher(libPath, db) : false
}

/** 当前是否在监听（未接入时按「没有」处理） */
export function watcherActive(): boolean {
  return iso ? iso.watcherActive() : false
}

/**
 * 隔离窗口收尾对账（未接入时是空实现）。
 * 调用方**不要 await**：它是收尾工作，不该拖慢改名/删除的 IPC 返回。
 */
export function reconcileAfterWindow(libPath: string, db: DB): void {
  // ⚠️ 用**可选调用** `?.()`：注册表的实现方可能只实现了一部分能力（脚本、探针、
  // 老版本接线）。没有这个方法时**静默跳过**，绝不能在调用方（library 的 finally）里抛
  // `... is not a function` —— 那会把「改名已经成功」变成一个失败返回（实测：探针里就是这样）。
  iso?.reconcileAfterWindow?.(libPath, db)
}
