// 时间/大小格式化
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * 时长：1 小时以内 `mm:ss`，满 1 小时进位成 `h:mm:ss`。
 *
 * ⚠️ 进位这条不能省：以前 90 分钟会显示成 `90:00`，而播放条（`PreviewPlayerBar` 的 `fmt`）
 * 同一份数据显示 `1:30:00` —— 两套口径并存，用户会以为时长算错了。
 * 卡片的「尺寸」列、列表行、详情栏都读这里（`dimsOnly`）。
 * 1 小时以内保持**零填充**的 `mm:ss`（与历史显示一致，不因为这条修复改变既有观感）。
 */
export function fmtDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return ''
  const total = Math.round(ms / 1000)
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`
}

export function fmtDate(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return `今天 ${hm}`
  const yest = new Date(now.getTime() - 86400000)
  if (d.toDateString() === yest.toDateString()) return `昨天 ${hm}`
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`
}

export function fmtCount(n: number): string {
  return n.toLocaleString('en-US').replace(/,/g, ' ')
}

/**
 * 库相关后端错误码 → 人话。
 *
 * 为什么单独抽出来：库的两个入口（欢迎页 Welcome、标题栏 TitleBar）各有「打开」与
 * 「新建」两条报错路径，原先各写一份 `e === 'ERR_LIBRARY_EXISTS' ? ... : e` 的三元，
 * 加一个新错误码就要改 4 处、漏一处就是一个入口把裸错误码 `ERR_XXX` 甩给用户。
 * 集中在一处，两个入口共用。
 *
 * ⚠️ 找不到映射时**原样回传**错误码（不吞、不猜）—— 至少不比现状更差，
 * 也方便用户截图报障。文件夹/标签那套错误码有自己的表（见 SideBar 的 FOLDER_ERR），
 * 两者领域不同，不合并。
 */
const LIB_ERROR_TEXT: Record<string, string> = {
  ERR_LIBRARY_EXISTS: '该目录已存在同名库',
  ERR_LIBRARY_TOO_NEW: '此库由更新版本的 Stash 创建，请升级软件后再打开',
  ERR_NOT_A_LIBRARY: '该目录不是一个 Stash 库（缺少 .stash 索引）',
  ERR_NO_LIBRARY: '未打开任何库',
  ERR_INVALID_NAME: '名称含非法字符（\\ / : * ? " < > |）或为系统保留名'
}

export function libErrorText(code: string | undefined | null): string {
  return LIB_ERROR_TEXT[code ?? ''] ?? String(code ?? '未知错误')
}

/**
 * 导入结果里的一条失败记录（与 `importer.ts` 的 `ImportFailItem` 同构，主进程不 import 渲染层，
 * 故这里再声明一份结构类型；两处字段必须保持一致）。
 */
export interface ImportFailedItem {
  path: string
  error: string
  /** 该条代表一次「整批提交失败」，不是单个文件 */
  batch?: boolean
  /** `batch === true` 时：本次失败涉及的文件条数（整批） */
  count?: number
}

/**
 * 导入结果里的 `failed` 列表 → 给用户看的那一句话（纯函数，便于单测）。
 *
 * 存在的理由：`App.vue` 原先直接渲染 `${failed.length} 个文件导入失败（首个：name：err）`。
 * 而「整批提交失败」在 `failed` 里只**记 1 条**（`path` 是哨兵串、`count` 才是整批条数），
 * 于是用户会读到「**1** 个文件导入失败（…本批 **41** 个…）」——「1 个」把整批 41 个都没进索引
 * 严重低估成「某一个文件的问题」。这里按 `batch` 标记分两类措辞，逐文件失败保持原语义。
 *
 * - 无失败 → `null`（调用方据此走别的提示分支）。
 * - 批次失败 → 说清「N 批共 M 个文件已拷入库目录、但索引未写入」，**绝不出现「首个：」**。
 * - 逐文件失败 → 保留「N 个文件导入失败（首个：name：err）」，用户能对着文件名去查。
 * - 两类同时存在 → 用「；」连接，各说各的，互不吞并。
 */
/**
 * 导入链路的「整体失败」错误码 → 人话。
 *
 * 为什么需要：这里以前把 `error` 原样拼进提示，用户读到的是「导入失败：ERR_FOLDER_NOT_FOUND」
 * 这种裸码 —— 同项目里文件夹 / 素材 / 标签的错误都有人话映射（SideBar 的 `FOLDER_ERR`、
 * GalleryGrid 的 `ASSET_ERR`），唯独导入这条链路没有。
 * 只收「用户能据此动手」的几个；其余（含 SQLite 原始报错）原样透出，便于排查。
 */
const IMPORT_ERR_TEXT: Record<string, string> = {
  ERR_FOLDER_NOT_FOUND: '目标文件夹已不存在（可能被删除或移动过）',
  ERR_NO_LIBRARY: '当前没有打开的素材库',
  ERR_LIBRARY_TOO_NEW: '该库由更新版本的 Stash 创建，请先升级软件'
}

function importErrText(code: string): string {
  return IMPORT_ERR_TEXT[code] ?? code
}

export function importFailedText(failed: ImportFailedItem[]): string | null {
  if (!failed.length) return null

  const batchFails = failed.filter((f) => f.batch === true)
  const fileFails = failed.filter((f) => f.batch !== true)
  const parts: string[] = []

  if (batchFails.length) {
    // 批次数与文件总数都要如实给出：整批都没进索引，用户需要知道影响面有多大。
    const total = batchFails.reduce((s, f) => s + (f.count ?? 0), 0)
    const reason = importErrText(batchFails[0]?.error ?? '未知原因')
    parts.push(
      `${batchFails.length} 批共 ${total} 个文件已拷入库目录，但索引未写入（库里看不到它们，磁盘文件仍在）。` +
        `请重新导入本批。原因：${reason}`
    )
  }

  if (fileFails.length) {
    const first = fileFails[0]
    /*
     * `path === '*'` 是**整条管线在开始逐个处理文件之前**就抛错的哨兵（importer 的顶层 catch：
     * 目标文件夹被删、库在导入途中被关等）。这种情况下没有"首个文件"可言，
     * 写成「1 个文件导入失败（首个：*：…）」只会让人莫名其妙 —— 直接说整体失败与原因。
     */
    if (first.path === '*') {
      parts.push(`导入失败：${importErrText(first.error)}`)
    } else {
      const name = first.path.split(/[\\/]/).pop()
      parts.push(`${fileFails.length} 个文件导入失败（首个：${name}：${importErrText(first.error)}）`)
    }
  }

  return parts.join('；')
}
