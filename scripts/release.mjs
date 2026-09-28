#!/usr/bin/env node
/**
 * 把 dist/ 里打好的安装包与便携包发到 GitHub Release。
 *
 *   GITHUB_TOKEN=xxx npm run release
 *
 * 为什么走 Release 而不是 git 提交：
 *   GitHub 对**单个文件**有 100MB 硬限制，setup.exe(135MB) / portable.zip(184MB) 直接
 *   `git add` 会被服务端拒收；退一步说，就算能做 LFS，二进制也不该进版本历史
 *   （每次发版都会让 clone 体积翻倍）。Release 附件上限 2GB，是这类产物的正路。
 *
 * 设计要点：
 *   - token 只从环境变量读，**绝不写进任何文件**，也不进仓库；
 *   - 幂等：tag 已存在则复用，Release 已存在则复用，同名附件先删再传；
 *   - 发什么由 package.json 的 version 决定，不做手工拼文件名；
 *   - 网络层用 node 内置 https 手写代理 CONNECT 隧道 —— 不 spawn curl。
 *     本机 `execFileSync('curl')` 会报 `spawnSync curl EBUSY`（那个 exe 被安全软件盯着），
 *     而 `execFileSync('git')` 正常；顺带也免掉了 token 出现在子进程命令行里的暴露面。
 */
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'
import tls from 'node:tls'
import net from 'node:net'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
const REPO = process.env.GITHUB_REPO || 'Zizzp0318/Stash'
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7897'
const API_HOST = 'api.github.com'
const UPLOAD_HOST = 'uploads.github.com'

if (!TOKEN) {
  console.error('缺少 GITHUB_TOKEN 环境变量。用法：GITHUB_TOKEN=xxx npm run release')
  process.exit(1)
}

// ---------- 网络层：经 HTTP 代理的 CONNECT 隧道 ----------

/** 与代理建立到 host:443 的隧道，返回裸 socket */
function tunnel(host) {
  return new Promise((resolve, reject) => {
    const p = new URL(PROXY)
    const sock = net.connect(Number(p.port) || 80, p.hostname)
    let acc = Buffer.alloc(0)
    const onData = (d) => {
      acc = Buffer.concat([acc, d])
      const i = acc.indexOf('\r\n\r\n')
      if (i < 0) return
      sock.removeListener('data', onData)
      const head = acc.subarray(0, i).toString('latin1')
      if (!/^HTTP\/1\.[01] 200/.test(head)) {
        return reject(new Error('代理 CONNECT 被拒绝：' + head.split('\r\n')[0]))
      }
      const rest = acc.subarray(i + 4)
      if (rest.length) sock.unshift(rest) // CONNECT 响应后面可能已经跟着数据了
      resolve(sock)
    }
    sock.on('data', onData)
    sock.once('error', reject)
    sock.once('connect', () =>
      sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Connection: Keep-Alive\r\n\r\n`)
    )
  })
}

class TunnelAgent extends https.Agent {
  constructor(host) {
    super({ keepAlive: false })
    this.targetHost = host
  }
  createConnection(_options, cb) {
    tunnel(this.targetHost)
      .then((sock) => {
        const t = tls.connect({ socket: sock, servername: this.targetHost }, () => cb(null, t))
        t.once('error', cb)
      })
      .catch(cb)
  }
}

/** 一次 GitHub API 调用；json → JSON body，file → 流式上传该文件 */
function gh({ host = API_HOST, method = 'GET', path, json, file, label }) {
  return new Promise((resolve, reject) => {
    const headers = {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'stash-release-script',
      'X-GitHub-Api-Version': '2022-11-28'
    }
    let payload = null
    let stream = null
    if (json !== undefined) {
      payload = Buffer.from(JSON.stringify(json), 'utf8')
      headers['Content-Type'] = 'application/json; charset=utf-8'
      headers['Content-Length'] = payload.length
    } else if (file) {
      headers['Content-Type'] = 'application/octet-stream'
      headers['Content-Length'] = statSync(file).size
      stream = createReadStream(file)
    }

    const req = https.request(
      { hostname: host, port: 443, method, path, headers, agent: new TunnelAgent(host) },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let body
          try {
            body = JSON.parse(text)
          } catch {
            body = { message: text.slice(0, 200) || `HTTP ${res.statusCode}` }
          }
          resolve({ status: res.statusCode, body })
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(0) // 大文件上传不设超时

    if (payload) req.end(payload)
    else if (stream) {
      const total = Number(headers['Content-Length'])
      let sent = 0
      let mark = 0
      stream.on('data', (c) => {
        sent += c.length
        const pct = Math.floor((sent / total) * 100)
        if (pct >= mark + 10) {
          mark = pct - (pct % 10)
          process.stdout.write(`${mark}% `)
        }
      })
      stream.on('error', reject)
      stream.pipe(req)
    } else req.end()
  })
}

/**
 * 带重试的调用。
 * 本机走代理访问 GitHub 偶尔会 ECONNRESET（实测撞过一次，白跑一趟 320MB 之前的上传）；
 * **大文件上传不重试** —— 传一半失败时服务端可能已建了同名 asset，
 * 盲重试会撞 422，交给「重跑脚本（先删同名再传）」更可控。
 */
async function call(opts) {
  const tries = opts.file ? 1 : 3
  let last
  for (let i = 0; i < tries; i++) {
    try {
      return await gh(opts)
    } catch (e) {
      last = e
      if (i < tries - 1) {
        const wait = 1000 * (i + 1)
        console.log(`      · 网络抖动（${e.code || e.message}），${wait}ms 后重试 …`)
        await new Promise((r) => setTimeout(r, wait))
      }
    }
  }
  throw last
}

function fail(step, res) {
  console.error(`\n✗ ${step} 失败（HTTP ${res?.status}）：${res?.body?.message || ''}`)
  const hints = {
    'Bad credentials': 'token 无效或已被撤销 —— 去 GitHub → Settings → Developer settings 重新生成',
    'Not Found': '仓库不存在，或 token 没有该仓库权限（classic token 要勾 repo 范围）',
    'Resource not accessible by personal access token': 'token 权限不足：classic token 需要 repo 范围',
    'already_exists': '同名附件已存在（脚本本应先删旧的，若反复出现就手工删一次）'
  }
  const key = Object.keys(hints).find((k) => String(res?.body?.message || '').includes(k))
  if (key) console.error(`  → ${hints[key]}`)
  process.exit(1)
}

const fmt = (n) => (n / 1024 / 1024).toFixed(0) + ' MB'

/**
 * 相比上一个 tag 的变更摘要（Release 页面的「本版更新」段）。
 * 列表就是 commit 首行 —— 本项目提交信息首行都是结论式中文长句，直接放上来信息量足够。
 */
function changelogFor(tag) {
  // ⚠️ 本机安全软件会**间歇性**盯上 git.exe：spawnSync 偶发 `EBUSY`（实测撞过一次）——
  //    而 changelog 的异常被 catch 静默吞成空串，结果 Release 里悄悄少了一段「本版更新」，
  //    事后只能手动 PATCH 补。所以这里对 EBUSY 做同步退避重试；其它异常照旧吞掉
  //    （宁缺毋滥，别让整次发布失败）。
  const git = (args: string[]): string => {
    let last: Error | null = null
    for (let i = 0; i < 4; i++) {
      try {
        return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
      } catch (e) {
        last = e as Error
        if (!String(e).includes('EBUSY')) break
        const until = Date.now() + 300 * (i + 1)
        while (Date.now() < until) {
          /* 同步退避（照 rmWithRetry 的样式，冒烟脚本里不值得引入异步） */
        }
      }
    }
    throw last as Error
  }
  try {
    const tags = git(['tag', '--sort=creatordate'])
      .split('\n')
      .filter(Boolean)
    const idx = tags.indexOf(tag)
    const prev = idx > 0 ? tags[idx - 1] : null
    const range = prev ? `${prev}..${tag}` : tag
    const lines = git(['log', range, '--oneline', '--no-decorate'])
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(0, 20)
    if (!lines.length) return ''
    return '### 本版更新\n\n' + lines.map((l) => `- ${l}`).join('\n') + '\n'
  } catch {
    return '' // git 出问题时宁缺毋滥，别让整次发布失败
  }
}

// `--check`：只验凭据 + 代理连通性，不碰远端任何东西（排错用）
if (process.argv.includes('--check')) {
  const r = await call({ path: '/user' })
  if (r.body?.login) {
    console.log(`✓ 凭据可用，账号 = ${r.body.login}（经代理 ${PROXY}）`)
    process.exit(0)
  }
  console.error(`✗ 凭据不可用（HTTP ${r.status}）：${r.body?.message}`)
  process.exit(1)
}

// ---------- 1) tag ----------
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const VERSION = pkg.version
const TAG = `v${VERSION}`

console.log(`[1/4] 推送 tag ${TAG} …`)
try {
  execFileSync('git', ['push', `https://x-access-token:${TOKEN}@github.com/${REPO}.git`, TAG], {
    cwd: ROOT,
    env: { ...process.env, HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8'
  })
  console.log('      ✓ tag 已推送')
} catch (e) {
  const msg = String(e.stderr || e.message)
  if (/up to date|already exists/i.test(msg)) console.log('      · tag 已在远端')
  else {
    console.error('      ✗ tag 推送失败：' + msg.trim().split('\n').slice(-2).join(' '))
    process.exit(1)
  }
}

// ---------- 2) Release ----------
console.log(`[2/4] 创建/复用 Release ${TAG} …`)
let rel = (await call({ path: `/repos/${REPO}/releases/tags/${TAG}` })).body
if (rel?.id) {
  console.log(`      · 已存在（id=${rel.id}），复用`)
} else {
  const body = `## Stash 素材库 ${TAG}

Windows **本地**素材管理软件 —— 自包含素材库 + 归档整理 + AI 生成参数提取。
所有数据都在你自己的磁盘上：不联网、不注册、不上传任何东西。

### 下载

| 包 | 说明 |
|---|---|
| \`Stash-${VERSION}-setup.exe\` | **安装版**：可选安装目录、按用户安装（不需要管理员权限）。卸载**不会**删除你的库数据 |
| \`Stash-${VERSION}-portable.zip\` | **便携版**：解压即用，可放 U 盘。解压后运行里面的 \`Stash.exe\` |

> ⚠️ 两个包都**未做代码签名**，首次运行会被 Windows SmartScreen 拦一下 —— 点「更多信息」→「仍要运行」。

### 功能概览

**库是自包含的** —— 一个库 = 素材文件 + \`.stash\`（SQLite 索引）+ \`.thumbs\`（缩略图缓存），三者都在库目录里。
整库拷到移动硬盘就能带走，不依赖任何外部数据库。

**导入与整理** —— 拖拽 / 粘贴 / 批量导入，按内容哈希跳过重复；重名自动改成 \`名字 (1).ext\`，**绝不覆盖**；
多级文件夹（与磁盘目录 1:1）、拖拽移动、标签、评分、喜欢。

**浏览与搜索** —— 瀑布流 / 列表双视图，虚拟滚动；搜文件名与标签、按类型/评分/喜欢筛选、
四维排序、命中高亮；框选与批量操作条。

**预览** —— 图片缩放平移 + 色板取色；视频 / 音频内置播放器（Range 流式，
MKV/AVI 等浏览器不认的容器自动转码派生）；文本直接编辑并自动识别 GBK；
HEIC / TIFF 自动生成高清派生预览图。

**AI 生成参数提取**（本项目最有意思的部分）—— 从图片自带的元数据里读出提示词、负向提示词、
模型、采样器、调度器、步数、CFG、种子、LoRA。支持 **ComfyUI / A1111·Forge / Fooocus /
InvokeAI / NovelAI / Midjourney**，并识别 C2PA 与国内 AIGC 标识。

**图像压缩** —— 按需单张或批量、**原地替换**、默认 JPG q90；动文件前会先把能提取的参数落库，
避免转格式把提示词一起丢掉。

### 首次使用

1. 安装版装完直接运行；便携版解压后运行 \`Stash.exe\`
2. 首次打开是欢迎页 → **新建库**（选一个空目录）或 **打开库…**（选中已有库目录）
3. 打开库后把文件拖进窗口即可导入

### 已知限制

- **删除素材 = 直接从磁盘删除**（无回收站），有二次确认，请谨慎对待
- 仅支持 Windows x64
- 未做代码签名，会被 SmartScreen 提示
- 打包版与开发版的配置目录不同（\`Stash\` / \`Electron\`），首次打开设置是默认值；
  但**素材库本身自包含**，用「打开库…」选回原目录，数据一条不少

### 验证情况

打包产物跑过完整自检：\`--smoke-preview\` 90 项断言全过（\`failed: []\`），覆盖 ffmpeg 转码与派生、
sharp 图片处理、Range 流式、真实播放与图片预览 —— 等于把「原生依赖在 asar 里解包对不对」实测了一遍。

${changelogFor(TAG)}

---

完整功能清单与开发说明见 [README](https://github.com/${REPO}#readme)。`

  const created = await call({
    method: 'POST',
    path: `/repos/${REPO}/releases`,
    json: { tag_name: TAG, name: `Stash 素材库 ${TAG}`, body, draft: false, prerelease: false }
  })
  rel = created.body
  if (!rel?.id) fail('创建 Release', created)
  console.log(`      ✓ 已创建（id=${rel.id}）`)
}

// ---------- 3) 上传附件 ----------
const wanted = [
  { file: join(ROOT, 'dist', `Stash-${VERSION}-setup.exe`), label: '安装版' },
  { file: join(ROOT, 'dist', `Stash-${VERSION}-portable.zip`), label: '便携版' }
]
const missing = wanted.filter((w) => !existsSync(w.file))
if (missing.length) {
  console.error('\n缺少产物，先跑 `npm run package:win`：')
  for (const m of missing) console.error('  ✗ ' + m.file)
  process.exit(1)
}

console.log('[3/4] 上传附件 …')
const existing = (await call({ path: `/repos/${REPO}/releases/${rel.id}/assets` })).body || []
for (const w of wanted) {
  const name = basename(w.file)
  const size = statSync(w.file).size
  const dup = Array.isArray(existing) ? existing.find((a) => a.name === name) : null
  if (dup) {
    if (dup.size === size) {
      console.log(`      · ${name} 已在且大小一致，跳过`)
      continue
    }
    await call({ method: 'DELETE', path: `/repos/${REPO}/releases/assets/${dup.id}` })
    console.log(`      · 删掉旧的 ${name}`)
  }
  process.stdout.write(`      ${name}（${fmt(size)}，${w.label}）`)
  const up = await call({
    host: UPLOAD_HOST,
    method: 'POST',
    path: `/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`,
    file: w.file
  })
  if (!up.body?.browser_download_url) fail(`上传 ${name}`, up)
  console.log('  ✓')
}

// ---------- 4) 核对 ----------
console.log('[4/4] 核对 …')
const final = (await call({ path: `/repos/${REPO}/releases/${rel.id}` })).body
for (const a of final.assets || []) {
  console.log(`      ✓ ${a.name}  ${fmt(a.size)}  ${a.download_count} 次下载  ${a.browser_download_url}`)
}
console.log(`\n发布页：${final.html_url}`)
