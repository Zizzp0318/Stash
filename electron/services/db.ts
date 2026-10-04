// 数据库连接管理 + schema 初始化
// 驱动：node:sqlite（Electron ≥36 内置，无需 native 编译）
import type { DatabaseSync } from 'node:sqlite'
import { derivedAdditiveColumns } from './derived'

export type DB = DatabaseSync

/**
 * 转义 SQL `LIKE` 的通配符（`\` `%` `_`），配合 `ESCAPE '\'` 使用。
 *
 * 为什么必须有：路径/名字里含 `_` 或 `%` 时（`报告_2024`、`100%.png`），`_` 匹配任意单字符、
 * `%` 匹配任意串 → 前缀查询会**误匹配别的路径**。真实后果：删掉 `报告_2024/` 会把
 * `报告X2024/` 下的素材也标成 missing。搜索（`assets.ts`）与目录删除（`watcher.ts`）都用它。
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/**
 * 当前库 schema 版本号（**单一真相源**）。
 *
 * 库是一个可被任意版本软件打开的普通目录，索引 `.stash` 里必须能回答两个问题：
 *   ① 这个库是哪一版建的？（决定要不要做迁移）
 *   ② 这个库是不是比我更新的版本建的？（决定要不要拒绝打开）
 * 本常量就是这两个问题的答案基准，写在 `meta.schema_version`（TEXT）里。
 *
 * ⚠️ 每次做**破坏性**结构变更（重建表 / 改列类型或语义 / 加 NOT NULL 无默认值列 / 删列）
 * 或新增任何迁移步骤时，**必须 +1**，并在 `migrate()` 阶梯末尾追加一条 `if (from < N)` 步骤。
 */
export const SCHEMA_VERSION = 1

/** `meta.schema_version` 的键名（只有这一份，别再各写一份字面量） */
const SCHEMA_VERSION_KEY = 'schema_version'

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
  missing INTEGER DEFAULT 0,
  -- 生成参数（AI 出图的提示词/模型/采样器等，JSON）。见 services/genmeta.ts
  gen_meta TEXT,
  -- 已扫过的类别位标记：1=生成参数 2=AI 来源。用位而不是「有没有值」，
  -- 否则「本来就没元数据」的图会被无限重扫
  gen_state INTEGER DEFAULT 0,
  -- AI 来源标识（comfyui / a1111 / c2pa:openai / aigc-cn …），卡片角标与详情栏用
  ai_source TEXT
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
  // 建表（IF NOT EXISTS）之后才读版本：无论新库老库，`meta` 表此刻一定已存在
  const stored = readSchemaVersion(db)
  // 太新的库：**拒绝打开**。用户装回旧版本打开一个被新版本升级过的库时，
  // 旧版代码不认识新 schema，继续读写只会以「莫名报错 / 静默读出错误语义」收场，
  // 远不如明确告诉用户「请升级软件」。（错误码经 main.ts 的 wrap() 转成 {ok:false,error}）
  // ⚠️ 必须在任何「自愈/迁移」之前判断：绝不擅自改动一个自己看不懂的库。
  if (stored > SCHEMA_VERSION) {
    // 抛之前先关掉这个连接，别把一个拒绝打开的库留成句柄泄漏（Windows 上还会锁文件）
    try {
      db.close()
    } catch {
      /* ignore */
    }
    throw new Error('ERR_LIBRARY_TOO_NEW')
  }
  // ① 增量列自愈（**无条件、每次打开都跑**）：`SCHEMA` 全是 CREATE TABLE IF NOT EXISTS，
  //    表已存在时新增列不会自动补上，所以每列都显式检测 + ADD COLUMN。
  //    刻意做成无条件而非「只在版本号偏小时跑」—— 它是幂等的、只有 4 次 PRAGMA、极便宜，
  //    却能兜住「列被外部工具损坏 / 老版本残留」这类版本号看不出来的状态
  //    （`--smoke-edit` 的 S7 就是「删掉 note 列再开库，必须自动补回」这条契约）。
  ensureAdditiveColumns(db)
  // ② 版本阶梯迁移（**只在版本号偏小时跑**）：留给 ADD COLUMN 表达不了的破坏性变更。
  //    成功后把版本号回写到当前值；stored === 当前 → 什么都不写（正常路径）。
  if (stored < SCHEMA_VERSION) {
    migrate(db, stored)
    writeSchemaVersion(db)
  }
  return db
}

/**
 * 读库里的 schema 版本号。
 *
 * ⚠️ **读不到 / 不是合法整数 → 一律当 `0`（最老的库）**，绝不能当「太新」：
 * 存量库都是 v0.1.x 建的，若哪天版本键缺失或被手改坏，把老库误判成「太新」会让
 * 用户彻底打不开自己的库 —— 那是灾难。宁可当最老、多跑一次幂等迁移。
 */
function readSchemaVersion(db: DB): number {
  const row = db.prepare(`SELECT value FROM meta WHERE key='${SCHEMA_VERSION_KEY}'`).get() as
    | { value: string }
    | undefined
  const raw = row?.value
  // 只认纯十进制整数；`parseInt('1abc')` 会得到 1，太宽松，直接正则挡掉
  if (raw != null && /^\d+$/.test(String(raw))) return Number(raw)
  return 0
}

/** 把当前版本号回写进 `meta`（TEXT 列，所以 `String()`）。 */
function writeSchemaVersion(db: DB): void {
  db.prepare(`INSERT OR REPLACE INTO meta(key,value) VALUES('${SCHEMA_VERSION_KEY}',?)`).run(
    String(SCHEMA_VERSION)
  )
}

/**
 * 增量列自愈：把「历史版本新增过的可空列」补齐（幂等、每次打开都跑）。
 * 与版本号无关 —— 见 openDatabase 里的说明：它兜的是版本号看不出来的列级损坏。
 */
function ensureAdditiveColumns(db: DB): void {
  // 列清单由**派生字段注册表**派生（审计 §2.17）：新增派生字段只需改 `derived.ts`，
  // 别再手写这一串（漏一处就是「缓存命中的素材永远补不上字段」那类 B2 复发型 bug）。
  for (const { col, decl } of derivedAdditiveColumns()) ensureColumn(db, 'assets', col, decl)
}

/**
 * 老库版本阶梯迁移。
 *
 * 形状约定（**未来加 v2 时一眼知道往哪写**）：
 *   每条迁移 = 一个版本号的增量步骤，条件一律写成 `if (from < N)`，
 *   从上到下按 N 递增排列，**新步骤追加在阶梯末尾**。
 *   `from` 是打开时读到的版本号（缺失/非法时按 0）。老库会依次跑过所有 `from < N` 的步骤，
 *   升到 `SCHEMA_VERSION`。
 *
 * ⚠️ **绝不修改已有步骤**：老库是按「从 from 逐级升上来」解释的，改动历史步骤会让
 * 已经升过级的库与刚开始升级的库产生分叉。要改行为就 +1 版本、加新步骤。
 *
 * v1 没有阶梯步骤：它相对 v0 的唯一变更就是「加 4 个可空列」，已由上面的
 * `ensureAdditiveColumns()`（无条件自愈）覆盖，这里不再重复。
 * **破坏性迁移（重建表 / 改列类型或语义 / 加 NOT NULL 无默认值列 / 删列）从 v2 起在这里追加**，
 * 同时把 SCHEMA_VERSION 改成对应的 N。
 */
function migrate(_db: DB, _from: number): void {
  // —— 未来加 v2：在**这里往下**追加，并同步把 SCHEMA_VERSION 改成 2 ——
  // if (_from < 2) { ... 例如重建表 / 加 NOT NULL 列 ... }
}

function tableColumns(db: DB, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name)
}

function ensureColumn(db: DB, table: string, column: string, decl: string): void {
  if (tableColumns(db, table).includes(column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
}
