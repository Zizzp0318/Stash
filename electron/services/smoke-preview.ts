// 放大预览冒烟：electron . --smoke-preview
//
// P1 覆盖（媒体派生层 + stash://media 协议）：
//   S1 策略判定   —— 白名单直出 / 需派生 / 不支持，逐类型核对
//   S2 Range 流式 —— 200 / 206 / 后缀区间 / 416 / HEAD，且**字节内容与磁盘一致**
//   S3 图片派生   —— tiff → 2560px webp，派生结果能被真正解码（不是只看文件存在）
//   S4 视频派生   —— avi(mpeg4+mp3) → 转码 mp4，且派生文件本身可 seek（Range 生效）
//
// P2 覆盖（渲染层中栏浮层）：
//   U2 浮层       —— 双击打开 / 单击不打开 / Esc 关闭 / ←→ 切换 / 滚轮缩放 / 不压住右侧信息栏
//
// P3 覆盖（视频与音频）：
//   U 真实播放    —— mp4 / mkv 直出可播可 seek；avi 转码后可播可 seek；wav 可播可 seek
//
// P4 覆盖（文本读写）：
//   S5 文本读写   —— UTF-8 / 真 GBK 字节兜底 / 落盘与索引同步 / 陈旧 mtime 被拒 / 非文本与超限被拒
//   U2 文本编辑   —— 编辑器出现 / 改动标记未保存 / Ctrl+S 落盘 / 外部改动触发冲突条 / 覆盖保存生效
//
// P5 覆盖（右侧信息栏）：
//   D 信息栏预览  —— 图片仍走缩略图；视频/音频是真播放器；文本是只读（编辑只在中栏）
//
// 样张全部用 ffmpeg / sharp 现造，跑完连临时库一起删掉，不留痕。
//
// 运行：node_modules/electron/dist/electron.exe . --smoke-preview
//   ⚠️ 一个环境坑：有些宿主会注入 `ELECTRON_RUN_AS_NODE=1`，那会把 electron.exe 变成纯 Node，
//   启动即报 `Cannot read properties of undefined (reading 'registerSchemesAsPrivileged')`。
//   用 `env -u ELECTRON_RUN_AS_NODE` 去掉（start.bat 里那行 `set ELECTRON_RUN_AS_NODE=` 同理）。
//
//   （另一条历史上要手动挂 `--in-process-gpu` 的 GPU 崩溃问题，已在 main.ts 里按 `--smoke-` 前缀
//     自动降级处理，不用再记参数；根因与实测数据见 main.ts 顶部那段注释。）
import { app, type BrowserWindow } from 'electron'
import { spawn } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { FFMPEG } from './ffmpeg'
import { createLibrary, mkdirRel, closeCurrent, requireCurrent } from './library'
import { importFiles } from './importer'
import {
  analyze, previewInfo, deriveFor, serveMedia, derivedAbs, rowOf, readText, writeText,
  TEXT_MAX_BYTES, type PreviewInfo
} from './preview'

interface Check {
  name: string
  pass: boolean
  detail?: string
}

const checks: Check[] = []
function check(name: string, pass: boolean, detail?: string): void {
  checks.push({ name, pass, detail })
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { windowsHide: true })
    let err = ''
    p.stderr.on('data', (d: Buffer) => { err += d.toString() })
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.slice(-200)}`))))
    p.on('error', reject)
  })
}

/**
 * 构造一个 serveMedia 能吃的 Request。
 * 用 http URL 而不是 stash:// —— serveMedia 只读 method / headers / signal，
 * 不碰 URL（id 是单独传进去的），而自定义 scheme 在 Request 构造里行为不一定一致。
 * 真正的 stash:// 通路由渲染层在 P2/P6 验证。
 */
function mkReq(id: number, init: RequestInit = {}): Request {
  return new Request(`https://stash.test/media/${id}`, init)
}

/** 让派生文件与磁盘上的原文件对照：取 [start,end] 闭区间的字节 */
function sliceOfDisk(abs: string, start: number, end: number): Buffer {
  return readFileSync(abs).subarray(start, end + 1)
}

/**
 * 删除文件，带重试。
 * Windows 上刚写完的文件可能被杀软/索引服务短暂占用，`rmSync` 会偶发 EPERM ——
 * 这不是代码缺陷，但会让冒烟随机红掉，所以这里退避重试几次。
 */
function rmWithRetry(target: string, tries = 6): void {
  for (let i = 0; i < tries; i++) {
    try {
      rmSync(target, { force: true })
      return
    } catch (e) {
      if (i === tries - 1) throw e
      const until = Date.now() + 150
      while (Date.now() < until) { /* 同步退避，冒烟里不值得引入异步 */ }
    }
  }
}

export async function runSmokePreview(win: BrowserWindow): Promise<void> {
  const result: Record<string, unknown> = {}
  let dir: string | null = null
  try {
    dir = mkdtempSync(join(tmpdir(), 'stash-smoke-preview-'))
    const lib = createLibrary({ name: 'smoke-preview-lib', parentDir: dir })
    result.library = lib
    const folder = mkdirRel('媒体')

    // ==================== 造样张 ====================
    const srcDir = join(dir, 'src')
    mkdirSync(srcDir)

    // 图片：一张 PNG（直出）与一张 TIFF（需派生 —— Chromium 解不了 tiff）
    const pngPath = join(srcDir, 'pic.png')
    await sharp({ create: { width: 640, height: 400, channels: 3, background: '#3A6EA5' } }).png().toFile(pngPath)
    const tiffPath = join(srcDir, 'photo.tiff')
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#C06030' } }).tiff().toFile(tiffPath)
    // 竖屏图片：用来验「长宽比不被压成 1:1」。刻意做 1:2，跟横图差异足够明显
    const portraitPath = join(srcDir, 'portrait.png')
    await sharp({ create: { width: 600, height: 1200, channels: 3, background: '#2E7D5B' } }).png().toFile(portraitPath)

    // 视频：mp4 / mkv（白名单直出）+ avi(mpeg4+mp3)（必须转码）
    const mp4Path = join(srcDir, 'clip.mp4')
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'faststart', mp4Path])
    const mkvPath = join(srcDir, 'clip.mkv')
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mkvPath])
    const aviPath = join(srcDir, 'old.avi')
    await runFfmpeg(['-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'mpeg4', '-c:a', 'libmp3lame', '-shortest', aviPath])

    // 音频：wav（白名单直出）
    const wavPath = join(srcDir, 'tone.wav')
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', wavPath])

    // 文本：验 analyze 的 text 分支（内容读写见 S5）
    const txtPath = join(srcDir, 'note.txt')
    writeFileSync(txtPath, '预览冒烟样张。')

    // 真 GBK 字节的 txt：「你好，世界」的 GBK 编码。
    // 用真字节而不是「读回来再比字符串」—— 只有原始字节才能验出编码兜底到底走没走到。
    const gbkPath = join(srcDir, 'gbk.txt')
    writeFileSync(gbkPath, Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xa3, 0xac, 0xca, 0xc0, 0xbd, 0xe7]))

    // 「库内文件被外部删除」专用样张：删了就不还原，避免「删了再写回」多一次占用风险
    const vanishPath = join(srcDir, 'vanish.png')
    await sharp({ create: { width: 120, height: 90, channels: 3, background: '#205020' } }).png().toFile(vanishPath)

    const allPaths = [pngPath, tiffPath, portraitPath, mp4Path, mkvPath, aviPath, wavPath, txtPath, gbkPath, vanishPath]
    result.samples = allPaths.length

    // ==================== 导入 ====================
    const imp = await new Promise<{ added: number; skipped: number }>((resolve) => {
      importFiles({ paths: allPaths, folderId: folder.id, mode: 'copy', onDone: (r) => resolve(r) })
    })
    result.import = imp
    check('导入全部样张', imp.added === allPaths.length, `added=${imp.added}/${allPaths.length}`)

    const { db } = requireCurrent()
    // ⚠️ 现取 `requireCurrent().db` 而不是用上面那个 `db` 变量：渲染层那次 `library.open`
    // 会 closeCurrent + 重开连接，早先捕获的句柄会失效（用它查会报 "database is not open"）。
    const idOf = (name: string): number => {
      const row = requireCurrent().db.prepare('SELECT id FROM assets WHERE name=?').get(name) as
        | { id: number } | undefined
      if (!row) throw new Error(`样张未入库：${name}`)
      return row.id
    }
    const pngId = idOf('pic.png')
    const tiffId = idOf('photo.tiff')
    const mp4Id = idOf('clip.mp4')
    const mkvId = idOf('clip.mkv')
    const aviId = idOf('old.avi')
    const wavId = idOf('tone.wav')
    const txtId = idOf('note.txt')

    // ==================== S1 策略判定 ====================
    const expectations: Array<[string, number, Partial<PreviewInfo>]> = [
      ['png 原图直出', pngId, { kind: 'image', strategy: 'original', mime: 'image/png' }],
      ['tiff 需派生', tiffId, { kind: 'image', strategy: 'derived', derive: 'image', mime: 'image/webp', ready: false }],
      ['mp4 直出', mp4Id, { kind: 'video', strategy: 'original', mime: 'video/mp4' }],
      ['mkv 直出（反常识，实测能播）', mkvId, { kind: 'video', strategy: 'original', mime: 'video/x-matroska' }],
      ['avi 需转码', aviId, { kind: 'video', strategy: 'derived', derive: 'transcode', mime: 'video/mp4', ready: false }],
      ['wav 直出', wavId, { kind: 'audio', strategy: 'original', mime: 'audio/wav' }],
      ['txt 直出且可编辑', txtId, { kind: 'text', strategy: 'original', editable: true }]
    ]
    for (const [label, id, want] of expectations) {
      const info = await previewInfo(id)
      const bad = Object.entries(want).filter(([k, v]) => (info as unknown as Record<string, unknown>)[k] !== v)
      check(`S1 ${label}`, bad.length === 0, bad.length ? JSON.stringify(bad.map(([k, v]) => `${k}: ${String((info as unknown as Record<string, unknown>)[k])} ≠ ${String(v)}`)) : undefined)
    }
    // avi 的派生判定必须是转码（mpeg4 不在可 copy 列表里）——上面已覆盖；这里再验编码探测本身
    const aviProbe = await analyze(rowOf(aviId))
    check('S1 avi 探测出分辨率', aviProbe.width === 320 && aviProbe.height === 240, `wh=${aviProbe.width}x${aviProbe.height}`)

    // 库内文件被外部删掉 → 明确的不支持，而不是抛未捕获异常
    const vanishId = idOf('vanish.png')
    const vanishAbs = join(lib.path, '媒体', 'vanish.png')
    rmWithRetry(vanishAbs)
    const goneInfo = await previewInfo(vanishId)
    check('S1 文件缺失 → unsupported 且有中文原因',
      goneInfo.strategy === 'unsupported' && !!goneInfo.reason,
      `strategy=${goneInfo.strategy} reason=${goneInfo.reason ?? ''}`)

    // ==================== S2 Range 流式 ====================
    const pngAbs = join(lib.path, '媒体', 'pic.png')
    const pngSize = readFileSync(pngAbs).length

    // 无 Range → 200 全量
    {
      const res = await serveMedia(mkReq(pngId), String(pngId))
      const buf = Buffer.from(await res.arrayBuffer())
      check('S2 无 Range → 200 + 全量字节',
        res.status === 200 && buf.length === pngSize && res.headers.get('content-type') === 'image/png',
        `status=${res.status} len=${buf.length}/${pngSize} ct=${res.headers.get('content-type')}`)
      check('S2 声明 accept-ranges',
        res.headers.get('accept-ranges') === 'bytes', String(res.headers.get('accept-ranges')))
    }

    // `bytes=0-`（Chromium 首包就是这种开区间）→ 206
    {
      const res = await serveMedia(mkReq(pngId, { headers: { range: 'bytes=0-' } }), String(pngId))
      const buf = Buffer.from(await res.arrayBuffer())
      check('S2 bytes=0- → 206 全量',
        res.status === 206 && buf.length === pngSize &&
        res.headers.get('content-range') === `bytes 0-${pngSize - 1}/${pngSize}`,
        `status=${res.status} cr=${res.headers.get('content-range')}`)
    }

    // 中段区间：字节必须与磁盘逐字节一致（这是「真读对了」的证据）
    {
      const start = 100
      const end = 199
      const res = await serveMedia(mkReq(pngId, { headers: { range: `bytes=${start}-${end}` } }), String(pngId))
      const buf = Buffer.from(await res.arrayBuffer())
      const disk = sliceOfDisk(pngAbs, start, end)
      check('S2 中段区间字节与磁盘一致',
        res.status === 206 && buf.length === 100 && buf.equals(disk),
        `status=${res.status} len=${buf.length} equal=${buf.equals(disk)}`)
    }

    // 后缀区间 `bytes=-16`（mp4 把 moov 放文件尾时 Chromium 靠它探测）
    {
      const res = await serveMedia(mkReq(pngId, { headers: { range: 'bytes=-16' } }), String(pngId))
      const buf = Buffer.from(await res.arrayBuffer())
      const disk = sliceOfDisk(pngAbs, pngSize - 16, pngSize - 1)
      check('S2 后缀区间 bytes=-16',
        res.status === 206 && buf.length === 16 && buf.equals(disk) &&
        res.headers.get('content-range') === `bytes ${pngSize - 16}-${pngSize - 1}/${pngSize}`,
        `status=${res.status} cr=${res.headers.get('content-range')}`)
    }

    // 越界 → 416 + Content-Range: bytes */size
    {
      const res = await serveMedia(mkReq(pngId, { headers: { range: `bytes=${pngSize + 1000}-` } }), String(pngId))
      check('S2 越界 → 416',
        res.status === 416 && res.headers.get('content-range') === `bytes */${pngSize}`,
        `status=${res.status} cr=${res.headers.get('content-range')}`)
    }

    // HEAD：有头无体
    {
      const res = await serveMedia(mkReq(pngId, { method: 'HEAD' }), String(pngId))
      const buf = Buffer.from(await res.arrayBuffer())
      check('S2 HEAD 无 body 但带 content-length',
        res.status === 200 && buf.length === 0 && res.headers.get('content-length') === String(pngSize),
        `status=${res.status} len=${buf.length} cl=${res.headers.get('content-length')}`)
    }

    // 不存在的 id → 404；非法 id → 400
    {
      const notFound = await serveMedia(mkReq(999999), '999999')
      const bad = await serveMedia(mkReq(0), '0')
      check('S2 不存在的 id → 404 / 非法 id → 400',
        notFound.status === 404 && bad.status === 400,
        `notFound=${notFound.status} bad=${bad.status}`)
    }

    // ==================== S3 图片派生（tiff → webp）====================
    {
      const derive = await deriveFor(tiffId)
      check('S3 tiff 派生方式为 image', derive === 'image', String(derive))

      const tiffRow = rowOf(tiffId)
      const out = derivedAbs(tiffRow.content_hash ?? '', 'webp')
      check('S3 派生文件已落盘（与缩略图同住 .thumbs）', existsSync(out), out.replace(lib.path, '<lib>'))

      // 「能解码」而不是「文件存在」：让 sharp 真读一遍
      const meta = await sharp(out).metadata()
      check('S3 派生图可被解码且已缩放',
        meta.format === 'webp' && (meta.width ?? 0) === 1200 && (meta.height ?? 0) === 800,
        `format=${meta.format} ${meta.width}x${meta.height}`)

      const after = await previewInfo(tiffId)
      check('S3 派生后 ready=true 且 MIME 变 webp',
        after.ready === true && after.mime === 'image/webp' && after.bytes > 0,
        `ready=${after.ready} mime=${after.mime} bytes=${after.bytes}`)

      // 走协议把派生图取回来，再解一次 —— 证明协议出口给的确实是可解码的图
      const res = await serveMedia(mkReq(tiffId), String(tiffId))
      const buf = Buffer.from(await res.arrayBuffer())
      const viaProtocol = await sharp(buf).metadata()
      check('S3 经 stash://media 取回的字节可直接解码',
        res.status === 200 && res.headers.get('content-type') === 'image/webp' && viaProtocol.format === 'webp',
        `status=${res.status} ct=${res.headers.get('content-type')} format=${viaProtocol.format}`)
    }

    // ==================== S4 视频派生（avi → mp4 转码）====================
    {
      const derive = await deriveFor(aviId, () => { /* 进度回调在 P6 由渲染层消费 */ })
      check('S4 avi 派生方式为 transcode', derive === 'transcode', String(derive))

      const aviRow = rowOf(aviId)
      const out = derivedAbs(aviRow.content_hash ?? '', 'mp4')
      check('S4 派生 mp4 已落盘', existsSync(out), out.replace(lib.path, '<lib>'))

      // 原文件必须还在（派生是「另存一份」，不能动源文件）
      const aviAbs = join(lib.path, '媒体', 'old.avi')
      check('S4 源文件未被改动', existsSync(aviAbs) && readFileSync(aviAbs).length > 0)

      // 派生结果必须是 h264 且带视频流（能被 Chromium 解的前提）
      const info = await analyze(rowOf(aviId))
      check('S4 派生后 ready=true', info.ready === true, `ready=${info.ready}`)

      const derivedSize = readFileSync(out).length
      check('S4 派生文件非空', derivedSize > 0, `${derivedSize} bytes`)

      // 派生 mp4 也要支持 Range —— 这是「能拖进度条」的前提
      const res = await serveMedia(mkReq(aviId, { headers: { range: 'bytes=0-' } }), String(aviId))
      const buf = Buffer.from(await res.arrayBuffer())
      check('S4 派生 mp4 走协议回 206 且长度一致',
        res.status === 206 && buf.length === derivedSize &&
        res.headers.get('content-range') === `bytes 0-${derivedSize - 1}/${derivedSize}`,
        `status=${res.status} len=${buf.length}/${derivedSize}`)
    }

    // ==================== S5 文本读写（P4）====================
    const gbkId = idOf('gbk.txt')
    const noteId = idOf('note.txt')
    const noteAbs = join(lib.path, '媒体', 'note.txt')

    // 读：UTF-8
    {
      const r = readText(noteId)
      check('S5 UTF-8 文本读回正确', r.text.includes('预览冒烟样张') && r.encoding === 'utf-8',
        `encoding=${r.encoding} text=${JSON.stringify(r.text)}`)
    }

    // 读：GBK 兜底。用**真 GBK 字节**，否则验不出兜底到底走没走到
    {
      const r = readText(gbkId)
      check('S5 GBK 字节自动兜底解码', r.text === '你好，世界' && r.encoding === 'gb18030',
        `encoding=${r.encoding} text=${JSON.stringify(r.text)}`)
    }

    // 读：非文本被拒
    {
      let code = ''
      try { readText(pngId) } catch (e) { code = String((e as Error).message) }
      check('S5 非文本素材读文本被拒', code === 'ERR_NOT_TEXT', code)
    }

    // 写：落盘 + 索引同步 + 内容变了哈希跟着变 + 新哈希的缩略图补上
    {
      const before = readText(noteId)
      const hashBefore = (requireCurrent().db.prepare('SELECT content_hash FROM assets WHERE id=?')
        .get(noteId) as { content_hash: string }).content_hash
      const w = writeText(noteId, '改写后的内容\n', before.mtime)
      const disk = readFileSync(noteAbs).toString('utf8')
      const row = requireCurrent().db.prepare('SELECT size, content_hash FROM assets WHERE id=?')
        .get(noteId) as { size: number; content_hash: string }
      check('S5 写入落盘且索引同步',
        disk === '改写后的内容\n' && w.hash === row.content_hash && row.size === Buffer.byteLength('改写后的内容\n'),
        `disk=${JSON.stringify(disk)} hashSync=${w.hash === row.content_hash} size=${row.size}`)
      check('S5 内容变了 → 哈希跟着变', row.content_hash !== hashBefore,
        `${hashBefore} → ${row.content_hash}`)
      // 缩略图是**入队异步**生成的（与导入后的批量生成同一条队列），所以这里要等一等 ——
      // 不能写完就断言「文件在」，那是在测队列的调度时机，不是在测补生成有没有发生。
      const thumbPath = join(lib.path, '.thumbs', row.content_hash, 'grid.webp')
      let thumbReady = false
      for (let i = 0; i < 40 && !thumbReady; i++) {
        if (existsSync(thumbPath)) thumbReady = true
        else await new Promise((r) => setTimeout(r, 150))
      }
      check('S5 新哈希的占位缩略图已补齐', thumbReady, thumbPath.replace(lib.path, '<lib>'))
    }

    // 写：陈旧 mtime 必须被拒，而且**磁盘内容一个字都不能动**
    {
      const stale = readText(noteId)
      const future = new Date(Date.now() + 60000)
      utimesSync(noteAbs, future, future) // 模拟「文件在软件外被改过」
      let code = ''
      try { writeText(noteId, '不该写进去的内容', stale.mtime) } catch (e) { code = String((e as Error).message) }
      check('S5 陈旧 mtime → ERR_MTIME_CONFLICT 且不覆盖',
        code === 'ERR_MTIME_CONFLICT' && readFileSync(noteAbs).toString('utf8') === '改写后的内容\n',
        `code=${code} disk=${JSON.stringify(readFileSync(noteAbs).toString('utf8'))}`)
    }

    // 写：非文本 / 超限
    {
      let notText = ''
      try { writeText(pngId, 'x') } catch (e) { notText = String((e as Error).message) }
      let tooLarge = ''
      try { writeText(noteId, 'x'.repeat(TEXT_MAX_BYTES + 1)) } catch (e) { tooLarge = String((e as Error).message) }
      check('S5 非文本写入被拒 / 超限被拒',
        notText === 'ERR_NOT_TEXT' && tooLarge === 'ERR_TOO_LARGE', `${notText} | ${tooLarge}`)
    }

    // ==================== U2 渲染层：中栏浮层（P2）====================
    // 浮层交互只能在真实渲染层里验：双击挂载点、捕获阶段吃 Esc、panzoom 的 wheel。
    const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code) as Promise<T>

    /** 轮询直到表达式为真（渲染是异步的，不能睡固定时间就断言） */
    async function waitFor(expr: string, timeoutMs = 15000): Promise<boolean> {
      const t0 = Date.now()
      while (Date.now() - t0 < timeoutMs) {
        if (await js<boolean>('(() => { try { return !!(' + expr + ') } catch { return false } })()')) return true
        await new Promise((r) => setTimeout(r, 150))
      }
      return false
    }

    /** 截图留证：版式类改动光看数字看不全，留一张图方便人工复核（已 gitignore） */
    async function capture(name: string): Promise<void> {
      try {
        writeFileSync(join(process.cwd(), name), (await win.webContents.capturePage()).toPNG())
      } catch { /* 截图失败不影响结论 */ }
    }

    // 让渲染层打开这个临时库：先经 IPC 打开（主进程的 current 指过去），再 reload 走正常引导流程。
    // （App.vue 的 onMounted → lib.bootstrap() → library.getInfo()，只要 current 已指向该库即可）
    await js('window.stash.library.open(' + JSON.stringify(lib.path) + ')')
    // 确保右侧信息栏是**展开**的：它是一个显式布局状态、存在 localStorage 里，
    // 上一轮冒烟若把它收起了，这一轮就找不到 .detail（D 段要验的就是它）。
    await js("try { localStorage.removeItem('stash.detailCollapsed') } catch (e) {}")
    const loaded = new Promise<void>((resolve) => win.webContents.once('did-finish-load', () => resolve()))
    win.webContents.reload()
    await loaded

    // 收集交互期间的渲染层错误（页面内监听，避免依赖 Electron 各版本 console-message 的签名差异）
    await js('window.__pvErrors = [];' +
      "window.addEventListener('error', (e) => window.__pvErrors.push(String(e.message)));" +
      "window.addEventListener('unhandledrejection', (e) => window.__pvErrors.push(String(e.reason)));")

    const gridReady = await waitFor("document.querySelectorAll('.card').length >= 10")
    check('U2 渲染层加载出素材网格', gridReady,
      'cards=' + await js<number>("document.querySelectorAll('.card').length"))

    // 按**网格里的实际顺序**取前两张。列表按 imported_at desc 排，不能假设 png 就是第一张
    // （第一版就是这么翻车的：拿 png 当第一张，而它其实是最后一张，→ 键自然切不动）
    const order = await js<string[]>("[...document.querySelectorAll('.card')].map((c) => c.dataset.id)")
    // ⚠️ 现取 db 而不是用上面捕获的 `db`：渲染层那次 `library.open` 会 closeCurrent + 重开连接，
    // 旧句柄已经失效（用它查会报 "database is not open"）。
    const q = <T>(sql: string, ...args: Array<string | number>): T =>
      requireCurrent().db.prepare(sql).get(...args) as T
    const nameOf = (id: number): string => q<{ name: string }>('SELECT name FROM assets WHERE id=?', id).name
    const typeOf = (id: number): string => q<{ type: string }>('SELECT type FROM assets WHERE id=?', id).type

    // 挑一张**图片**卡来验浮层，且它后面还得有下一张（用来验 → 切换）：
    //  - 跳过 vanish.png —— S1 里已经删了它在磁盘上的文件，本来就加载不出图
    //  - 跳过文本 / 音频 / 视频 —— P2 还没接入它们的预览组件，
    //    拿它们去验「图片能加载」只会得到一条假失败（第一版就是这么红的）
    const orderIds = order.map(Number)
    let pick = -1
    for (let i = 0; i < orderIds.length - 1; i++) {
      if (orderIds[i] !== vanishId && typeOf(orderIds[i]) === 'image') { pick = i; break }
    }
    if (pick < 0) throw new Error('U2 找不到可用于验证的图片卡片')
    const firstId = orderIds[pick]
    const firstName = nameOf(firstId)
    const secondName = nameOf(orderIds[pick + 1])

    const fire = (id: number, type: string): Promise<unknown> =>
      js('document.querySelector(\'.card[data-id="' + id + '"]\').dispatchEvent(new MouseEvent(\'' + type + '\', { bubbles: true }))')

    // 单击不应打开浮层（单击仍是「选中 + 右侧详情」）
    await fire(firstId, 'click')
    await new Promise((r) => setTimeout(r, 250))
    const overlayAfterClick = await js<boolean>("!!document.querySelector('[data-pv-wrap]')")
    check('U2 单击不打开浮层', overlayAfterClick === false, 'overlay=' + overlayAfterClick)

    // 双击打开
    await fire(firstId, 'dblclick')
    const opened = await waitFor("document.querySelector('[data-pv-wrap]')")
    check('U2 双击打开浮层', opened)

    if (opened) {
      const name = await js<string>("document.querySelector('[data-pv-name]').textContent")
      check('U2 浮层显示当前素材名', name === firstName, 'name=' + name + ' expect=' + firstName)

      // 浮层只覆盖中栏，不能压住右侧信息栏
      const clearOfDetail = await js<boolean>(
        "(() => { const w = document.querySelector('[data-pv-wrap]').getBoundingClientRect();" +
        " const d = document.querySelector('.detail'); if (!d) return true;" +
        ' return w.right <= d.getBoundingClientRect().left + 1 })()')
      check('U2 浮层不覆盖右侧信息栏', clearOfDetail)

      // 背景必须是**不透明的纯色**（用户明确要求：不要半透明，别让下面的网格透出来）。
      // 计算样式里 alpha=1 会算成 `rgb(...)`，带透明度才是 `rgba(...)`。
      const bg = await js<string>("getComputedStyle(document.querySelector('[data-pv-wrap]')).backgroundColor")
      const opaque = /^rgb\(/.test(bg) || /,\s*1\)$/.test(bg)
      check('U2 浮层背景为不透明纯色', opaque, 'backgroundColor=' + bg)

      // 图片确实经 stash://media 加载成功
      const imgOk = await waitFor(
        "(() => { const i = document.querySelector('.pv-img'); return i && i.complete && i.naturalWidth > 0 })()")
      check('U2 图片经 stash://media 加载成功', imgOk)

      // 滚轮缩放：panzoom 把 transform 写在 .pv-stage 上。
      // 先等它初始化出 transform 再**比数值** —— 拿 `none → scale(1)` 当「缩放成功」是假证据，
      // 那只是 panzoom 初始化时写下的单位变换，跟滚轮没关系。
      const scaleExpr = "(() => { const t = document.querySelector('[data-pv-stage]').style.transform || '';" +
        ' const m = /scale\\(([\\d.]+)\\)/.exec(t); return m ? parseFloat(m[1]) : 0 })()'
      if (imgOk) {
        // ⚠️ 必须等「大图加载完成」再测缩放：`onBigLoad` 会再调一次 `setupPz()`，
        // 而 `setupPz()` 是先 destroy 再重建 panzoom —— 那一下会把 transform 重置成 scale(1)。
        // 不等的话，滚轮刚放大就被重建冲掉，断言随机红（实测约一半概率）。
        await waitFor(
          "(() => { const i = document.querySelector('.pv-img'); return i && i.style.opacity === '1' })()", 8000)
        await new Promise((r) => setTimeout(r, 500)) // 让 rAF 里的那次 setupPz 落定
        await waitFor(scaleExpr + ' > 0', 5000)
        const scaleBefore = await js<number>(scaleExpr)
        await js("(() => { const s = document.querySelector('[data-pv-stage]');" +
          ' const r = s.getBoundingClientRect();' +
          " s.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true," +
          ' clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })) })()')
        // 轮询而不是睡固定时间：放大本身是异步的
        let scaleAfter = scaleBefore
        for (let i = 0; i < 20 && !(scaleAfter > scaleBefore); i++) {
          await new Promise((r) => setTimeout(r, 150))
          scaleAfter = await js<number>(scaleExpr)
        }
        check('U2 滚轮放大（scale 数值变大）', scaleAfter > scaleBefore,
          'before=' + scaleBefore + ' after=' + scaleAfter)
      } else {
        check('U2 滚轮放大（scale 数值变大）', false, '图片没加载出来，缩放无从验证')
      }

      // → 键切换下一张（浮层吃的是捕获阶段的 keydown，dispatch 到 window 即可命中）
      await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))")
      const navigated = await waitFor(
        "document.querySelector('[data-pv-name]').textContent === " + JSON.stringify(secondName))
      check('U2 → 键切换到下一张', navigated,
        'after=' + await js<string>("document.querySelector('[data-pv-name]')?.textContent") + ' expect=' + secondName)

      // Esc 关闭。捕获阶段吃键就是为了不让它继续落到网格上把多选也清了
      await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
      const closed = await waitFor("!document.querySelector('[data-pv-wrap]')", 3000)
      check('U2 Esc 关闭浮层', closed)
    }

    // ---- U2 文本：编辑器 / Ctrl+S 落盘 / 外部改动冲突 ----
    {
      await js('document.querySelector(\'.card[data-id="' + noteId + '"]\').dispatchEvent(new MouseEvent(\'dblclick\', { bubbles: true }))')
      const editorOk = await waitFor("document.querySelector('[data-ptext-editor]')")
      check('U2 文本浮层出现编辑器', editorOk)

      if (editorOk) {
        const enc = await js<string>("document.querySelector('[data-ptext-encoding]').textContent")
        check('U2 工具栏显示编码', enc === 'utf-8', 'enc=' + enc)

        const typeDraft = (text: string): Promise<unknown> =>
          js("(() => { const t = document.querySelector('[data-ptext-editor]');" +
            ' t.value = ' + JSON.stringify(text) + ';' +
            " t.dispatchEvent(new Event('input', { bubbles: true })) })()")
        const pressCtrlS = (): Promise<unknown> =>
          js("document.querySelector('[data-ptext-editor]').dispatchEvent(" +
            "new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))")

        // 改动 → 标记未保存
        await typeDraft('冒烟改写的内容')
        const pending = await js<string>("document.querySelector('[data-ptext-toolbar]').dataset.pending")
        check('U2 改动后标记未保存', pending === '1', 'pending=' + pending)

        // Ctrl+S → 落盘
        await pressCtrlS()
        const saved = await waitFor("document.querySelector('[data-ptext-toolbar]').dataset.pending === '0'", 8000)
        const diskAfterSave = readFileSync(noteAbs).toString('utf8')
        check('U2 Ctrl+S 落盘', saved && diskAfterSave === '冒烟改写的内容',
          `saved=${saved} disk=${JSON.stringify(diskAfterSave)}`)

        // 制造「软件外改动」：直接改盘上内容并把 mtime 推后
        writeFileSync(noteAbs, '外部程序写的内容\n')
        const future2 = new Date(Date.now() + 120000)
        utimesSync(noteAbs, future2, future2)

        await typeDraft('我的新内容')
        await pressCtrlS()
        const conflictShown = await waitFor("document.querySelector('[data-ptext-conflict]')", 8000)
        check('U2 外部改动 → 冲突条出现且未覆盖',
          conflictShown && readFileSync(noteAbs).toString('utf8') === '外部程序写的内容\n',
          `shown=${conflictShown} disk=${JSON.stringify(readFileSync(noteAbs).toString('utf8'))}`)

        // 点「覆盖保存」→ 以我的内容为准
        await js("document.querySelector('[data-ptext-force]').click()")
        const forced = await waitFor(
          "document.querySelector('[data-ptext-toolbar]').dataset.conflict === '0' &&" +
          " document.querySelector('[data-ptext-toolbar]').dataset.pending === '0'", 8000)
        check('U2 覆盖保存写入成功',
          forced && readFileSync(noteAbs).toString('utf8') === '我的新内容',
          `forced=${forced} disk=${JSON.stringify(readFileSync(noteAbs).toString('utf8'))}`)

        await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
        await waitFor("!document.querySelector('[data-pv-wrap]')", 3000)
      }
    }

    // ---- U2 图片尺寸：等比缩放到完整可见（不裁剪、不压成 1:1）----
    // 这一条是被真实反馈逼出来的：`.pv-stage` 原来用 grid，行被内容撑高，
    // 下面 `max-height: 100%` 等于没约束 → 图片按原始像素画出来、再被裁成一块方形。
    // 横图竖图都会中招，所以**两种朝向都量**。
    interface ImgMeasure {
      nw: number; nh: number; rw: number; rh: number; sw: number; sh: number; ok: boolean
    }
    async function measurePreview(assetId: number): Promise<ImgMeasure> {
      return await js<ImgMeasure>(
        '(async () => {' +
        ' const card = document.querySelector(\'.card[data-id="' + assetId + '"]\');' +
        ' if (!card) return { nw: 0, nh: 0, rw: 0, rh: 0, sw: 0, sh: 0, ok: false };' +
        ' card.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));' +
        ' const t0 = Date.now(); let img = null;' +
        ' while (Date.now() - t0 < 15000) {' +
        '   img = document.querySelector(".pv-img");' +
        '   if (img && img.complete && img.naturalWidth > 0 && img.style.opacity === "1") break;' +
        '   await new Promise((r) => setTimeout(r, 120));' +
        ' }' +
        ' if (!img || !img.naturalWidth) return { nw: 0, nh: 0, rw: 0, rh: 0, sw: 0, sh: 0, ok: false };' +
        ' const r = img.getBoundingClientRect();' +
        ' const s = document.querySelector("[data-pv-stage]").getBoundingClientRect();' +
        ' window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));' +
        ' return { nw: img.naturalWidth, nh: img.naturalHeight, rw: Math.round(r.width),' +
        '          rh: Math.round(r.height), sw: Math.round(s.width), sh: Math.round(s.height), ok: true };' +
        '})()')
    }

    /** 渲染结果必须：① 宽高比与原图一致（容差 5%）② 完整落在舞台内（不裁剪） */
    function judgeFit(label: string, m: ImgMeasure): void {
      const natRatio = m.nh ? m.nw / m.nh : 0
      const shownRatio = m.rh ? m.rw / m.rh : 0
      const ratioOk = natRatio > 0 && Math.abs(shownRatio - natRatio) / natRatio < 0.05
      const fits = m.rw <= m.sw + 1 && m.rh <= m.sh + 1
      check(label, m.ok && ratioOk && fits,
        JSON.stringify({
          ...m,
          natRatio: +natRatio.toFixed(3),
          shownRatio: +shownRatio.toFixed(3),
          ratioOk,
          fits
        }))
    }

    judgeFit('U2 竖屏图片等比缩放完整可见（不裁剪、不压成 1:1）', await measurePreview(idOf('portrait.png')))
    judgeFit('U2 横屏图片等比缩放完整可见（不裁剪）', await measurePreview(pngId))

    const jsErrors = await js<string[]>('window.__pvErrors || []')
    check('U2 交互期间渲染层无运行期错误', jsErrors.length === 0,
      jsErrors.length ? jsErrors.join(' | ').slice(0, 300) : undefined)

    // ==================== U 渲染层：真实播放与 seek（P3）====================
    // 在**真实 <video>/<audio>** 里验：能不能播、能不能拖进度条（拖得动 = Range/206 真的生效了）。
    // ⚠️ 这里刻意不看 canPlayType —— 探针实测它完全不可信，只认「真播出来」这件事。
    interface PlayResult {
      ok: boolean
      reason?: string
      duration?: number
      seeked?: boolean
      videoW?: number
      via?: string
    }

    /** 双击某张素材 → 等媒体元素就绪 → seek 一次 → 关闭浮层，返回全过程的关键事实 */
    async function playCheck(assetId: number, kind: 'video' | 'audio'): Promise<PlayResult> {
      const code = '(async () => {' +
        ' const card = document.querySelector(\'.card[data-id="' + assetId + '"]\');' +
        ' if (!card) return { ok: false, reason: "card not found" };' +
        ' card.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));' +
        ' const sel = "[data-pv-' + kind + ']";' +
        ' const t0 = Date.now(); let el = null;' +
        ' while (Date.now() - t0 < 25000) {' +
        '   el = document.querySelector(sel);' +
        '   if (el) break;' +
        '   await new Promise((r) => setTimeout(r, 100));' +
        ' }' +
        ' if (!el) {' +
        '   const w = document.querySelector("[data-pv-wait]");' +
        '   return { ok: false, reason: "no media element; wait=" + (w ? w.dataset.pvWait : "none") };' +
        ' }' +
        ' const t1 = Date.now();' +
        ' while (Date.now() - t1 < 25000) {' +
        '   if (el.error) return { ok: false, reason: "media error " + el.error.code };' +
        '   if (el.readyState >= 1 && el.duration > 0) break;' +
        '   await new Promise((r) => setTimeout(r, 100));' +
        ' }' +
        ' const duration = el.duration;' +
        ' if (!(duration > 0)) return { ok: false, reason: "no metadata, readyState=" + el.readyState };' +
        ' const target = Math.min(1.0, duration / 2);' +
        ' const seeked = await new Promise((resolve) => {' +
        '   el.addEventListener("seeked", () => resolve(true), { once: true });' +
        '   el.currentTime = target;' +
        '   setTimeout(() => resolve(false), 10000);' +
        ' });' +
        ' const out = { ok: true, duration: duration, seeked: seeked,' +
        '   videoW: el.videoWidth || 0, via: (el.getAttribute("src") || "").slice(0, 32) };' +
        ' window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));' +
        ' return out;' +
        '})()'
      return await js<PlayResult>(code)
    }

    const mp4Play = await playCheck(mp4Id, 'video')
    check('U 视频 mp4 直出可播且可 seek', mp4Play.ok && mp4Play.seeked === true,
      JSON.stringify(mp4Play))

    const mkvPlay = await playCheck(mkvId, 'video')
    check('U 视频 mkv 直出可播且可 seek（反常识，实测能播）', mkvPlay.ok && mkvPlay.seeked === true,
      JSON.stringify(mkvPlay))

    // avi 的**原文件 Chromium 播不了**（实测 SRC_NOT_SUPPORTED），所以它能播出来这件事本身
    // 就证明了渲染层走的是派生文件，而不是原文件。
    const aviPlay = await playCheck(aviId, 'video')
    check('U 视频 avi 转码后可播且可 seek（能播即证明走的是派生文件）',
      aviPlay.ok && aviPlay.seeked === true && (aviPlay.videoW ?? 0) > 0, JSON.stringify(aviPlay))

    const wavPlay = await playCheck(wavId, 'audio')
    check('U 音频 wav 可播且可 seek', wavPlay.ok && wavPlay.seeked === true, JSON.stringify(wavPlay))

    // ---- U 音频播放器版式：控制条要撑满、控件要垂直居中对齐 ----
    // 用户反馈「播放栏和大小错位」：media-chrome 的 control-bar 默认只有内容宽、
    // 还自带深色底，于是右侧露出一截容器底色。这两条断言把版式钉住。
    {
      interface BarLayout {
        ok: boolean
        playerW: number
        barW: number
        spread: number
        centers: number[]
      }
      const m = await js<BarLayout>(
        '(async () => {' +
        ' const empty = { ok: false, playerW: 0, barW: 0, spread: 0, centers: [] };' +
        ' const card = document.querySelector(\'.card[data-id="' + wavId + '"]\');' +
        ' if (!card) return empty;' +
        ' card.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));' +
        ' const t0 = Date.now(); let p = null;' +
        ' while (Date.now() - t0 < 15000) {' +
        '   p = document.querySelector(".pv-player-audio");' +
        '   if (p) break;' +
        '   await new Promise((r) => setTimeout(r, 120));' +
        ' }' +
        ' if (!p) return empty;' +
        ' await new Promise((r) => setTimeout(r, 400));' +
        ' const bar = p.querySelector("media-control-bar");' +
        ' if (!bar) return empty;' +
        ' const pr = p.getBoundingClientRect();' +
        ' const br = bar.getBoundingClientRect();' +
        ' const centers = [...bar.querySelectorAll("media-play-button, media-time-range, media-time-display, media-mute-button")]' +
        '   .map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0)' +
        '   .map((r) => r.top + r.height / 2);' +
        ' const spread = centers.length ? Math.max(...centers) - Math.min(...centers) : 0;' +
        // 注意：这里**不要**关浮层，下面还要截图留证
        ' return { ok: true, playerW: Math.round(pr.width), barW: Math.round(br.width),' +
        '          spread: Math.round(spread), centers: centers.map((c) => Math.round(c)) };' +
        '})()')
      check('U 音频控制条撑满容器（不错位）',
        m.ok && m.barW >= m.playerW * 0.9 && m.barW <= m.playerW, JSON.stringify(m))
      check('U 音频控件垂直居中对齐', m.ok && m.spread <= 2,
        'spread=' + m.spread + 'px centers=' + JSON.stringify(m.centers))

      // 版式这种事光靠数字看不全，留一张图（沿用项目里 shot-*.png 的惯例，已 gitignore）
      await capture('shot-preview-audio.png')
      await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
      await waitFor("!document.querySelector('[data-pv-wrap]')", 3000)
    }

    const errsAfterPlay = await js<string[]>('window.__pvErrors || []')
    check('U 播放期间渲染层无运行期错误', errsAfterPlay.length === 0,
      errsAfterPlay.length ? errsAfterPlay.join(' | ').slice(0, 300) : undefined)

    // ==================== D 右侧信息栏：真预览（P5）====================
    // 详情栏里换素材走的是**单击**（选中即联动详情），不是双击。
    interface DetailProbe { present: boolean; absent: boolean }
    async function detailProbe(assetId: number, presentSel: string, absentSel: string): Promise<DetailProbe> {
      return await js<DetailProbe>(
        '(async () => {' +
        ' const card = document.querySelector(\'.card[data-id="' + assetId + '"]\');' +
        ' if (!card) return { present: false, absent: false };' +
        ' card.dispatchEvent(new MouseEvent("click", { bubbles: true }));' +
        ' const t0 = Date.now();' +
        ' while (Date.now() - t0 < 15000) {' +
        '   if (document.querySelector(".detail-preview ' + presentSel + '")) break;' +
        '   await new Promise((r) => setTimeout(r, 120));' +
        ' }' +
        ' return {' +
        '   present: !!document.querySelector(".detail-preview ' + presentSel + '"),' +
        '   absent: !document.querySelector(".detail-preview ' + absentSel + '") };' +
        '})()')
    }

    const dImg = await detailProbe(pngId, '.detail-img', '[data-pv-video]')
    check('D 图片仍走 800px 缩略图（不换成原图预览）', dImg.present && dImg.absent, JSON.stringify(dImg))

    const dVideo = await detailProbe(mp4Id, '[data-pv-video]', '.detail-img')
    check('D 视频在信息栏里是真播放器', dVideo.present && dVideo.absent, JSON.stringify(dVideo))

    const dAudio = await detailProbe(wavId, '[data-pv-audio]', '.detail-img')
    check('D 音频在信息栏里是真播放器', dAudio.present && dAudio.absent, JSON.stringify(dAudio))

    const dText = await detailProbe(noteId, '[data-ptext-viewonly]', '[data-ptext-editor]')
    check('D 文本在信息栏里是只读（唯一编辑入口是中栏浮层）',
      dText.present && dText.absent, JSON.stringify(dText))

    result.checks = checks
    result.failed = checks.filter((c) => !c.pass)
    result.ok = checks.every((c) => c.pass)
    console.log('[SMOKE-PREVIEW] ' + JSON.stringify(result, null, 2))
  } catch (e) {
    result.ok = false
    result.error = String((e as Error).message ?? e)
    result.checks = checks
    console.log('[SMOKE-PREVIEW] ' + JSON.stringify(result, null, 2))
  } finally {
    closeCurrent()
    // Windows 上 ffmpeg/sharp 的句柄偶尔还没释放完，rmSync 会抛 EPERM。
    // 这里必须吞掉：清理失败不能挡住 app.exit，否则进程会一直挂着不退。
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        console.log('[SMOKE-PREVIEW] 临时目录未能删除（句柄未释放），不影响结论：' + dir)
      }
    }
    app.exit(0)
  }
}
