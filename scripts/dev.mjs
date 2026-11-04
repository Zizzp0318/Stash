// `npm run dev` 的入口：包一层 run-electron-vite，免疫 ELECTRON_RUN_AS_NODE。
//
// 为什么要这层壳：宿主终端（如 WorkBuddy 集成终端）注入的
// `ELECTRON_RUN_AS_NODE=1` 会让 electron.exe 以纯 Node 模式启动，
// 主进程 `require('electron')` 拿不到 API 对象，一跑就崩
// （registerSchemesAsPrivileged 报 undefined）。通用逻辑与说明见
// scripts/run-electron-vite.mjs；本文件只是让 `npm run dev` 的语义清晰，
// 实际等价于 `node scripts/run-electron-vite.mjs dev`。
import { run } from './run-electron-vite.mjs'

await run(['dev'])
