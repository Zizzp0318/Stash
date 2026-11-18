// 缓存占用账本冒烟：electron . --smoke-usage
//
// 盯的是 2026-11 用户报的「库一大，开软件就卡一会、点不动滚不动」——
// 实测根因不是加载素材，而是 `library:usage` 每次同步遍历 `.thumbs` 给每个文件 statSync：
//   2 万条库 1104 ms、5 万条库 2838 ms（`cache:stats` 同类遍历 872 / 2241 ms）。
// 而侧栏还会 `watch(counts.total)` —— 等于开库、导入收尾、删除之后各冻一次界面。
//
// 修法：`meta.thumbs_bytes` 增量记账 + 缺失时分块异步重算（见 usage.ts 文件头）。
// 本套件断的就是那三条承诺：
//   U1 开库路径 O(1)：账本缺失时 `library:usage()` 必须**立刻**返回（pending=true），不许扫盘；
//   U2 异步重算不卡事件循环：重算期间 10ms 心跳必须持续触发（同步遍历会钉死主线程）；
//   U3 账本正确：重算值 == 独立遍历真值；`bumpThumbsBytes` 增量精确；清理按实际释放量扣减。
//
// 纪律（与本项目其它套件一致）：真值用**本段自己写**的遍历算，不 import 产线的
// `thumbsDirBytesSync()` —— 否则实现写错、断言照抄，会一起错（铁律 G11）。
import { app } from 'electron'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  closeCurrent, createLibrary, getDatabase, listFolders, mkdirRel, openLibrary, requireCurrent
} from './library'
import { counts, listAssets } from './assets'
import { libraryUsage } from './health'
import { clearCache } from './cache'
import {
  bumpThumbsBytes, cachedThumbsBytes, isRecountingThumbsBytes, markThumbsBytesDirty,
  recountThumbsBytesAsync, THUMBS_BYTES_KEY
} from './usage'
import { unwatchLibrary } from './watcher'

const N = 3000
const FILE_BYTES = 1024

interface Check {
  name: string
  pass: boolean
  detail?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 独立口径：自己遍历 `.thumbs` 两层（不 import 产线实现） */
function trueThumbsBytes(root: string): number {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs')
  let total = 0
  let hashes: string[] = []
  try {
    hashes = fs.readdirSync(root)
  } catch {
    return 0
  }
  for (const h of hashes) {
    const dir = join(root, h)
    let files: string[] = []
    try {
      files = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const f of files) {
      try {
        total += fs.statSync(join(dir, f)).size
      } catch {
        /* 并发写/删，跳过 */
      }
    }
  }
  return total
}

function metaRow(): string | null {
  try {
    const row = requireCurrent().db.prepare('SELECT value FROM meta WHERE key=?').get(THUMBS_BYTES_KEY) as
      | { value?: string }
      | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

export async function runSmokeUsage(): Promise<void> {
  const checks: Check[] = []
  const result: Record<string, unknown> = { n: N }
  const check = (name: string, pass: boolean, detail?: string): void => {
    checks.push({ name, pass, detail })
  }
  let root: string | null = null
  try {
    root = mkdtempSync(join(tmpdir(), 'stash-smoke-usage-'))
    const lib = createLibrary({ name: 'smoke-usage-lib', parentDir: root })
    result.library = lib
    const folder = mkdirRel('批量')
    const thumbsDir = join(lib.path, '.thumbs')
    const db = getDatabase()

    // ---------- 夹具：N 条素材 + N 个 hash 目录 × 2 个文件 ----------
    const tBuild = Date.now()
    const buf = Buffer.alloc(FILE_BYTES, 0x41)
    const ins = db.prepare(
      `INSERT INTO assets(folder_id,name,rel_path,type,ext,size,content_hash,file_mtime,imported_at,missing)
       VALUES(?,?,?,'image','jpg',?,?,?,?,0)`
    )
    db.exec('BEGIN')
    for (let i = 0; i < N; i++) {
      const hash = (0xa0000000 + i).toString(16).padStart(20, '0')
      ins.run(folder.id, `u_${i}.jpg`, `批量/u_${i}.jpg`, 100_000, hash, Date.now(), Date.now())
      const dir = join(thumbsDir, hash)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'grid.webp'), buf)
      writeFileSync(join(dir, 'detail.webp'), buf)
    }
    db.exec('COMMIT')
    result.buildMs = Date.now() - tBuild
    result.trueBytes = trueThumbsBytes(thumbsDir)

    // ---------- U1：账本缺失时，usage 必须立刻返回（不许扫盘）----------
    unwatchLibrary()
    closeCurrent()
    openLibrary(lib.path)
    markThumbsBytesDirty()
    const t1 = performance.now()
    const u1 = libraryUsage()
    const syncMs = Math.round((performance.now() - t1) * 10) / 10
    result.u1 = { syncMs, pending: u1.thumbsPending === true, thumbsBytes: u1.thumbsBytes, assetsBytes: u1.assetsBytes }
    // 判别力（注入验证）：把 `libraryUsage` 改回 `thumbsDirBytesSync()` 全扫，
    // 本机 3000×2 个文件实测 113.9ms → 本条立刻红（旧实现 2 万条 1104ms / 5 万条 2838ms）。
    check(
      `U1 账本缺失时 library:usage 同步 < 10ms（实测 ${syncMs}ms）且标 pending`,
      syncMs < 10 && u1.thumbsPending === true,
      `syncMs=${syncMs} pending=${String(u1.thumbsPending)}`
    )
    check(
      'U1 素材字节数不依赖遍历（SQL sum，立即可用）',
      u1.assetsBytes === N * 100_000,
      `assetsBytes=${u1.assetsBytes} expect=${N * 100_000}`
    )

    // ---------- U2：重算期间事件循环不被钉住 ----------
    // 用 10ms 心跳计「主线程有没有空」：同步遍历会把所有 tick 压到结束后才补。
    let ticks = 0
    const ticker = setInterval(() => { ticks++ }, 10)
    const tRec = performance.now()
    const pendingRec = recountThumbsBytesAsync()
    const recountStarted = isRecountingThumbsBytes()
    const counted = await pendingRec
    const recMs = Math.round((performance.now() - tRec) * 10) / 10
    clearInterval(ticker)
    result.u2 = { recMs, ticks, counted, recountStarted }
    check('U2 重算被真的发起了（单飞标记为真）', recountStarted === true, String(recountStarted))
    check(
      `U2 重算 ${recMs}ms 期间 10ms 心跳触发 ${ticks} 次（≥3 才算没被同步遍历钉住）`,
      ticks >= 3,
      `ticks=${ticks} recMs=${recMs}`
    )
    check(
      'U2 重算值 == 独立遍历真值（±1%）',
      typeof counted === 'number' && Math.abs(counted - (result.trueBytes as number)) <= (result.trueBytes as number) * 0.01,
      `counted=${String(counted)} true=${String(result.trueBytes)}`
    )
    check('U2 重算结果已写回 meta（跨进程可读）', metaRow() === String(counted), `meta=${metaRow()}`)

    // 账本在 → usage 立刻是终值（不再 pending）
    const u2 = libraryUsage()
    result.u2Value = u2
    check(
      'U2 有账时 usage 直接给终值（pending 不为真、字节对得上）',
      u2.thumbsPending !== true && u2.thumbsBytes === counted,
      JSON.stringify(u2)
    )

    // ---------- U2b：单飞（并发两次只跑一份，返回同一个 Promise）----------
    {
      markThumbsBytesDirty()
      const a = recountThumbsBytesAsync()
      const b = recountThumbsBytesAsync()
      const [ra, rb] = await Promise.all([a, b])
      check('U2b 并发两次重算只跑一份（同一 Promise、结果一致）', a === b && ra === rb, `same=${a === b} ra=${String(ra)} rb=${String(rb)}`)
    }

    // ---------- U4：整条开库路径的同步耗时（用户能感觉到的就是这个数）----------
    // ⚠️ 必须排在 U3 的清理**之前**：清理会把 .thumbs 里的文件删光，之后再量就只剩 readdir，
    // 同步版也会「很快」—— 那条断言就变成空转了（本项目踩过同类的假绿：见 §11.2）。
    {
      markThumbsBytesDirty() // 让 U4 走「账本缺失 → 立刻返回 pending」这条真实开库路径
      closeCurrent()
      unwatchLibrary()
      const t = performance.now()
      openLibrary(lib.path)
      const usage = libraryUsage()
      listFolders()
      counts()
      listAssets({ limit: 200, offset: 0 } as never)
      const ms = Math.round((performance.now() - t) * 10) / 10
      result.u4 = { ms, pending: usage.thumbsPending === true }
      check(
        `U4 开库路径（open + usage + folder + counts + 首屏 200 条）同步总耗时 ${ms}ms < 100ms`,
        ms < 100,
        `ms=${ms} pending=${String(usage.thumbsPending)}`
      )
      check('U4 该路径上 usage 是 pending（没在开库时扫盘）', usage.thumbsPending === true, String(usage.thumbsPending))
      await recountThumbsBytesAsync() // 把账本补回来，后面的 U3 要用
    }

    // ---------- U3：增量记账精确 ----------
    {
      const before = cachedThumbsBytes(requireCurrent().db)
      bumpThumbsBytes(4096)
      const after = cachedThumbsBytes(requireCurrent().db)
      check('U3 bump(+4096) 精确加 4096', before != null && after === before + 4096, `before=${String(before)} after=${String(after)}`)

      // 清理按**实际释放量**扣减：这里清掉 N 个 grid.webp
      markThumbsBytesDirty()
      const real = await recountThumbsBytesAsync()
      const cachedBefore = cachedThumbsBytes(requireCurrent().db)
      const freed = clearCache('thumbs')
      const cachedAfter = cachedThumbsBytes(requireCurrent().db)
      result.u3 = { real, freed: freed.freed, removed: freed.removed, cachedBefore, cachedAfter }
      check(
        'U3 clearCache(thumbs) 后账本 == 清理前 - 实际释放字节（逐个文件真大小）',
        cachedBefore != null && cachedAfter === cachedBefore - freed.freed && freed.freed > 0,
        `before=${String(cachedBefore)} freed=${freed.freed} after=${String(cachedAfter)} removed=${freed.removed}`
      )
      check(
        'U3 清理后账本仍与磁盘一致（重新遍历核对）',
        Math.abs((cachedAfter ?? -1) - trueThumbsBytes(thumbsDir)) <= Math.max(2048, freed.freed * 0.01),
        `cached=${String(cachedAfter)} disk=${trueThumbsBytes(thumbsDir)}`
      )
    }

    // （U4 已上移：它必须在 U3 清理 `.thumbs` 之前跑，否则量到的只是 readdir，断言会空转）

    // ==================== U5. cache:stats 异步化：不卡事件循环 + 数字对得上 ====================
    //
    // 背景：同步版在 2 万条库上 872ms、5 万条 2241ms，用户点开「设置 → 缩略图与缓存」就卡这么久
    // （每个文件一次 statSync，主进程整整钉住）。这里验两件事：
    //   ① 遍历期间 10ms 心跳能持续触发（= 真的分块让出了事件循环）；
    //   ② 分类口径没漂：异步版的 thumbs/derived/other 与**本段自己数**的结果逐字段相等。
    {
      const { cacheStatsAsync } = await import('./cache')
      // 造一点有分类意义的缓存：2 个 grid + 1 个 detail + 1 个派生 + 1 个 tmp + 1 个根目录占位图
      const mk = (rel: string, bytes: number): void => {
        const parts = rel.split('/')
        const dir = parts.length > 1 ? join(thumbsDir, parts[0]) : thumbsDir
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, parts[parts.length - 1]), Buffer.alloc(bytes, 0x42))
      }
      mk('u5a/grid.webp', 300)
      mk('u5a/detail.webp', 400)
      mk('u5b/grid.webp', 500)
      mk('u5b/preview-2560.webp', 600)
      mk('u5b/preview.123.tmp.mp4', 700)
      mk('placeholder-audio.webp', 800)

      // 独立口径：自己走一遍（不 import 产线的 classify）
      const expect = { thumbs: { files: 0, bytes: 0 }, derived: { files: 0, bytes: 0 }, other: { files: 0, bytes: 0 } }
      const bump = (k: 'thumbs' | 'derived' | 'other', b: number): void => {
        expect[k].files++
        expect[k].bytes += b
      }
      bump('thumbs', 300); bump('thumbs', 400); bump('thumbs', 500)
      bump('derived', 600)
      bump('other', 700); bump('other', 800)

      const t5a = performance.now()
      const stats = await cacheStatsAsync()
      const smallMs = Math.round((performance.now() - t5a) * 10) / 10
      result.u5 = { smallMs, stats }
      check(
        `U5 cacheStatsAsync 结果与独立口径逐字段一致（thumbs ${stats.thumbs.files}/${stats.thumbs.bytes}B · derived ${stats.derived.files}/${stats.derived.bytes}B · other ${stats.other.files}/${stats.other.bytes}B）`,
        stats.thumbs.files === expect.thumbs.files && stats.thumbs.bytes === expect.thumbs.bytes &&
          stats.derived.files === expect.derived.files && stats.derived.bytes === expect.derived.bytes &&
          stats.other.files === expect.other.files && stats.other.bytes === expect.other.bytes,
        JSON.stringify({ got: { t: stats.thumbs, d: stats.derived, o: stats.other }, want: expect })
      )
      check(
        'U5 分类口径：preview-2560.webp 记 derived、preview.*.tmp 记 other（前缀判据会整类漏算）',
        stats.derived.bytes === 600 && stats.other.bytes === 1500,
        `derived=${stats.derived.bytes} other=${stats.other.bytes}`
      )

      // 规模测试：6 个文件只要 2ms，测不出「有没有让出事件循环」。
      // 造 3000 个 hash 目录 × 1 文件，让遍历真的需要几十毫秒 —— 这才是用户点开设置时的规模感。
      const FILL = 3000
      for (let i = 0; i < FILL; i++) {
        const d = join(thumbsDir, `u5f_${i}`)
        mkdirSync(d, { recursive: true })
        writeFileSync(join(d, 'grid.webp'), Buffer.alloc(1, 0x43))
      }
      let ticks5 = 0
      const iv5 = setInterval(() => { ticks5++ }, 10)
      const t5 = performance.now()
      const big = await cacheStatsAsync()
      const asyncMs = Math.round((performance.now() - t5) * 10) / 10
      clearInterval(iv5)
      result.u5 = { asyncMs, ticks: ticks5, files: big.total.files, before: stats.total.files }
      check(
        `U5 大目录也能数对：${stats.total.files} + ${FILL} 个填充文件 = ${big.total.files}`,
        big.total.files === stats.total.files + FILL,
        `got=${big.total.files} want=${stats.total.files + FILL}`
      )
      check(
        `U5 统计期间事件循环没被钉住（${asyncMs}ms 内 10ms 心跳 ${ticks5} 次 ≥ 3；同步版会 0 次）`,
        ticks5 >= 3,
        `ticks=${ticks5} asyncMs=${asyncMs}`
      )
    }

    // ==================== U6. 回填分批 + 低优先级让路 + 失败黑名单 ====================
    //
    // 背景：以前一次把「全库缺缩略图」塞进 4 并发队列，几万条库连跑几十分钟，sharp 占满线程池
    // → 滚动掉帧。现在：每轮最多 limit 条、低优先级 job 独占并发位且彼此间隔 24ms、
    // 这批跑完还有欠账才续批；生成不出来的进黑名单（否则续批会变成永不停止的轮子）。
    {
      const { ensureBatch, failedThumbCount, clearThumbFailures, isThumbFailed } = await import('./thumbs')
      clearThumbFailures()
      // 40 条「源文件不存在」的素材：ensureOne 会立刻失败 → 正好用来验黑名单与分批
      const db = requireCurrent().db
      const folderRow = db.prepare('SELECT id FROM folders LIMIT 1').get() as { id: number } | undefined
      const fid = folderRow?.id ?? 1
      db.exec('BEGIN')
      const ins = db.prepare(
        `INSERT INTO assets(folder_id,name,rel_path,type,ext,size,content_hash,file_mtime,imported_at,missing)
         VALUES(?,?,?,'image','jpg',1000,?,?,?,0)`
      )
      const rows: Array<{ id: number; type: string; ext: string; content_hash: string; rel_path: string }> = []
      for (let i = 0; i < 40; i++) {
        const hash = (0xb0000000 + i).toString(16).padStart(20, '0')
        const name = `u6_${i}.jpg`
        const r = ins.run(fid, name, `批量/${name}`, hash, Date.now(), Date.now()) as { lastInsertRowid: number | bigint }
        rows.push({ id: Number(r.lastInsertRowid), type: 'image', ext: 'jpg', content_hash: hash, rel_path: `批量/${name}` })
      }
      db.exec('COMMIT')

      // 第一批：limit 5 → 只入队 5 条，且 capped（还有 35 条欠账）
      const done1 = new Promise<number>((resolve) => {
        const t0 = performance.now()
        ensureBatch(rows as never, 'grid', () => resolve(Math.round((performance.now() - t0) * 10) / 10), {
          lowPriority: true,
          limit: 5
        })
      })
      const first = done1
      const batchMs = await first
      result.u6 = { batchMs }
      check('U6 分批：limit=5 时这一批只跑 5 条（不是 40）', failedThumbCount() === 5, `failed=${failedThumbCount()}`)
      check(
        `U6 低优先级让路：5 个 job 之间空 24ms，整批耗时 ${batchMs}ms ≥ 90ms（同步连跑会 < 10ms）`,
        batchMs >= 90,
        `batchMs=${batchMs}`
      )

      // 第二批：那 5 条已进黑名单 → 只会跑剩下的 35 条里的 5 条；再来一轮则剩 30
      await new Promise<void>((resolve) => {
        ensureBatch(rows as never, 'grid', () => resolve(), { lowPriority: true, limit: 5 })
      })
      check('U6 黑名单生效：第二轮跳过已失败的 5 条，只补新的 5 条（累计 10）', failedThumbCount() === 10, `failed=${failedThumbCount()}`)
      check(
        'U6 黑名单按 id+size+hash 计（换内容/换尺寸另有记录，不会被一条错误记录堵死）',
        isThumbFailed(rows[0].id, 'grid', rows[0].content_hash) === true &&
          isThumbFailed(rows[0].id, 'detail', rows[0].content_hash) === false,
        `grid=${isThumbFailed(rows[0].id, 'grid', rows[0].content_hash)} detail=${isThumbFailed(rows[0].id, 'detail', rows[0].content_hash)}`
      )
      clearThumbFailures()
      check('U6 clearThumbFailures() 能整表重置（清缓存/换库后重新给一次机会）', failedThumbCount() === 0, String(failedThumbCount()))
    }

    result.checks = checks
    result.failed = checks.filter((c) => !c.pass)
    result.ok = checks.every((c) => c.pass)
  } catch (e) {
    result.ok = false
    result.error = String((e as Error)?.stack ?? e)
    result.checks = checks
    result.failed = checks.filter((c) => !c.pass)
  } finally {
    try {
      unwatchLibrary()
      closeCurrent()
      if (root) rmSync(root, { recursive: true, force: true })
    } catch (e) {
      result.cleanupError = String((e as Error)?.message ?? e)
    }
    console.log('[SMOKE-USAGE] ' + JSON.stringify(result, null, 2))
    app.exit(0)
  }
}
