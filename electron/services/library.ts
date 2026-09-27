import { existsSync, mkdirSync, rmSync } from 'fs'
import { join, dirname, basename, relative, isAbsolute, resolve } from 'path'
import { openDatabase, type DB } from './db'
import { addRecentLibrary, listRecentLibraries, removeRecentLibrary } from './config'

let current: { db: DB; path: string } | null = null

export interface LibraryInfo {
  path: string
  name: string
}

function libName(db: DB): string {
  const row = db.prepare("SELECT value FROM meta WHERE key='library_name'").get() as { value: string } | undefined
  return row?.value ?? ''
}

export function getLibrary(): LibraryInfo | null {
  return current ? { path: current.path, name: libName(current.db) } : null
}

export function requireCurrent(): { db: DB; path: string } {
  if (!current) throw new Error('ERR_NO_LIBRARY')
  return current
}

/** 当前库的数据库连接（watcher 等模块用） */
export function getDatabase(): DB {
  return requireCurrent().db
}

function setCurrent(db: DB, path: string): void {
  if (current) closeCurrent()
  current = { db, path }
  addRecentLibrary(path)
}

export function closeCurrent(): void {
  if (current) {
    try {
      current.db.close()
    } catch {
      /* ignore */
    }
    current = null
  }
}

export function createLibrary({ name, parentDir }: { name: string; parentDir: string }): LibraryInfo {
  if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error('ERR_INVALID_NAME')
  const libPath = resolve(join(parentDir, name))
  if (existsSync(join(libPath, '.stash'))) throw new Error('ERR_LIBRARY_EXISTS')
  mkdirSync(join(libPath, '.thumbs'), { recursive: true })
  const db = openDatabase(join(libPath, '.stash'))
  const now = Date.now()
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version','1')").run()
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('library_name',?)").run(name)
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('created_at',?)").run(String(now))
  setCurrent(db, libPath)
  return { path: libPath, name }
}

export function openLibrary(target: string): LibraryInfo {
  const raw = target.toLowerCase().endsWith('.stash') ? dirname(target) : target
  const libPath = resolve(raw)
  if (!existsSync(join(libPath, '.stash'))) throw new Error('ERR_NOT_A_LIBRARY')
  const db = openDatabase(join(libPath, '.stash'))
  setCurrent(db, libPath)
  return { path: libPath, name: libName(db) }
}

export function listLibraries(): LibraryInfo[] {
  return listRecentLibraries().map((p) => ({
    path: p,
    name: basename(p)
  }))
}

/**
 * 彻底删除库：库目录（含全部素材、.stash 索引、.thumbs 缓存）直接从磁盘移除，不进回收站。
 * 安全约束：只允许删除「最近列表中注册且含 .stash 的库目录」，防止误删任意路径。
 */
export function deleteLibrary(target: string): void {
  const raw = target.toLowerCase().endsWith('.stash') ? dirname(target) : target
  const libPath = resolve(raw)
  if (!existsSync(join(libPath, '.stash'))) throw new Error('ERR_NOT_A_LIBRARY')
  const registered = listRecentLibraries().some((p) => p.toLowerCase() === libPath.toLowerCase())
  if (!registered) throw new Error('ERR_NOT_REGISTERED')
  if (current && current.path.toLowerCase() === libPath.toLowerCase()) closeCurrent()
  rmSync(libPath, { recursive: true, force: true })
  removeRecentLibrary(libPath)
}

// —— 文件夹（与库目录真实文件夹 1:1）——

/** 在库内创建真实目录并同步索引，relPath 用 / 分隔 */
export function mkdirRel(relPath: string): { id: number; path: string } {
  const { db, path: libPath } = requireCurrent()
  const parts = relPath.split(/[\\/]+/).filter(Boolean)
  const abs = join(libPath, ...parts)
  // 用 path.relative 做越界判断（startsWith 会被正反斜杠/大小写差异误判）
  const rel = relative(libPath, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('ERR_OUTSIDE_LIBRARY')
  mkdirSync(abs, { recursive: true })
  return ensureFolderRows(db, parts)
}

/** 为已存在的物理目录补齐 folders 表行（不建目录），返回最深层 id */
function ensureFolderRows(db: DB, parts: string[]): { id: number; path: string } {
  let parentId: number | null = null
  let cur = ''
  let lastId = 0
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part
    const exist = db.prepare('SELECT id FROM folders WHERE path=?').get(cur) as { id: number } | undefined
    if (exist) {
      lastId = exist.id
    } else {
      const r = db.prepare('INSERT INTO folders(parent_id,path,name,created_at) VALUES(?,?,?,?)').run(parentId, cur, part, Date.now())
      lastId = Number(r.lastInsertRowid)
    }
    parentId = lastId
  }
  return { id: lastId, path: cur }
}

export function listFolders(): Array<{ id: number; parent_id: number | null; path: string; name: string }> {
  const { db } = requireCurrent()
  return db.prepare('SELECT id, parent_id, path, name FROM folders ORDER BY path').all() as never
}
