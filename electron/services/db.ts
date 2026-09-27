// 数据库连接管理 + schema 初始化
// 驱动：node:sqlite（Electron ≥36 内置，无需 native 编译）
import type { DatabaseSync } from 'node:sqlite'

export type DB = DatabaseSync

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER,
  path TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY,
  folder_id INTEGER NOT NULL REFERENCES folders(id),
  name TEXT NOT NULL,
  rel_path TEXT UNIQUE NOT NULL,
  source_path TEXT,
  type TEXT NOT NULL,
  ext TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER, height INTEGER,
  duration_ms INTEGER,
  content_hash TEXT,
  rating INTEGER DEFAULT 0,
  is_fav INTEGER DEFAULT 0,
  palette TEXT,
  exif TEXT,
  note TEXT,
  file_mtime INTEGER NOT NULL,
  imported_at INTEGER NOT NULL,
  missing INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_assets_type   ON assets(type);
CREATE INDEX IF NOT EXISTS idx_assets_rating ON assets(rating);
CREATE INDEX IF NOT EXISTS idx_assets_folder ON assets(folder_id);
CREATE INDEX IF NOT EXISTS idx_assets_name   ON assets(name);
CREATE INDEX IF NOT EXISTS idx_assets_hash   ON assets(content_hash);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  color TEXT NOT NULL DEFAULT '#7FA8D9'
);

CREATE TABLE IF NOT EXISTS asset_tags (
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tags(id)   ON DELETE CASCADE,
  PRIMARY KEY (asset_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_asset_tags_tag ON asset_tags(tag_id);
`

export function openDatabase(stashFile: string): DB {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(stashFile) as DB
  db.exec('PRAGMA journal_mode = WAL')
  /**
   * 这里的外键声明其实**不是必需**的：`node:sqlite` 的 `DatabaseSync` 默认
   * `enableForeignKeyConstraints: true`（实测注释掉本行后 CASCADE 依然生效）。
   * 但显式写出来更保险 —— 一旦换回 `better-sqlite3` 或改了构造参数，
   * 外键会被静默关掉，删标签就会留下指向已删 tag_id 的孤儿关联
   * （侧栏计数为 0、素材详情却还挂着空标签）。`--smoke-tag` 里有孤儿断言盯着这件事。
   */
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  migrate(db)
  return db
}

/**
 * 老库增量迁移。
 *
 * `SCHEMA` 里全是 `CREATE TABLE IF NOT EXISTS`，表已存在时新增的列**不会**补上，
 * 所以每一列都要在这里显式检测 + `ALTER TABLE`（SQLite 支持 ADD COLUMN，
 * 对已有行填 NULL，不需要重建表）。新库走完 SCHEMA 就已经有列，这里会直接跳过。
 */
function migrate(db: DB): void {
  ensureColumn(db, 'assets', 'note', 'TEXT')
}

function tableColumns(db: DB, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name)
}

function ensureColumn(db: DB, table: string, column: string, decl: string): void {
  if (tableColumns(db, table).includes(column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
}
