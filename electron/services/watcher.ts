import chokidar from 'chokidar'
import { extname, relative } from 'path'
import { statSync } from 'fs'
import { EXT_TYPE } from './importer'
import type { DB } from './db'

let watcher: chokidar.FSWatcher | null = null

export function unwatchLibrary(): void {
  if (watcher) {
    watcher.close()
    watcher = null
  }
}

/** 监听库目录，外部改动增量同步索引（防抖由 awaitWriteFinish + 简单标记实现） */
export function watchLibrary(libPath: string, db: DB): void {
  unwatchLibrary()
  watcher = chokidar.watch(libPath, {
    ignoreInitial: true,
    ignored: (p: string) => {
      const rel = relative(libPath, p)
      return rel === '' || rel.startsWith('.stash') || rel.startsWith('.thumbs')
    },
    awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 100 }
  })

  function relOf(abs: string): string {
    return relative(libPath, abs).replace(/\\/g, '/')
  }

  watcher.on('add', (abs) => {
    try {
      const rel = relOf(abs)
      if (db.prepare('SELECT id FROM assets WHERE rel_path=?').get(rel)) return
      const name = rel.split('/').pop() as string
      const dirRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
      let folderId: number | null = null
      if (dirRel) {
        const f = db.prepare('SELECT id FROM folders WHERE path=?').get(dirRel) as { id: number } | undefined
        folderId = f?.id ?? null
      }
      const ext = extname(name).slice(1).toLowerCase()
      const type = EXT_TYPE[ext]
      if (!type) return
      const st = statSync(abs)
      db.prepare(
        `INSERT INTO assets(folder_id,name,rel_path,source_path,type,ext,size,content_hash,file_mtime,imported_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      ).run(folderId, name, rel, null, type, ext, st.size, null, Math.floor(st.mtimeMs), Date.now())
    } catch {
      /* 单文件失败不中断监听 */
    }
  })

  const markMissing = (abs: string) => {
    try {
      db.prepare('UPDATE assets SET missing=1 WHERE rel_path=?').run(relOf(abs))
    } catch {
      /* ignore */
    }
  }
  const markDirMissing = (abs: string) => {
    try {
      db.prepare('UPDATE assets SET missing=1 WHERE rel_path LIKE ?').run(relOf(abs) + '/%')
    } catch {
      /* ignore */
    }
  }
  watcher.on('unlink', markMissing)
  watcher.on('unlinkDir', markDirMissing)
}
