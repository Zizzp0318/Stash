// 清理 electron-vite 遗留在项目根的临时配置副本。
//
// 背景（读 node_modules/electron-vite 的实现确认过，别凭猜）：
//   electron-vite 会把 `electron.vite.config.ts` 打包成
//   `electron.vite.config.<Date.now()>.mjs` 写到项目根，再 `import()` 它来读配置；
//   读完在 finally 里 `unlinkSync` 删掉 —— 但 **Windows 上这个文件句柄还没释放**，
//   删除会抛错并被它自己的 `catch {}` 吞掉。于是「每加载一次配置就留一个」：
//   build / dev / preview 都会留，一次一个（曾一天攒了 14 个）。
//
// 所以清理必须做成幂等的收尾，挂在 npm 生命周期钩子上：
//   postbuild / predev（见 package.json）。start.bat 走 `npm run build`，
//   因此也吃得到 postbuild。
//
// 边界：
//   - 只删名字形如 `electron.vite.config.<纯数字>.mjs` 的 —— 真正的
//     `electron.vite.config.ts` 没有数字后缀、扩展名也不同，双重不匹配，删不到它；
//   - 文件正被别的进程占用（比如另一个 dev 实例）时 unlink 会失败，跳过即可；
//   - 任何异常都吞掉并 **始终以 0 退出** —— 这只是打扫，不能把 build 带成失败。
import { readdirSync, statSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/** 时间戳型临时副本：electron.vite.config.1790525050218.mjs */
const TMP_RE = /^electron\.vite\.config\.\d+\.mjs$/

let removed = 0
try {
  for (const name of readdirSync(root)) {
    if (!TMP_RE.test(name)) continue
    const abs = join(root, name)
    try {
      if (!statSync(abs).isFile()) continue
      unlinkSync(abs)
      removed++
    } catch {
      /* 单个文件删不掉（被占用等）就跳过，不影响其它 */
    }
  }
} catch {
  /* 读目录失败也不该拖垮调用方 */
}

if (removed) console.log(`[clean-vite-tmp] 已清理 ${removed} 个 electron-vite 临时配置文件`)
