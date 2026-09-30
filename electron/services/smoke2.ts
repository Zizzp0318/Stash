// M2 冒烟测试：electron . --smoke-m2
// 验收：真实图片/视频/音频导入 → 两级缩略图生成 → 缓存文件齐全 →
//       图片宽高/主色板回写、视频时长回写 → 二次调用全命中缓存
import { app } from 'electron'
import { spawn } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { FFMPEG } from './ffmpeg'
import { createLibrary, mkdirRel, closeCurrent, requireCurrent } from './library'
import { importFiles } from './importer'
import { ensureBatch } from './thumbs'

const IMG_N = 30
const AUDIO_N = 8

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { windowsHide: true })
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))))
    p.on('error', reject)
  })
}

function awaitBatch(ids: Array<never>, size: 'grid' | 'detail'): Promise<void> {
  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ensureBatch(ids as any, size, () => resolve())
  })
}

export async function runSmokeM2(): Promise<void> {
  const result: Record<string, unknown> = {}
  let dir: string | null = null
  try {
    dir = mkdtempSync(join(tmpdir(), 'stash-smoke2-'))
    const lib = createLibrary({ name: 'smoke2-lib', parentDir: dir })
    result.library = lib
    const folder = mkdirRel('媒体')

    // 1. 生成测试素材：30 张彩色 PNG + 2 个 mp4 + 1 个 wav
    const srcDir = join(dir, 'src')
    mkdirSync(srcDir)
    const paths: string[] = []
    for (let i = 0; i < IMG_N; i++) {
      const hue = (i * 137) % 360
      const w = 400 + i * 30, h = 300 + (i % 5) * 40
      const png = join(srcDir, `img_${String(i).padStart(2, '0')}.png`)
      await sharp({ create: { width: w, height: h, channels: 3, background: `hsl(${hue}, 70%, 50%)` } })
        .png().toFile(png)
      paths.push(png)
    }
    const v1 = join(srcDir, 'clip_a.mp4')
    const v2 = join(srcDir, 'clip_b.mov')
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=640x360:rate=12', '-pix_fmt', 'yuv420p', v1])
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'smptebars=duration=2:size=480x320:rate=10', '-pix_fmt', 'yuv420p', '-movflags', 'faststart', v2])
    // ⚠️ 音频**必须一次导入多个**：音频缩略图是「按类型共享一张占位图」，
    // 队列并发 4 —— 只导 1 个音频时永远只有一个 job 去生成占位图，并发竞态根本不会暴露
    // （曾经的 bug：4 个 job 同时往同一个 placeholder-audio.webp 写，失败的 job 直接没缩略图
    //  → 卡片永久灰块。用户反馈过「有时候导入素材进去预览图是灰色的」）。
    // 8 个 > 并发数 4，且命名与用户那批（vocal_*.flac）一致。
    const audios: string[] = []
    for (let i = 0; i < AUDIO_N; i++) {
      const a = join(srcDir, `vocal_${i + 1}.flac`)
      await runFfmpeg(['-y', '-f', 'lavfi', '-i', `sine=frequency=${300 + i * 40}:duration=1`, a])
      audios.push(a)
    }
    writeFileSync(join(srcDir, 'note.md'), '# 测试笔记\n\nM2 冒烟。')
    paths.push(v1, v2, ...audios, join(srcDir, 'note.md'))
    result.generated = paths.length

    // 2. 导入
    const imp = await new Promise<{
      added: number
      skipped: number
      failed: Array<{ path: string; error: string }>
    }>((resolve) => {
      importFiles({ paths, folderId: folder.id, mode: 'copy', onDone: (r) => resolve(r) })
    })
    result.import = imp

    // 3. 全量缩略图（grid + detail）计时
    const { db } = requireCurrent()
    const assets = db.prepare('SELECT id, type, ext, content_hash, rel_path FROM assets').all() as Array<{ id: number; type: string; ext: string; content_hash: string; rel_path: string }>
    // 独立口径：用**另一条只读连接**数库里的行 —— 既不复用 `added` 自证，也不走当前写连接。
    // 为什么必须换连接：收尾 COMMIT 失败时事务还开着，**同一条连接**的 SELECT 仍能看到那些
    // 「尚未落盘」的行，照不出「索引没写进去」；换一条连接只能看到**已提交**的行，才有鉴别力。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync: ProbeDb } = require('node:sqlite')
    const probe = new ProbeDb(join(lib.path, '.stash'), { readOnly: true })
    let dbRows = 0
    try {
      dbRows = (probe.prepare('SELECT count(*) AS c FROM assets').get() as { c: number }).c
    } finally {
      probe.close()
    }
    result.dbRows = dbRows
    const t0 = Date.now()
    await awaitBatch(assets as never, 'grid')
    await awaitBatch(assets as never, 'detail')
    result.thumbMs = Date.now() - t0

    // 4. 验证缓存文件齐全
    const libPath = requireCurrent().path
    let missing = 0
    for (const a of assets) {
      for (const size of ['grid', 'detail']) {
        if (!existsSync(join(libPath, '.thumbs', a.content_hash, `${size}.webp`))) missing++
      }
    }
    result.missingThumbs = missing

    // 音频单独统计并单独断言：它是「按类型共享一张占位图」那条路径，并发竞态只会在这里冒出来。
    // 只报总数的话，30 张图里少 2 个只会看到 missing=2，看不出是哪一类坏的、也定位不到根因。
    const audioRows = assets.filter((a) => a.type === 'audio')
    let missingAudio = 0
    for (const a of audioRows) {
      for (const size of ['grid', 'detail']) {
        if (!existsSync(join(libPath, '.thumbs', a.content_hash, `${size}.webp`))) missingAudio++
      }
    }
    result.audio = { imported: audioRows.length, missingThumbs: missingAudio }

    // 5. 验证元数据回写
    const stats = db.prepare(
      `SELECT
         (SELECT count(*) FROM assets WHERE type='image' AND width IS NOT NULL) imgWH,
         (SELECT count(*) FROM assets WHERE type='image' AND palette IS NOT NULL) imgPal,
         (SELECT count(*) FROM assets WHERE type='video' AND duration_ms > 0) vidDur,
         (SELECT count(*) FROM assets WHERE type='video' AND width > 0) vidWH,
         (SELECT count(*) FROM assets WHERE type='audio' AND duration_ms IS NULL) audDurNull`
    ).get() as Record<string, number>
    result.meta = stats
    const sample = db.prepare("SELECT palette FROM assets WHERE type='image' AND palette IS NOT NULL LIMIT 1").get() as { palette: string } | undefined
    result.samplePalette = sample?.palette

    // 6. 二次调用 → 全部命中缓存（立即返回）
    const t1 = Date.now()
    await awaitBatch(assets as never, 'grid')
    await awaitBatch(assets as never, 'detail')
    result.cacheHitMs = Date.now() - t1

    // 7. F3 导入失败文案：用 **真实的** `src/utils/format.ts`（esbuild 打成 CJS 后 require）
    //    为什么打真实模块、而不是在测试里重写一份函数：重写一份就与被测代码脱钩 —— 被测代码坏了
    //    它照样绿（铁律 G11：断言不能脱离/复用被测代码）。esbuild 随 devDependencies 提供、可 require。
    {
      let f3dir: string | null = null
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const esbuild = require('esbuild') as { buildSync: (o: any) => unknown }
        let entry = join(app.getAppPath(), 'src', 'utils', 'format.ts')
        if (!existsSync(entry)) entry = join(process.cwd(), 'src', 'utils', 'format.ts')
        f3dir = mkdtempSync(join(tmpdir(), 'stash-smoke2-fmt-'))
        const out = join(f3dir, 'format.cjs')
        esbuild.buildSync({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: out })
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fmt = require(out) as {
          importFailedText: (
            f: Array<{ path: string; error: string; batch?: boolean; count?: number }>
          ) => string | null
        }

        // 单条批次失败（batch:true, count:41）→ 必须带 41、且**绝不能**出现「首个：」
        const batchOnly = fmt.importFailedText([
          { path: '（本批文件·索引未写入）', error: 'database is locked', batch: true, count: 41 }
        ])
        // 只有逐文件失败 → 保持「N 个文件导入失败（首个：name：err）」语义
        const fileOnly = fmt.importFailedText([{ path: 'C:\\pics\\坏图.png', error: '文件被占用' }])
        // 空 → null
        const empty = fmt.importFailedText([])
        // 两类同时存在 → 各说各的，都要说清
        const mixed = fmt.importFailedText([
          { path: '（本批文件·索引未写入）', error: 'disk I/O error', batch: true, count: 40 },
          { path: 'C:\\pics\\a.png', error: 'not a file' }
        ])

        result.f3 = { entry, batchOnly, fileOnly, empty, mixed }
        result.f3ok =
          typeof batchOnly === 'string' &&
          batchOnly.includes('41') &&
          !batchOnly.includes('首个：') &&
          typeof fileOnly === 'string' &&
          /1 个文件导入失败（首个：坏图\.png：文件被占用）/.test(fileOnly) &&
          empty === null &&
          typeof mixed === 'string' &&
          mixed.includes('40') &&
          mixed.includes('首个：')
      } catch (e) {
        result.f3ok = false
        result.f3Error = String((e as Error)?.message ?? e)
      } finally {
        if (f3dir) {
          try {
            rmSync(f3dir, { recursive: true, force: true })
          } catch {
            /* 临时目录删不掉就留给系统清理 */
          }
        }
      }
    }

    result.ok =
      imp.added === paths.length &&
      // 独立 DB 口径不变量：added 必须恰好等于**另一条连接**看到的库里实际新增行数
      // （正常导入时二者都应 = paths.length）。收尾 COMMIT 失败只让 added 涨、已提交行不涨
      // → 这条立刻变红（由 commitBatch 扣回 added 后恢复一致）。
      imp.added === dbRows &&
      imp.failed.length === 0 &&
      missing === 0 &&
      audioRows.length === AUDIO_N &&
      missingAudio === 0 &&
      stats.imgWH === IMG_N &&
      stats.imgPal === IMG_N &&
      stats.vidDur === 2 &&
      stats.vidWH === 2 &&
      stats.audDurNull === 0 &&
      result.f3ok === true &&
      result.cacheHitMs < 500

    console.log('[SMOKE-M2] ' + JSON.stringify(result, null, 2))
  } catch (e) {
    result.ok = false
    result.error = String(e)
    console.log('[SMOKE-M2] ' + JSON.stringify(result, null, 2))
  } finally {
    closeCurrent()
    if (dir) rmSync(dir, { recursive: true, force: true })
    app.exit(0)
  }
}
