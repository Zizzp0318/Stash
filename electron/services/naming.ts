import { existsSync } from 'fs'
import { extname, join } from 'path'

/**
 * 目标目录内已有同名文件时，追加 ` (1)`、` (2)`… 取第一个空位。
 *
 * **导入 / 移动 / 复制 / 重命名四条路径共用这一个函数**，不许各写一份：
 * 早先导入那边是手抄的等价逻辑，规则一旦有人改动（比如换成 `_1`）就会两套并存，
 * 用户会在不同入口看到不同风格的名字。这里是唯一的命名真相。
 *
 * 判定依据默认是**磁盘上是否存在**（不是索引）—— 外部放进来的文件即使还没被 watcher 索引，
 * 也不该被覆盖。`extraTaken` 供调用方补充「索引里也算占用」的判断：
 * 记录还在、文件已被外部删掉的 `missing` 行，磁盘上完全看不出来，可 `assets.rel_path`
 * 的 UNIQUE 约束认得它 —— 重命名时漏掉这一层就会在 UPDATE 时炸约束错。
 */
export function uniqueName(dir: string, name: string, extraTaken?: (name: string) => boolean): string {
  const taken = (n: string): boolean => existsSync(join(dir, n)) || extraTaken?.(n) === true
  if (!taken(name)) return name
  const ext = extname(name)
  const base = name.slice(0, name.length - ext.length)
  let i = 1
  while (taken(`${base} (${i})${ext}`)) i++
  return `${base} (${i})${ext}`
}
