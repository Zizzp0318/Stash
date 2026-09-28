import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync } from 'fs'
import { extname, isAbsolute, join, relative } from 'path'
import { shell } from 'electron'
import { requireCurrent, mkdirRel, pruneUnlinkedTags } from './library'
import { importFiles } from './importer'
import { uniqueName } from './naming'
import type { DB } from './db'

/** 拼接库内相对路径（统一用 / 分隔） */
function toRel(...segs: string[]): string {
  return segs.filter(Boolean).join('/')
}

export interface AssetQuery {
  folderId?: number | null
  /**
   * 连同整棵子树一起匹配（只在 `folderId` 非空时有意义）。
   *
   * 默认 `false` = 只匹配该文件夹的**直属**素材，保留给需要精确口径的调用方；
   * 侧栏点文件夹走 `true` —— 素材管理场景里「点进一个分类要看全部内容」才是直觉，
   * 子文件夹是分组手段而不是隔离手段。
   */
  folderDeep?: boolean
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

/**
 * 某文件夹及其整棵子树的文件夹 id（含自身）。
 *
 * 用内存里的 path 前缀比较，不用 SQL `LIKE` —— 文件夹名里含 `_` / `%` 时 LIKE 会误匹配
 * （`报告_2024` 会连上 `报告X2024`）。与 `library.subtreeRows` 同一套判断，别各写一份。
 * 找得到根就用子树；根不在 folders 表里（理论不该发生）退化成「只看自身」，
 * 至少不会因为一个悬空 id 把整张表的素材都捞出来。
 */
function subtreeIds(db: DB, rootId: number): number[] {
  const all = db.prepare('SELECT id, path FROM folders').all() as Array<{ id: number; path: string }>
  const root = all.find((f) => f.id === rootId)
  if (!root) return [rootId]
  const prefix = root.path + '/'
  return all.filter((f) => f.path === root.path || f.path.startsWith(prefix)).map((f) => f.id)
}

export function listAssets(q: AssetQuery): { total: number; items: unknown[] } {
  const { db } = requireCurrent()

  const where: string[] = []
  const params: Array<string | number> = []

  if (q.folderId != null) {
    if (q.folderDeep) {
      const ids = subtreeIds(db, q.folderId)
      where.push(`a.folder_id IN (${ids.map(() => '?').join(',')})`)
      params.push(...ids)
    } else {
      where.push('a.folder_id = ?')
      params.push(q.folderId)
    }
  }
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

export function updateAsset(id: number, patch: { rating?: number; isFav?: boolean; note?: string }): void {
  const { db } = requireCurrent()
  if (patch.rating != null) {
    const r = Math.max(0, Math.min(5, Math.round(patch.rating)))
    db.prepare('UPDATE assets SET rating=? WHERE id=?').run(r, id)
  }
  if (patch.isFav != null) {
    db.prepare('UPDATE assets SET is_fav=? WHERE id=?').run(patch.isFav ? 1 : 0, id)
  }
  if (patch.note != null) {
    // 提示词/备注：空串统一存 NULL，避免「有内容但全是空白」和「真的没有」两种状态混在一起
    const v = patch.note.trim()
    db.prepare('UPDATE assets SET note=? WHERE id=?').run(v ? patch.note : null, id)
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

/** 目标目录内重名时追加 (n)。实现见 `naming.ts`（四条路径共用，别在这里另写一份） */
export { uniqueName } from './naming'

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

const BAD_FILE_CHARS = /[\\/:*?"<>|]/
/** Windows 保留设备名当文件名同样会翻车（`CON.png` 这类一并拦掉） */
const RESERVED_FILE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/**
 * 校验素材文件名。比文件夹名宽松一点（允许中间的点），但四类必须拦：
 * 空、`. / ..`、非法字符与保留设备名、以点或空格结尾（Windows 会静默裁掉）。
 * 路径分隔符也在非法字符里，防止用重命名把文件「搬」到别的目录。
 */
function validateAssetName(raw: string): string {
  const name = (raw ?? '').trim()
  if (!name) throw new Error('ERR_EMPTY_NAME')
  if (name === '.' || name === '..') throw new Error('ERR_INVALID_NAME')
  if (BAD_FILE_CHARS.test(name)) throw new Error('ERR_INVALID_NAME')
  if (RESERVED_FILE_NAMES.test(name)) throw new Error('ERR_INVALID_NAME')
  if (/[. ]$/.test(name)) throw new Error('ERR_INVALID_NAME')
  return name
}

/** `renameAsset` 的结果；`renamedFrom` 非空表示「想要的名字被占了，自动换了一个」 */
export interface RenameResult {
  id: number
  name: string
  rel_path: string
  /** 被占用而放弃的原始目标名（供 UI 说明），没发生冲突时为 null */
  renamedFrom: string | null
}

/**
 * 重命名素材文件名：物理文件先改名，成功后再改索引（name / rel_path）；
 * 索引写失败就把物理文件名改回去，避免磁盘与索引不一致（与 `library.renameFolder` 同一套顺序）。
 *
 * **扩展名不允许修改**：文件内容没变，改扩展名只会让 type / 缩略图管线 / 预览全部对不上，
 * 所以在服务层直接拒绝（`ERR_EXT_CHANGED`），由 UI 提示用户。
 *
 * **目标名被占用了不报错，自动换一个不冲突的名字**（`uniqueName` 追加 ` (n)`）。
 * 用户的诉求是「重名了就给素材改个名」，而不是「重名了就不许改」——
 * 报错拒绝对用户来说等于白打一遍字。被换掉的原名通过 `renamedFrom` 回传，让 UI 能说明清楚。
 * 与导入 / 移动 / 复制走同一个 `uniqueName`，所以命名规则（`名字 (1).png`）处处一致。
 */
export function renameAsset(id: number, rawName: string): RenameResult {
  const { db, path: libPath } = requireCurrent()
  const row = db.prepare('SELECT id, name, rel_path FROM assets WHERE id=?').get(id) as
    | { id: number; name: string; rel_path: string }
    | undefined
  if (!row) throw new Error('ERR_ASSET_NOT_FOUND')

  const wanted = validateAssetName(rawName)
  // 名字完全没变 → 什么都不做（连一次多余的磁盘操作都不做）
  if (wanted === row.name) return { id, name: row.name, rel_path: row.rel_path, renamedFrom: null }

  const oldExt = extname(row.name).slice(1).toLowerCase()
  const newExt = extname(wanted).slice(1).toLowerCase()
  if (newExt !== oldExt) throw new Error('ERR_EXT_CHANGED')

  const dirRel = row.rel_path.includes('/') ? row.rel_path.slice(0, row.rel_path.lastIndexOf('/')) : ''
  const dirAbs = dirRel ? join(libPath, ...dirRel.split('/')) : libPath
  const oldAbs = join(libPath, ...row.rel_path.split('/'))
  if (!existsSync(oldAbs)) throw new Error('ERR_ASSET_MISSING')

  // 目标名被占用 → 自动换名。仅大小写变化（a.png → A.png）在 Windows 上是同一个文件，
  // existsSync(新名) 恒真，属于合法改名，必须放行。
  let name = wanted
  let renamedFrom: string | null = null
  const wantedAbs = join(dirAbs, wanted)
  if (wantedAbs.toLowerCase() !== oldAbs.toLowerCase()) {
    // 除了磁盘，还要把索引算进来：`rel_path` 有 UNIQUE 约束，
    // 「记录还在、文件已被外部删掉」的 missing 行在磁盘上完全看不出来（见 naming.ts）
    const relTaken = (n: string): boolean =>
      !!db.prepare('SELECT id FROM assets WHERE LOWER(rel_path)=LOWER(?) AND id<>?').get(toRel(dirRel, n), id)
    const final = uniqueName(dirAbs, wanted, relTaken)
    if (final !== wanted) {
      name = final
      renamedFrom = wanted
    }
  }

  const newAbs = join(dirAbs, name)
  renameSync(oldAbs, newAbs)
  const newRel = toRel(dirRel, name)
  try {
    db.prepare('UPDATE assets SET name=?, rel_path=? WHERE id=?').run(name, newRel, id)
  } catch (e) {
    try {
      renameSync(newAbs, oldAbs)
    } catch {
      /* 回滚物理也失败，只能把错误抛出去 */
    }
    throw e
  }
  return { id, name, rel_path: newRel, renamedFrom }
}

/** 批量移动到库内目标文件夹：物理文件 + 索引同步（rel_path / folder_id / name 一起改） */
export function moveAssets(ids: number[], folderId: number): { moved: number; renamed: number; failed: BulkFail[] } {
  const { db, path: libPath } = requireCurrent()
  const failed: BulkFail[] = []
  if (!ids.length) return { moved: 0, renamed: 0, failed }

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
  let renamed = 0
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
        if (name !== row.name) renamed++
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
  return { moved, renamed, failed }
}

/** 库内复制时要一起带过去的列（内容属性 + 用户标注），别漏 —— 漏了 note 就会出现「副本没有备注」 */
const COPY_COLS = [
  'type', 'ext', 'size', 'width', 'height', 'duration_ms', 'content_hash',
  'rating', 'is_fav', 'palette', 'exif', 'note'
] as const

/**
 * 库内复制：在目标文件夹生成一份**独立副本**（文件真拷一份，索引行新建）。
 *
 * 与 `moveAssets` 的区别只在「源留不留」，所以重名处理、目标兜底、事务粒度都对齐：
 * - 目标文件夹没指定时落到「未分类」（与导入的兜底一致，避免用户在没有文件夹的库里粘贴失败）；
 * - 重名自动加 ` (n)`（复用 `uniqueName`）；
 * - **评分 / 喜欢 / 备注 / 标签一并带过去** —— 副本是「同一个素材的另一个拷贝」，
 *   只拷文件不拷标注会让人以为标注丢了。缩略图按 `content_hash` 命名，天然共享缓存。
 */
export function copyAssets(
  ids: number[],
  folderId?: number | null
): { copied: number; renamed: number; failed: BulkFail[] } {
  const { db, path: libPath } = requireCurrent()
  const failed: BulkFail[] = []
  if (!ids.length) return { copied: 0, renamed: 0, failed }

  let target: { id: number; path: string }
  if (folderId != null) {
    const f = db.prepare('SELECT id, path FROM folders WHERE id=?').get(folderId) as
      | { id: number; path: string }
      | undefined
    if (!f) throw new Error('ERR_FOLDER_NOT_FOUND')
    target = f
  } else {
    target = mkdirRel('未分类')
  }
  const destDir = join(libPath, ...target.path.split('/'))
  mkdirSync(destDir, { recursive: true })

  const ph = ids.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT id, name, rel_path, ${COPY_COLS.join(', ')} FROM assets WHERE id IN (${ph})`)
    .all(...ids) as Array<Record<string, unknown> & { id: number; name: string; rel_path: string }>

  const ins = db.prepare(
    `INSERT INTO assets(folder_id,name,rel_path,source_path,${COPY_COLS.join(',')},file_mtime,imported_at,missing)
     VALUES(?,?,?,?,${COPY_COLS.map(() => '?').join(',')},?,?,0)`
  )
  const tagOf = db.prepare('SELECT tag_id FROM asset_tags WHERE asset_id=?')
  const insTag = db.prepare('INSERT OR IGNORE INTO asset_tags(asset_id,tag_id) VALUES(?,?)')

  let copied = 0
  let renamed = 0
  db.exec('BEGIN')
  try {
    for (const row of rows) {
      try {
        const src = join(libPath, ...row.rel_path.split('/'))
        if (!existsSync(src)) {
          failed.push({ id: row.id, name: row.name, error: '源文件不存在' })
          continue
        }
        const name = uniqueName(destDir, row.name)
        if (name !== row.name) renamed++
        const dest = join(destDir, name)
        copyFileSync(src, dest)
        const r = ins.run(
          target.id,
          name,
          toRel(target.path, name),
          src,
          ...COPY_COLS.map((c) => row[c] as never),
          Math.floor(statSync(dest).mtimeMs),
          Date.now()
        )
        const newId = Number(r.lastInsertRowid)
        for (const t of tagOf.all(row.id) as Array<{ tag_id: number }>) insTag.run(newId, t.tag_id)
        copied++
      } catch (e) {
        failed.push({ id: row.id, name: row.name, error: errMsg(e) })
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return { copied, renamed, failed }
}

/**
 * 粘贴一批路径到目标文件夹，**按来源分流**：
 *  - 路径落在**库内**（且能在 `assets` 里对上号）→ `copyAssets` 生成保留标注的副本；
 *  - 库**外**的路径 → 走 `importFiles` 导入管线（内容查重、进度事件全都复用）。
 *
 * 这个分流是「Ctrl+C 一张图 → 切到 Stash → Ctrl+V」体验的关键：
 * 用户在库内复制粘贴，期望得到的是**带评分/标签/备注的副本**，
 * 而不是一条「内容重复被跳过」的提示。
 */
export function pastePaths(
  paths: string[],
  folderId?: number | null
): { copied: number; renamed: number; failed: BulkFail[]; importing: number } {
  const { db, path: libPath } = requireCurrent()
  const ids: number[] = []
  const outside: string[] = []
  const findRel = db.prepare('SELECT id FROM assets WHERE LOWER(rel_path)=LOWER(?)')

  for (const p of paths) {
    const rel = relative(libPath, p).replace(/\\/g, '/')
    // 库外路径：relative 返回 `..\xxx`（同盘）或直接回绝对路径（跨盘），两种都要挡住
    const inLib = !!rel && !rel.startsWith('..') && !isAbsolute(rel)
    const row = inLib ? (findRel.get(rel) as { id: number } | undefined) : undefined
    if (row) ids.push(row.id)
    else outside.push(p)
  }

  const res = ids.length ? copyAssets(ids, folderId) : { copied: 0, renamed: 0, failed: [] as BulkFail[] }
  if (outside.length) importFiles({ paths: outside, folderId, mode: 'copy' })
  return { copied: res.copied, renamed: res.renamed, failed: res.failed, importing: outside.length }
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
 * 重命名标签本体（不是「从某个素材上摘掉」——那个走 `setTags`）。
 * 纯改文本，素材关联不受影响（关联挂在 id 上，与名字无关）。
 * `tags.name` 有 UNIQUE 约束，重名提前报 `ERR_TAG_EXISTS` 比让 SQLite 抛约束错好读。
 */
export function renameTag(id: number, rawName: string): { id: number; name: string } {
  const { db } = requireCurrent()
  const name = (rawName ?? '').trim()
  if (!name) throw new Error('ERR_EMPTY_NAME')
  const cur = db.prepare('SELECT id, name FROM tags WHERE id=?').get(id) as { id: number; name: string } | undefined
  if (!cur) throw new Error('ERR_TAG_NOT_FOUND')
  if (cur.name === name) return { id, name }
  if (db.prepare('SELECT id FROM tags WHERE name=?').get(name)) throw new Error('ERR_TAG_EXISTS')
  db.prepare('UPDATE tags SET name=? WHERE id=?').run(name, id)
  return { id, name }
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

/**
 * 取素材在库内的绝对路径，并确认它确实存在（两个 shell 动作共用）。
 * 注意：这里**不查 missing 列**，直接看磁盘 —— 索引可能滞后于现实。
 */
function assetAbsPath(id: number): string {
  const { db, path: libPath } = requireCurrent()
  const row = db.prepare('SELECT rel_path FROM assets WHERE id=?').get(id) as { rel_path: string } | undefined
  if (!row) throw new Error('ERR_ASSET_NOT_FOUND')
  const abs = join(libPath, ...row.rel_path.split('/'))
  if (!existsSync(abs)) throw new Error('ERR_ASSET_MISSING')
  return abs
}

/**
 * 用系统默认程序打开素材。
 * 这是「Chromium 真解不了」时的兜底出口（例如 avi 里塞了 mpeg4 之外的怪编码），
 * 也可能是用户单纯想用外部工具看。
 *
 * ⚠️ Electron 44 的 `shell.openPath` 返回的是 **Promise<string>**（空串 = 成功，
 * 非空 = 错误描述），不是旧版本的同步字符串 —— 所以这里必须是 async。
 */
export async function openAsset(id: number): Promise<{ opened: boolean; error?: string }> {
  const err = await shell.openPath(assetAbsPath(id))
  return err ? { opened: false, error: err } : { opened: true }
}

/** 在资源管理器里定位该素材（`explorer /select` 语义，由 Electron 的 showItemInFolder 提供） */
export function revealAsset(id: number): { revealed: boolean } {
  shell.showItemInFolder(assetAbsPath(id))
  return { revealed: true }
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
