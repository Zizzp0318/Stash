import { copyFileSync, readSync, closeSync, openSync, statSync, readdirSync } from 'fs'
import type { Dirent } from 'fs'
import { basename, extname, join } from 'path'
import { createHash } from 'crypto'
import { BrowserWindow } from 'electron'
import { requireCurrent, mkdirRel } from './library'
import { getSettings } from './config'
import { uniqueName } from './naming'
import { moveFileSync } from './fsutil'
import { toRel } from './paths'
import type { DB } from './db'

export type AssetType = 'image' | 'video' | 'audio' | 'text'

/**
 * 扩展名 → 素材类型。**这是素材类型判定的唯一真相源**（`watcher.ts` 也 import 它）。
 *
 * ⚠️ **HEIC / HEIF 不支持，别好心加回来**：这份预编译 sharp 的 libheif 不带 HEVC 编解码器 ——
 * 决定性证据是 `sharp(...).heif({ compression: 'hevc' })` 直接抛 `heifsave: Unsupported compression`
 * （辅助证据：`libvips-42.dll` 里查不到 `libde265` / `dav1d` 这两个 HEVC 解码器符号）。
 * 加回来只会导入成功、却永远出不了缩略图和预览 —— 空白卡片还不报错，比直接不认更糟。
 * 要支持得换自编译 libheif+HEVC 的 sharp，或接系统解码器（WIC）。
 *
 * ⚠️ **别拿扩展名列表当证据**：`sharp.format.heif.input.fileSuffix` 只有 `['.avif']`，
 * 但 sharp 解码按**魔数嗅探**，不看扩展名 —— 把一份 AVIF 改名成 `.heic` 照样读得出来
 * （`metadata().format` 仍是 `heif`）。所以「改名 .heic 也能解」不能证明支持 HEIC，
 * 只能证明那份文件本来就不是 HEIC。
 */
export const EXT_TYPE: Record<string, AssetType> = {
  jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image',
  bmp: 'image', tiff: 'image', tif: 'image', svg: 'image',
  mp4: 'video', mov: 'video', mkv: 'video', webm: 'video', avi: 'video',
  mp3: 'audio', wav: 'audio', flac: 'audio', aac: 'audio', ogg: 'audio', m4a: 'audio',
  txt: 'text', md: 'text'
}

/**
 * 内容哈希：size + 前 64KB 的 sha1 前 20 位（仅用于缓存命名与查重）。
 * **导出供 preview.ts 复用** —— 改了内容必须同步哈希，两侧算法绝不能分裂，
 * 否则派生缓存与缩略图会各认一套 key。
 */
export function contentHash(file: string): string {
  const st = statSync(file)
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(Math.min(65536, st.size))
    readSync(fd, buf, 0, buf.length, 0)
    return createHash('sha1').update(`${st.size}:`).update(buf).digest('hex').slice(0, 20)
  } finally {
    closeSync(fd)
  }
}

export interface ImportArgs {
  paths: string[]
  folderId?: number | null
  mode?: 'copy' | 'move'
  onProgress?: (p: { importId: number; done: number; total: number }) => void
  onDone?: (r: ImportResult) => void
}

/**
 * 一条导入失败记录。
 *
 * `batch` / `count` 是**批次提交失败**（整批）的机器可读标记 —— 渲染层（`importFailedText`）
 * 据此换用「整批」措辞，避免把「整批 N 个都没进索引」误渲染成「某一个文件失败」。
 * 逐文件失败不设这两个字段。
 */
export interface ImportFailItem {
  path: string
  error: string
  /** 该条代表一次「整批提交失败」，不是单个文件 */
  batch?: boolean
  /** `batch === true` 时：本次失败涉及的文件条数（整批） */
  count?: number
}

export interface ImportResult {
  importId: number
  added: number
  /** 因内容重复 / 扩展名不在 EXT_TYPE 被跳过的数量（两个成因共用这一个计数器） */
  skipped: number
  /** 因目标目录已有同名文件、被自动改成 `名字 (1).ext` 的数量 */
  renamed: number
  failed: ImportFailItem[]
  /**
   * **仅文件夹导入**会带：本次因此在 `folders` 表里新增的目录行数。
   * 可选 —— `importFiles` 的结果对象里**不会出现这个键**（逐字节保持旧形状）。
   */
  dirsCreated?: number
}

let importSeq = 0

/**
 * 一条待导入条目。
 *
 * `relDir` = 该文件在**目标文件夹内部**应有的子目录（`/` 分隔，`''` = 直接放进目标文件夹）。
 * 单个文件导入时它恒为 `''`；文件夹导入用它保留磁盘上的目录层级。
 */
export interface ImportEntry {
  src: string
  relDir: string
}

/** 一次扫描的产物 */
interface CollectResult {
  /** 真正会尝试导入的条目（**只含 EXT_TYPE 认得的文件**） */
  entries: ImportEntry[]
  /** 扫描阶段就已确定要计入 `skipped` 的条数（扩展名不受支持） */
  skipped: number
}

/** 解析后的目标目录（缓存值） */
interface TargetDir {
  /** `folders.id` */
  id: number
  /** 库内相对路径（`/` 分隔） */
  path: string
  /** 磁盘上的绝对目录 */
  dest: string
}

interface RunImportOptions {
  /**
   * 惰性取条目。
   *
   * 为什么不直接传 `entries`：文件夹扫描是**同步 fs IO**，上千个子目录在主进程里同步跑完
   * 会把窗口绘制一起卡住（IPC 处理是同步返回的）。放进下面的异步块里执行，
   * 扫描期间事件循环仍可继续派发。单文件导入这里只是一次 `map`，语义与原来完全一致。
   */
  collect: () => CollectResult
  folderId: number | null
  mode?: 'copy' | 'move'
  onProgress?: (p: { importId: number; done: number; total: number }) => void
  onDone?: (r: ImportResult) => void
}

/**
 * 导入管线的**唯一**实现：`importFiles`（选文件/拖文件）与 `importFolder`（选文件夹）
 * 都收敛到这里，区别只在 `collect()` 给出什么条目。
 *
 * ⚠️ **`importFiles` 的对外签名与可观测行为必须一字不变** —— 13 个冒烟文件直接 import 它。
 * 抽取时逐字保留了原来的顺序（stat → 扩展名 → 哈希/查重 → 命名 → 物理复制 → 入库 → 进度）、
 * 批提交区间（500 条）、以及「`skipped` 混装重复与不支持格式」的语义。
 */
function runImport(opts: RunImportOptions): { importId: number } {
  const { db, path: libPath } = requireCurrent()
  const importId = ++importSeq
  // 调用方没指定方式就按设置走（用时现读，不做模块级快照）
  const mode = opts.mode ?? getSettings().importing.mode
  // 按内容去重也归设置管：关掉之后重复文件照样导入，靠 uniqueName 改名避开覆盖
  const dedupe = getSettings().importing.dedupe

  // 异步执行，不阻塞 IPC 返回
  ;(async () => {
    // 条目（文件夹导入时含递归扫描）在异步块里取得，不卡 IPC 返回
    const { entries, skipped: preSkipped } = opts.collect()
    const total = entries.length

    // 目标文件夹（基准目录）：relDir === '' 的条目落在它里面
    let base: TargetDir
    if (opts.folderId != null) {
      const f = db.prepare('SELECT path FROM folders WHERE id=?').get(opts.folderId) as { path: string } | undefined
      if (!f) throw new Error('ERR_FOLDER_NOT_FOUND')
      base = { id: opts.folderId, path: f.path, dest: join(libPath, ...f.path.split('/')) }
    } else {
      // 未指定文件夹：导入到「未分类」（物理目录 + folders 表同步创建）
      const fallback = mkdirRel('未分类')
      base = { id: fallback.id, path: fallback.path, dest: join(libPath, ...fallback.path.split('/')) }
    }

    /**
     * `relDir` → 目标目录。**同一 relDir 只解析一次**：
     * 每个文件都走一遍 `mkdirRel`（多级 mkdir + 逐级查 folders 表）会让进度条明显卡顿。
     *
     * 用 `mkdirRel` 而不是新写一套建文件夹 API：它已经是「物理目录 + `ensureFolderRows`」
     * 的合并入口，且**幂等**（`folders` 里已有同 path 的行就复用该 id），
     * 所以导入到已有子目录不会炸、也不会产生重复文件夹。
     */
    const dirCache = new Map<string, TargetDir>([['', base]])
    const resolveDir = (relDir: string): TargetDir => {
      if (!relDir) return base
      const cached = dirCache.get(relDir)
      if (cached) return cached
      const folder = mkdirRel(toRel(base.path, relDir))
      const target: TargetDir = {
        id: folder.id,
        path: folder.path,
        dest: join(libPath, ...folder.path.split('/'))
      }
      dirCache.set(relDir, target)
      return target
    }

    const insStmt = db.prepare(
      `INSERT INTO assets(folder_id,name,rel_path,source_path,type,ext,size,content_hash,file_mtime,imported_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`
    )
    const dupStmt = db.prepare('SELECT id FROM assets WHERE content_hash=?')

    let done = 0, added = 0, skipped = preSkipped, renamed = 0
    const failed: ImportFailItem[] = []
    const BATCH = 500
    let inTx = false
    // 当前事务里「已 INSERT、尚未 COMMIT」的条数。用它（而不是 `added % BATCH`）来判断是否该成批提交：
    // COMMIT 失败时会从 `added` 里扣回本批条数，`added` 会回退。`added % BATCH` 在本实现下其实仍成立
    // （回滚恰好扣回一整批，`added` 仍停在 BATCH 的整数倍上，同余关系不破），但直接数 `batchInserts`
    // 与「每 BATCH 条提交一次」的意图一一对应、也不受 `added` 任何增减运算牵连，更不易在后续改动里被写错。
    let batchInserts = 0

    /**
     * 提交当前批次。**自己永不抛出** —— 这是本函数存在的全部意义。
     *
     * 为什么要这样：两处 COMMIT（批中间 / 收尾）任一处把异常抛出去都会坏事 ——
     *   · 批中间那处若抛出，会被外层「逐文件」的 catch 捕获、误记成「某个文件失败」，
     *     而 `added` 在这之前已经自增过 → 计数虚报；
     *   · 收尾那处若抛出，原本被空 catch 静默吞掉 → 文件已物理拷入库、索引却没落盘，
     *     用户却照常看到 `import:done` 的「导入成功」。
     *
     * 成功：COMMIT；`inTx=false`；`batchInserts` 归零。
     * 失败：尽力 ROLLBACK（本批 INSERT 随之作废）；`inTx=false`；从 `added` 里**扣回本批条数**
     *       （否则 `added` 反映了库里根本不存在的行）；`batchInserts` 归零；
     *       往 `failed` 追加一条**措辞诚实**的记录（见下）。
     */
    const commitBatch = (): void => {
      if (!inTx) return
      const n = batchInserts
      try {
        db.exec('COMMIT')
        inTx = false
        batchInserts = 0
      } catch (e) {
        // 回滚是「尽力而为」：即使回滚也失败，也无法再做更多，下面的记录如实反映「索引未写入」这个现实。
        try {
          db.exec('ROLLBACK')
        } catch {
          /* 回滚失败只能放任事务处于不确定态，但至少把失败如实上报给用户 */
        }
        inTx = false
        batchInserts = 0
        // 本批 INSERT 已随 ROLLBACK 全部作废 → 把之前误记的成功数扣回来，让 `added` 与库中实际行数一致。
        added -= n
        failed.push({
          // path 刻意**不含任何真实文件名**：它是「万一渲染层没认出 batch 标记」时的兜底，
          // 确保这条记录不会被当成某个真实文件去展示/重导。
          path: '（本批文件·索引未写入）',
          // error 只放**底层原因**（SQLite 的原始报错）。面向用户的那整句话由渲染层的
          // `importFailedText` 依据 batch/count 组装 —— 两处各写一遍会重复、且容易说得不一致。
          error: String((e as Error).message ?? e),
          // 机器可读标记：这是一次「整批提交失败」，涉及 n 个文件（渲染层据此换措辞）。
          batch: true,
          count: n
        })
      }
    }

    for (const entry of entries) {
      const src = entry.src
      try {
        const st = statSync(src)
        if (!st.isFile()) throw new Error('not a file')
        const ext = extname(src).slice(1).toLowerCase()
        const type = EXT_TYPE[ext]
        if (!type) { skipped++; continue }

        const hash = contentHash(src)
        if (dedupe && dupStmt.get(hash)) { skipped++; continue }

        // 目标目录**放在去重判定之后**解析：全是重复文件的子目录不会在库里留下空文件夹
        const target = resolveDir(entry.relDir)

        // 目标目录已有同名文件 → 自动换一个不冲突的名字（`名字 (1).png`），
        // 绝不覆盖也不跳过。规则与移动/复制/重命名共用 `uniqueName`。
        const origName = basename(src)
        const name = uniqueName(target.dest, origName)
        const dest = join(target.dest, name)

        // ⚠️ 用 `moveFileSync`，别裸调 `renameSync`：跨盘（库在 D:、源在 C:）时 rename 必失败
        // （EXDEV），「移动导入」会直接报错，而库里移动却好好的 —— 同一动作两个入口行为不一致。
        if (mode === 'move') moveFileSync(src, dest)
        else copyFileSync(src, dest)
        if (name !== origName) renamed++

        if (!inTx) { db.exec('BEGIN'); inTx = true }
        insStmt.run(
          target.id, name,
          toRel(target.path, name), src, type, ext,
          st.size, hash, Math.floor(st.mtimeMs), Date.now()
        )
        added++
        batchInserts++
        if (batchInserts >= BATCH) commitBatch()
      } catch (err) {
        failed.push({ path: src, error: String((err as Error).message ?? err) })
      }
      done++
      if (done % 50 === 0 || done === total) {
        opts.onProgress?.({ importId, done, total })
        BrowserWindow.getAllWindows()[0]?.webContents.send('import:progress', { importId, done, total })
      }
    }
    // 收尾提交最后不足一批的剩余（`inTx === false` 时是空操作，不会再碰已提交的批次）。
    // 与批中间那次走同一个 helper：失败会被扣回 added 并如实上报，不再静默吞掉。
    commitBatch()

    const result: ImportResult = { importId, added, skipped, renamed, failed }
    opts.onDone?.(result)
    BrowserWindow.getAllWindows()[0]?.webContents.send('import:done', result)
  })().catch((e) => {
    opts.onDone?.({ importId, added: 0, skipped: 0, renamed: 0, failed: [{ path: '*', error: String(e) }] })
  })

  return { importId }
}

/**
 * 导入一批**文件**到某个文件夹（选文件对话框 / 拖文件进窗口 / 剪贴板粘贴都走这里）。
 *
 * 行为与抽取前**完全一致**：`paths` 里不支持的扩展名、内容重复、非文件一律计入 `skipped`，
 * 目标文件夹为 `null` 时回退到「未分类」。
 */
export function importFiles(args: ImportArgs): { importId: number } {
  return runImport({
    collect: () => ({ entries: args.paths.map((p) => ({ src: p, relDir: '' })), skipped: 0 }),
    folderId: args.folderId ?? null,
    mode: args.mode,
    onProgress: args.onProgress,
    onDone: args.onDone
  })
}

export interface ImportFolderArgs {
  /** 磁盘上被选中的文件夹（绝对路径） */
  rootPath: string
  /** 目标文件夹 id；`null` = 「未分类」 */
  folderId: number | null
  mode?: 'copy' | 'move'
  onProgress?: (p: { importId: number; done: number; total: number }) => void
  /** 比 `ImportResult` 多一个 `dirsCreated`：本次在库里新增的目录数（保留层级的副产物） */
  onDone?: (r: ImportResult & { dirsCreated: number }) => void
}

/**
 * 递归扫描一个磁盘文件夹，产出「可导入条目」。
 *
 * 规则（与 `watcher.ts` 的索引判据同源，别各写一份）：
 * - 递归用**显式栈**而不是函数递归：用户选中的可能是几个层级的资料盘，递归有爆栈风险；
 * - **跳过** `.` 开头的目录与文件名（`.stash*` / `.thumbs` / `.stash-compress-*` 全在其中，
 *   顺带挡掉 `.git` / `.DS_Store` 这类系统垃圾）；
 * - **跳过**符号链接 / 联接点：Windows 的 junction 能让同一目录无限嵌套，跟进去就是死循环；
 * - 只收 `isFile()`，其他类型（FIFO / socket）静默略过；
 * - 扩展名不在 `EXT_TYPE` 的文件**不进 entries、但计入 `skipped`** —— 这样提示条会显示
 *   「跳过 N 个（重复或格式不支持）」，用户才知道有多少文件没被导进来；
 * - 空目录不产生条目，因此**也不会在库里建出空文件夹**。
 */
function scanFolder(rootPath: string): CollectResult {
  const entries: ImportEntry[] = []
  let skipped = 0
  const stack: Array<{ abs: string; rel: string }> = [{ abs: rootPath, rel: '' }]
  while (stack.length) {
    const cur = stack.pop() as { abs: string; rel: string }
    let dirents: Dirent[]
    try {
      dirents = readdirSync(cur.abs, { withFileTypes: true })
    } catch {
      // 单个目录读不了（权限 / 扫描途中被删）：跳过它，其余照常导入。
      // 一个坏目录不该让整次文件夹导入失败 —— 用户看到的仍是「导入了 X 个」。
      continue
    }
    for (const d of dirents) {
      if (d.isSymbolicLink()) continue
      if (d.name.startsWith('.')) continue
      const abs = join(cur.abs, d.name)
      const rel = cur.rel ? `${cur.rel}/${d.name}` : d.name
      if (d.isDirectory()) {
        stack.push({ abs, rel })
        continue
      }
      if (!d.isFile()) continue
      const ext = extname(d.name).slice(1).toLowerCase()
      if (!EXT_TYPE[ext]) {
        skipped++
        continue
      }
      // relDir 用 `/` 分隔（库内路径的唯一形状），空串 = 直接放进目标文件夹
      entries.push({ src: abs, relDir: cur.rel })
    }
  }
  return { entries, skipped }
}

/** `folders` 表现有行数；没开库 / 读失败时返回 0（只用于算增量，读不到就当没增量） */
function countFolders(): number {
  try {
    const { db } = requireCurrent()
    const row = db.prepare('SELECT COUNT(*) AS c FROM folders').get() as { c: number } | undefined
    return row?.c ?? 0
  } catch {
    return 0
  }
}

/**
 * 把整个文件夹导入到当前文件夹，**连被选中那一层自己一起保留**
 * （选中「风景」里有 `a.png` + `子目录/b.png`，导入到「收藏」后
 *   → `收藏/风景/a.png` + `收藏/风景/子目录/b.png`）。
 *
 * 老行为是「内容倒进当前文件夹」（`收藏/a.png` + `收藏/子目录/b.png`），上层名字被吃掉；
 * 用户实际使用时期望外层也留着，否则一次导入多个同名结构的文件夹会互相搅在一起。
 * 目标文件夹里已有同名子目录时**合并进去** —— `mkdirRel` 本身幂等，不需要额外判断。
 *
 * 层级是靠在库内按 `relDir` 逐级 `mkdirRel` 还原的 —— 没有新写任何建文件夹逻辑，
 * 也就不会出现「导入建目录」与「手动新建目录」两套规则各偏一次。
 */
export function importFolder(args: ImportFolderArgs): { importId: number } {
  // 基线必须在同步返回前取：`onDone` 是在异步块收尾时回调的，那时才知道最终行数
  const before = countFolders()
  return runImport({
    // 扫描放进 runImport 的异步块里跑（同步 readdir 上千个目录会卡主进程）
    collect: () => {
      const { entries, skipped } = scanFolder(args.rootPath)
      // `basename` 对尾斜杠是安全的：`D:\素材\` → `素材`（与 `D:\素材` 同结果）
      const rootName = basename(args.rootPath)
      // 边界①：盘符根 / 无名字的路径（`basename('D:\\') === ''`）。
      // 套层就会建出一个**空名**目录，库内路径退化成 `/a.png`（首段为空）→ 直接放弃套层，
      // 退化为旧行为。绝不能为了「统一」去建空名文件夹。
      // 边界②：根目录名以 `.` 开头的（如 `C:\x\.cache`）。项目的索引规则是
      // 「`.` 开头的目录一律不索引」（见 `watcher.ts` 里 `dirRel.split('/').some(p => p.startsWith('.'))`），
      // 套层会造出一个「folders 表里有、但里面文件全不被索引」的幽灵目录；
      // 而且它还会撞上 rename/delete 的 `path.startsWith('.')` → `ERR_PROTECTED_FOLDER`，
      // 用户既看不见也删不掉。同样退化为旧行为：内容直接倒进当前文件夹。
      if (!rootName || rootName.startsWith('.')) return { entries, skipped }
      return {
        // 把 rootName 拼到每条 relDir 前面；`relDir === ''`（根层文件）时不能再拼 `/`，
        // 否则库内路径会出现 `风景/` 这样的空尾段。
        entries: entries.map((e) => ({
          src: e.src,
          relDir: e.relDir ? `${rootName}/${e.relDir}` : rootName
        })),
        skipped
      }
    },
    folderId: args.folderId ?? null,
    mode: args.mode,
    onProgress: args.onProgress,
    // `dirsCreated` 只在文件夹导入的结果上出现：`importFiles` 的返回对象逐字节保持旧形状
    onDone: (r) => args.onDone?.({ ...r, dirsCreated: Math.max(0, countFolders() - before) })
  })
}
