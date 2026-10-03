import chokidar, { type FSWatcher } from 'chokidar'
import { basename, extname, join, relative } from 'path'
import { renameSync, rmSync, statSync } from 'fs'
import { BrowserWindow } from 'electron'
import { contentHash, EXT_TYPE } from './importer'
import { ensureFolderRows, mkdirRel } from './library'
import { uniqueName } from './naming'
import { relFromLib } from './paths'
import type { DB } from './db'

let watcher: FSWatcher | null = null

/** 压缩管线写的临时文件前缀（同目录、同盘，见 compress.ts 的 tmpPathFor） */
const TMP_PREFIX = '.stash-compress-'

/**
 * 「未归属素材」的约定目录名。
 * 必须与 `importer.ts` 未指定文件夹时的兜底目录一致（那里调 `mkdirRel('未分类')`）——
 * 否则「导入」和「外部拷入根目录」两条路径会把素材归到两个不同文件夹。
 */
const UNCATEGORIZED = '未分类'

/**
 * 「这次改动是我们自己造成的」——登记后，随后那次 add/unlink 不再同步索引。
 *
 * 为什么不能只靠 `awaitWriteFinish` 的 800ms：那是**时间**保证，而原地替换在这段窗口里
 * 还要哈希大文件 + 写 sqlite，慢机器 / 网络盘上完全可能超时。一旦超时，
 * `add` 会给新文件插一行重复素材、`unlink` 会把我们刚改好的那行标成 missing。
 * 所以顺序（见 compress.ts）与显式抑制两条都要。
 *
 * 一次性消费：外部后来真的又改了同一个路径，仍然会被正常同步到。
 */
const suppressed = new Map<string, number>()

/** 让下一次针对该 rel_path 的 add/unlink 事件被忽略（默认 10s 内有效） */
export function suppressRel(rel: string, ms = 10_000): void {
  suppressed.set(rel, Date.now() + ms)
}

function consumeSuppressed(rel: string): boolean {
  const until = suppressed.get(rel)
  if (until == null) return false
  suppressed.delete(rel)
  return Date.now() <= until
}

/**
 * 外部变更的**界面刷新广播**（去抖合并）。
 *
 * 背景：watcher 的三条线（add / change / unlink）以前只改索引，没有任何通道告诉渲染层
 * → 界面上必须「重开库」才看得到外部改动（`--smoke-watch` 的注释里也这么写着）。
 * 这里在**索引确实被改动**之后累计计数，去抖窗口结束后一次性广播给**所有**窗口。
 *
 * ⚠️ 计数只在「真的改动了索引」时才 +1：
 *   · add   —— 只有 INSERT 真的成功才计数（被 consumeSuppressed / rel_path 查重 /
 *              非素材扩展名 / `.` 开头目录拦掉的一律不计）；
 *   · change—— 两个分支（只刷 mtime / 内容真变）都算，被 consumeSuppressed / 查不到行 /
 *              非文件拦掉的不计；
 *   · unlink—— 只有 `UPDATE ... .run()` 的 `changes > 0` 才算。
 * 这三条一起保证了**应用自身的导入 / 压缩 / 重命名/移动**不会产生假广播
 * （它们在同一同步块内已经把索引改好了，watcher 回调触发时按 rel_path 查不到要改的行）。
 * 否则用户每导入一次就会收到「导入完成 + 库在外部被改动」两条重复提示。
 */
/** 一次外部批次在各条线上「真正改动了索引」的行数 */
interface ExternalCounts {
  added: number
  changed: number
  removed: number
}

/**
 * 广播 payload：计数 + `partial` 标记（`partial` **恒存在**，保持契约形状稳定，别做成可选字段）。
 *
 * `partial` 区分两种 flush：
 *   · `true` —— 流**进行中**由 maxWait 触发的中途 flush（长拷贝期间定期刷新界面，别让界面僵住）；
 *   · `false`—— 流静默后由尾部去抖定时器触发的**收尾** flush。
 * 渲染层据此把「轻量刷新」与「收尾动作（bumpThumbs + 弹提示）」分开：
 * 否则长拷贝期间提示条会全程常驻、数字乱跳，且整个网格每 ~1.4s 重拉一次缩略图。
 */
interface ExternalDelta extends ExternalCounts {
  partial: boolean
}

let pendingExternal: ExternalCounts | null = null
let externalTimer: ReturnType<typeof setTimeout> | null = null
/** 本批「第一个尚未 flush 的事件」的时刻（maxWait 的计时起点）；无待发批次时为 null */
let batchStartedAt: number | null = null

/**
 * 去抖窗口。一次外部批量操作（从资源管理器拖进一个目录、Ctrl+V 粘一批图）
 * 常常触发几十个 add/change 事件 —— 合并成一次广播，用户只被打扰一次。
 */
const EXTERNAL_DEBOUNCE_MS = 400

/**
 * 去抖的**兜底上限**（maxWait）：距「本批第一个尚未 flush 的事件」最多等这么久就必须 flush 一次。
 *
 * 为什么必须有：只有尾部去抖（每次事件都 `clearTimeout` 续命）时，**持续**的事件流
 * （大批拖拷、被同步软件持续改动的目录）会让 400ms 窗口永远排不上 flush ——
 * 实测往库里每 150ms 写一个文件、连写 40 个（≈6s）时，整段流期间渲染层收到的广播数为 **0**，
 * 界面在用户最需要反馈的那几秒里完全不刷新。
 * maxWait 只保证「流进行中也会定期刷新」；它**不改变**「流结束后收尾合并成少数几条」的行为
 * （流一旦停下，最后一次 setTimeout 的去抖窗自然会 flush 掉剩余计数）。
 */
const EXTERNAL_MAX_WAIT_MS = 1400

function bumpExternal(kind: keyof ExternalCounts, n = 1): void {
  if (n <= 0) return
  const now = Date.now()
  // maxWait 兜底：若**上一段**已积压超过上限 → 先把上一段以**中途 flush(partial=true)** 送走，
  // 再让本次事件开一个新批次。关键点：触发中途 flush 的那个事件**不算进被送走的上一段**——
  // 它落到新批次里，于是「流停下时的那次收尾」必然带着至少 1 条计数：
  //   · 否则会出现「中途 flush 恰好把最后一段吃干」的退化 → 收尾计数为 0 → 提示条不弹，界面收尾动作缺失；
  //   · 且每个事件只被计一次 → 各批计数之和仍恰好 = 该批实际改动数（E1 的 sum 断言不受影响）。
  if (batchStartedAt != null && now - batchStartedAt >= EXTERNAL_MAX_WAIT_MS) flushExternal(true)
  if (!pendingExternal) pendingExternal = { added: 0, changed: 0, removed: 0 }
  pendingExternal[kind] += n
  if (batchStartedAt == null) batchStartedAt = now
  // 每次事件都（重）排「收尾」定时器：idle 满 EXTERNAL_DEBOUNCE_MS 无新事件 → 非 partial 收尾。
  // 该定时器**只**由收尾 flush 清除；中途 flush 不动它 —— 所以流停下后一定还有一次非 partial 的收尾。
  if (externalTimer) clearTimeout(externalTimer)
  externalTimer = setTimeout(() => flushExternal(false), EXTERNAL_DEBOUNCE_MS)
}

/**
 * 送出一次广播。
 * @param partial `true` = maxWait 触发的中途 flush；`false` = 尾部去抖定时器触发的收尾 flush。
 *
 * 语义：
 *   · 中途 flush 后 `pendingExternal` 清空、`batchStartedAt` 归零 —— 流继续时下一事件开新批次计时；
 *     收尾定时器**保留**（见 bumpExternal 的说明）。
 *   · 收尾 flush 是终态：清掉收尾定时器。
 *   · 正常不会出现「收尾时已无积压计数」（见 bumpExternal 的 flush-before-add：触发中途 flush 的事件
 *     总会落进新批次）；万一出现，仍补发一条**零计数**的 `partial=false` 作安全网，
 *     它纯粹是「流已结束」的信号；`partial=true` 且无计数时则直接跳过（无意义）。
 */
function flushExternal(partial: boolean): void {
  if (!partial) {
    // 收尾：清掉尾部定时器（中途 flush 不走这里，故保留定时器）
    if (externalTimer) {
      clearTimeout(externalTimer)
      externalTimer = null
    }
  }
  const counts = pendingExternal
  pendingExternal = null
  batchStartedAt = null // 下一批重新计时
  // 广播风格与 settings:changed 一致（见 main.ts）：发给**所有**窗口，而不是 [0]
  const send = (delta: ExternalDelta): void => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('library:external', delta)
  }
  if (!counts) {
    if (!partial) send({ added: 0, changed: 0, removed: 0, partial: false }) // 纯收尾信号
    return
  }
  send({ added: counts.added, changed: counts.changed, removed: counts.removed, partial })
}

/**
 * 仅供冒烟断言：当前是否持有库监听器（生产代码不依赖它）。
 *
 * 为什么值得单独导出：`unwatchLibrary()` 的效果（chokidar 释放句柄）在进程外不可见，
 * 而「删库后监听器有没有真的停掉」正是一条纯泄漏、不崩不报错的缺陷 ——
 * 需要一个直接观测「监听器存不存在」的探针，否则断言无从下手（项目已有为冒烟导出内部能力的先例，
 * 如 library 的 `ensureFolderRows`）。返回 `watcher !== null`，不含任何副作用。
 */
export function isWatching(): boolean {
  return watcher !== null
}

export function unwatchLibrary(): void {
  if (watcher) {
    watcher.close()
    watcher = null
  }
  suppressed.clear()
  // 清掉待发的去抖广播与计数。否则切库/关库后，一个属于**上一个库**的陈旧广播
  // 会打到新库上：新库会莫名弹出「库在外部被改动了」并把列表刷新一遍。
  // watchLibrary 开头也会调本函数，所以「切库」与「关库」两条路径都被覆盖。
  if (externalTimer) {
    clearTimeout(externalTimer)
    externalTimer = null
  }
  pendingExternal = null
  batchStartedAt = null
}

/** 监听库目录，外部改动增量同步索引（防抖由 awaitWriteFinish + 简单标记实现） */
export function watchLibrary(libPath: string, db: DB): void {
  unwatchLibrary()
  watcher = chokidar.watch(libPath, {
    ignoreInitial: true,
    ignored: (p: string) => {
      const rel = relative(libPath, p)
      // .stash 数据库文件 / .thumbs 缩略图缓存，均不参与索引同步。
      // `.stash-compress-*.tmp` 是压缩管线写在**目标同目录**的临时文件（同盘 rename 才快），
      // 必须一并忽略 —— 否则会被当成「外部新增文件」（见 compress.ts 的 tmpPathFor）
      //
      // ⚠️ 绝不能在这里忽略「库根目录本身」（即 `rel === ''`）：chokidar 会对被监听的根目录
      // 求值 `ignored`，返回 true 会**直接不建立任何 watch**（chokidar 5.0.0 实测：
      // getWatched() 为空、写文件 0 事件、ready 0ms）→ 整个外部变更同步静默失效。
      // 而根目录本没有理由被忽略：`ignoreInitial: true` 已跳过初始扫描，也没有 addDir 处理器。
      // `relative()` 对子路径至少返回一段文件名，只有根目录会得到 `''`，删掉它不影响下面三条判断。
      return (
        rel.startsWith('.stash') ||
        rel.startsWith('.thumbs') ||
        basename(rel).startsWith(TMP_PREFIX)
      )
    },
    awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 100 }
  })

  watcher.on('add', (abs: string) => {
    try {
      let rel = relFromLib(libPath, abs)
      // 我们自己刚放进来的（压缩替换）→ 索引已经改好了，别再插一行重复素材
      if (consumeSuppressed(rel)) return
      // 索引里已有该 rel_path → 不重复插行。
      // 这条同时兜住「根目录文件被我们移动后，chokidar 补发的新路径 add」：
      // 移动是同步完成的，本行的 INSERT 已先于那次 add 落库（详见下方根目录分支的注释）。
      if (db.prepare('SELECT id FROM assets WHERE rel_path=?').get(rel)) return

      const ext = extname(abs).slice(1).toLowerCase()
      const type = EXT_TYPE[ext]
      // 非素材类型（含压缩临时文件 `.stash-compress-*` 等）：不索引
      if (!type) return

      let dirRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
      // `.` 开头的目录一律不索引：与 deleteFolder/renameFolder 的 `path.startsWith('.')`
      // → `ERR_PROTECTED_FOLDER` 保护同一条线。否则会给它们造出「侧栏里看不见、
      // 却又因为受保护而永远删不掉/改不掉」的 folders 行（既不在册又受保护）。
      if (dirRel.split('/').some((p) => p.startsWith('.'))) return

      // 注意：用 `rel.slice(...)` 取文件名而不是 `path.basename` ——
      // rel 已被规范化成 `/` 分隔，而 Windows 上 basename 只认 `\\`，会原样返回整串路径。
      let name = rel.slice(dirRel.length ? dirRel.length + 1 : 0)
      let folderId: number | null = null

      if (!dirRel) {
        // ① 文件落在**库根目录**：folders 表里没有「根目录」这一行，folder_id 保持 null 会撞
        //    `assets.folder_id INTEGER NOT NULL`。按 importer 的既有约定，把它物理移动进
        //    「未分类」——索引与磁盘始终一致，且不需要动 schema（用户已知情并同意此行为）。
        const fallback = mkdirRel(UNCATEGORIZED)
        const destDir = join(libPath, ...fallback.path.split('/'))
        // 目标已存在同名文件 → 自动改名，绝不覆盖（规则唯一来源 naming.ts 的 uniqueName）
        const movedName = uniqueName(destDir, name)
        renameSync(abs, join(destDir, movedName)) // 同一目录树内移动 = 同盘，不会跨卷
        dirRel = fallback.path
        name = movedName
        rel = `${dirRel}/${name}`
        folderId = fallback.id
      } else {
        // ② 文件落在子目录：查 folders 行；查不到 = 外部（资源管理器）新建的目录，
        //    用 ensureFolderRows 逐级补齐（不建目录，目录已由用户建好）。
        const f = db.prepare('SELECT id FROM folders WHERE path=?').get(dirRel) as { id: number } | undefined
        folderId = f ? f.id : ensureFolderRows(db, dirRel.split('/')).id
      }

      const absPath = join(libPath, ...rel.split('/'))
      const st = statSync(absPath)
      // content_hash 必须与行在同一 INSERT 内落库：thumbs.ts 的 `ensureOne`/`ensureBatch`
      // 都以 `content_hash` 为过滤条件，缺了它这张卡永远没有缩略图、尺寸/色板也永不回填。
      const hash = contentHash(absPath)
      db.prepare(
        `INSERT INTO assets(folder_id,name,rel_path,source_path,type,ext,size,content_hash,file_mtime,imported_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      ).run(folderId, name, rel, null, type, ext, st.size, hash, Math.floor(st.mtimeMs), Date.now())
      // 走到这里 = 真的插了一行外部新增素材 → 才计入待广播的 added。
      // 上面任何一条 return（抑制 / 查重 / 非素材 / 隐藏目录）都不会执行到这里。
      bumpExternal('added')
    } catch (e) {
      // 保持「单文件失败不中断监听」的语义，但留下可诊断的痕迹：
      // 此前这里是空 catch，用户看到的「文件拷进去却凭空消失」因此在日志里查无实据。
      console.warn('[watcher] add 同步失败:', basename(abs), e)
    }
  })

  const markMissing = (abs: string) => {
    try {
      const rel = relFromLib(libPath, abs)
      // 旧文件是我们自己删的（压缩替换完成），别把已经改好的那行标成 missing
      if (consumeSuppressed(rel)) return
      // `AND missing=0` 让「标失效」幂等：整目录被删时 chokidar 会**同时**发 unlinkDir（目录）
      // 与逐文件 unlink，两条线都会命中同一批素材行。加上这个条件后，无论谁先到：
      //   · 先 unlinkDir → 整子树刷成 missing=1，随后逐文件命中 0 行 → changes=0；
      //   · 先逐文件   → 各自命中 1 行、共 N，随后 unlinkDir 命中 0 行。
      // 两种到达顺序的 removed 合计都恰好 = N（实测：以前是 2N，提示条会说「删除 6 个」而实际只删 3 个）。
      // 终态（missing=1）完全不变。
      const info = db.prepare('UPDATE assets SET missing=1 WHERE rel_path=? AND missing=0').run(rel)
      // 只有真的标到了行才广播。应用自身的重命名/移动/压缩在同一同步块内已经把那条行的
      // rel_path 改好了 —— 回调触发时按**旧** rel_path 查不到，changes 天然为 0 → 不会假广播。
      // Number(...)：node:sqlite 的 changes 类型是 number | bigint，统一成 number。
      if (Number(info.changes) > 0) bumpExternal('removed', Number(info.changes))
    } catch {
      /* ignore */
    }
  }
  const markDirMissing = (abs: string) => {
    try {
      // 同样 `AND missing=0`：与 markMissing 一起保证「unlinkDir + 逐文件 unlink」不会被双计（详见 markMissing）
      const info = db
        .prepare('UPDATE assets SET missing=1 WHERE rel_path LIKE ? AND missing=0')
        .run(relFromLib(libPath, abs) + '/%')
      // 整目录被删会一次标到 N 行 → removed 计 N（提示条上的「删除 N 个」才说得通）
      if (Number(info.changes) > 0) bumpExternal('removed', Number(info.changes))
    } catch {
      /* ignore */
    }
  }

  /**
   * 外部**原地改写**了某个已有素材（路径没变、只有内容变了）。
   *
   * 为什么这一步不能省：`.thumbs/{hash}/grid|detail.webp`、`preview-{px}.webp`，
   * 以及 `width` / `height` / `duration_ms` / `palette` 全都以**文件内容**为前提。
   * 内容换了却不更新索引，用户看到的是：卡片还是旧图、按旧尺寸排版、提示词还是上一版
   * —— 而磁盘上那个文件早就不是它了。
   *
   * 分三种结局处理，为的是**别让没必要的失效发生**：
   *   · 内容与元数据都没变 → 什么都不做（chokidar 偶发重复上报、只改了权限）
   *   · 只有 size/mtime 变   → 只刷这两列。内容没变就不该动派生缓存（被 touch、
   *                            或被拷回一个内容相同的副本，都是常见情形）
   *   · `content_hash` 也变  → 才算「内容真的换了」，清掉一切以内容为前提的派生字段与缓存
   */
  const syncChanged = (abs: string) => {
    try {
      const rel = relFromLib(libPath, abs)
      // 我们自己刚写完的（压缩原地替换走 rename；文本编辑走 preview 的写回落库）→ 索引已改好
      if (consumeSuppressed(rel)) return

      const row = db
        .prepare('SELECT id, size, file_mtime, content_hash FROM assets WHERE rel_path=?')
        .get(rel) as
        | { id: number; size: number; file_mtime: number; content_hash: string | null }
        | undefined
      // 索引里没有这一行 → 这是「新增」而不是「修改」（chokidar 有时把新建报成 change），交给 add
      if (!row) return

      const st = statSync(abs)
      // 被换成同名目录之类 → 交给 unlink/unlinkDir 那两条线，这里不处理
      if (!st.isFile()) return
      const mtime = Math.floor(st.mtimeMs)

      // 先算内容哈希再决定，而不是拿 mtime/size 当「内容没变」的代理：
      // 同一毫秒内等长的两次改写会让 mtime+size 双双相同，那样会漏掉真正的改动。
      // 只需读前 64KB（见 importer.contentHash），代价可以忽略。
      const hash = contentHash(abs)

      if (hash === row.content_hash) {
        if (row.size === st.size && row.file_mtime === mtime) return // 真的什么都没变
        // 内容没变（touch / 拷回同内容副本）→ 只刷这两列，**不动任何派生缓存**
        db.prepare('UPDATE assets SET size=?, file_mtime=? WHERE id=?').run(st.size, mtime, row.id)
        bumpExternal('changed') // 只刷元数据也算「改动了索引」，界面上的大小/时间要跟着变
        return
      }

      // —— 内容真的换了 ——
      // 一条 UPDATE 原子地刷三列并清掉派生字段：
      // · width/height/duration_ms/palette 是从**旧内容**算出来的，留着就是错的；
      // · gen_state 归零 = 放回「待扫」状态，让提示词/来源被重新提取。
      //   位标记的代价正是「已扫过就永不重扫」（见 C7/C8），所以这里必须显式归零，
      //   否则换了一张图、详情栏还挂着上一张的提示词。
      // · note / rating / is_fav / 标签是**用户字段**，一律保留 —— 内容变了不代表用户标注作废。
      db.prepare(
        `UPDATE assets
            SET size=?, file_mtime=?, content_hash=?, missing=0,
                width=NULL, height=NULL, duration_ms=NULL, palette=NULL,
                gen_meta=NULL, ai_source=NULL, gen_state=0
          WHERE id=?`
      ).run(st.size, mtime, hash, row.id)
      // 内容真的换了 → 索引已改（size/hash/派生字段），界面必须刷新才不挂着旧图
      bumpExternal('changed')

      // 旧内容的缓存（缩略图与派生预览同住 `.thumbs/{hash}/`）已无人引用就删掉。
      // ⚠️ 必须在 UPDATE **之后**数引用：否则这一行自己还挂在旧 hash 上，永远显示「有人用」。
      // ⚠️ 也必须数引用：两份内容相同的素材共享同一个 hash 目录，删了会把另一张卡打成灰。
      const oldHash = row.content_hash
      if (oldHash && oldHash !== hash && /^[0-9a-f]{20}$/.test(oldHash)) {
        const still = db.prepare('SELECT count(*) AS c FROM assets WHERE content_hash=?').get(oldHash) as {
          c: number
        }
        if (!still.c) rmSync(join(libPath, '.thumbs', oldHash), { recursive: true, force: true })
      }
    } catch (e) {
      // 与 add 同一条纪律：单文件失败不中断监听，但必须留下可诊断的痕迹
      console.warn('[watcher] change 同步失败:', basename(abs), e)
    }
  }

  watcher.on('unlink', markMissing)
  watcher.on('unlinkDir', markDirMissing)
  watcher.on('change', syncChanged)
}
