// 主题：值域 + 「主题落到 <html> 上」的唯一入口 + 首帧提示。
//
// 为什么单独一个纯函数模块，而不是全塞进 stores/settings.ts：
//  ① 首帧（Pinia 装好之前、main.ts 挂载之前）就要把 data-theme 铺上 ——
//     这个模块不依赖 store，谁先跑都能用；
//  ② 反过来 store 也要用同一套「写 DOM / 读系统偏好」的实现。写两份的典型后果是
//     一处用 setAttribute、一处用 dataset，看着一样，遇到「删属性」时行为不同。
//
// ⚠️ 这里只碰表现层：不读写业务数据、不动配置（配置的真相在主进程 config.json）。

/** 用户选的模式（落盘的那个值） */
export type ThemeMode = 'dark' | 'light' | 'system'

/** 真正生效的主题（system 已按系统偏好解析成两态）；CSS 只认这个 */
export type EffectiveTheme = 'dark' | 'light'

/** 系统深浅色的媒体查询。App.vue 的 change 监听必须用同一个字符串 */
export const PREFERS_LIGHT_QUERY = '(prefers-color-scheme: light)'

/**
 * 上一次**有效**主题的缓存键（只存 dark / light）。
 *
 * 它只解决一件事：首帧。配置在主进程的 config.json 里，读它必须过 IPC（异步），
 * 在那之前 `<html>` 上还没有 data-theme → 命中 `:root`（深色）。
 * 深色用户于是完全无感，浅色用户会先看到一闪的深色 —— 这个键就是消掉那一下的。
 *
 * ⚠️ 它**不是**设置的真相，只是「上一次画成什么样」的提示：
 *  · 唯一写入点：applyThemeToDocument()（每次真正应用主题时顺手更新）；
 *  · 唯一读取点：main.ts 的首帧；
 *  · 读到什么都不影响最终结果 —— settings.init() 之后 App.vue 会以配置为准再铺一次，
 *    所以「缓存过期」最坏只是闪一下，不会停在错误的主题上。
 *
 * ⚠️ 键名刻意与 settings store 里那三个老键（stash.viewZoom / stash.cardFields /
 * stash.detailCollapsed）不同：那三个的迁移判据是「存在就搬进 config」，
 * 叫 stash.theme 会被当成用户偏好搬走，凭空在 config 里写一个来历不明的值。
 */
export const THEME_HINT_KEY = 'stash.themeHint'

/** 系统的深浅色偏好。读不到（老内核 / 被策略禁用）就当深色 —— 与 `:root` 的默认一致 */
export function systemPrefersLight(): boolean {
  try {
    return window.matchMedia(PREFERS_LIGHT_QUERY).matches
  } catch {
    return false
  }
}

/** 读首帧提示。没有 / 坏值 / localStorage 被禁 → 'dark'（= 内核默认，等于不铺） */
export function readThemeHint(): EffectiveTheme {
  try {
    return window.localStorage.getItem(THEME_HINT_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

/** 写首帧提示。写不进去也不影响本次运行（只是下次启动少一帧优化） */
export function writeThemeHint(theme: EffectiveTheme): void {
  try {
    window.localStorage.setItem(THEME_HINT_KEY, theme)
  } catch {
    /* 隐私模式 / 配额满：忽略 */
  }
}

/**
 * 把主题铺到 `<html data-theme>` 上。
 *
 * 深色**显式写** `dark` 而不是删属性：
 * ① devtools 里一眼能看出当前是什么主题（删掉属性时只能靠「没有这条」推断）；
 * ② 将来若真需要 `[data-theme="dark"]` 覆盖某条规则，不必再改这里。
 * 值域里没有 `system` —— 三态在 store 的 effectiveTheme 里就已经解析成两态了。
 */
export function applyThemeToDocument(theme: EffectiveTheme): void {
  document.documentElement.dataset.theme = theme
  writeThemeHint(theme)
}
