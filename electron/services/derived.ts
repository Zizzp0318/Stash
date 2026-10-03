/**
 * 「生成时回写」的派生字段**注册表**（审计 §2.17）。
 *
 * 为什么要有它：铁律 B2 被标注为**复发型 bug** —— 一个「生成缩略图/扫元数据时顺带算出来的
 * 索引字段」需要人工在好几处同步：① 建库 DDL ② `db.ts` 的补列自愈 ③ `assets.ts` 的
 * `COPY_COLS` ④ 写回函数 ⑤ **入队纳条件** ⑥ 插入列。历史事故正是漏了第 ⑤ 点：
 * 「缩略图已命中缓存、但 width/palette 仍为 NULL」的素材永远不会被重新入队 → 永远补不上，
 * 用户只能「清理缓存 + 重建」。
 *
 * 现在：**新增一个派生字段只需改本文件** —— `COPY_COLS`（`assets.ts`）、
 * `ensureAdditiveColumns`（`db.ts`）、缩略图队列的「欠账条件」（`thumbs.ts`）都从这里派生。
 * 另外 `--smoke-m2` 有一条**跨源不变量**盯着「注册表 ↔ 真实表结构 / 真实复制结果」，
 * 漂移会直接变红，而不是静默漏字段。
 *
 * ⚠️ 本文件**不 import 任何 service**（只描述数据），避免重演 `library ↔ watcher` 的 import 成环
 * （见 MEMORY.md I3）。
 */

/** 谁在生成时写它（仅作文档与断言锚点） */
export type DerivedProducer = 'thumb' | 'meta'
/** 受哪个导入设置控制（键名即 `settings.importing` 下的字段） */
export type DerivedSetting = 'palette' | 'extractMeta' | 'detectAi'

export interface DerivedField {
  /** DB 列名（`assets` 表） */
  col: string
  /** 谁在生成时写它 */
  producer: DerivedProducer
  /** 参与的素材类型（给人看的；缩略图欠账条件另有 `sink` 开关） */
  types: string[]
  /**
   * 「还没算过」的判据（SQL 片段）。`null` = **不能**靠「值为空」判断，另有机制：
   * `duration_ms` 由视频截帧顺带写；`gen_*` 靠 `gen_state` 位标记（「本来就没元数据」是常态，
   * 用「值为空」判断会无限重扫）。
   */
  pending: string | null
  /**
   * 是否参与**缩略图队列的欠账条件**（`ensureBatch(…, 'grid')` 据此决定要不要重新入队）。
   *
   * ⚠️ 判据是「**缓存命中时写回仍会发生**」。`ensureOne` 命中缓存会直接 `return`
   * （`thumbs.ts:43`），所以凡是标 `sink: true` 的字段，都必须在**入队完成后的写回分支**
   * 里有一条不依赖「本次真的生成了缩略图」的补写路径 —— 否则它只会白排队、不回写。
   * 图片：`writeIndexFields`（尺寸 + 色板）；视频：`writeVideoMetaIfPending`（时长 + 分辨率）。
   */
  sink: boolean
  /** 受哪个设置控制；`undefined` = 无开关 */
  setting?: DerivedSetting
  /** `db.ts` 的 `ADD COLUMN` 声明；`null` = 建库 DDL 里就有（老库也无需补列） */
  addColumn: string | null
}

/**
 * 全部派生字段（顺序即缩略图欠账条件里 `OR` 的拼接顺序，改顺序不影响语义）。
 *
 * `height` 与 `width` 由**同一条 UPDATE** 一起写，所以它没有独立的 `pending`
 * （「宽高只有都算出来/都不算出来」两种状态）。
 * `note` 是**用户字段**，`genmeta` 只在它为空时填入提示词 —— 绝不覆盖用户手写内容。
 */
export const DERIVED_FIELDS: DerivedField[] = [
  { col: 'width', producer: 'thumb', types: ['image'], pending: 'width IS NULL', sink: true, addColumn: null },
  { col: 'height', producer: 'thumb', types: ['image'], pending: null, sink: false, addColumn: null },
  {
    col: 'palette',
    producer: 'thumb',
    types: ['image'],
    pending: 'palette IS NULL',
    sink: true,
    setting: 'palette',
    addColumn: null
  },
  {
    col: 'duration_ms',
    producer: 'thumb',
    types: ['video'],
    pending: 'duration_ms IS NULL',
    sink: true,
    addColumn: null
  },
  {
    col: 'gen_meta',
    producer: 'meta',
    types: ['image'],
    pending: null,
    sink: false,
    setting: 'extractMeta',
    addColumn: 'TEXT'
  },
  {
    col: 'ai_source',
    producer: 'meta',
    types: ['image'],
    pending: null,
    sink: false,
    setting: 'detectAi',
    addColumn: 'TEXT'
  },
  { col: 'gen_state', producer: 'meta', types: ['image'], pending: null, sink: false, addColumn: 'INTEGER DEFAULT 0' },
  { col: 'note', producer: 'meta', types: ['image'], pending: null, sink: false, addColumn: 'TEXT' }
]

/** 全部派生字段的列名 —— 库内复制必须**一个不漏**地带走（`COPY_COLS` 由它派生） */
export function derivedCopyCols(): string[] {
  return DERIVED_FIELDS.map((f) => f.col)
}

/** 需要「给老库补列」的派生字段（`db.ts` 的 `ensureAdditiveColumns` 由它派生） */
export function derivedAdditiveColumns(): Array<{ col: string; decl: string }> {
  return DERIVED_FIELDS.filter((f) => f.addColumn !== null).map((f) => ({
    col: f.col,
    decl: f.addColumn as string
  }))
}

/**
 * 缩略图队列的「欠账条件」SQL（`thumbs.ts` 的 `indexFieldsSinkIds` 由它派生）。
 *
 * **按素材类型分组**：同一组内多个字段的 `pending` 用 `OR` 连，组间再用 `OR` 连，
 * 每组自带类型限定。于是：
 *   · 色板开 → `(type='image' AND (width IS NULL OR palette IS NULL)) OR (type='video' AND (duration_ms IS NULL))`
 *   · 色板关 → `(type='image' AND (width IS NULL))                    OR (type='video' AND (duration_ms IS NULL))`
 * 与旧实现（只查 `type='image'`）相比，图片语义**逐字未变**，新增的是视频那条欠账。
 *
 * 开关按 F4 的约定判「开」：`!== false`（未传 = 开）。
 */
export function thumbSinkWhere(enabled: Partial<Record<DerivedSetting, boolean>> = {}): string {
  const groups = new Map<string, string[]>()
  for (const f of DERIVED_FIELDS) {
    if (!f.sink || !f.pending) continue
    if (f.setting !== undefined && enabled[f.setting] === false) continue
    const key = f.types.join('|')
    const arr = groups.get(key)
    if (arr) arr.push(f.pending)
    else groups.set(key, [f.pending])
  }
  return [...groups.entries()]
    .map(([key, preds]) => {
      const types = key.split('|')
      // types 来自本文件的字面量、不含用户输入 → 拼接进 SQL 安全
      const typeCond =
        types.length === 1 ? `type='${types[0]}'` : `type IN (${types.map((t) => `'${t}'`).join(',')})`
      return `(${typeCond} AND (${preds.join(' OR ')}))`
    })
    .join(' OR ')
}
