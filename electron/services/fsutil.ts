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
 * 移动文件：先试 `rename`（同盘、原子、零拷贝），失败再退化成「拷贝 + 删源」。
 *
 * 退化路径是为**跨盘**准备的（`rename` 不能跨卷）。故意 catch 住所有错误而不只判 EXDEV：
 * `rename` 在 Windows 上还可能因目标被占用等杂因失败，而「拷贝 + 删源」在这些情况下同样成立，
 * 没必要把失败模式枚举全。拷完了才删源 —— 即使删源失败也只是留下一份副本，不会丢数据。
 */
export function moveFileSync(src: string, dest: string): void {
  try {
    renameSync(src, dest)
  } catch {
    copyFileSync(src, dest)
    unlinkSync(src)
  }
}
