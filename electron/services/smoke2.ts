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
    const imp = await new Promise<{ added: number; skipped: number }>((resolve) => {
      importFiles({ paths, folderId: folder.id, mode: 'copy', onDone: (r) => resolve(r) })
    })
    result.import = imp

    // 3. 全量缩略图（grid + detail）计时
    const { db } = requireCurrent()
    const assets = db.prepare('SELECT id, type, ext, content_hash, rel_path FROM assets').all() as Array<{ id: number; type: string; ext: string; content_hash: string; rel_path: string }>
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

    result.ok =
      imp.added === paths.length &&
      missing === 0 &&
      audioRows.length === AUDIO_N &&
      missingAudio === 0 &&
      stats.imgWH === IMG_N &&
      stats.imgPal === IMG_N &&
      stats.vidDur === 2 &&
      stats.vidWH === 2 &&
      stats.audDurNull === 0 &&
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
