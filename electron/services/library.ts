import { existsSync, mkdirSync, renameSync, rmSync } from 'fs'
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

const BAD_NAME_CHARS = /[\\/:*?"<>|]/
/** Windows 保留设备名（CON、NUL、COM1…）无法作为目录名 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/**
 * 校验文件夹名。拒绝三类：
 * 1. 空 / `.` / `..` / 路径分隔符等文件系统非法字符 / Windows 保留设备名
 * 2. 结尾是「点或空格」——Windows 会静默裁掉，导致磁盘目录名与索引 path 不一致
 * 3. 名称里带 `/` 或 `\`（防止用重命名把文件夹「搬」到别处）
 */
export function validateFolderName(raw: string): string {
  const name = (raw ?? '').trim()
  if (!name) throw new Error('ERR_EMPTY_NAME')
  if (name === '.' || name === '..') throw new Error('ERR_INVALID_NAME')
  if (BAD_NAME_CHARS.test(name)) throw new Error('ERR_INVALID_NAME')
  if (RESERVED_NAMES.test(name)) throw new Error('ERR_INVALID_NAME')
  if (/[. ]$/.test(name)) throw new Error('ERR_INVALID_NAME')
  return name
}

/**
 * 库内相对路径 → 绝对路径，并做越界校验。
 * 用 path.relative 而不是 startsWith：库路径可能是正斜杠，与 join 产出的反斜杠永不相等。
 */
function resolveInLib(libPath: string, relPath: string): string {
  const parts = relPath.split(/[\\/]+/).filter(Boolean)
  const abs = join(libPath, ...parts)
  const rel = relative(libPath, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('ERR_OUTSIDE_LIBRARY')
  return abs
}

/**
 * 取某文件夹及其整棵子树的 folders 行。
 * 直接用内存里的 path 前缀比较（我们自己规范化的 `a/b` 形式），
 * 不用 SQL LIKE —— 文件夹名里含 `_` / `%` 时 LIKE 会误匹配。
 */
function subtreeRows(db: DB, rootPath: string): Array<{ id: number; path: string }> {
  const all = db.prepare('SELECT id, path FROM folders').all() as Array<{ id: number; path: string }>
  const prefix = rootPath + '/'
  return all.filter((f) => f.path === rootPath || f.path.startsWith(prefix))
}

/** 在库内创建真实目录并同步索引，relPath 用 / 分隔 */
export function mkdirRel(relPath: string): { id: number; path: string } {
  const { db, path: libPath } = requireCurrent()
  const parts = relPath.split(/[\\/]+/).filter(Boolean)
  const abs = resolveInLib(libPath, relPath)
  mkdirSync(abs, { recursive: true })
  return ensureFolderRows(db, parts)
}

/**
 * 在指定父文件夹下新建子文件夹（parentPath 为空 = 库根目录）。
 * 逐级 mkdir + ensureFolderRows 天然支持多级，所以「新建多级子文件夹」只要嵌套调用即可。
 */
export function mkdirChild(parentPath: string, rawName: string): { id: number; path: string } {
  const { db } = requireCurrent()
  const name = validateFolderName(rawName)
  const parent = (parentPath ?? '').replace(/^[/\\]+|[/\\]+$/g, '')
  if (parent) {
    const p = db.prepare('SELECT id FROM folders WHERE path=?').get(parent)
    if (!p) throw new Error('ERR_FOLDER_NOT_FOUND')
  }
  const rel = parent ? `${parent}/${name}` : name
  if (db.prepare('SELECT id FROM folders WHERE path=?').get(rel)) throw new Error('ERR_FOLDER_EXISTS')
  return mkdirRel(rel)
}

/**
 * 重命名文件夹：物理目录先改名，成功后再在同一事务里同步
 * folders 子树的 path 与 assets.rel_path（否则素材会指向不存在的老路径）。
 * 索引写失败则把物理目录名改回去，避免磁盘与索引不一致。
 */
export function renameFolder(id: number, rawName: string): { id: number; path: string; folders: number; assets: number } {
  const { db, path: libPath } = requireCurrent()
  const name = validateFolderName(rawName)
  const row = db.prepare('SELECT id, path, name FROM folders WHERE id=?').get(id) as
    | { id: number; path: string; name: string }
    | undefined
  if (!row) throw new Error('ERR_FOLDER_NOT_FOUND')
  if (row.path.startsWith('.')) throw new Error('ERR_PROTECTED_FOLDER')
  if (row.name === name) return { id, path: row.path, folders: 0, assets: 0 }

  const parentPath = row.path.includes('/') ? row.path.slice(0, row.path.lastIndexOf('/')) : ''
  const newRel = parentPath ? `${parentPath}/${name}` : name
  const oldAbs = resolveInLib(libPath, row.path)
  const newAbs = resolveInLib(libPath, newRel)
  // 仅大小写变化（Photos → photos）时 Windows 认为同一目录，existsSync 恒真，需要放行
  const caseOnly = oldAbs.toLowerCase() === newAbs.toLowerCase()
  if (!caseOnly) {
    if (db.prepare('SELECT id FROM folders WHERE path=?').get(newRel)) throw new Error('ERR_FOLDER_EXISTS')
    if (existsSync(newAbs)) throw new Error('ERR_FOLDER_EXISTS')
  }
  if (!existsSync(oldAbs)) throw new Error('ERR_FOLDER_MISSING')

  renameSync(oldAbs, newAbs)

  // 父先子后更新，避免 UNIQUE(path) 出现暂时冲突
  const sub = subtreeRows(db, row.path).sort((a, b) => a.path.length - b.path.length)
  const subIds = sub.map((f) => f.id)
  const ph = subIds.map(() => '?').join(',')
  const assetRows = db
    .prepare(`SELECT id, name, folder_id FROM assets WHERE folder_id IN (${ph})`)
    .all(...subIds) as Array<{ id: number; name: string; folder_id: number }>

  let folders = 0
  let assets = 0
  try {
    db.exec('BEGIN')
    const setPath = db.prepare('UPDATE folders SET path=? WHERE id=?')
    const setName = db.prepare('UPDATE folders SET name=? WHERE id=?')
    for (const f of sub) {
      // 自身换成新名；子孙只换前缀
      const np = f.path === row.path ? newRel : newRel + f.path.slice(row.path.length)
      setPath.run(np, f.id)
      folders++
    }
    setName.run(name, row.id)

    const newPathById = new Map<number, string>()
    for (const f of sub) newPathById.set(f.id, f.path === row.path ? newRel : newRel + f.path.slice(row.path.length))
    const setRel = db.prepare('UPDATE assets SET rel_path=? WHERE id=?')
    for (const a of assetRows) {
      setRel.run(`${newPathById.get(a.folder_id)}/${a.name}`, a.id)
      assets++
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    // 索引没改成 → 物理目录名也改回去，保持两边一致
    try {
      renameSync(newAbs, oldAbs)
    } catch {
      /* 回滚物理也失败，只能把错误抛出去 */
    }
    throw e
  }
  return { id, path: newRel, folders, assets }
}

/**
 * 删除整个文件夹：**直接从磁盘删除**，不进回收站，不可恢复。
 *
 * 顺序与 deleteAssets 保持一致：先把物理目录整棵 rmSync 掉，成功后才清索引；
 * 物理删除失败（被占用/权限）就抛错且不动索引，避免留下「有记录没文件」的幽灵条目。
 * 索引清理含三部分：该子树的 assets 行（asset_tags 靠外键 CASCADE 自动清）、
 * folders 行、以及无其他素材引用的 .thumbs/<hash> 缓存。
 */
export function deleteFolder(id: number): { folders: number; assets: number; thumbsRemoved: number } {
  const { db, path: libPath } = requireCurrent()
  const row = db.prepare('SELECT id, path FROM folders WHERE id=?').get(id) as { id: number; path: string } | undefined
  if (!row) throw new Error('ERR_FOLDER_NOT_FOUND')
  // 库内的隐藏目录（.thumbs 等）永远不该被当普通文件夹删掉
  if (row.path.startsWith('.')) throw new Error('ERR_PROTECTED_FOLDER')

  const sub = subtreeRows(db, row.path)
  const subIds = sub.map((f) => f.id)
  const ph = subIds.map(() => '?').join(',')

  const abs = resolveInLib(libPath, row.path)
  if (existsSync(abs)) rmSync(abs, { recursive: true, force: true })

  const assetRows = db
    .prepare(`SELECT id, content_hash FROM assets WHERE folder_id IN (${ph})`)
    .all(...subIds) as Array<{ id: number; content_hash: string | null }>

  try {
    db.exec('BEGIN')
    db.prepare(`DELETE FROM assets WHERE folder_id IN (${ph})`).run(...subIds)
    db.prepare(`DELETE FROM folders WHERE id IN (${ph})`).run(...subIds)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }

  // 缩略图缓存：hash 校验通过（同时防目录穿越）且已无任何素材引用时才删
  let thumbsRemoved = 0
  const stillUsed = db.prepare('SELECT count(*) AS c FROM assets WHERE content_hash=?')
  for (const a of assetRows) {
    const hash = a.content_hash
    if (!hash || !/^[0-9a-f]{20}$/.test(hash)) continue
    if ((stillUsed.get(hash) as { c: number }).c) continue
    try {
      rmSync(join(libPath, '.thumbs', hash), { recursive: true, force: true })
      thumbsRemoved++
    } catch {
      /* 缓存清理失败不影响删除结果 */
    }
  }
  return { folders: sub.length, assets: assetRows.length, thumbsRemoved }
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
