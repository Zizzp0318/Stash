// 冒烟测试共享工具（**不是 runner**：不要往 `main.ts` 注册，也不要被除 smoke* 之外的模块引用）。
//
// 为什么要有这个文件：审计 §2「同一逻辑在多处各写一遍」——`waitUntil` 此前在
// `smoke-search.ts` / `smoke-watch.ts` / `smoke-welcome.ts` 各有一份、默认超时还各不相同。
// 本次把 4 套（preview / edit / folder / m4）的固定 `sleep` 改成有界轮询时，
// 统一从这里取，避免出现第 8 份拷贝。

import type { MouseInputEvent } from 'electron'

/**
 * `sendInputEvent` 的 `modifiers` 形参类型（`MouseInputEvent['modifiers']`）。
 *
 * 为什么要单独拎出来：`modifiers` 是**收窄的字符串联合**，直接传 `string[]` 会 TS2322；
 * 而把它写成 `string[]` 又会丢掉「只允许约定的修饰键名」这层校验。
 *
 * ⚠️ 大小写（实测过，别再猜）：官方 d.ts 的联合里**只有小写**（`leftbuttondown` / `isautorepeat` …），
 * 但 Electron 运行时**大小写都认** —— 探针 `.workbuddy/audit/probe-mods.js` 用 camelCase
 * (`leftButtonDown`) 与小写 (`leftbuttondown`) 各发一次 `mouseMove`，渲染层两次都拿到 `buttons===1`；
 * `control` 与 `ctrl` 亦等价。故本项目统一按**官方小写**书写：纯对齐类型，运行行为不变。
 */
export type InputModifiers = NonNullable<MouseInputEvent['modifiers']>

/** 渲染层求值器：把一段 JS 表达式丢进页面里求值（与各套件的 `js(code)` 同形）。 */
export type JsEval = (code: string) => Promise<unknown>

/**
 * 有界轮询：反复求值表达式 `expr` 直到它为真；**超时返回 `false`**（绝不假装成功）。
 *
 * 为什么必须有它：固定 `sleep(N)` 是在赌「N 毫秒后状态一定就绪」，机器一忙就不够 →
 * 断言偶发红，且红得看起来像产线 bug（铁律 G4）。轮询把「等多久」交给事实。
 * ⚠️ 调用方**必须**把返回值并入断言（或至少放进诊断字段）——否则超时后照样往下跑，
 * 在某些输入下快照可能恰好满足断言，你只是把 flake 藏起来了（铁律 G11）。
 *
 * @param js                渲染层求值器（各套件的 `js(code)`），表达式需在页面里求值为布尔。
 * @param defaultTimeoutMs  默认超时上限；各调用点可按需覆盖（给足余量，宁可慢也不能假绿）。
 * @returns                 `(expr, timeoutMs?) => Promise<boolean>`：真 = 在超时前等到了。
 */
export function makeWaitUntil(
  js: JsEval,
  defaultTimeoutMs = 15000
): (expr: string, timeoutMs?: number) => Promise<boolean> {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  return async function waitUntil(expr: string, timeoutMs = defaultTimeoutMs): Promise<boolean> {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      // 用 `!!(expr)` 包一层：调用方写的表达式返回任何「真值」都算成立（有的套件原来直接当布尔用）
      if ((await js(`!!(${expr})`)) === true) return true
      await sleep(120)
    }
    return false
  }
}
