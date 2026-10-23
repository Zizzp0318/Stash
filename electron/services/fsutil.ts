/**
 * 文件系统基元。
 *
 * 为什么单独一层：`moveFileSync` 此前只在 `assets.ts` 里有一份私有实现，而 `importer.ts` 的
 * 「移动」模式直接裸调 `renameSync` —— 跨盘（库在 D:、源在 C:）时 `renameSync` 必失败
 * （EXDEV），于是「移动导入」在跨盘场景下**直接报错**，而库里移动却好好的：
 * 同一个动作两个入口行为不一致，正是审计 §2.16 点名的温床。
 *
 * ⚠️ 本文件**只依赖 `node:fs`，不得 import 任何 service**（避免 import 成环，见 MEMORY.md I3）。
 */

import { copyFileSync, renameSync, unlinkSync } from 'fs'

/**
 * 「瞬时」的文件系统错误码 —— 值得重试的那些。
 *
 * 依据（实测，见 `.workbuddy/audit/probe-libvips-rename.mjs` / `probe-handles-file-rename.mjs`）：
 * Windows 上只要目录内**任一文件**存在被打开的句柄（未共享删除，比如别的程序正在读），
 * `renameSync(目录)` 就抛 `EPERM: operation not permitted` —— 与用户报的重命名文件夹失败
 * **逐字一致**；`EBUSY`/`EACCES` 同族。这类占用通常是**短暂**的（缩略图生成中 / 资源管理器
 * 生成缩略图 / 杀软扫描 / 索引器），稍等片刻多半就好了，所以值得重试。
 *
 * ⚠️ `EXDEV`（跨盘）/`ENOENT`/`ENOTEMPTY`/`EEXIST` 等**不在此列**：重试一万次也不会变，
 * 一律**立即抛出**，绝不白等。
 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/** 该错误是否属于「等一下再试可能就好了」的瞬时占用 */
export function isTransientRenameError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && TRANSIENT_RENAME_CODES.has(code)
}

/** 异步等待（让出主进程事件循环，别同步阻塞） */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * **同步**等待，用 `Atomics.wait`（真·睡眠，不是忙等）。
 *
 * 为什么需要它：`moveFileSync` / `renameAsset` 跑在**同步上下文**里 —— `moveAssets` 的
 * `BEGIN…COMMIT` 事务中间**不允许出现 await**（一 await，事件循环里别的 IPC 就可能插进这半开
 * 的事务里读到一个中间态，这是本项目明令禁止的形态，见 `library.renameFolder` 的注释）。
 * 所以那两处只能做**同步**短重试。`Atomics.wait` 会真正挂起线程（不烧 CPU），
 * 且只在**出错**路径上才调用，单次最长约 120ms，可接受。
 */
function sleepSync(ms: number): void {
  if (ms <= 0) return
  const sab = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(sab), 0, 0, ms)
}

/** `renameWithRetry` 的可选项（全部可覆盖，方便冒烟把预算压到 0 次 / 0 延迟） */
export interface RenameRetryOptions {
  /** 最多尝试几次（默认 7：1 次首发 + 6 次重试）。冒烟可压到 1。 */
  attempts?: number
  /** 每次重试前的等待毫秒数组（默认见 `RENAME_RETRY_DELAYS`） */
  delays?: number[]
  /**
   * 真正执行改名的函数（默认 `fs.renameSync`）。
   * **这是给冒烟留的测试缝**：EPERM 在真实世界里无法确定性复现，只能注入一个会抛 EPERM 的
   * 假 rename 来验证「重试确实发生、且次数正确」（铁律 G13/G11，否则断言是空转）。
   */
  renameFn?: (from: string, to: string) => void
}

/**
 * 默认预算：6 次重试、递增等待 60/120/250/500/900/1500ms（合计 ≈3.3s）后再放弃。
 *
 * 为什么是这个量级：占用多半来自「正在生成缩略图 / 资源管理器正生成缩略图 / 杀软扫描」这类
 * 短动作，几百毫秒到一两秒内基本会释放；3.3s 足够覆盖绝大多数瞬时占用，又不至于让用户
 * 面对一个长时间无响应的界面（每次重试都会 `await sleep` 让出事件循环，界面不卡）。
 */
const RENAME_RETRY_DELAYS = [60, 120, 250, 500, 900, 1500]

/**
 * 重试耗尽的收尾：抛**裸码** `ERR_FOLDER_BUSY`。
 *
 * 为什么消息必须**恰好**是裸码（QA 在渲染层实测否证过一版带后缀的写法）：`main.ts` 的 `wrap`
 * 只回传 `String(e.message)`，而渲染层两张映射表（`SideBar.vue` 的 `errText` /
 * `GalleryGrid.vue` 的 `assetErrText`）是**精确查表** `TABLE[code] ?? String(code)`。
 * 消息只要带了后缀，键就查不到 → 用户看到的还是原始 `EPERM … + 完整路径`，友好文案变成**死键**。
 * 所以原始错误进 `cause`、并以 `console.warn` 落到主进程日志保住诊断（`wrap` 只回传 message，
 * 细节进不了 UI）。`--smoke-folder` 有一条断言用 `===` 钉住「消息 == 裸码」这条契约。
 */
function busyRenameError(from: string, to: string, attempts: number, last: unknown): Error {
  const cause = last instanceof Error ? last : new Error(String(last))
  console.warn(`[fsutil] 重命名重试耗尽（已试 ${attempts} 次）：${from} -> ${to}`, cause)
  const err = new Error('ERR_FOLDER_BUSY')
  ;(err as Error & { cause?: unknown }).cause = cause
  return err
}

/**
 * 该错误是不是「我们自己的重命名重试耗尽」（裸码 `ERR_FOLDER_BUSY`）？
 *
 * 为什么不能用 `isTransientRenameError` 判：`renameWithRetry` 耗尽后抛的是**新造的裸码错误**
 * （`code` 为 undefined，原始 EPERM 在 `cause` 里），而 `isTransientRenameError` 只看 `code` ——
 * 对着它返回 false。「还要不要升级隔离」这个判断必须用本函数，否则第 2 级隔离永远触发不到
 * （实测：写错成 `isTransientRenameError` 后，改名在有 watcher 的库上仍然直接失败）。
 */
export function isBusyRenameError(e: unknown): boolean {
  return (e as Error | undefined)?.message === 'ERR_FOLDER_BUSY'
}

/**
 * 有界重试的重命名助手（**异步**）。
 *
 * 语义：
 *  - 只对**瞬时占用**（`EPERM`/`EBUSY`/`EACCES`）重试；其余错误一律**立即抛出**（`EXDEV`
 *    跨盘、`ENOENT`、`ENOTEMPTY`、`EEXIST`… 重试无意义，绝不白等）；
 *  - 每次重试前 `await sleep(ms)` **让出主进程**（不忙等、不同步阻塞）；
 *  - 预算耗尽仍失败 → 抛 `ERR_FOLDER_BUSY`（**裸码**，见 `busyRenameError`）。
 *
 * ⚠️ 不要把本函数塞进任何 `BEGIN…COMMIT` 之间：它含 await，会破坏事务的原子窗口。
 */
export async function renameWithRetry(
  from: string,
  to: string,
  opts: RenameRetryOptions = {}
): Promise<void> {
  const attempts = Math.max(1, opts.attempts ?? RENAME_RETRY_DELAYS.length + 1)
  const delays = opts.delays ?? RENAME_RETRY_DELAYS
  const doRename = opts.renameFn ?? renameSync
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      doRename(from, to)
      return
    } catch (e) {
      last = e
      if (!isTransientRenameError(e)) throw e // 非瞬时错误：立即抛出，别白等
      if (i < attempts - 1) await sleep(delays[i] ?? delays[delays.length - 1] ?? 0)
    }
  }
  throw busyRenameError(from, to, attempts, last)
}

/**
 * **同步**版短重试改名：给「活在同步上下文里」的两个调用点用 ——
 * `assets.renameAsset` 的物理改名与 `moveFileSync`。
 *
 * 默认 3 次尝试（首发 + 2 次重试）、等待 [0, 50]ms → 首轮立即重试、第二轮等 50ms，
 * **最多阻塞约 50ms**。
 *
 * 为什么这个量级够：本函数面对的多是**我们自己**转瞬即逝的句柄 —— 实测 `sharp(abs)` 的
 * in-flight 持柄窗口只有毫秒级（`.workbuddy/audit/probe-inflight-rename.mjs`；QA 探针测到
 * 约 1–3ms），50ms 的等待已远大于该窗口。**别再加大**：`Atomics.wait` 会同步挂起主线程，
 * 而这里只是「锦上添花」的短重试，真正的兜底是 `moveFileSync` 的拷贝退路与上层重试。
 *
 * 语义与 `renameWithRetry` 一致：只对瞬时占用重试、其余立即抛、耗尽后抛**裸码**
 * `ERR_FOLDER_BUSY`（见 `busyRenameError`）。
 * ⚠️ 会同步阻塞（Atomics.wait）；能用异步版的就**别用这个**。
 */
export function renameWithShortRetrySync(
  from: string,
  to: string,
  opts: RenameRetryOptions = {}
): void {
  const attempts = Math.max(1, opts.attempts ?? 3)
  const delays = opts.delays ?? [0, 50]
  const doRename = opts.renameFn ?? renameSync
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      doRename(from, to)
      return
    } catch (e) {
      last = e
      if (!isTransientRenameError(e)) throw e
      if (i < attempts - 1) sleepSync(delays[i] ?? delays[delays.length - 1] ?? 0)
    }
  }
  throw busyRenameError(from, to, attempts, last)
}

/**
 * 移动文件：先试 `rename`（同盘、原子、零拷贝），失败再退化成「拷贝 + 删源」。
 *
 * 退化路径是为**跨盘**准备的（`rename` 不能跨卷）。故意 catch 住所有错误而不只判 EXDEV：
 * `rename` 在 Windows 上还可能因目标被占用等杂因失败，而「拷贝 + 删源」在这些情况下同样成立，
 * 没必要把失败模式枚举全。拷完了才删源 —— 即使删源失败也只是留下一份副本，不会丢数据。
 *
 * ⚠️ 加短重试（实测依据见 `fsutil.isTransientRenameError`）：`rename` 撞上**瞬时占用**
 * （`EPERM`/`EBUSY`/`EACCES`）时先小幅重试几次，多半能直接成功，避免白白退化成「拷贝 + 删源」
 * （慢且留下一份半成品副本）。`EXDEV` 是确定的跨盘信号，**不重试、直接退化**。
 * ⚠️ 本函数**必须保持同步**：`moveAssets` 在 `BEGIN…COMMIT` 事务中间调它，不能出现 await。
 */
export function moveFileSync(src: string, dest: string): void {
  try {
    renameWithShortRetrySync(src, dest)
  } catch {
    copyFileSync(src, dest)
    unlinkSync(src)
  }
}
