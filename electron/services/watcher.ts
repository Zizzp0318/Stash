import chokidar from 'chokidar'
import { basename, extname, relative } from 'path'
import { statSync } from 'fs'
import { EXT_TYPE } from './importer'
import type { DB } from './db'

let watcher: chokidar.FSWatcher | null = null

/** 压缩管线写的临时文件前缀（同目录、同盘，见 compress.ts 的 tmpPathFor） */
const TMP_PREFIX = '.stash-compress-'

/**
 * 「这次改动是我们自己造成的」——登记后，随后那次 add/unlink 不再同步索引。
 *
 * 为什么不能只靠 `awaitWriteFinish` 的 800ms：那是**时间**保证，而原地替换在这段窗口里
 * 还要哈希大文件 + 写 sqlite，慢机器 / 网络盘上完全可能超时。一旦超时，
 * `add` 会给新文件插一行重复素材、`unlink` 会把我们刚改好的那行标成 missing。
 * 所以顺序（见 compress.ts）与显式抑制两条都要。
 *
 * 一次性消费：外部后来真的又改了同一个路径，仍然会被正常同步到。
 */
const suppressed = new Map<string, number>()

/** 让下一次针对该 rel_path 的 add/unlink 事件被忽略（默认 10s 内有效） */
export function suppressRel(rel: string, ms = 10_000): void {
  suppressed.set(rel, Date.now() + ms)
}

function consumeSuppressed(rel: string): boolean {
  const until = suppressed.get(rel)
  if (until == null) return false
  suppressed.delete(rel)
  return Date.now() <= until
}

export function unwatchLibrary(): void {
  if (watcher) {
    watcher.close()
    watcher = null
  }
  suppressed.clear()
}

/** 监听库目录，外部改动增量同步索引（防抖由 awaitWriteFinish + 简单标记实现） */
export function watchLibrary(libPath: string, db: DB): void {
  unwatchLibrary()
  watcher = chokidar.watch(libPath, {
    ignoreInitial: true,
    ignored: (p: string) => {
      const rel = relative(libPath, p)
      // .stash 数据库文件 / .thumbs 缩略图缓存，均不参与索引同步。
      // `.stash-compress-*.tmp` 是压缩管线写在**目标同目录**的临时文件（同盘 rename 才快），
      // 必须一并忽略 —— 否则会被当成「外部新增文件」（见 compress.ts 的 tmpPathFor）
      return (
        rel === '' ||
        rel.startsWith('.stash') ||
        rel.startsWith('.thumbs') ||
        basename(rel).startsWith(TMP_PREFIX)
      )
    },
    awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 100 }
  })

  function relOf(abs: string): string {
    return relative(libPath, abs).replace(/\\/g, '/')
  }

  watcher.on('add', (abs) => {
    try {
      const rel = relOf(abs)
      // 我们自己刚放进来的（压缩替换）→ 索引已经改好了，别再插一行重复素材
      if (consumeSuppressed(rel)) return
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
      const rel = relOf(abs)
      // 旧文件是我们自己删的（压缩替换完成），别把已经改好的那行标成 missing
      if (consumeSuppressed(rel)) return
      db.prepare('UPDATE assets SET missing=1 WHERE rel_path=?').run(rel)
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
