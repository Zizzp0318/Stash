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
 *   - token 只从环境变量读，**绝不写进任何文件**，也不出现在仓库里；
 *   - 幂等：tag 已存在则复用，Release 已存在则复用，同名附件先删再传；
 *   - 发什么由 package.json 的 version 决定，不做手工拼文件名。
 */
import { readFileSync, existsSync, statSync } from 'fs'
import { execFileSync } from 'child_process'
import { join, dirname, basename } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
const REPO = process.env.GITHUB_REPO || 'Zizzp0318/Stash'
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7897'
const API = 'https://api.github.com'
const UPLOADS = 'https://uploads.github.com'

if (!TOKEN) {
  console.error('缺少 GITHUB_TOKEN 环境变量。用法：GITHUB_TOKEN=xxx npm run release')
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const VERSION = pkg.version
const TAG = `v${VERSION}`

/** 一次 curl 调用；返回解析后的 JSON。token 通过 header 传，不落任何文件 */
function api(method, url, { json, binary, out } = {}) {
  const args = ['-sS', '-x', PROXY, '-X', method, '-H', `Authorization: Bearer ${TOKEN}`,
    '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28']
  if (json !== undefined) {
    args.push('-H', 'Content-Type: application/json; charset=utf-8', '--data-binary', '@-')
  } else if (binary) {
    args.push('-H', 'Content-Type: application/octet-stream', '--data-binary', `@${binary}`)
  }
  args.push(url)

  let stdout
  try {
    stdout = execFileSync('curl', args, {
      input: json !== undefined ? Buffer.from(JSON.stringify(json), 'utf8') : undefined,
      maxBuffer: 32 * 1024 * 1024,
      encoding: out ? 'utf8' : 'utf8'
    })
  } catch (e) {
    throw new Error(`curl 失败（${method} ${url}）：${e.message}`)
  }
  if (out) return stdout
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`返回不是 JSON：${stdout.slice(0, 300)}`)
  }
}

function fail(step, res) {
  console.error(`✗ ${step} 失败：${res?.message || JSON.stringify(res).slice(0, 200)}`)
  const hints = {
    'Bad credentials': 'token 无效或已被撤销 —— 去 GitHub → Settings → Developer settings 重新生成',
    'Not Found': '仓库不存在，或 token 没有该仓库的权限（classic token 要勾 repo 范围）',
    'Resource not accessible by personal access token': 'token 权限不足：classic token 需要 repo 范围'
  }
  if (hints[res?.message]) console.error(`  → ${hints[res.message]}`)
  process.exit(1)
}

const fmt = (n) => (n / 1024 / 1024).toFixed(0) + ' MB'

// ---- 待发附件：由版本号推导，不手工拼 ----
const wanted = [
  { file: join(ROOT, 'dist', `Stash-${VERSION}-setup.exe`), label: '安装版' },
  { file: join(ROOT, 'dist', `Stash-${VERSION}-portable.zip`), label: '便携版' }
]
const missing = wanted.filter((w) => !existsSync(w.file))
if (missing.length) {
  console.error('缺少产物，先跑 `npm run package:win`：')
  for (const m of missing) console.error('  ✗ ' + m.file)
  process.exit(1)
}

// ---- 1) tag：把本地 tag 推到远端（Release 依附在 tag 上）----
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

// ---- 2) Release：已存在就复用，避免重复创建报 422 ----
console.log(`[2/4] 创建/复用 Release ${TAG} …`)
let rel = api('GET', `${API}/repos/${REPO}/releases/tags/${TAG}`)
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

---

完整功能清单与开发说明见 [README](https://github.com/${REPO}#readme)。`

  rel = api('POST', `${API}/repos/${REPO}/releases`, {
    json: { tag_name: TAG, name: `Stash 素材库 ${TAG}`, body, draft: false, prerelease: false }
  })
  if (!rel?.id) fail('创建 Release', rel)
  console.log(`      ✓ 已创建（id=${rel.id}）`)
}

// ---- 3) 上传附件：同名先删，否则 422 already_exists ----
console.log('[3/4] 上传附件 …')
const existing = api('GET', `${API}/repos/${REPO}/releases/${rel.id}/assets`) || []
for (const w of wanted) {
  const name = basename(w.file)
  const size = statSync(w.file).size
  const dup = existing.find((a) => a.name === name)
  if (dup) {
    if (dup.size === size) {
      console.log(`      · ${name} 已在且大小一致，跳过`)
      continue
    }
    await api('DELETE', `${API}/repos/${REPO}/releases/assets/${dup.id}`)
    console.log(`      · 删掉旧的 ${name}`)
  }
  process.stdout.write(`      传 ${name}（${fmt(size)}，${w.label}）… `)
  const asset = api('POST', `${UPLOADS}/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`, {
    binary: w.file
  })
  if (!asset?.browser_download_url) fail(`上传 ${name}`, asset)
  console.log('✓')
}

// ---- 4) 核对 ----
console.log('[4/4] 核对 …')
const final = api('GET', `${API}/repos/${REPO}/releases/${rel.id}`)
for (const a of final.assets || []) {
  console.log(`      ✓ ${a.name}  ${fmt(a.size)}  ${a.download_count} 次下载`)
}
console.log(`\n发布页：${final.html_url}`)
