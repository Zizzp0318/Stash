// 时间/大小格式化
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function fmtDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return ''
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
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
  ERR_NOT_REGISTERED: '该库不在最近列表中，无法直接删除',
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
export function importFailedText(failed: ImportFailedItem[]): string | null {
  if (!failed.length) return null

  const batchFails = failed.filter((f) => f.batch === true)
  const fileFails = failed.filter((f) => f.batch !== true)
  const parts: string[] = []

  if (batchFails.length) {
    // 批次数与文件总数都要如实给出：整批都没进索引，用户需要知道影响面有多大。
    const total = batchFails.reduce((s, f) => s + (f.count ?? 0), 0)
    const reason = batchFails[0]?.error ?? '未知原因'
    parts.push(
      `${batchFails.length} 批共 ${total} 个文件已拷入库目录，但索引未写入（库里看不到它们，磁盘文件仍在）。` +
        `请重新导入本批。原因：${reason}`
    )
  }

  if (fileFails.length) {
    const first = fileFails[0]
    const name = first.path.split(/[\\/]/).pop()
    parts.push(`${fileFails.length} 个文件导入失败（首个：${name}：${first.error}）`)
  }

  return parts.join('；')
}
