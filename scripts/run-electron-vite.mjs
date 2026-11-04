// electron-vite 通用包装器：先摘掉 ELECTRON_RUN_AS_NODE，再拉起 electron-vite。
//
// 背景（崩溃现场：`TypeError: Cannot read properties of undefined
// (reading 'registerSchemesAsPrivileged')` at out/main/main.js）：
//   宿主环境（如 WorkBuddy 集成终端）会注入 `ELECTRON_RUN_AS_NODE=1`，
//   该变量会让 electron.exe 以「纯 Node 模式」运行 —— 此时主进程里
//   `require('electron')` 返回的不是 Electron API 对象而是模块路径字符串，
//   `electron.protocol` 为 undefined，主进程一启动就崩。
//   详见 electron/services/smoke-preview.ts 头部注释，以及根目录 dev.bat 的
//   `set ELECTRON_RUN_AS_NODE=`（手动兜底，本脚本让 `npm run dev` /
//   `npm run build` / `npm run start` 自身免疫，不再依赖它）。
//
// 做法：
//   1. `delete process.env.ELECTRON_RUN_AS_NODE` 彻底移除（置空字符串在
//      部分 Electron 版本上仍会被判定为 truthy/存在，必须 delete）；
//   2. 不走 npx / .cmd shim —— Windows 上 npx 依赖 cmd 解释器且行为易漂移，
//      这里直接用当前 node 可执行文件运行 electron-vite 的 CLI 入口
//      `node_modules/electron-vite/bin/electron-vite.js`，最稳；
//   3. `stdio: 'inherit'` 透传全部输出，子进程退出码原样赋给
//      `process.exitCode`，保证 npm 生命周期（predev / postbuild）语义不变。
//
// 用法：`node scripts/run-electron-vite.mjs <dev|build|preview> [更多参数…]`
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const root = join(scriptDir, '..')
/** electron-vite 的 CLI 入口（bin 包内文件，稳定存在；避开 .cmd shim） */
const cliPath = join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')

/**
 * 以干净的环境变量运行 electron-vite 子命令，退出码透传给当前进程。
 * @param {string[]} args 传给 electron-vite 的参数（首项为子命令，如 'dev'）
 * @returns {Promise<void>} 子进程结束后 resolve；退出码写入 process.exitCode
 */
export async function run(args) {
  if (!existsSync(cliPath)) {
    console.error(`[run-electron-vite] 未找到 electron-vite CLI：${cliPath}`)
    console.error('[run-electron-vite] 请先执行 `npm install`')
    process.exitCode = 1
    return
  }
  if (args.length === 0) {
    console.error('[run-electron-vite] 缺少子命令，用法：node scripts/run-electron-vite.mjs <dev|build|preview>')
    process.exitCode = 1
    return
  }

  // 关键一步：彻底移除而不是置空，避免 electron.exe 被降级成纯 Node 模式
  delete process.env.ELECTRON_RUN_AS_NODE

  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  })

  child.on('error', (err) => {
    console.error(`[run-electron-vite] 启动 electron-vite ${args.join(' ')} 失败：`, err)
    process.exitCode = 1
  })

  // 父进程收到 SIGINT/SIGTERM（如 Ctrl+C）时连带终止子进程，避免孤儿 vite 进程
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      child.kill(signal)
    })
  }

  await new Promise((resolve) => {
    child.on('close', (code) => {
      // 透传退出码：失败让 npm run 链路（含 postbuild 钩子）正确感知
      process.exitCode = code === null ? 1 : code
      resolve()
    })
  })
}

// 直接被执行时（npm scripts 调的是本文件），从 argv 取子命令；
// 被 dev.mjs 等导入调用时（import.meta.url !== argv[1]）不自动执行。
import { pathToFileURL } from 'url'
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  await run(process.argv.slice(2))
}
