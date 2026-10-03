import { existsSync, mkdirSync, renameSync, rmSync } from 'fs'
import { join, dirname, basename, relative, isAbsolute, resolve } from 'path'
import { openDatabase, SCHEMA_VERSION, type DB } from './db'
import { addRecentLibrary, listRecentLibraries, removeRecentLibrary } from './config'
import { subtreeOfPath, validateName } from './paths'

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
  // 版本号引用共享常量（单一真相源）。openDatabase 建新库时其实已经写过一次；
  // 这里再显式 WRITE 一遍是刻意为之：把「建库 = 当前版本」这条不变量钉在创建路径上，
  // 不依赖 openDatabase 的内部实现细节。meta.value 是 TEXT，所以要 String()。
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)").run(String(SCHEMA_VERSION))
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
  // 收掉老版本遗留的空标签（那时没有自动清理，库里可能躺着计数为 0 的标签）。
  // 这里静默处理、不通知：用户没做任何操作，弹提示反而莫名其妙。
  pruneAllEmptyTags(db)
  return { path: libPath, name: libName(db) }
}

export function listLibraries(): LibraryInfo[] {
  return listRecentLibraries().map((p) => ({
    path: p,
    name: basename(p)
  }))
}

/**
 * 把「库路径」的多种写法统一解析成**库目录**的绝对路径。
 *
 * 允许传入 `.stash` 索引文件本身或库目录本身 —— 两者都指向同一个库（与 openLibrary 同口径）。
 * 纯提取自 deleteLibrary 的头两行，逻辑一字未改；导出是为了让 main.ts 的删库收口入口
 * 能与 deleteLibrary 内部用**同一份**规范化结果去判断「删的是不是当前库」，
 * 避免两边各写一份路径比较而分叉。
 */
export function normalizeLibraryPath(target: string): string {
  const raw = target.toLowerCase().endsWith('.stash') ? dirname(target) : target
  return resolve(raw)
}

/**
 * 彻底删除库：库目录（含全部素材、.stash 索引、.thumbs 缓存）直接从磁盘移除，不进回收站。
 * 安全约束：只允许删除「最近列表中注册且含 .stash 的库目录」，防止误删任意路径。
 *
 * ⚠️ 本函数**不含** `unwatchLibrary()`：直接 import watcher 会与 watcher → library 形成 import 环。
 * 「删当前库前先停 chokidar」由 main.ts 的收口入口 `deleteLibrarySafely` 负责（两个调用点都走它）。
 */
export function deleteLibrary(target: string): void {
  const libPath = normalizeLibraryPath(target)
  if (!existsSync(join(libPath, '.stash'))) throw new Error('ERR_NOT_A_LIBRARY')
  const registered = listRecentLibraries().some((p) => p.toLowerCase() === libPath.toLowerCase())
  if (!registered) throw new Error('ERR_NOT_REGISTERED')
  if (current && current.path.toLowerCase() === libPath.toLowerCase()) closeCurrent()
  rmSync(libPath, { recursive: true, force: true })
  removeRecentLibrary(libPath)
}

// —— 文件夹（与库目录真实文件夹 1:1）——

/**
 * 校验文件夹名。规则与素材名**完全同一套**（空 / `.` / `..` / 非法字符 / 保留设备名 /
 * 以点或空格结尾 —— 末者 Windows 会静默裁掉，导致磁盘目录名与索引 path 不一致），
 * 实现下沉到 `paths.ts` 的 `validateName`。审计 §2.16：此前两处各写一份、连常量都各维护一份，
 * 是「改一处漏一处 → 两个入口行为不一致」的温床。
 */
export function validateFolderName(raw: string): string {
  return validateName(raw)
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
 * 过滤规则共用 `paths.ts` 的 `subtreeOfPath`（与 `assets.ts` 的 `subtreeIds` 同一份，审计 §2.16）：
 * 内存 path 前缀比较，不用 SQL LIKE —— 文件夹名里含 `_` / `%` 时 LIKE 会误匹配。
 */
function subtreeRows(db: DB, rootPath: string): Array<{ id: number; path: string }> {
  const all = db.prepare('SELECT id, path FROM folders').all() as Array<{ id: number; path: string }>
  return subtreeOfPath(all, rootPath)
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
 * 挑选并删除「一个素材都没挂」的标签，返回被删掉的标签（供 UI 提示）。
 *
 * 背景：标签的全部用途就是给素材分类，挂着 0 个素材的标签没有任何信息量 ——
 * 留在侧栏只会显示一个孤零零的 `0`，看起来像 bug（用户就是这么报上来的）。
 *
 * ⚠️ 分两种调用场景，别混：
 *  - **业务路径**（摘标签 / 删素材 / 删文件夹）用 `pruneUnlinkedTags(db, candidates)`，
 *    只在自己刚摘掉关联的那些标签里找。**绝对不能在这里全表扫「空的标签」**：
 *    `createTag` 与 `setTags` 之间有窗口期，新建的标签在挂上任何素材之前就是「空的」，
 *    全表扫会当场把它误删，紧接着 `setTags` 插关联就会撞 `FOREIGN KEY constraint failed`
 *    （这个坑是写冒烟时踩出来的：脚本先连建两个标签再逐个挂，第一个 `setTags` 就把
 *    第二个还没挂上的标签清掉了）。
 *  - **打开库时**用 `pruneAllEmptyTags(db)` 全量扫一次，收掉老版本遗留的脏数据 ——
 *    这个时点不存在「用户正在创建标签」的状态，安全。
 *
 * 两者都用 `NOT EXISTS` 而不是 `NOT IN`：后者在子查询结果含 NULL 时恒为空集（经典陷阱）。
 */
function selectEmptyTags(db: DB, candidates: number[] | null): Array<{ id: number; name: string }> {
  const listed = candidates && !candidates.length ? [] : candidates
  const ph = listed?.map(() => '?').join(',')
  const rows = (
    listed
      ? db
          .prepare(
            `SELECT t.id, t.name FROM tags t
              WHERE t.id IN (${ph})
                AND NOT EXISTS (SELECT 1 FROM asset_tags a WHERE a.tag_id = t.id)`
          )
          .all(...listed)
      : db
          .prepare(
            'SELECT t.id, t.name FROM tags t WHERE NOT EXISTS (SELECT 1 FROM asset_tags a WHERE a.tag_id = t.id)'
          )
          .all()
  ) as Array<{ id: number; name: string }>
  if (!rows.length) return []
  db.prepare(`DELETE FROM tags WHERE id IN (${rows.map(() => '?').join(',')})`).run(...rows.map((t) => t.id))
  return rows
}

/** 只清理「刚被摘掉关联」的那些标签（业务路径用，理由见 `selectEmptyTags`） */
export function pruneUnlinkedTags(db: DB, candidates: number[]): Array<{ id: number; name: string }> {
  return selectEmptyTags(db, candidates)
}

/** 全量清理空标签（打开库时用，理由见 `selectEmptyTags`） */
export function pruneAllEmptyTags(db: DB): Array<{ id: number; name: string }> {
  return selectEmptyTags(db, null)
}

/**
 * 删除整个文件夹：**直接从磁盘删除**，不进回收站，不可恢复。
 *
 * 顺序与 deleteAssets 保持一致：先把物理目录整棵 rmSync 掉，成功后才清索引；
 * 物理删除失败（被占用/权限）就抛错且不动索引，避免留下「有记录没文件」的幽灵条目。
 * 索引清理含三部分：该子树的 assets 行（asset_tags 靠外键 CASCADE 自动清）、
 * folders 行、以及无其他素材引用的 .thumbs/<hash> 缓存。
 *
 * ⚠️ 因为连带删了素材，挂在那些素材上的标签可能归零，所以最后要清一次空标签。
 * 候选集必须在 `DELETE FROM assets` **之前**取，删完关联就查不到了。
 */
export function deleteFolder(id: number): {
  folders: number
  assets: number
  thumbsRemoved: number
  pruned: Array<{ id: number; name: string }>
} {
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

  // 空标签清理的候选集：这些素材当前挂着的标签。**必须在 DELETE 之前取**，
  // 删完 asset_tags 就一起没了，事后无从知道该检查哪些标签
  const affectedTagIds = (
    db
      .prepare(
        `SELECT DISTINCT tag_id FROM asset_tags
          WHERE asset_id IN (SELECT id FROM assets WHERE folder_id IN (${ph}))`
      )
      .all(...subIds) as Array<{ tag_id: number }>
  ).map((r) => r.tag_id)

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
  // 素材行删掉后，挂在它们身上的标签可能一个素材都不剩了
  const pruned = pruneUnlinkedTags(db, affectedTagIds)
  return { folders: sub.length, assets: assetRows.length, thumbsRemoved, pruned }
}

/**
 * 为已存在的物理目录补齐 folders 表行（不建目录），返回最深层 id。
 * 导出供 watcher 复用：外部（资源管理器）新建的子目录物理上已存在，但 folders 表里没有行，
 * 直接 INSERT asset 会因 `folder_id NOT NULL` 违约 —— 这里把各级祖先一起补上。
 */
export function ensureFolderRows(db: DB, parts: string[]): { id: number; path: string } {
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
