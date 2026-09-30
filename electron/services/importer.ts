import { copyFileSync, readSync, closeSync, openSync, renameSync, statSync } from 'fs'
import { basename, extname, join } from 'path'
import { createHash } from 'crypto'
import { BrowserWindow } from 'electron'
import { requireCurrent, mkdirRel } from './library'
import { getSettings } from './config'
import { uniqueName } from './naming'
import type { DB } from './db'

export type AssetType = 'image' | 'video' | 'audio' | 'text'

export const EXT_TYPE: Record<string, AssetType> = {
  jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image',
  bmp: 'image', tiff: 'image', tif: 'image', svg: 'image', heic: 'image', heif: 'image', hif: 'image',
  mp4: 'video', mov: 'video', mkv: 'video', webm: 'video', avi: 'video',
  mp3: 'audio', wav: 'audio', flac: 'audio', aac: 'audio', ogg: 'audio', m4a: 'audio',
  txt: 'text', md: 'text'
}

/**
 * 内容哈希：size + 前 64KB 的 sha1 前 20 位（仅用于缓存命名与查重）。
 * **导出供 preview.ts 复用** —— 改了内容必须同步哈希，两侧算法绝不能分裂，
 * 否则派生缓存与缩略图会各认一套 key。
 */
export function contentHash(file: string): string {
  const st = statSync(file)
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(Math.min(65536, st.size))
    readSync(fd, buf, 0, buf.length, 0)
    return createHash('sha1').update(`${st.size}:`).update(buf).digest('hex').slice(0, 20)
  } finally {
    closeSync(fd)
  }
}

function toRel(...segs: string[]): string {
  return segs.filter(Boolean).join('/')
}

export interface ImportArgs {
  paths: string[]
  folderId?: number | null
  mode?: 'copy' | 'move'
  onProgress?: (p: { importId: number; done: number; total: number }) => void
  onDone?: (r: ImportResult) => void
}

export interface ImportResult {
  importId: number
  added: number
  /** 因内容重复（content_hash 命中）被跳过的数量 */
  skipped: number
  /** 因目标目录已有同名文件、被自动改成 `名字 (1).ext` 的数量 */
  renamed: number
  failed: Array<{ path: string; error: string }>
}

let importSeq = 0

export function importFiles(args: ImportArgs): { importId: number } {
  const { db, path: libPath } = requireCurrent()
  const importId = ++importSeq
  // 调用方没指定方式就按设置走（用时现读，不做模块级快照）
  const mode = args.mode ?? getSettings().importing.mode
  // 按内容去重也归设置管：关掉之后重复文件照样导入，靠 uniqueName 改名避开覆盖
  const dedupe = getSettings().importing.dedupe
  const total = args.paths.length

  // 异步执行，不阻塞 IPC 返回
  ;(async () => {
    let destDir = libPath
    let folderRel = ''
    if (args.folderId != null) {
      const f = db.prepare('SELECT path FROM folders WHERE id=?').get(args.folderId) as { path: string } | undefined
      if (!f) throw new Error('ERR_FOLDER_NOT_FOUND')
      destDir = join(libPath, ...f.path.split('/'))
      folderRel = f.path
    } else {
      // 未指定文件夹：导入到「未分类」（物理目录 + folders 表同步创建）
      const fallback = mkdirRel('未分类')
      destDir = join(libPath, ...fallback.path.split('/'))
      folderRel = fallback.path
      args.folderId = fallback.id
    }

    const insStmt = db.prepare(
      `INSERT INTO assets(folder_id,name,rel_path,source_path,type,ext,size,content_hash,file_mtime,imported_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`
    )
    const dupStmt = db.prepare('SELECT id FROM assets WHERE content_hash=?')

    let done = 0, added = 0, skipped = 0, renamed = 0
    const failed: Array<{ path: string; error: string }> = []
    const BATCH = 500
    let inTx = false
    // 当前事务里「已 INSERT、尚未 COMMIT」的条数。用它（而不是 `added % BATCH`）来判断是否该成批提交：
    // COMMIT 失败时会从 `added` 里扣回本批条数，`added` 会回退。`added % BATCH` 在本实现下其实仍成立
    // （回滚恰好扣回一整批，`added` 仍停在 BATCH 的整数倍上，同余关系不破），但直接数 `batchInserts`
    // 与「每 BATCH 条提交一次」的意图一一对应、也不受 `added` 任何增减运算牵连，更不易在后续改动里被写错。
    let batchInserts = 0

    /**
     * 提交当前批次。**自己永不抛出** —— 这是本函数存在的全部意义。
     *
     * 为什么要这样：两处 COMMIT（批中间 / 收尾）任一处把异常抛出去都会坏事 ——
     *   · 批中间那处若抛出，会被外层「逐文件」的 catch 捕获、误记成「某个文件失败」，
     *     而 `added` 在这之前已经自增过 → 计数虚报；
     *   · 收尾那处若抛出，原本被空 catch 静默吞掉 → 文件已物理拷入库、索引却没落盘，
     *     用户却照常看到 `import:done` 的「导入成功」。
     *
     * 成功：COMMIT；`inTx=false`；`batchInserts` 归零。
     * 失败：尽力 ROLLBACK（本批 INSERT 随之作废）；`inTx=false`；从 `added` 里**扣回本批条数**
     *       （否则 `added` 反映了库里根本不存在的行）；`batchInserts` 归零；
     *       往 `failed` 追加一条**措辞诚实**的记录（见下）。
     */
    const commitBatch = (): void => {
      if (!inTx) return
      const n = batchInserts
      try {
        db.exec('COMMIT')
        inTx = false
        batchInserts = 0
      } catch (e) {
        // 回滚是「尽力而为」：即使回滚也失败，也无法再做更多，下面的记录如实反映「索引未写入」这个现实。
        try {
          db.exec('ROLLBACK')
        } catch {
          /* 回滚失败只能放任事务处于不确定态，但至少把失败如实上报给用户 */
        }
        inTx = false
        batchInserts = 0
        // 本批 INSERT 已随 ROLLBACK 全部作废 → 把之前误记的成功数扣回来，让 `added` 与库中实际行数一致。
        added -= n
        failed.push({
          // path 刻意**不含任何真实文件名**：App.vue 会取它的 basename 当「首个文件名」展示，
          // 而这是「整批提交失败」、不是某个文件的问题，别诱导用户去怀疑/重导某一个具体文件。
          path: '（本批文件·索引未写入）',
          error:
            `数据库提交失败：本批 ${n} 个文件已拷入库目录，但索引未写入（库里看不到它们，磁盘文件仍在），` +
            `请重新导入本批。原因：${String((e as Error).message ?? e)}`
        })
      }
    }

    for (const src of args.paths) {
      try {
        const st = statSync(src)
        if (!st.isFile()) throw new Error('not a file')
        const ext = extname(src).slice(1).toLowerCase()
        const type = EXT_TYPE[ext]
        if (!type) { skipped++; continue }

        const hash = contentHash(src)
        if (dedupe && dupStmt.get(hash)) { skipped++; continue }

        // 目标目录已有同名文件 → 自动换一个不冲突的名字（`名字 (1).png`），
        // 绝不覆盖也不跳过。规则与移动/复制/重命名共用 `uniqueName`。
        const origName = basename(src)
        const name = uniqueName(destDir, origName)
        const dest = join(destDir, name)

        if (mode === 'move') renameSync(src, dest)
        else copyFileSync(src, dest)
        if (name !== origName) renamed++

        if (!inTx) { db.exec('BEGIN'); inTx = true }
        insStmt.run(
          args.folderId ?? null, name,
          toRel(folderRel, name), src, type, ext,
          st.size, hash, Math.floor(st.mtimeMs), Date.now()
        )
        added++
        batchInserts++
        if (batchInserts >= BATCH) commitBatch()
      } catch (err) {
        failed.push({ path: src, error: String((err as Error).message ?? err) })
      }
      done++
      if (done % 50 === 0 || done === total) {
        args.onProgress?.({ importId, done, total })
        BrowserWindow.getAllWindows()[0]?.webContents.send('import:progress', { importId, done, total })
      }
    }
    // 收尾提交最后不足一批的剩余（`inTx === false` 时是空操作，不会再碰已提交的批次）。
    // 与批中间那次走同一个 helper：失败会被扣回 added 并如实上报，不再静默吞掉。
    commitBatch()

    const result = { importId, added, skipped, renamed, failed }
    args.onDone?.(result)
    BrowserWindow.getAllWindows()[0]?.webContents.send('import:done', result)
  })().catch((e) => {
    args.onDone?.({ importId, added: 0, skipped: 0, renamed: 0, failed: [{ path: '*', error: String(e) }] })
  })

  return { importId }
}
