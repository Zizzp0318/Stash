import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, unlinkSync } from 'fs'
import { extname, join } from 'path'
import { requireCurrent, pruneUnlinkedTags } from './library'

/** 拼接库内相对路径（统一用 / 分隔） */
function toRel(...segs: string[]): string {
  return segs.filter(Boolean).join('/')
}

export interface AssetQuery {
  folderId?: number | null
  tagId?: number | null
  type?: string
  rating?: number
  fav?: boolean
  keyword?: string
  missing?: boolean
  sort?: 'imported_at' | 'name' | 'size' | 'rating'
  order?: 'asc' | 'desc'
  offset?: number
  limit?: number
}

const SORTABLE = new Set(['imported_at', 'name', 'size', 'rating'])

/**
 * 转义 LIKE 的通配符。
 *
 * 不转义的话，用户搜 `100%` 会变成「以 100 开头」、搜 `a_b` 会匹配到 `axb`
 * —— 搜索框看起来「不精确」，但很难联想到是通配符问题。
 * `\` 自身必须一起转义，否则用户输入的 `\` 会让后面的字符意外获得转义语义。
 * 配套 SQL 必须写 `ESCAPE '\'`，否则反斜杠会被当作普通字符。
 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export function listAssets(q: AssetQuery): { total: number; items: unknown[] } {
  const { db } = requireCurrent()

  const where: string[] = []
  const params: Array<string | number> = []

  if (q.folderId != null) { where.push('a.folder_id = ?'); params.push(q.folderId) }
  if (q.tagId != null) { where.push('a.id IN (SELECT asset_id FROM asset_tags WHERE tag_id = ?)'); params.push(q.tagId) }
  if (q.type) { where.push('a.type = ?'); params.push(q.type) }
  if (q.rating != null && q.rating > 0) { where.push('a.rating >= ?'); params.push(q.rating) }
  if (q.fav) where.push('a.is_fav = 1')
  if (q.missing != null) { where.push('a.missing = ?'); params.push(q.missing ? 1 : 0) }
  if (q.keyword) {
    // 文件名或标签名命中即可；两侧 LIKE 都走 escapeLike + ESCAPE '\'
    where.push(
      "(a.name LIKE ? ESCAPE '\\' OR a.id IN (" +
        "SELECT at.asset_id FROM asset_tags at JOIN tags t ON t.id = at.tag_id WHERE t.name LIKE ? ESCAPE '\\'))"
    )
    const kw = `%${escapeLike(q.keyword)}%`
    params.push(kw, kw)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const sortCol = SORTABLE.has(q.sort ?? '') ? `a.${q.sort}` : 'a.imported_at'
  const order = q.order === 'asc' ? 'ASC' : 'DESC'
  const limit = Math.min(q.limit ?? 200, 1000)
  const offset = q.offset ?? 0

  const total = (db.prepare(`SELECT count(*) AS c FROM assets a ${whereSql}`).get(...params) as { c: number }).c
  const items = db
    .prepare(`SELECT a.* FROM assets a ${whereSql} ORDER BY ${sortCol} ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset)

  return { total, items }
}

export function getAsset(id: number): unknown {
  const { db } = requireCurrent()
  const asset = db.prepare('SELECT * FROM assets WHERE id=?').get(id)
  if (!asset) throw new Error('ERR_ASSET_NOT_FOUND')
  const tags = db
    .prepare('SELECT t.id, t.name, t.color FROM tags t JOIN asset_tags at ON at.tag_id = t.id WHERE at.asset_id=?')
    .all(id)
  return { ...asset, tags }
}

export function updateAsset(id: number, patch: { rating?: number; isFav?: boolean }): void {
  const { db } = requireCurrent()
  if (patch.rating != null) {
    const r = Math.max(0, Math.min(5, Math.round(patch.rating)))
    db.prepare('UPDATE assets SET rating=? WHERE id=?').run(r, id)
  }
  if (patch.isFav != null) {
    db.prepare('UPDATE assets SET is_fav=? WHERE id=?').run(patch.isFav ? 1 : 0, id)
  }
}

/** 批量改评分 / 喜欢（单事务，避免 N 次 IPC 往返） */
export function bulkUpdate(ids: number[], patch: { rating?: number; isFav?: boolean }): { updated: number } {
  const { db } = requireCurrent()
  if (!ids.length) return { updated: 0 }
  const ph = ids.map(() => '?').join(',')
  let updated = 0
  db.exec('BEGIN')
  try {
    if (patch.rating != null) {
      const r = Math.max(0, Math.min(5, Math.round(patch.rating)))
      updated = Number(db.prepare(`UPDATE assets SET rating=? WHERE id IN (${ph})`).run(r, ...ids).changes)
    }
    if (patch.isFav != null) {
      updated = Number(
        db.prepare(`UPDATE assets SET is_fav=? WHERE id IN (${ph})`).run(patch.isFav ? 1 : 0, ...ids).changes
      )
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return { updated }
}

/** 目标目录内重名时追加 (n)，与导入逻辑保持一致的命名规则 */
function uniqueName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name
  const e = extname(name)
  const b = name.slice(0, name.length - e.length)
  let i = 1
  while (existsSync(join(dir, `${b} (${i})${e}`))) i++
  return `${b} (${i})${e}`
}

/**
 * 搬动单个文件。同库内基本都在同一卷，rename 即可；
 * 遇到挂载点 / 卷不同 / 文件被占用时退化为复制 + 删除。
 */
function moveFile(src: string, dest: string): void {
  try {
    renameSync(src, dest)
  } catch {
    copyFileSync(src, dest)
    unlinkSync(src)
  }
}

function errMsg(e: unknown): string {
  return String((e as Error).message ?? e)
}

export interface BulkFail {
  id: number
  name: string
  error: string
}

/** 批量移动到库内目标文件夹：物理文件 + 索引同步（rel_path / folder_id / name 一起改） */
export function moveAssets(ids: number[], folderId: number): { moved: number; failed: BulkFail[] } {
  const { db, path: libPath } = requireCurrent()
  const failed: BulkFail[] = []
  if (!ids.length) return { moved: 0, failed }

  const folder = db.prepare('SELECT id, path FROM folders WHERE id=?').get(folderId) as
    | { id: number; path: string }
    | undefined
  if (!folder) throw new Error('ERR_FOLDER_NOT_FOUND')
  const destDir = join(libPath, ...folder.path.split('/'))
  mkdirSync(destDir, { recursive: true })

  const ph = ids.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT id, name, rel_path FROM assets WHERE id IN (${ph})`)
    .all(...ids) as Array<{ id: number; name: string; rel_path: string }>
  const upd = db.prepare('UPDATE assets SET folder_id=?, rel_path=?, name=? WHERE id=?')

  let moved = 0
  db.exec('BEGIN')
  try {
    for (const row of rows) {
      try {
        const src = join(libPath, ...row.rel_path.split('/'))
        const targetRel = toRel(folder.path, row.name)
        if (row.rel_path === targetRel && existsSync(src)) {
          // 已在目标文件夹，无需搬动
          moved++
          continue
        }
        if (!existsSync(src)) {
          failed.push({ id: row.id, name: row.name, error: '源文件不存在' })
          continue
        }
        const name = uniqueName(destDir, row.name)
        const dest = join(destDir, name)
        moveFile(src, dest)
        upd.run(folder.id, toRel(folder.path, name), name, row.id)
        moved++
      } catch (e) {
        failed.push({ id: row.id, name: row.name, error: String((e as Error).message ?? e) })
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return { moved, failed }
}

/**
 * 批量删除素材：**直接真删除**，不经过任何回收站。
 *
 * 设计取舍：库里不设 `.trash`。理由（历史记录）——Windows 上 shell.trashItem
 * 在本机表现为首次调用必然失败（"Operation was aborted"），且失败的同时文件已经
 * 被真正删掉了，既不可靠也说不清文件到底去了哪。与其维护一个「半可靠」的中间态，
 * 不如把语义做干净：删除 = 从磁盘抹掉，不可恢复。
 * 因此 UI 侧必须保留二次确认（右键菜单与底部悬浮条共用同一个确认弹窗）。
 *
 * 索引行与缩略图缓存一并清理（同 hash 仍被其他素材引用时保留缓存）。
 * 文件删失败则不动索引，避免出现「有记录没文件」的幽灵条目。
 *
 * 素材行删掉后 asset_tags 靠外键 CASCADE 一起消失，挂在它们上的标签可能归零，
 * 所以最后要 `pruneUnlinkedTags`（返回值里的 `pruned` 供 UI 提示）。
 */
export function deleteAssets(ids: number[]): {
  deleted: number
  failed: BulkFail[]
  pruned: Array<{ id: number; name: string }>
} {
  const { db, path: libPath } = requireCurrent()
  const failed: BulkFail[] = []
  if (!ids.length) return { deleted: 0, failed, pruned: [] }

  const ph = ids.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT id, name, rel_path, content_hash FROM assets WHERE id IN (${ph})`)
    .all(...ids) as Array<{ id: number; name: string; rel_path: string; content_hash: string | null }>
  const del = db.prepare('DELETE FROM assets WHERE id=?')
  const stillUsed = db.prepare('SELECT count(*) AS c FROM assets WHERE content_hash=?')

  // 空标签清理的候选集：待删素材当前挂着的标签。**必须在 DELETE 之前取**，
  // 删完 asset_tags 靠 CASCADE 一起消失，事后无从知道该检查哪些标签
  const affectedTagIds = (
    db.prepare(`SELECT DISTINCT tag_id FROM asset_tags WHERE asset_id IN (${ph})`).all(...ids) as Array<{
      tag_id: number
    }>
  ).map((r) => r.tag_id)

  let deleted = 0
  for (const row of rows) {
    const file = join(libPath, ...row.rel_path.split('/'))

    if (existsSync(file)) {
      try {
        unlinkSync(file)
      } catch (e) {
        // 文件没删掉就不动索引，避免出现「有记录没文件」的幽灵条目
        failed.push({ id: row.id, name: row.name, error: `删除文件失败：${errMsg(e)}` })
        continue
      }
    }

    try {
      del.run(row.id)
    } catch (e) {
      failed.push({ id: row.id, name: row.name, error: `索引删除失败：${errMsg(e)}` })
      continue
    }

    // 缩略图缓存：hash 校验通过（同时防目录穿越）且无其他素材引用时才删
    const hash = row.content_hash
    if (hash && /^[0-9a-f]{20}$/.test(hash)) {
      const used = (stillUsed.get(hash) as { c: number }).c
      if (!used) {
        try {
          rmSync(join(libPath, '.thumbs', hash), { recursive: true, force: true })
        } catch {
          /* 缓存清理失败不影响删除结果 */
        }
      }
    }
    deleted++
  }
  return { deleted, failed, pruned: pruneUnlinkedTags(db, affectedTagIds) }
}

/**
 * 重写某素材的标签集合（「从这张素材上摘标签」也走这里）。
 *
 * 摘掉的标签若变成「全网零素材」，会在事务提交后被自动删除 ——
 * 见 `pruneUnlinkedTags` 的注释（侧栏留着一个计数 0 的标签会被当成 bug）。
 * 返回 `pruned` 供 UI 提示；调用方若正按被删标签筛选，需要自己把筛选清掉。
 */
export function setTags(assetId: number, tagIds: number[]): { pruned: Array<{ id: number; name: string }> } {
  const { db } = requireCurrent()
  // 清理候选 = 这张素材原本挂着的标签里、本次没被保留的那些。
  // 刻意**只检查这些**：新建但还没挂上任何素材的标签也是「空」的，
  // 若无脑全表扫空标签，会把用户刚建好、紧接着就要挂上去的标签当场删掉
  // （然后 INSERT 关联就会 `FOREIGN KEY constraint failed`）。
  const before = (
    db.prepare('SELECT tag_id FROM asset_tags WHERE asset_id=?').all(assetId) as Array<{ tag_id: number }>
  ).map((r) => r.tag_id)
  const unlinked = before.filter((id) => !tagIds.includes(id))

  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM asset_tags WHERE asset_id=?').run(assetId)
    const ins = db.prepare('INSERT OR IGNORE INTO asset_tags(asset_id, tag_id) VALUES(?,?)')
    for (const tid of tagIds) ins.run(assetId, tid)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  // 放在 COMMIT 之后：清理读的是已提交状态，语义清楚，也不会让清理失败倒灌回关联写入
  return { pruned: pruneUnlinkedTags(db, unlinked) }
}

export function listTags(): unknown[] {
  const { db } = requireCurrent()
  return db.prepare('SELECT id, name, color FROM tags ORDER BY name').all()
}

export function createTag({ name, color }: { name: string; color?: string }): { id: number } {
  const { db } = requireCurrent()
  const r = db.prepare('INSERT INTO tags(name,color) VALUES(?,?)').run(name, color ?? '#7FA8D9')
  return { id: Number(r.lastInsertRowid) }
}

/**
 * 彻底删除标签本身（不是「从某个素材上摘掉」——那个走 `setTags`）。
 * `asset_tags` 的关联靠外键 `ON DELETE CASCADE` 自动清空，前提是 `db.ts` 里的
 * `PRAGMA foreign_keys = ON` 生效：SQLite 的外键约束**默认是关的**，被关掉时
 * 这里会留下一堆指向已删除 tag_id 的孤儿关联（表现为侧栏计数为 0 但素材详情里还挂着空标签）。
 * 返回被解绑的素材数，供 UI 提示。
 */
export function deleteTag(id: number): { unlinked: number } {
  const { db } = requireCurrent()
  const unlinked = (db.prepare('SELECT count(*) AS c FROM asset_tags WHERE tag_id=?').get(id) as { c: number }).c
  const r = db.prepare('DELETE FROM tags WHERE id=?').run(id)
  if (r.changes === 0) throw new Error('ERR_TAG_NOT_FOUND')
  return { unlinked }
}

/** 侧栏计数：总数 + 按文件夹直挂数 + 按标签数（子树聚合由渲染层按路径前缀计算） */
export function counts(): { total: number; byFolder: Record<string, number>; byTag: Record<string, number> } {
  const { db } = requireCurrent()
  const total = (db.prepare('SELECT count(*) AS c FROM assets WHERE missing=0').get() as { c: number }).c
  const byFolder: Record<string, number> = {}
  for (const r of db.prepare('SELECT folder_id AS f, count(*) AS c FROM assets WHERE missing=0 GROUP BY folder_id').all() as Array<{ f: number; c: number }>) {
    byFolder[String(r.f)] = r.c
  }
  const byTag: Record<string, number> = {}
  for (const r of db.prepare('SELECT tag_id AS t, count(*) AS c FROM asset_tags GROUP BY tag_id').all() as Array<{ t: number; c: number }>) {
    byTag[String(r.t)] = r.c
  }
  return { total, byFolder, byTag }
}
