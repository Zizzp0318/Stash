// M2 冒烟测试：electron . --smoke-m2
// 验收：真实图片/视频/音频导入 → 两级缩略图生成 → 缓存文件齐全 →
//       图片宽高/主色板回写、视频时长回写 → 二次调用全命中缓存
import { app } from 'electron'
import { spawn } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { FFMPEG } from './ffmpeg'
import { createLibrary, mkdirRel, closeCurrent, requireCurrent } from './library'
import { importFiles } from './importer'
import { ensureBatch, retestLegacyDims } from './thumbs'
import { copyAssets } from './assets'
import { DERIVED_FIELDS, derivedCopyCols } from './derived'

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

    // 8. 审计 §2.17：派生字段注册表的**跨源不变量**。
    //    为什么必须有：B2 是「复发型」—— 加一个「生成时顺手回写」的索引字段要同步好几处，
    //    历史上就漏过第 ⑤ 点（入队欠账条件）。下面三条都**不复用被测代码的判据**，
    //    而是与「真实表结构 / 真实行为 / 真实复制结果」对照，漂移会变红而不是静默漏字段（铁律 G11）。
    let d17MissingCols: string[] = []
    let d17SinkOk = false
    let d17VideoSinkOk = false
    let d17CopyDiff: string[] = []
    {
      // ① 注册表里的每一列都必须真实存在于 assets 表（跨源：注册表 vs `PRAGMA`）
      const tableCols = (db.prepare('PRAGMA table_info(assets)').all() as Array<{ name: string }>).map(
        (r) => r.name
      )
      d17MissingCols = DERIVED_FIELDS.filter((f) => !tableCols.includes(f.col)).map((f) => f.col)
      const cols = derivedCopyCols()

      // ⚠️ 注册表与真实表结构一旦不一致，下面那些动态 SQL（`zzz IS NULL` / `SELECT zzz`）会直接抛错、
      //    把诊断信息冲掉 → 整段包一层 try/catch，异常文本记进 copyDiff（照样红，但红得看得懂）。
      try {
        // ② 同步点⑤（入队欠账条件）的**行为**验证：抹掉一张图的 palette，模拟
        //    「缩略图已缓存、但字段还是 NULL」→ 再跑一次网格批，欠账条件必须把它捞回来补写。
        //    这正是 B2 的历史根因；把 palette 从注册表的 `sink` 里去掉，这条立刻变红。
        const victim = db
          .prepare("SELECT id FROM assets WHERE type='image' AND palette IS NOT NULL ORDER BY id LIMIT 1")
          .get() as { id: number } | undefined
        if (victim) {
          db.prepare('UPDATE assets SET palette=NULL WHERE id=?').run(victim.id)
          await awaitBatch(assets as never, 'grid')
          const back = db.prepare('SELECT palette FROM assets WHERE id=?').get(victim.id) as
            | { palette: string | null }
            | undefined
          d17SinkOk = back?.palette != null
        }
        result.d17SinkVictim = victim?.id ?? null

        // ②b 同一欠账的**视频**分支（`duration_ms`）：抹掉时长 → 再跑网格批 → 必须 probe 补回。
        //     这正是把「已知欠账」修成 `sink: true` 的那一条；把 `duration_ms` 从注册表的
        //     `sink` 去掉、或去掉泵里的视频分支，这条立刻变红。
        const vvictim = db
          .prepare("SELECT id FROM assets WHERE type='video' AND duration_ms IS NOT NULL ORDER BY id LIMIT 1")
          .get() as { id: number } | undefined
        if (vvictim) {
          db.prepare('UPDATE assets SET duration_ms=NULL WHERE id=?').run(vvictim.id)
          await awaitBatch(assets as never, 'grid')
          const vback = db.prepare('SELECT duration_ms FROM assets WHERE id=?').get(vvictim.id) as
            | { duration_ms: number | null }
            | undefined
          d17VideoSinkOk = vback?.duration_ms != null
        }
        result.d17VideoSinkVictim = vvictim?.id ?? null

        // ③ 同步点③（`COPY_COLS`）的**行为**验证：注册表里的每一列都必须原样带到副本上。
        //    ⚠️ 必须**先给每个派生列塞上可辨识的值**再复制 —— 否则 `NULL === NULL` 会让「漏列」
        //    假绿（铁律 G11 的空转形态；`note`/`gen_meta`/`ai_source` 在 m2 里本来都是空的）。
        //    图片覆盖 width/height/palette/note/gen_state/gen_meta/ai_source，
        //    视频再补 `duration_ms`（图片没有该项）。
        d17CopyDiff = []
        const cases: Array<[string, string]> = [
          ['image', "type='image' AND palette IS NOT NULL"],
          ['video', "type='video' AND duration_ms IS NOT NULL"]
        ]
        for (const [label, where] of cases) {
          const pick = db
            .prepare(`SELECT id FROM assets WHERE ${where} ORDER BY id LIMIT 1`)
            .get() as { id: number } | undefined
          if (!pick) {
            // 显式前置：样本不存在说明夹具变了，必须红（不能静默跳过 → 空转）
            d17CopyDiff.push(`${label}:无样本（前置不成立）`)
            continue
          }
          db.prepare('UPDATE assets SET note=?, gen_meta=?, ai_source=?, gen_state=3 WHERE id=?').run(
            `QA-${label}`,
            '{"generator":"qa"}',
            'qa-source',
            pick.id
          )
          const srcRow = db
            .prepare(`SELECT ${cols.join(',')} FROM assets WHERE id=?`)
            .get(pick.id) as Record<string, unknown>
          const cp = copyAssets([pick.id])
          const cpRow = db
            .prepare(`SELECT ${cols.join(',')} FROM assets ORDER BY id DESC LIMIT 1`)
            .get() as Record<string, unknown> | undefined
          if (cp.copied !== 1 || !cpRow) {
            d17CopyDiff.push(`${label}:复制未发生`)
            continue
          }
          for (const c of cols) {
            if (String(srcRow[c] ?? '') !== String(cpRow[c] ?? '')) d17CopyDiff.push(`${label}.${c}`)
          }
        }
      } catch (e) {
        d17CopyDiff.push(`行为验证抛错：${String(e).slice(0, 160)}`)
      }
      result.d17 = { missingCols: d17MissingCols, sinkRefilled: d17SinkOk, videoSinkRefilled: d17VideoSinkOk, copyDiff: d17CopyDiff, cols }
    }

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

    // 9. 方向（缺陷 2）：竖屏素材的索引宽高必须是**显示尺寸**，且与缩略图真实形状一致。
    //    为什么单开一个库：这里要导入「带 EXIF 旋转的图 / 带 display matrix 的视频」，
    //    若塞进上面的库会改掉 imgWH===IMG_N 等既有断言的计数。新库把影响面隔离干净。
    //    为什么断言「索引比例 == 缩略图比例」：卡片高度 = thumbW * (height/width) 用的是**索引**尺寸，
    //    而用户眼睛看到的是缩略图 —— 只有两者同形，卡片才不会歪。这条不变量才是那个 bug 本身。
    let orientOk = false
    let migrateOk = false
    {
      const oLib = createLibrary({ name: 'orient-lib', parentDir: dir })
      const oDir = join(dir, 'orient-src')
      mkdirSync(oDir)
      // 图片夹具：1200x900 + EXIF Orientation=6 → 显示应为竖屏 900x1200
      const o6 = join(oDir, 'o6.jpg')
      await sharp({ create: { width: 1200, height: 900, channels: 3, background: { r: 200, g: 80, b: 60 } } })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toFile(o6)
      // 正对照：Orientation=1 的横图**不该**被交换
      const o1 = join(oDir, 'o1.jpg')
      await sharp({ create: { width: 1200, height: 900, channels: 3, background: { r: 60, g: 80, b: 200 } } })
        .jpeg()
        .withMetadata({ orientation: 1 })
        .toFile(o1)
      // 视频夹具：1920x1080 + display_rotation 90 → 显示应为竖屏 1080x1920
      // ⚠️ `-metadata:s:v:0 rotate=90`（老 API）在本机 ffmpeg 6.1.1 上写不进去，必须用
      //    输入选项 `-display_rotation 90`（实测见 .workbuddy/audit/probe-orient.mjs）
      const vBase = join(oDir, 'vbase.mp4')
      await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=1920x1080:rate=10', '-pix_fmt', 'yuv420p', vBase])
      const vRot = join(oDir, 'vrot.mp4')
      await runFfmpeg(['-y', '-display_rotation', '90', '-i', vBase, '-c', 'copy', vRot])

      const oFolder = mkdirRel('方向')
      await new Promise<void>((resolve) => {
        importFiles({ paths: [o6, o1, vRot], folderId: oFolder.id, mode: 'copy', onDone: () => resolve() })
      })
      const odb = requireCurrent().db
      const oRows = odb
        .prepare('SELECT id, name, type, content_hash, rel_path FROM assets')
        .all() as Array<{ id: number; name: string; type: string; content_hash: string; rel_path: string }>
      await awaitBatch(oRows as never, 'grid')
      const oById = new Map(oRows.map((r) => [r.name, r]))
      const idxDims = (name: string): { w: number; h: number } => {
        const r = oById.get(name)!
        const row = odb.prepare('SELECT width, height FROM assets WHERE id=?').get(r.id) as { width: number; height: number }
        return { w: row.width, h: row.height }
      }
      // 读磁盘上缩略图的真实尺寸（不复用被测代码的判据）。
      // ⚠️ 用 `sharp(readFileSync(...))` 而非 `sharp(path)`：后者会在临时目录里留下未释放的
      //    文件句柄，末尾 `rmSync(dir)` 会 EPERM（与 B3 同族）。读进内存则读完即关。
      const thumbDims = async (name: string): Promise<{ w: number; h: number }> => {
        const r = oById.get(name)!
        const m = await sharp(readFileSync(join(oLib.path, '.thumbs', r.content_hash, 'grid.webp'))).metadata()
        return { w: m.width ?? 0, h: m.height ?? 0 }
      }
      const ratio = (d: { w: number; h: number }): number => d.h / d.w
      const i6 = idxDims('o6.jpg')
      const t6 = await thumbDims('o6.jpg')
      const i1 = idxDims('o1.jpg')
      const t1 = await thumbDims('o1.jpg')
      const iv = idxDims('vrot.mp4')
      const tv = await thumbDims('vrot.mp4')
      result.orient = { i6, t6, i1, t1, iv, tv }
      orientOk =
        // 竖屏图（EXIF 6）：索引与缩略图都必须 h > w，且比例一致
        i6.h > i6.w && t6.h > t6.w && Math.abs(ratio(i6) - ratio(t6)) < 0.05 &&
        // 竖屏视频（display matrix 90）：同上
        iv.h > iv.w && tv.h > tv.w && Math.abs(ratio(iv) - ratio(tv)) < 0.05 &&
        // 正对照：Orientation=1 的横图仍是横屏（h < w），没被误交换
        i1.w > i1.h && Math.abs(ratio(i1) - ratio(t1)) < 0.05

      // 存量迁移：手工写错尺寸 + dims_rev=1 → retestLegacyDims 清空 → 走一次 backfill 重测回正确值
      odb.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('dims_rev','1')").run()
      const o6id = oById.get('o6.jpg')!.id
      odb.prepare('UPDATE assets SET width=1200, height=900 WHERE id=?').run(o6id) // 模拟「老代码写错的横屏值」
      const r1 = retestLegacyDims()
      const afterClear = odb.prepare('SELECT width FROM assets WHERE id=?').get(o6id) as { width: number | null }
      const revAfter = (odb.prepare("SELECT value FROM meta WHERE key='dims_rev'").get() as { value: string }).value
      await awaitBatch(oRows as never, 'grid')
      const afterFix = odb.prepare('SELECT width, height FROM assets WHERE id=?').get(o6id) as { width: number; height: number }
      const r2 = retestLegacyDims() // 幂等：第二次不该再清
      const rev2 = (odb.prepare("SELECT value FROM meta WHERE key='dims_rev'").get() as { value: string }).value
      result.migrate = { cleared: r1.cleared, widthAfterClear: afterClear.width, revAfter, afterFix, clearedAgain: r2.cleared, rev2 }
      migrateOk =
        r1.cleared === true &&
        afterClear.width === null &&
        revAfter === '2' &&
        afterFix.width === 900 &&
        afterFix.height === 1200 &&
        r2.cleared === false &&
        rev2 === '2'
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
      Number(result.cacheHitMs) < 500 &&
      // 审计 §2.17 跨源不变量：注册表 ↔ 真实表结构 / 欠账条件行为 / 复制结果
      d17MissingCols.length === 0 &&
      d17SinkOk &&
      d17VideoSinkOk &&
      d17CopyDiff.length === 0 &&
      // 缺陷 2：方向（索引尺寸 = 显示尺寸且与缩略图同形）+ 存量迁移
      orientOk &&
      migrateOk

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
