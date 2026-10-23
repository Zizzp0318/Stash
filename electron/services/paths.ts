/**
 * 库内路径与「条目命名」的公共基元。
 *
 * 为什么单独一层：审计 §2.16 —— `toRel` / `relOf` / 条目名校验 / 子树过滤此前在多个
 * service 里**各写一份**（`toRel` 甚至两侧逐字节相同）。"两个入口各写一份"正是本项目
 * 历史上反复出现的「改一处漏一处 → 两个入口行为不一致」类 bug 的温床。
 *
 * ⚠️ 本文件**只依赖 `node:path`，不得 import 任何其它 service** —— 否则
 * `library.ts ↔ watcher.ts` 那类 import 成环会立刻复发（见 MEMORY.md I3 的教训）。
 */

import { relative } from 'path'

/** 拼接库内相对路径（统一用 `/` 分隔；空段自动丢弃） */
export function toRel(...segs: string[]): string {
  return segs.filter(Boolean).join('/')
}

/**
 * 绝对路径 → 库内相对路径（统一 `/` 分隔）。
 *
 * 用 `path.relative` 而不是 `abs.slice(libPath.length + 1)`：后者依赖「abs 一定以
 * `libPath + 分隔符` 开头」，库路径带尾分隔符、大小写不一致（Windows）时就会切错位置。
 * 与铁律 A4 同源：路径比较一律走 `path.relative`，不做手工前缀算术。
 */
export function relFromLib(libPath: string, abs: string): string {
  return relative(libPath, abs).replace(/\\/g, '/')
}

/** 条目名（文件名 / 目录名）的非法字符；含路径分隔符，防重命名把条目「搬」到别的目录 */
export const BAD_ENTRY_CHARS = /[\\/:*?"<>|]/
/** Windows 保留设备名（`CON.png`、`NUL` 这类当文件名/目录名同样会翻车） */
export const RESERVED_ENTRY_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/**
 * 校验单个条目名 —— **素材与文件夹共用同一套规则**（审计 §2.16）。
 * 拒绝：空、`.` / `..`、非法字符、保留设备名、以点或空格结尾
 * （末者 Windows 会静默裁掉，导致磁盘上的名字与索引里的 path 不一致）。
 */
export function validateName(raw: string): string {
  const name = (raw ?? '').trim()
  if (!name) throw new Error('ERR_EMPTY_NAME')
  if (name === '.' || name === '..') throw new Error('ERR_INVALID_NAME')
  if (BAD_ENTRY_CHARS.test(name)) throw new Error('ERR_INVALID_NAME')
  if (RESERVED_ENTRY_NAMES.test(name)) throw new Error('ERR_INVALID_NAME')
  if (/[. ]$/.test(name)) throw new Error('ERR_INVALID_NAME')
  return name
}

/**
 * 从 folders 全表（或任何带 `path` 的行）筛出某 path 的整棵子树（含自身）。
 *
 * ⚠️ 一律用**内存 path 前缀**比较，**绝不用 SQL `LIKE`** —— 目录名含 `_` / `%` 时
 * LIKE 会误匹配（`报告_2024` 会连上 `报告X2024`）。这是刻意选型，别改（审计 §3.1 第 4 条）。
 */
export function subtreeOfPath<T extends { path: string }>(all: T[], rootPath: string): T[] {
  const prefix = rootPath + '/'
  return all.filter((f) => f.path === rootPath || f.path.startsWith(prefix))
}

/**
 * 内容哈希（`assets.content_hash`，同时也是 `<库>/.thumbs/{hash}/` 的目录名）的**唯一**形状定义：
 * 20 位小写十六进制（`importer.contentHash` 的产物）。
 *
 * 为什么必须集中成一份（审计 §2.16 同源问题）：这段校验原先在 6 个 service 里**各抄一遍**正则，
 * 改一处必漏一处 —— 实际上就已经漏了一处（`preview.ts` 删旧缓存时完全没有校验）。
 *
 * 为什么它是**安全闸**而不只是「格式检查」：`.thumbs` 下的目录名直接由 hash 拼成。
 * 一旦某个 `content_hash` 被写成 `..`（脏库 / 手改 DB / 将来某条写 hash 的路径出错），
 * `join(lib, '.thumbs', '..')` 会归一成**库根**，紧接着的 `rmSync(recursive)` 就把整个库删了。
 * ⇒ 凡是用 hash 拼路径或删缓存的代码，**必须先过 `isThumbHash`**。
 */
export const THUMB_HASH_RE = /^[0-9a-f]{20}$/

/**
 * hash 形状是否合法（见 `THUMB_HASH_RE`）。不合法的 hash **不**拿来拼路径、**不**删缓存。
 * 传 `null` / `undefined` / 空串一律为假 —— 三个调用点里有两个的源头是 DB 可空列。
 */
export function isThumbHash(h: string | null | undefined): h is string {
  return !!h && THUMB_HASH_RE.test(h)
}
