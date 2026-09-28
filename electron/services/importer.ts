import { copyFileSync, readSync, closeSync, openSync, renameSync, statSync } from 'fs'
import { basename, extname, join } from 'path'
import { createHash } from 'crypto'
import { BrowserWindow } from 'electron'
import { requireCurrent, mkdirRel } from './library'
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
  const mode = args.mode ?? 'copy'
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

    for (const src of args.paths) {
      try {
        const st = statSync(src)
        if (!st.isFile()) throw new Error('not a file')
        const ext = extname(src).slice(1).toLowerCase()
        const type = EXT_TYPE[ext]
        if (!type) { skipped++; continue }

        const hash = contentHash(src)
        if (dupStmt.get(hash)) { skipped++; continue }

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
        if (added % BATCH === 0) { db.exec('COMMIT'); inTx = false }
      } catch (err) {
        failed.push({ path: src, error: String((err as Error).message ?? err) })
      }
      done++
      if (done % 50 === 0 || done === total) {
        args.onProgress?.({ importId, done, total })
        BrowserWindow.getAllWindows()[0]?.webContents.send('import:progress', { importId, done, total })
      }
    }
    if (inTx) { try { db.exec('COMMIT') } catch { /* ignore */ } }

    const result = { importId, added, skipped, renamed, failed }
    args.onDone?.(result)
    BrowserWindow.getAllWindows()[0]?.webContents.send('import:done', result)
  })().catch((e) => {
    args.onDone?.({ importId, added: 0, skipped: 0, renamed: 0, failed: [{ path: '*', error: String(e) }] })
  })

  return { importId }
}
