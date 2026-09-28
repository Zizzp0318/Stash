#!/usr/bin/env node
/**
 * 便携版打包：往 `dist/win-unpacked` 里放上 `portable.txt`，再把它压成 zip。
 *
 * 为什么不直接跑第二遍 electron-builder（那样更"标准"）：
 *   第二次打包会**重新 pack**，而 pack 的第一步是清空 `dist/win-unpacked` ——
 *   本机的安全删除守卫（**按对话轮次累计**、阈值 50）会拦下 `locales` 那 87 个文件，
 *   构建当场失败（实测：`[SAFE_DELETE_BULK_CONFIRM_REQUIRED]`）。
 *   用 `--prepackaged` 走「只压缩、不重新 pack」就没有这一步，还快得多。
 *
 * 标记文件由本脚本直接写（`--prepackaged` 模式下 electron-builder 不会处理 extraFiles）；
 * `electron-builder-portable.yml` 里那份 extraFiles 是给「不走 prepackaged」的场合兜底的。
 */
import { copyFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const UNPACKED = join(ROOT, 'dist', 'win-unpacked')
const MARK_SRC = join(ROOT, 'build', 'portable.txt')
const MARK_DST = join(UNPACKED, 'portable.txt')

if (!existsSync(join(UNPACKED, 'Stash.exe'))) {
  console.error('✗ 没找到 dist/win-unpacked/Stash.exe —— 先跑 `npm run package:win:setup`')
  process.exit(1)
}

copyFileSync(MARK_SRC, MARK_DST)
console.log('[portable] 已放入便携标记 → ' + MARK_DST)

// shell: true 是为了在 Windows 上能把 `npx` 解析成 npx.cmd（参数里没有空格，安全）
execFileSync(
  'npx',
  [
    'electron-builder',
    '--win', 'zip',
    '--x64',
    '--publish', 'never',
    '--config', 'electron-builder-portable.yml',
    '--prepackaged', 'dist/win-unpacked'
  ],
  { cwd: ROOT, stdio: 'inherit', shell: true }
)

console.log('[portable] 完成')
