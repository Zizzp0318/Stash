// 检查更新：只**查询**最新版本号，不下载、不安装、不自动更新（用户明确要求的边界）。
//
// 为什么不用 GitHub API（`api.github.com/repos/.../releases/latest`）：
// 未认证调用限流 **60 次/小时/IP**，用户处在 NAT/公司网络后就更容易被判定超限；
// 而我们真正需要的只有一个版本号。所以改打**网页**的 `/releases/latest`：
// GitHub 会 302 到 `/releases/tag/vX.Y.Z`，版本号就在 `Location` 头里，
// 不消耗任何 API 配额，也不需要 token。
//
// 为什么**不跟随重定向**：跟随之后拿到的是一整页 HTML（几百 KB），
// 还得再解析 DOM 才能取版本号；读 `Location` 是零解析成本。
// Node 的 `https.get` 默认就不跟随，正好合用。
//
// ⚠️ 本模块**不许 import electron**（尤其不许碰 `app.getVersion()`）：
// 冒烟要直接 `import { checkLatest } ...` 做注入测试，一旦掺进 electron 单例就跑不起来。
// 当前版本号在 IPC handler 层取（main.ts），纯函数只跟字符串打交道。
import { get as httpsGet } from 'https'

/** 仓库与发布页（**全仓唯一一份**，UI 与主进程都从这里对表，别各抄一行） */
export const REPO_URL = 'https://github.com/Zizzp0318/Stash'
/** 下载页面：用户点「去下载」/ GitHub 图标都落到这里 */
export const RELEASES_URL = 'https://github.com/Zizzp0318/Stash/releases'
/** 302 探针：GitHub 会把它重定向到 `/releases/tag/<tag>` */
export const LATEST_RELEASE_URL = 'https://github.com/Zizzp0318/Stash/releases/latest'

/** 默认超时：5 秒。国内直连 GitHub 常常「能连但很慢」，超时给太短会全是失败态 */
export const DEFAULT_TIMEOUT_MS = 5000

/** 检查结果：**永不 throw**，成功与失败都是值（失败要能在 UI 上做文案） */
export type UpdateCheckResult = { latest: string; url: string } | { error: string }

export interface CheckLatestOptions {
  /** 超时毫秒；默认 5000 */
  timeoutMs?: number
  /** 取 302 的 `Location`。可注入 —— 冒烟**绝不能**依赖真实网络 */
  fetchLocation?: () => Promise<string | null>
}

/**
 * 从 302 的 `Location` 里取 tag：
 * `'https://github.com/o/r/releases/tag/v0.1.9'` → `'0.1.9'`
 *
 * 容忍这些形态（都要能取到或安全地返回 null，不许抛）：
 * · 尾部斜杠 `/releases/tag/v0.1.9/`
 * · 带 query / hash `/releases/tag/v0.1.9?foo=bar#x`
 * · 非 GitHub 域名（代理、镜像站、钓鱼地址）→ null
 * · 压根没有 `/tag/` 段（比如被重定向到登录页 / 404 页）→ null
 * · 取到的段不是版本号（`latest`、`untagged-abc`）→ null，让调用方走失败态
 */
export function parseTagFromLocation(location: string): string | null {
  if (typeof location !== 'string') return null
  const raw = location.trim()
  if (!raw) return null

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  // 只认 http(s)：`file:` / `javascript:` 之类一律不认
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase()
  if (host !== 'github.com' && host !== 'www.github.com') return null

  // `pathname` 不含 query / hash，所以 `?foo=bar` 天然被忽略；
  // `filter(Boolean)` 顺手吃掉尾部的空段（`/v0.1.9/` 与 `/v0.1.9` 等价）
  const segs = url.pathname.split('/').filter(Boolean)
  // 约定的形态：/<owner>/<repo>/releases/tag/<tag>
  const releasesIdx = segs.findIndex((s) => s.toLowerCase() === 'releases')
  if (releasesIdx < 0) return null
  if ((segs[releasesIdx + 1] ?? '').toLowerCase() !== 'tag') return null
  const rawTag = segs[releasesIdx + 2]
  if (!rawTag) return null

  let decoded = rawTag
  try {
    decoded = decodeURIComponent(rawTag)
  } catch {
    /* 非法百分号编码：直接用原串，后面的正则还会再校验一次 */
  }

  // 版本号只取开头的数字段：`v0.1.9` → `0.1.9`，`0.1.9-beta.1` → `0.1.9`
  const m = /^[vV]?\s*(\d+(?:\.\d+)*)/.exec(decoded.trim())
  return m ? m[1] : null
}

/** 版本串 → 数字段数组（`v0.1.10` → `[0, 1, 10]`；非数字段当 0） */
function versionSegments(version: string): number[] {
  const s = (version ?? '').trim().replace(/^[vV]/, '')
  // 预发布 / 构建元数据不参与比较：`1.2.3-beta.1` 与 `1.2.3` 视为同一版
  const core = s.split('-')[0].split('+')[0]
  return core.split('.').map((part) => {
    const m = /^\d+/.exec(part.trim())
    return m ? Number(m[0]) : 0
  })
}

/**
 * 语义化版本比较：`a > b` 返回 1，相等 0，`a < b` 返回 -1。
 *
 * ⚠️ **必须逐段按数字比**，不能 `a > b`、也不能 `localeCompare`：
 * 字符串比较里 `'0.1.10' < '0.1.9'`（`'1' < '9'`），会把「有新版」判成「已最新」——
 * 而 0.1.10 恰恰是最常见的下一个版本号。缺的段按 0 补齐（`1.0.0` == `1`）。
 */
export function compareVersion(a: string, b: string): number {
  const left = versionSegments(a)
  const right = versionSegments(b)
  const len = Math.max(left.length, right.length)
  for (let i = 0; i < len; i++) {
    const x = left[i] ?? 0
    const y = right[i] ?? 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

/**
 * 默认取 Location 的实现：打网页版 `/releases/latest`，读 302 的 `Location`。
 *
 * · **不跟随重定向**（`https.get` 默认行为）
 * · **超时必须 destroy**：光记一个定时器不掐 socket 的话，进程会一直挂着；
 *   `req.destroy(new Error('ETIMEDOUT'))` 之后 `error` 事件会把 Promise 收掉
 * · 响应体直接 `resume()` 丢掉：头部已经拿到，留着 body 只会占 socket
 */
function fetchLocationViaHttps(timeoutMs: number): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }

    const req = httpsGet(
      LATEST_RELEASE_URL,
      {
        headers: {
          // GitHub 对没有 UA 的请求偶尔直接拒；带上 UA 也更便于对方识别来源
          'user-agent': 'Stash-Update-Check',
          accept: 'text/html'
        }
      },
      (res) => {
        const location = res.headers.location
        res.resume() // 丢掉响应体，别让 socket 悬着
        finish(() => resolve(typeof location === 'string' && location ? location : null))
      }
    )

    req.on('error', (e) => finish(() => reject(e)))
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('ETIMEDOUT'))
    })
  })
}

/**
 * 查询最新版本。**任何异常都收敛成 `{ error }`**，绝不 throw 到 IPC 层 ——
 * 「检查更新」失败是常态（断网 / 代理 / 超时），UI 只需要一句「检查失败，请稍后再试」。
 *
 * ⚠️ **总超时看门狗**（`WATCHDOG` 那几行）不是冗余，别删：
 * `req.setTimeout()` 的语义是「**socket 分配、连接建立之后**才开始计时」——
 * 卡在 DNS 解析阶段（此时还没有 socket）时它**根本不会 arm**。
 * 国内网络下 DNS 挂起比连接超时更常见，一旦发生，`fetchLocation` 永不 settle，
 * `checkLatest` 也永不返回 → 渲染层那颗按钮永远停在 disabled 的转圈态，
 * 用户只能关掉设置面板。看门狗与 socket 状态解耦，保证**函数一定在 timeoutMs 内返回**。
 * 两者职责不同、都要留：看门狗负责「一定返回」，`req.destroy` 负责「连接不泄漏」。
 *
 * @param opts.timeoutMs 超时毫秒（默认 5000）
 * @param opts.fetchLocation 可注入的 Location 获取器（冒烟用它，不碰真实网络）
 */
export async function checkLatest(opts: CheckLatestOptions = {}): Promise<UpdateCheckResult> {
  const rawTimeout = Number(opts.timeoutMs)
  // 看门狗与下面的 socket 超时都必须是**归一化之后**的值，不能直接用原始 opts.timeoutMs
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.floor(rawTimeout) : DEFAULT_TIMEOUT_MS
  const fetchLocation = opts.fetchLocation ?? (() => fetchLocationViaHttps(timeoutMs))

  // WATCHDOG：句柄存下来，在 finally 里清掉 —— 否则一次成功的检查也会留下一个
  // 悬挂 5 秒的定时器，把整个进程（以及冒烟的退出）多拖 5 秒
  let watchdog: ReturnType<typeof setTimeout> | null = null
  try {
    const guarded = Promise.race([
      fetchLocation(),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('ETIMEDOUT')), timeoutMs)
      })
    ])
    const location = await guarded
    if (!location) return { error: 'ERR_NO_LOCATION' }
    const latest = parseTagFromLocation(location)
    if (!latest) return { error: 'ERR_BAD_LOCATION' }
    return { latest, url: RELEASES_URL }
  } catch (e) {
    return { error: String((e as Error)?.message ?? e) }
  } finally {
    // 成功 / 失败 / 超时三条路径都要走到：清掉看门狗，绝不留悬挂定时器
    if (watchdog !== null) clearTimeout(watchdog)
  }
}

/**
 * `shell:open-external` 的白名单。
 *
 * `shell.openExternal` 是**危险能力**：它会把任意 URL / 协议交给操作系统。
 * 渲染层一旦被 XSS 拿到，`openExternal('file:///C:/Windows/System32/...')`
 * 或自定义协议就等同于「本地代码执行」的前置条件。所以这里**只放行本仓库的 GitHub 页面**，
 * 其余一律由 IPC 层回 `ERR_URL_NOT_ALLOWED`。
 *
 * 实现要点：**先解析再比对**，不做字符串 `startsWith`：
 * · `https://github.com/Zizzp0318/Stash@evil.com/` 这种前缀骗术，`hostname` 是
 *   解析后的真域名，一眼出局
 * · `/Zizzp0318/Stash/../evil` 会被 URL 规范化成 `/Zizzp0318/evil`，同样出局
 * · 路径按**段边界**比对（允许 `/Stash` 与 `/Stash/...`），避免 `/StashX` 混过去
 */
export function isAllowedExternalUrl(raw: string): boolean {
  if (typeof raw !== 'string') return false
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.hostname.toLowerCase() !== 'github.com') return false
  // owner/repo 大小写不敏感（GitHub 自己就是），比较前统一小写
  const path = url.pathname.toLowerCase()
  if (path === '/zizzp0318/stash') return true
  return path.startsWith('/zizzp0318/stash/')
}
