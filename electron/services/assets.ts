import { requireCurrent } from './library'

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
    where.push('(a.name LIKE ? OR a.id IN (SELECT at.asset_id FROM asset_tags at JOIN tags t ON t.id = at.tag_id WHERE t.name LIKE ?))')
    params.push(`%${q.keyword}%`, `%${q.keyword}%`)
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

export function setTags(assetId: number, tagIds: number[]): void {
  const { db } = requireCurrent()
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
