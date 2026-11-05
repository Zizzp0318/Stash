// 设置面板冒烟：electron . --smoke-settings
//
// 覆盖「设置面板 P1（外观与浏览 + 关于）」：
//   S1 入口与骨架 —— 侧栏底部能打开面板、默认落在「外观与浏览」、Esc 能关掉
//   S2 逐项生效   —— 默认视图 / 卡片大小 / 显示字段 / 类型角标 / 详情栏收起，
//                    每项都要**同时**验两边：DOM 真的变了 + config.json 真的落盘了
//   S3 持久化     —— reload 之后设置还在（只验 DOM 的话，「只存内存」也能全绿）
//   S4 旧偏好迁移 —— 老的 localStorage 三个键被搬进 config 并删除（只迁一次）
//   S5 恢复默认   —— 二次确认后回到默认值（config 与 DOM 一致）
//   S6 关于页     —— 版本号与主进程一致、运行环境齐全
//   S7 缓存组     —— 占用统计（缩略图/派生分开算，含**图片带尺寸 tag 的高清派生** `preview-2560.webp`）、
//                    并发与质量落盘、清理缩略图后真被重建；`清理派生预览` 真的删掉 `preview-2560.webp`
//                    而不动缩略图、`清理缩略图` 反过来不动派生预览（I2 的两条不变量各补一条真断言）
//   S8 预览与播放 —— 自动隐藏延迟**真的改行为**（浮层提示常驻/淡出）、高清预览上限换了档
//                    会生成**新文件名**的派生文件（不是复用旧的）、音量/自动播放/文本上限落盘
//   S9 导入组     —— 方式/去重/色板落盘，且**不传 mode 直接调 import.files** 时管线真的按设置走
//                    （移动真的搬走源文件、关掉去重真的会重复导入、关掉色板真的不再回写色板）
//                    S9c：打开色板后重跑 backfill，**缩略图已缓存**的存量素材也要补算色板
//                    （旧实现只在缩略图本次新生成时回写 → 这类素材永远补不上，只能清缓存重建）
//   S10 库与存储  —— 体检能找出「文件已不在磁盘」的素材、清理点两次才生效且**不碰磁盘上还在的文件**
//   S11 快捷键    —— 只读清单：有内容、不留空行、且**里面不该有任何可点控件**（防「假设置」）
//   S12 切换库     —— 两个临时库（X: 400×200 的图；Y: txt 占位图 1:1）来回切，
//                    断言图片卡片的宽高比不被上一个库的实测值带偏（用户报过「切库后都变成 1:1」）
//   UF 检查更新    —— 关于页的 GitHub 入口 + 检查更新（QA 增补，编号 UF-1…UF-8）：
//                    版本比较逐段按数字比、302 Location 解析、白名单（含前缀骗术 / 段边界）、
//                    checkLatest 三态与「异常收敛成值」、IPC 白名单拒绝、版本行 DOM 结构、
//                    转圈动画、三态文案真实渲染。**零真实网络、零真实浏览器**（见段内说明）。
//   OP 开库性能    —— 开库回填不再逐条 stat（QA 增补，编号 OP-1…OP-10 + OP-4b/OP-4c）：
//                    1 万条夹具下 `thumb:backfill` 的 IPC 往返耗时（绝对上界 + 「目录集合 vs 逐条 stat」比值）、
//                    已有 grid 不重复生成、detail 不被目录集合误判、清缓存后「重启」与「同进程」两条重建路径、
//                    派生预览不被连带删除、
//                    **OP-4b**：派生预览原位、目录删不掉时回填仍须全部重建（真回归面）；
//                    **OP-4c**：脏标记 meta 双写① / 全量洗白是 DELETE② / 非全量批次不得消费③ /
//                            内存复位后仍 dirty（只可能来自 meta）④ / 重建后洗白⑤；
//                    OP-10 小批次（≤8）退回逐条 existsSync、
//                    进度条的出现/置满/淡出节奏与「不抢点击、不压标题栏」。
//
// ⚠️ 本套件会**写真实的 userData/config.json**（设置本来就存在那里，没有库里那份），
// 所以开头快照、`finally` 里原样写回 —— 冒烟不能把用户的偏好改掉。
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, type Dirent } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import sharp from 'sharp'
import { closeCurrent, createLibrary, forgetLibrary, mkdirRel, openLibrary, requireCurrent } from './library'
import { importFiles, type ImportResult } from './importer'
import { ensureBatch, gridPresenceState } from './thumbs'
import { cacheStats, clearCache } from './cache'
import { deriveFor } from './preview'
import { libraryUsage } from './health'
import { DEFAULT_SETTINGS, getSettings, patchSettings, type Settings } from './config'
import {
  checkLatest,
  compareVersion,
  isAllowedExternalUrl,
  parseTagFromLocation,
  RELEASES_URL,
  REPO_URL,
  type UpdateCheckResult
} from './update'

interface Check { name: string; pass: boolean; detail?: string }

export async function runSmokeSettings(win: BrowserWindow): Promise<void> {
  const checks: Check[] = []
  const check = (name: string, pass: boolean, detail?: string): void => {
    checks.push({ name, pass, detail })
  }
  const js = async <T>(code: string): Promise<T | null> => {
    try {
      return (await win.webContents.executeJavaScript(code)) as T
    } catch {
      return null
    }
  }
  const waitFor = async (cond: string, timeout = 6000): Promise<boolean> => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      if ((await js<boolean>(`!!(${cond})`)) === true) return true
      await new Promise((r) => setTimeout(r, 120))
    }
    return false
  }
  // 运行期错误在**页面内**收集（同 smoke-preview）：走 console-message 会把 Electron 的
  // 安全警告也当成错误 —— 那不是我们的运行期错误，却会把这套件钉成红的。
  // 注意 reload 会清掉页面里的收集数组，所以每次 reload 前先把已有错误捞回来、reload 后重新挂。
  const jsErrors: string[] = []
  const armErrors = async (): Promise<void> => {
    await js(
      'window.__spErrors = [];' +
        "window.addEventListener('error', (e) => window.__spErrors.push(String(e.message)));" +
        "window.addEventListener('unhandledrejection', (e) => window.__spErrors.push(String(e.reason)));"
    )
  }
  const collectErrors = async (): Promise<void> => {
    const list = await js<string[]>('window.__spErrors || []')
    if (Array.isArray(list)) jsErrors.push(...list)
  }
  const reload = async (): Promise<void> => {
    await collectErrors()
    const done = new Promise<void>((resolve) => win.webContents.once('did-finish-load', () => resolve()))
    win.webContents.reload()
    await done
    await waitFor("document.querySelector('.masonry-card, .list-row')", 10000)
    await armErrors()
  }
  const capture = async (name: string): Promise<void> => {
    // 等一帧再抓：DOM 插进去 ≠ 已经画出来，capturePage() 拿的是**上一帧**，
    // 立刻抓会得到「面板还没出现」的图（这个坑当场踩到过）
    await new Promise((r) => setTimeout(r, 350))
    try {
      writeFileSync(join(process.cwd(), name), (await win.webContents.capturePage()).toPNG())
    } catch { /* 截图失败不影响结论 */ }
  }

  /**
   * 直接数磁盘上的缓存文件（不走 IPC）—— 用来验「界面上说的占用」不是编的。
   *
   * ⚠️ 这里的判据**刻意不复用 `cache.ts` 的 `classify()`、也不 import 它**：
   * 本项目的 I2 就是「断言与实现共用同一份错误认知」→ 11 套冒烟全绿也照不到这个 bug
   * （审计 §1.2：实现只认 `preview.`，断言也照抄只认 `preview.`，图片派生在两边一起漏）。
   * 真相来源是 `preview.ts` 的命名规则，这里照**真名**手写一遍：
   *   缩略图   = `{grid|detail}.webp`
   *   派生预览 = `preview.mp4` / `preview.mp3`（视频、音频无 tag）+ `preview-{尺寸}.webp`（图片带 tag）
   *   临时文件 = `preview-{尺寸}.webp.tmp` / `preview.{时间戳}.tmp.{mp4,mp3}` → **不计入任何桶**
   * 返回里带上 `derivedNames`，供断言直接核对「某张具体的派生文件确实被数进来了」。
   */
  const cacheDisk = (): { thumbs: number; derived: number; total: number; derivedNames: string[] } => {
    const dir = join(requireCurrent().path, '.thumbs')
    let thumbs = 0
    let derived = 0
    let total = 0
    const derivedNames: string[] = []
    try {
      for (const hash of readdirSync(dir)) {
        const sub = join(dir, hash)
        let files: string[] = []
        try {
          files = readdirSync(sub)
        } catch {
          continue
        }
        for (const f of files) {
          total++
          if (f === 'grid.webp' || f === 'detail.webp') {
            thumbs++
          } else if (f.startsWith('preview') && !f.includes('.tmp') && /\.(webp|mp3|mp4)$/.test(f)) {
            derived++
            derivedNames.push(f)
          }
        }
      }
    } catch {
      /* 目录还没建起来 */
    }
    return { thumbs, derived, total, derivedNames }
  }
  /** 直接查库（用来拿 TIFF 的 hash） */
  const q = <T>(sql: string): T => requireCurrent().db.prepare(sql).get() as T
  const cfgPath = join(app.getPath('userData'), 'config.json')
  const diskSettings = (): Settings => {
    try {
      const raw = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { settings?: Settings }
      return raw.settings ?? DEFAULT_SETTINGS
    } catch {
      return DEFAULT_SETTINGS
    }
  }
  const clickEl = async (selector: string): Promise<boolean> => {
    return (
      (await js<boolean>(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.click(); return true })()`)) ===
      true
    )
  }
  const openPanel = async (): Promise<boolean> => {
    await clickEl('[data-open-settings]')
    return await waitFor("document.querySelector('[data-settings-panel]')")
  }

  // 用户的真实配置快照：跑完必须原样还原
  const backup = JSON.parse(JSON.stringify(getSettings())) as Settings

  let dir: string | null = null
  try {
    dir = mkdtempSync(join(tmpdir(), 'stash-smoke-settings-'))
    const lib = createLibrary({ name: 'settings-lib', parentDir: dir })
    const folder = mkdirRel('素材')
    const src = join(dir, 'src')
    mkdirSync(src)
    const paths: string[] = []
    for (let i = 0; i < 6; i++) {
      const p = join(src, `s${i}.png`)
      await sharp({ create: { width: 400, height: 300, channels: 3, background: `hsl(${i * 60}, 60%, 45%)` } })
        .png().toFile(p)
      paths.push(p)
    }
    // 一张 TIFF：它是「需要派生高清预览」的那类，专门用来验「高清预览上限」这项设置
    const tiffPath = join(src, 'big.tiff')
    await sharp({ create: { width: 3200, height: 2400, channels: 3, background: '#336699' } })
      .tiff().toFile(tiffPath)
    paths.push(tiffPath)
    await new Promise<void>((resolve) => {
      importFiles({ paths, folderId: folder.id, mode: 'copy', onDone: () => resolve() })
    })

    // ⚠️ 前置状态归位：这些开关是**跨套件共享的全局偏好**，而断言是「点一下应当反转」。
    // 上一轮（或用户自己）把 detailCollapsed 留成 true，点一下就变 false → 断言整条假红
    // （本轮就是这么红的：用户真实配置里 detailCollapsed 本来就是 true）。
    patchSettings({
      detailCollapsed: false,
      cardFields: { name: true, dims: true, size: true, time: true, typeBadge: true }
    })

    // 打开库并 reload（与其它套件一致：走正常引导流程）
    await js(`window.stash.library.open(${JSON.stringify(lib.path)}).then(() => location.reload())`)
    await waitFor("document.querySelector('.masonry-card')", 15000)
    await armErrors()
    await new Promise((r) => setTimeout(r, 400))

    // ==================== S1 入口与骨架 ====================
    const opened = await openPanel()
    check('S1 侧栏底部「设置」能打开面板', opened)
    const nav = await js<string[]>(
      "[...document.querySelectorAll('[data-sp-group]')].map((b) => b.textContent.trim())"
    )
    check('S1 面板分组导航正确',
      JSON.stringify(nav) ===
        JSON.stringify([
          '外观与浏览',
          '预览与播放',
          '导入',
          '图像压缩',
          '缩略图与缓存',
          '库与存储',
          '快捷键',
          '关于'
        ]),
      JSON.stringify(nav))
    const bodyTitle = await js<string>("document.querySelector('.sp-h')?.textContent.trim() ?? ''")
    check('S1 默认停在「外观与浏览」', bodyTitle === '外观与浏览', bodyTitle ?? '')
    await capture('shot-settings-appearance.png')

    // ==================== S2 逐项生效（DOM + 磁盘都要动） ====================
    // 2a 默认视图 → 列表
    await clickEl("[data-sp-view] button:nth-child(2)")
    const listOn = await waitFor("document.querySelector('.list-row') && !document.querySelector('.masonry-card')")
    check('S2 改成「列表」视图：网格当场切换', listOn)
    check('S2 改成「列表」视图：落盘 defaultView=list', diskSettings().defaultView === 'list',
      JSON.stringify(diskSettings()))

    // 2b 卡片大小（先切回瀑布才看得到列数）
    await clickEl("[data-sp-view] button:nth-child(1)")
    await waitFor("document.querySelector('.masonry-card')")
    const colsAt = async (): Promise<number> => {
      // 列数用**卡片左边去重**数出来：绝对定位下 offsetLeft 不反映 transform，必须用 rect
      const n = await js<number>(
        "(() => { const s = new Set([...document.querySelectorAll('.masonry-card')].map(c => Math.round(c.getBoundingClientRect().left))); return s.size })()"
      )
      return n ?? -1
    }
    const colsBefore = await colsAt()
    await js("(() => { const el = document.querySelector('[data-sp-zoom]'); el.value = '260'; el.dispatchEvent(new Event('input', { bubbles: true })); return true })()")
    await new Promise((r) => setTimeout(r, 350))
    const colsAfter = await colsAt()
    check('S2 卡片大小拉大：网格列数当场变少', colsBefore > 0 && colsAfter > 0 && colsAfter < colsBefore,
      `cols ${colsBefore} → ${colsAfter}`)
    check('S2 卡片大小落盘 viewZoom=260', diskSettings().viewZoom === 260, String(diskSettings().viewZoom))

    // 2c 卡片显示字段（关掉「尺寸」→ 卡片信息行里不该再有 宽 × 高）
    const dimsRe = /\d+\s*×\s*\d+/
    const hasDims = async (): Promise<boolean> =>
      ((await js<number>(
        `[...document.querySelectorAll('.ci-meta')].filter((e) => ${dimsRe.toString()}.test(e.textContent)).length`
      )) ?? 0) > 0
    const dimsBefore = await hasDims()
    await clickEl('[data-sp-field="dims"]')
    await new Promise((r) => setTimeout(r, 350))
    const dimsAfter = await hasDims()
    check('S2 关掉「尺寸」字段：卡片上的尺寸文案当场消失', dimsBefore && !dimsAfter,
      `before=${dimsBefore} after=${dimsAfter}`)
    check('S2 关掉「尺寸」字段：落盘 cardFields.dims=false', diskSettings().cardFields.dims === false,
      JSON.stringify(diskSettings().cardFields))

    // 2d 类型角标开关
    const badgeCount = async (): Promise<number> =>
      ((await js<number>("document.querySelectorAll('.thumb-type').length")) ?? -1)
    const badgeBefore = await badgeCount()
    await clickEl('[data-sp-badge]')
    await new Promise((r) => setTimeout(r, 350))
    const badgeAfter = await badgeCount()
    check('S2 关掉类型角标：缩略图上的角标当场消失', badgeBefore > 0 && badgeAfter === 0,
      `before=${badgeBefore} after=${badgeAfter}`)
    check('S2 关掉类型角标：落盘 cardFields.typeBadge=false',
      diskSettings().cardFields.typeBadge === false, JSON.stringify(diskSettings().cardFields))

    // 2e 详情栏默认收起
    await clickEl('[data-sp-detail]')
    const detailGone = await waitFor("!document.querySelector('.detail')")
    check('S2 打开「详情栏默认收起」：右侧信息栏当场收起', detailGone)
    check('S2 详情栏落盘 detailCollapsed=true', diskSettings().detailCollapsed === true,
      JSON.stringify(diskSettings()))

    // ==================== S8 预览与播放 ====================
    {
      await clickEl('[data-sp-group="preview"]')
      const pvOpen = await waitFor("!!document.querySelector('[data-sp-idle]')", 6000)
      const ctrl = await js<Record<string, boolean>>(
        `(() => ({
           idle: !!document.querySelector('[data-sp-idle]'),
           auto: !!document.querySelector('[data-sp-autoplay]'),
           vol: !!document.querySelector('[data-sp-volume]'),
           maxpx: !!document.querySelector('[data-sp-maxpx]'),
           textmb: !!document.querySelector('[data-sp-textmb]')
         }))()`
      )
      check('S8 「预览与播放」分组能打开且五个控件都在',
        pvOpen && Object.values(ctrl ?? {}).every(Boolean), JSON.stringify(ctrl))

      // —— 自动隐藏延迟：**真的改行为**（拿图片浮层底部的提示验证，与播放条共用同一套逻辑）——
      const hintOpacity = async (): Promise<string> =>
        ((await js<string>(
          "(() => { const h = document.querySelector('.pv-image [data-pv-hint]'); return h ? getComputedStyle(h).opacity : 'none' })()"
        )) ?? 'none')
      const openImageOverlay = async (): Promise<void> => {
        await js(
          "(() => { const c = [...document.querySelectorAll('.masonry-card')][0]; if (c) c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true })()"
        )
        await waitFor("!!document.querySelector('.pv-image [data-pv-hint]')", 8000)
      }
      const closeOverlay = async (): Promise<void> => {
        await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
        await waitFor("!document.querySelector('[data-pv-wrap]')", 4000)
      }

      // 先设成「不隐藏」：提示应该一直在
      await clickEl('[data-sp-idle] button:nth-child(1)')
      await new Promise((r) => setTimeout(r, 300))
      check('S8 自动隐藏延迟落盘（不隐藏）', diskSettings().preview.idleHideMs === 0,
        String(diskSettings().preview.idleHideMs))
      await openImageOverlay()
      await new Promise((r) => setTimeout(r, 3600)) // 超过默认的 2.6s
      check('S8 设成「不隐藏」后提示不会淡出', (await hintOpacity()) === '1', await hintOpacity())
      await closeOverlay()

      // 再设成 1.5s：3 秒后必须已经淡出（证明设置真的驱动了计时，而不是写死的 2.6s）
      await openPanel()
      await clickEl('[data-sp-group="preview"]')
      await waitFor("!!document.querySelector('[data-sp-idle]')", 6000)
      await clickEl('[data-sp-idle] button:nth-child(2)')
      await new Promise((r) => setTimeout(r, 300))
      check('S8 自动隐藏延迟落盘（1.5s）', diskSettings().preview.idleHideMs === 1500,
        String(diskSettings().preview.idleHideMs))
      await openImageOverlay()
      await new Promise((r) => setTimeout(r, 3000))
      check('S8 设成 1.5s 后提示会在 3 秒内淡出', (await hintOpacity()) === '0', await hintOpacity())
      await closeOverlay()

      // —— 高清预览上限：换了档必须生成**新文件名**的派生文件，而不是复用旧的那份 ——
      await openPanel()
      await clickEl('[data-sp-group="preview"]')
      await waitFor("!!document.querySelector('[data-sp-maxpx]')", 6000)
      await clickEl('[data-sp-maxpx] button:nth-child(2)') // 2560（默认档）
      await new Promise((r) => setTimeout(r, 250))
      const tiff = q<{ id: number; content_hash: string }>(
        "SELECT id, content_hash FROM assets WHERE name='big.tiff'"
      )
      const derivedFile = (px: number): string => join(lib.path, '.thumbs', tiff.content_hash, `preview-${px}.webp`)
      await js(
        `(() => { const c = document.querySelector('.masonry-card[data-id="${tiff.id}"]'); if (c) c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true })()`
      )
      const d1 = await waitFor(`true`, 100)
      void d1
      const got2560 = await (async (): Promise<boolean> => {
        const t0 = Date.now()
        while (Date.now() - t0 < 25000) {
          if (existsSync(derivedFile(2560))) return true
          await new Promise((r) => setTimeout(r, 300))
        }
        return false
      })()
      check('S8 首次打开 TIFF：按当前上限生成 preview-2560.webp', got2560, derivedFile(2560))
      await closeOverlay()

      // 改成 1920 再打开：应该出现 preview-1920.webp（2560 那份还在，不共用）
      await openPanel()
      await clickEl('[data-sp-group="preview"]')
      await waitFor("!!document.querySelector('[data-sp-maxpx]')", 6000)
      await clickEl('[data-sp-maxpx] button:nth-child(1)') // 1920
      await new Promise((r) => setTimeout(r, 300))
      check('S8 高清预览上限落盘（1920）', diskSettings().preview.maxImagePx === 1920,
        String(diskSettings().preview.maxImagePx))
      await js(
        `(() => { const c = document.querySelector('.masonry-card[data-id="${tiff.id}"]'); if (c) c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true })()`
      )
      const got1920 = await (async (): Promise<boolean> => {
        const t0 = Date.now()
        while (Date.now() - t0 < 25000) {
          if (existsSync(derivedFile(1920))) return true
          await new Promise((r) => setTimeout(r, 300))
        }
        return false
      })()
      check('S8 改了上限后生成的是新文件名（不会命中旧的 2560 那份）',
        got1920 && existsSync(derivedFile(2560)), `1920=${existsSync(derivedFile(1920))} 2560=${existsSync(derivedFile(2560))}`)
      await closeOverlay()

      // —— 音量 / 自动播放 / 文本上限：落盘 ——
      await openPanel()
      await clickEl('[data-sp-group="preview"]')
      await waitFor("!!document.querySelector('[data-sp-volume]')", 6000)
      await js("(() => { const el = document.querySelector('[data-sp-volume]'); el.value = '35'; el.dispatchEvent(new Event('input', { bubbles: true })); return true })()")
      await new Promise((r) => setTimeout(r, 300))
      check('S8 初始音量落盘', Math.abs(diskSettings().preview.volume - 0.35) < 1e-6,
        String(diskSettings().preview.volume))
      // ⚠️ 不能写成「点一下 → 断言变成 true」：那是**依赖初始值**的写法。
      // 用户自己在设置里把「自动播放」打开后（config 里 autoPlay:true），点一下反而变 false
      // → 这条断言永远红（2026-09-29 实测踩到，当时还误以为是别处改动带坏的）。
      // toggle 的真实语义是「翻转」，所以先读当前值、再断言它变成了反值。
      const autoBefore = diskSettings().preview.autoPlay
      await clickEl('[data-sp-autoplay]')
      await new Promise((r) => setTimeout(r, 300))
      check('S8 自动播放开关落盘（点一下即翻转并写盘）',
        diskSettings().preview.autoPlay === !autoBefore,
        `${autoBefore} → ${String(diskSettings().preview.autoPlay)}`)
      await clickEl('[data-sp-textmb] button:nth-child(3)') // 8 MB
      await new Promise((r) => setTimeout(r, 300))
      check('S8 文本预览上限落盘（8MB）', diskSettings().preview.textMaxBytes === 8 * 1024 * 1024,
        String(diskSettings().preview.textMaxBytes))
      await capture('shot-settings-preview.png')
    }

    // ==================== S7 缩略图与缓存 ====================
    {
      await clickEl('[data-sp-group="cache"]')
      const cacheOpen = await waitFor("!!document.querySelector('[data-sp-cache]')")
      // 等统计回来（异步 IPC）
      await waitFor("document.querySelector('[data-sp-cache-total]')?.textContent.trim() !== '—'", 6000)
      const totalText = (await js<string>("document.querySelector('[data-sp-cache-total]')?.textContent.trim() ?? ''")) ?? ''
      const thumbText = (await js<string>("document.querySelector('[data-sp-cache-thumbs]')?.textContent.trim() ?? ''")) ?? ''
      const derivedText = (await js<string>("document.querySelector('[data-sp-cache-derived]')?.textContent.trim() ?? ''")) ?? ''
      const hasConc = await js<boolean>("!!document.querySelector('[data-sp-conc]')")
      const hasQuality = await js<boolean>("!!document.querySelector('[data-sp-quality]')")
      check('S7 缓存分组能打开并显示占用', cacheOpen && totalText !== '' && totalText !== '—', `total=${totalText} 控件=${hasConc}/${hasQuality}`)

      // 缩略图与派生预览必须分开统计：混在一起的话「清理」就分不清该不该带走转码结果
      const before = cacheDisk()
      check('S7 占用统计与磁盘一致（缩略图 / 派生分开算）',
        before.thumbs > 0 && thumbText !== '0 B',
        `diskThumbs=${before.thumbs} diskDerived=${before.derived} domThumbs=${thumbText}`)

      // —— A) 图片派生（带尺寸 tag 的 `preview-2560.webp`）必须落进「派生预览」桶 ——
      // 判据分两层、都用真文件名取证，避免同源盲区（I2 的教训）：
      //   ① 面板数据来源 cacheStats()（主进程真值）：文件数与字节数都 > 0；
      //   ② 独立手数的 cacheDisk()（判据照着 preview.ts 真名另写、不复用 classify）里
      //      确实包含这张具体的 preview-2560.webp —— 不用 stats 自证。
      const tiffRow = q<{ id: number; content_hash: string }>(
        "SELECT id, content_hash FROM assets WHERE name='big.tiff'"
      )
      const preview2560 = join(lib.path, '.thumbs', tiffRow.content_hash, 'preview-2560.webp')
      const s0Hash = q<{ content_hash: string }>("SELECT content_hash FROM assets WHERE name='s0.png'").content_hash
      const gridFile = join(lib.path, '.thumbs', s0Hash, 'grid.webp')
      const detailFile = join(lib.path, '.thumbs', s0Hash, 'detail.webp')
      check('S7 A 前置：S8 生成的那张 preview-2560.webp 此刻就在磁盘上', existsSync(preview2560), preview2560)
      const stA = cacheStats()
      check('S7 A 派生预览占用把图片派生算进来了（文件数与字节数都 > 0）',
        stA.derived.files > 0 && stA.derived.bytes > 0,
        `stats.files=${stA.derived.files} stats.bytes=${stA.derived.bytes}`)
      check('S7 A 面板上的「派生预览」占用不再是 0（DOM 也跟着对了）',
        derivedText !== '0 B' && derivedText !== '', derivedText || '(空)')
      check('S7 A 独立判据也把 preview-2560.webp 数进了派生桶（不用 stats 自证）',
        cacheDisk().derivedNames.includes('preview-2560.webp'),
        JSON.stringify(cacheDisk().derivedNames))

      // 并发数与质量：改完落盘，且主进程真的按新值跑（清掉缩略图后按新质量重建）
      await js("(() => { const el = document.querySelector('[data-sp-conc]'); el.value = '2'; el.dispatchEvent(new Event('input', { bubbles: true })); return true })()")
      await new Promise((r) => setTimeout(r, 300))
      check('S7 并发数落盘', diskSettings().thumbs.concurrency === 2, String(diskSettings().thumbs.concurrency))
      await clickEl('[data-sp-quality] button:nth-child(3)') // 第三档 = 92
      await new Promise((r) => setTimeout(r, 300))
      check('S7 质量档位落盘', diskSettings().thumbs.quality === 92, String(diskSettings().thumbs.quality))

      // —— C) 「清理缩略图」绝不能连带动派生预览（头注释第一条不变量）——
      const derivedBeforeC = cacheDisk().derived
      check('S7 C 前置：清理缩略图前，grid.webp 与 preview-2560.webp 都在磁盘上',
        existsSync(gridFile) && existsSync(preview2560),
        `grid=${existsSync(gridFile)} preview=${existsSync(preview2560)}`)
      await clickEl('[data-sp-clear-thumbs]')
      const armed = (await js<string>("document.querySelector('[data-sp-clear-thumbs]')?.textContent.trim() ?? ''")) ?? ''
      check('S7 清理要先二次确认', armed === '再点一次确认', armed)
      check('S7 第一次点击不会真删', cacheDisk().thumbs > 0, String(cacheDisk().thumbs))
      await clickEl('[data-sp-clear-thumbs]')
      await new Promise((r) => setTimeout(r, 600))
      // ⚠️ 不能拿「此刻磁盘上还剩几个」来断言「删干净了」—— 6 张小图几百毫秒就重建完了，
      // 这个测量本身是竞态的（第一版就这么假红过）。改从**主进程回报的删除数**取证：
      // 那些数是我自己先在磁盘上数出来的，两边对上就说明「这批 grid/detail 确实被她删掉了」。
      const toast = (await js<string>("document.querySelector('.notice-toast')?.textContent.trim() ?? ''")) ?? ''
      const cleared = Number(/已清理 (\d+) 个文件/.exec(toast)?.[1] ?? -1)
      check('S7 C 清理缩略图：主进程确实删掉了磁盘上那批 grid/detail（这批就是缩略图）',
        cleared === before.thumbs, `磁盘实测=${before.thumbs} 回报删除=${cleared} toast=${toast}`)
      check('S7 C 清理缩略图不会连带删掉派生预览（preview-2560.webp 必须还在）',
        cacheDisk().derived === derivedBeforeC && existsSync(preview2560),
        `derived ${derivedBeforeC}→${cacheDisk().derived} preview=${existsSync(preview2560)}`)
      // ⚠️ QA 独立复核补强（E 项）：下面这条原来是 `loadDiskDerived() === before.derived` ——
      //    LHS 与 RHS **都**来自本套件自己手数的 cacheDisk()，从头到尾没碰生产代码；
      //    且修前 cacheDisk 复用了错判据 → before.derived 恒为 0 → `0 === 0` **一直空转、永远绿**。
      //    两处加固：① 显式前置断言 `before.derived > 0`（杜绝空转）；
      //              ② LHS 改成**生产口径** `cacheStats().derived.files`（注入 classify 后必红）。
      check('S7 前置：清理缩略图前「派生预览」占用确实 > 0（否则下一条是 0===0 空转）',
        before.derived > 0 && cacheStats().derived.files > 0,
        `独立口径=${before.derived} 生产口径=${cacheStats().derived.files}`)
      check('S7 清理不会连带删掉派生预览（那是要重新转码的）',
        cacheStats().derived.files === before.derived,
        `独立口径 before=${before.derived} 生产口径 now=${cacheStats().derived.files}`)

      // 重建：等 thumb:done 后再看，缩略图应该回来了（按新质量 92 生成，文件更大）
      const need = Math.max(1, before.thumbs)
      const t0 = Date.now()
      let back = false
      while (Date.now() - t0 < 20000) {
        if (cacheDisk().thumbs >= need) { back = true; break }
        await new Promise((r) => setTimeout(r, 400))
      }
      check('S7 清理后缩略图会被重新生成（卡片不会一直空）', back,
        `rebuilt=${cacheDisk().thumbs} before=${before.thumbs}`)

      // —— B) 「清理派生预览」必须真的删掉那张高清大图，且绝不能碰缩略图
      //       （呼应头注释：缩略图删了只是秒级重建、派生删了要重新转码 —— 两个清理按钮各管各的、互不越界）——
      // 先补一张 detail.webp，让「缩略图」这一侧同时覆盖 grid 与 detail 两种文件名。
      await new Promise<void>((resolve) => {
        const rows = requireCurrent().db
          .prepare("SELECT id, type, ext, content_hash, rel_path FROM assets WHERE name='s0.png'")
          .all() as Array<never>
        ensureBatch(rows, 'detail', resolve)
      })
      const thumbsBeforeB = cacheDisk().thumbs
      check('S7 B 前置：此刻 grid.webp 与 detail.webp 都在磁盘上',
        existsSync(gridFile) && existsSync(detailFile),
        `grid=${existsSync(gridFile)} detail=${existsSync(detailFile)}`)
      await clickEl('[data-sp-clear-derived]')
      const armedD = (await js<string>("document.querySelector('[data-sp-clear-derived]')?.textContent.trim() ?? ''")) ?? ''
      check('S7 B 清理派生预览要先二次确认', armedD === '再点一次确认', armedD)
      check('S7 B 第一次点击不会真删', existsSync(preview2560))
      await clickEl('[data-sp-clear-derived]')
      await new Promise((r) => setTimeout(r, 600))
      check('S7 B 清理派生预览：preview-2560.webp 真的被删掉了（旧判据下它根本清不掉）',
        !existsSync(preview2560), `存在=${existsSync(preview2560)}`)
      check('S7 B 清理派生预览不会连带删掉缩略图（grid 与 detail 都还在）',
        existsSync(gridFile) && existsSync(detailFile) && cacheDisk().thumbs === thumbsBeforeB,
        `grid=${existsSync(gridFile)} detail=${existsSync(detailFile)} thumbs ${thumbsBeforeB}→${cacheDisk().thumbs}`)
      await capture('shot-settings-cache.png')
    }

    // ==================== S7X 缓存分类的独立验证（QA 增补：B / C / D） ====================
    // ⚠️ 判据**不复用** cache.ts 的 classify()，也不用本套件的 cacheDisk()；而是另写一份
    //    「照 preview.ts 真名规则」的独立分类器，对 .thumbs 全量 statSync 后与生产 cacheStats()
    //    三桶逐一比对（文件数 + 字节数）。两套独立判据互证，堵死 I2 的同源盲区。
    {
      const thumbsDir = join(lib.path, '.thumbs')

      // 独立分类器（真相来源 = preview.ts 的命名规则，不 import 被测的 classify）
      const kindOfMine = (name: string): 'thumbs' | 'derived' | 'other' => {
        if (name === 'grid.webp' || name === 'detail.webp') return 'thumbs'
        if (/^preview(-\d+)?\.(webp|mp3|mp4)$/.test(name)) return 'derived'
        return 'other'
      }
      type Bucket = { files: number; bytes: number; names: string[] }
      const scanMine = (): { thumbs: Bucket; derived: Bucket; other: Bucket } => {
        const mk = (): Bucket => ({ files: 0, bytes: 0, names: [] })
        const b = { thumbs: mk(), derived: mk(), other: mk() }
        const add = (name: string, abs: string): void => {
          const st = statSync(abs)
          if (!st.isFile()) return
          const k = kindOfMine(name)
          b[k].files++
          b[k].bytes += st.size
          b[k].names.push(name)
        }
        for (const e of readdirSync(thumbsDir)) {
          const abs = join(thumbsDir, e)
          if (statSync(abs).isDirectory()) {
            for (const f of readdirSync(abs)) add(f, join(abs, f))
          } else {
            add(e, abs)
          }
        }
        return b
      }

      // —— 前置：先让生产派生管线生成一张真·派生预览（preview-{当前上限}.webp）——
      const tiffX = q<{ id: number; content_hash: string }>(
        "SELECT id, content_hash FROM assets WHERE name='big.tiff'"
      )
      const pxX = getSettings().preview.maxImagePx
      const previewX = join(thumbsDir, tiffX.content_hash, `preview-${pxX}.webp`)
      const waitFileX = async (p: string): Promise<boolean> => {
        const t0 = Date.now()
        while (Date.now() - t0 < 20000) {
          if (existsSync(p)) return true
          await new Promise((r) => setTimeout(r, 200))
        }
        return existsSync(p)
      }
      if (!existsSync(previewX)) await deriveFor(tiffX.id)
      const previewXOk = await waitFileX(previewX)
      check('S7X 前置：生产派生管线生成了图片派生文件 preview-{上限}.webp',
        previewXOk, `preview-${pxX}.webp`)

      // —— B1/B2：三桶文件数与字节数与独立判据**完全一致**（derived.bytes 必须与我 stat 的相等）——
      const mine = scanMine()
      const statsX = cacheStats()
      check('S7X B1 三桶文件数 == 独立分类器（thumbs/derived/other 全部对齐）',
        statsX.thumbs.files === mine.thumbs.files &&
          statsX.derived.files === mine.derived.files &&
          statsX.other.files === mine.other.files,
        `生产=${statsX.thumbs.files}/${statsX.derived.files}/${statsX.other.files} 独立=${mine.thumbs.files}/${mine.derived.files}/${mine.other.files}`)
      check('S7X B2 三桶字节数 == 独立 statSync 求和',
        statsX.thumbs.bytes === mine.thumbs.bytes &&
          statsX.derived.bytes === mine.derived.bytes &&
          statsX.other.bytes === mine.other.bytes,
        `生产=${statsX.thumbs.bytes}/${statsX.derived.bytes}/${statsX.other.bytes} 独立=${mine.thumbs.bytes}/${mine.derived.bytes}/${mine.other.bytes}`)
      check('S7X B2 前置：derived 桶此刻非空（否则「字节数相等」是在比 0）',
        mine.derived.files > 0 && mine.derived.bytes > 0,
        `独立 derived=${mine.derived.files} 个 / ${mine.derived.bytes} B`)
      check('S7X B3 图片派生 preview-{上限}.webp 被算进生产 derived 桶（不是被漏掉）',
        mine.derived.names.includes(`preview-${pxX}.webp`) && statsX.derived.files === mine.derived.files,
        `独立 derivedNames=${JSON.stringify(mine.derived.names)}`)
      // B4：核心命题 —— 修完之后「其它」桶里**不再**含任何「真·派生预览」名。
      //     注意：preview* 的**临时文件**归 other 是刻意设计（见 cache.ts 头注释），故此处只筛真名。
      const inOtherReal = mine.other.names.filter((n) => /^preview(-\d+)?\.(webp|mp3|mp4)$/.test(n))
      check('S7X B4 「其它」桶里不含任何真·派生预览名（preview-2560.webp 这类必须在 derived）',
        inOtherReal.length === 0 && statsX.other.files === mine.other.files,
        `other 独立=${JSON.stringify(mine.other.names)}`)

      // —— DOM：面板「派生预览」卡必须 > 0 且与独立口径一致 ——
      //    切走再切回 cache 分组 → pickGroup 会重新 loadStats()（SettingsPanel.vue:111）
      await clickEl('[data-sp-group="about"]')
      await clickEl('[data-sp-group="cache"]')
      await waitFor("!!document.querySelector('[data-sp-cache-derived]')", 6000)
      await waitFor("document.querySelector('[data-sp-cache-total]')?.textContent.trim() !== '—'", 6000)
      const domDerivedBytes = (await js<string>("document.querySelector('[data-sp-cache-derived]')?.textContent.trim() ?? ''")) ?? ''
      const domDerivedFiles = (await js<number>(
        "(() => { const b = document.querySelector('[data-sp-cache-derived]'); const n = b?.parentElement?.querySelector('.sp-card-sub'); return n ? parseInt(n.textContent, 10) : -1 })()"
      )) ?? -1
      check('S7X DOM 前置：面板「派生预览」此刻 > 0（不是 0 B）',
        domDerivedBytes !== '' && domDerivedBytes !== '0 B' && domDerivedFiles > 0,
        `bytes=${domDerivedBytes} files=${domDerivedFiles}`)
      check('S7X DOM 对齐：面板「派生预览」文件数 == 独立口径（生产 → IPC → DOM 全链对齐）',
        domDerivedFiles === mine.derived.files,
        `dom=${domDerivedFiles} 独立=${mine.derived.files}`)

      // ==================== D 对抗性：像「派生」但不是「真派生」的边界名 ====================
      // 全部放进独立探针目录，逐个用「桶计数增量 + 字节增量」确定它到底落在哪一桶。
      // ⚠️ 大小写变体单独放另一个目录：NTFS 大小写不敏感，`PREVIEW-2560.WEBP` 与同目录的
      //    `preview-2560.webp` 会撞成同一个文件（实测：Δ=0 → 判不出），换个目录才是真·新文件。
      const probeDir = join(thumbsDir, 'qa-i2-probe')
      const probeCaseDir = join(thumbsDir, 'qa-i2-probe-case')
      mkdirSync(probeDir, { recursive: true })
      mkdirSync(probeCaseDir, { recursive: true })
      const cases: Array<{ name: string; expect: 'thumbs' | 'derived' | 'other'; why: string; caseDir?: boolean }> = [
        { name: 'preview.1234567890.tmp.mp4', expect: 'other', why: '视频派生中间临时文件（以 .mp4 结尾但含 .tmp）' },
        { name: 'preview.1234567890.tmp.mp3', expect: 'other', why: '音频派生中间临时文件' },
        { name: 'preview-2560.webp.tmp', expect: 'other', why: 'deriveImage 的 out.tmp 形态' },
        { name: 'preview.9999.tmp.webp', expect: 'other', why: '自补：带 .tmp 的 webp' },
        { name: 'preview.mp4', expect: 'derived', why: '视频派生真名（无 tag）' },
        { name: 'preview.mp3', expect: 'derived', why: '音频派生真名（无 tag）' },
        { name: 'preview-2560.webp', expect: 'derived', why: '图片派生真名（带尺寸 tag）—— I2 的核心' },
        { name: 'preview-1920.webp', expect: 'derived', why: '另一档尺寸的图片派生真名' },
        { name: 'grid.webp', expect: 'thumbs', why: '缩略图' },
        { name: 'detail.webp', expect: 'thumbs', why: '大缩略图' },
        { name: 'preview-.webp', expect: 'other', why: '边界：破折号后无数字 → 不匹配' },
        { name: 'preview-0.webp', expect: 'derived', why: '边界：tag=0 会匹配（项目正常不产生 maxImagePx=0）' },
        { name: 'preview.webp', expect: 'derived', why: '边界：tag 段可选 → 会匹配（图片族从不产此名，属可接受过匹配）' },
        { name: 'PREVIEW-2560.WEBP', expect: 'other', why: '边界：大写 → 不匹配（项目固定小写生成，有意为之）', caseDir: true }
      ]
      {
        const cur = cacheStats()
        let f0 = { t: cur.thumbs.files, d: cur.derived.files, o: cur.other.files }
        let b0 = { t: cur.thumbs.bytes, d: cur.derived.bytes, o: cur.other.bytes }
        for (let i = 0; i < cases.length; i++) {
          const c = cases[i]
          const size = 100 + i * 11
          writeFileSync(join(c.caseDir ? probeCaseDir : probeDir, c.name), Buffer.alloc(size))
          const s = cacheStats()
          const dt = s.thumbs.files - f0.t
          const dd = s.derived.files - f0.d
          const dob = s.other.files - f0.o
          const got = dt === 1 ? 'thumbs' : dd === 1 ? 'derived' : dob === 1 ? 'other' : 'none'
          const dbytes = got === 'thumbs' ? s.thumbs.bytes - b0.t : got === 'derived' ? s.derived.bytes - b0.d : s.other.bytes - b0.o
          check(`S7X D 归类：${c.name} → ${c.expect}`, got === c.expect && dbytes === size,
            `got=${got} bytes+${dbytes}(size=${size}) Δ=${JSON.stringify({ t: dt, d: dd, o: dob })}（${c.why}）`)
          f0 = { t: s.thumbs.files, d: s.derived.files, o: s.other.files }
          b0 = { t: s.thumbs.bytes, d: s.derived.bytes, o: s.other.bytes }
        }
        rmSync(probeDir, { recursive: true, force: true })
        rmSync(probeCaseDir, { recursive: true, force: true })
        const restored = scanMine()
        const statsR = cacheStats()
        check('S7X D 收尾：探针已清除，三桶生产口径与独立口径仍一致（无污染）',
          !existsSync(probeDir) && !existsSync(probeCaseDir) &&
            statsR.thumbs.files === restored.thumbs.files &&
            statsR.derived.files === restored.derived.files &&
            statsR.other.files === restored.other.files &&
            statsR.derived.bytes === restored.derived.bytes,
          `独立=${restored.thumbs.files}/${restored.derived.files}/${restored.other.files}`)
      }

      // ==================== C1/C2 两条不变量（磁盘实况，不只看返回计数）====================
      const s0HashX = q<{ content_hash: string }>("SELECT content_hash FROM assets WHERE name='s0.png'").content_hash
      const gridX = join(thumbsDir, s0HashX, 'grid.webp')
      const detailX = join(thumbsDir, s0HashX, 'detail.webp')
      check('S7X C 前置：grid.webp / detail.webp / preview-{上限}.webp 三样此刻都在磁盘上',
        existsSync(gridX) && existsSync(detailX) && existsSync(previewX),
        `grid=${existsSync(gridX)} detail=${existsSync(detailX)} preview=${existsSync(previewX)}`)

      // C1：清 'derived' → preview 消失，grid/detail 仍在（同步断言，杜绝竞态）
      clearCache('derived')
      check('S7X C1 清 derived 后 preview-{上限}.webp 消失', !existsSync(previewX))
      check('S7X C1 清 derived **不**动 grid.webp', existsSync(gridX))
      check('S7X C1 清 derived **不**动 detail.webp', existsSync(detailX))

      // C2：清 'thumbs' → grid/detail 消失，preview 仍在
      if (!existsSync(previewX)) await deriveFor(tiffX.id)
      const regenX = await waitFileX(previewX)
      check('S7X C2 前置：preview 已重新生成，且 grid/detail 仍在',
        regenX && existsSync(gridX) && existsSync(detailX),
        `preview=${existsSync(previewX)} grid=${existsSync(gridX)} detail=${existsSync(detailX)}`)
      clearCache('thumbs')
      check('S7X C2 清 thumbs 后 grid.webp 消失', !existsSync(gridX))
      check('S7X C2 清 thumbs 后 detail.webp 消失', !existsSync(detailX))
      check('S7X C2 清 thumbs **不**动派生预览（preview 仍在）', existsSync(previewX))

      // 收尾：把缩略图重建回来，免得后面段落卡片一片 404
      await js("window.stash.thumb.backfill('grid')")
    }

    // ==================== S6 关于页 ====================
    await clickEl('[data-sp-group="about"]')
    const aboutOpen = await waitFor("document.querySelector('.sp-h')?.textContent.trim() === '关于'")
    const ver = await js<string>("document.querySelector('[data-sp-version]')?.textContent.trim() ?? ''")
    const kvCount = await js<number>("document.querySelectorAll('.sp-kv b').length")
    check('S6 「关于」页能切换过去', aboutOpen)
    check('S6 关于页显示的版本号与主进程一致', ver === app.getVersion(), `dom=${ver} app=${app.getVersion()}`)
    check('S6 关于页列出了运行环境与数据目录', (kvCount ?? 0) >= 4, String(kvCount))
    await capture('shot-settings-about.png')

    // ==================== S9 导入 ====================
    {
      await clickEl('[data-sp-group="importing"]')
      const imOpen = await waitFor("!!document.querySelector('[data-sp-import-mode]')", 6000)
      const imCtrl = await js<Record<string, boolean>>(
        `(() => ({
           mode: !!document.querySelector('[data-sp-import-mode]'),
           dedupe: !!document.querySelector('[data-sp-dedupe]'),
           palette: !!document.querySelector('[data-sp-palette]')
         }))()`
      )
      check('S9 「导入」分组能打开且三个控件都在',
        imOpen && Object.values(imCtrl ?? {}).every(Boolean), JSON.stringify(imCtrl))
      check('S9 默认是「复制 + 去重 + 算色板」',
        diskSettings().importing.mode === 'copy' &&
          diskSettings().importing.dedupe === true &&
          diskSettings().importing.palette === true,
        JSON.stringify(diskSettings().importing))

      const names = (): string[] =>
        (requireCurrent().db.prepare('SELECT name FROM assets').all() as Array<{ name: string }>).map((r) => r.name)
      /** 轮询到条件成立（导入是异步的，不能睡固定时长就断言） */
      const until = async (fn: () => boolean, ms = 10000): Promise<boolean> => {
        const t0 = Date.now()
        while (Date.now() - t0 < ms) {
          if (fn()) return true
          await new Promise((r) => setTimeout(r, 200))
        }
        return fn()
      }

      // —— 方式：设成「移动」后导入真的会把源文件搬走 ——
      // ⚠️ 调 import.files 时**故意不传 mode**：真实的两个入口（对话框、拖入）都不传，
      // 让主进程自己按设置决定。传死 mode 的话就变成「测我自己传的值」，白测。
      const moveSrc = join(src, 'move-me.png')
      await sharp({ create: { width: 120, height: 120, channels: 3, background: '#884400' } }).png().toFile(moveSrc)
      await clickEl('[data-sp-import-mode] button:nth-child(2)') // 移动到库
      await new Promise((r) => setTimeout(r, 300))
      check('S9 切成「移动」会落盘', diskSettings().importing.mode === 'move', String(diskSettings().importing.mode))
      await js(`window.stash.import.files({ paths: [${JSON.stringify(moveSrc)}], folderId: ${folder.id} })`)
      const movedOk = await until(() => names().includes('move-me.png'))
      check('S9 「移动」方式：文件搬进库、原位置不再有它',
        movedOk && !existsSync(moveSrc), `入库=${movedOk} 源文件还在=${existsSync(moveSrc)}`)

      const copySrc = join(src, 'copy-me.png')
      await sharp({ create: { width: 120, height: 120, channels: 3, background: '#008844' } }).png().toFile(copySrc)
      await clickEl('[data-sp-import-mode] button:nth-child(1)') // 复制
      await new Promise((r) => setTimeout(r, 300))
      check('S9 切成「复制」会落盘', diskSettings().importing.mode === 'copy', String(diskSettings().importing.mode))
      await js(`window.stash.import.files({ paths: [${JSON.stringify(copySrc)}], folderId: ${folder.id} })`)
      const copiedOk = await until(() => names().includes('copy-me.png'))
      check('S9 「复制」方式：源文件留在原处', copiedOk && existsSync(copySrc),
        `入库=${copiedOk} 源文件还在=${existsSync(copySrc)}`)

      // —— 去重：同一个文件再导一次 ——
      await clickEl('[data-sp-dedupe]')
      await new Promise((r) => setTimeout(r, 300))
      check('S9 关掉「按内容去重」会落盘', diskSettings().importing.dedupe === false)
      const beforeDup = names().length
      await js(`window.stash.import.files({ paths: [${JSON.stringify(copySrc)}], folderId: ${folder.id} })`)
      const dupAdded = await until(() => names().length === beforeDup + 1)
      check('S9 关掉去重后，同一文件会再导入一份（重名自动改名）',
        dupAdded && names().includes('copy-me (1).png'), names().join(' | '))

      await clickEl('[data-sp-dedupe]')
      await new Promise((r) => setTimeout(r, 300))
      check('S9 「按内容去重」已恢复成开', diskSettings().importing.dedupe === true)
      const beforeSkip = names().length
      // 正对照（铁律 G9）：把这次导入的 `ImportResult` 抓回来 —— 它是「这一步确实跑了、且确实被判定为
      // 按内容重复而**跳过**」的独立证据（`added`/`skipped` 由主进程现场统计）。
      // 原断言只断「没多出素材」，而「什么都没发生」在那次导入**压根没跑 / 整条失败**时同样成立
      // → 是纯负向、无鉴别力的空转断言（G9）。把正对照并进同一条断言，顺便把固定 sleep 换成有界等待（铁律 G4）：
      // 监听 `import:done`（正常必达），8s 兜底超时；拿不到 → `skipRes=null` → 断言红，绝不赌时长。
      const skipRes = await js<ImportResult>(
        'new Promise((resolve) => {' +
          'const to = setTimeout(() => { off(); resolve(null) }, 8000);' +
          'const off = window.stash.import.onDone((d) => { clearTimeout(to); off(); resolve(d) });' +
          `window.stash.import.files({ paths: [${JSON.stringify(copySrc)}], folderId: ${folder.id} });` +
          '})'
      )
      check('S9 打开去重后，同一文件被跳过（没有多出素材）',
        names().length === beforeSkip && skipRes?.skipped === 1 && skipRes?.added === 0,
        `${beforeSkip} → ${names().length}｜ImportResult=${JSON.stringify(skipRes)}`)

      // —— 色板：关掉之后新导入的图片不该再回写色板 ——
      // 色板是缩略图生成时顺带回写的，所以要等它的 grid 缩略图出来再看，
      // 再多等一会儿——「本不该发生」的计算若真跑了，这段时间足够它落库（抓现行）。
      await clickEl('[data-sp-palette]')
      await new Promise((r) => setTimeout(r, 300))
      check('S9 关掉「生成主色板」会落盘', diskSettings().importing.palette === false)
      const palSrc = join(src, 'nopal.png')
      await sharp({ create: { width: 200, height: 200, channels: 3, background: '#AA3355' } }).png().toFile(palSrc)
      await js(`window.stash.import.files({ paths: [${JSON.stringify(palSrc)}], folderId: ${folder.id} })`)
      const palRow = (): { content_hash: string; palette: string | null } | undefined =>
        requireCurrent().db
          .prepare("SELECT content_hash, palette FROM assets WHERE name='nopal.png'")
          .get() as { content_hash: string; palette: string | null } | undefined
      const palIn = await until(() => !!palRow())
      check('S9 关掉色板不影响导入本身', palIn)
      const thumbReady = await until(
        () => existsSync(join(lib.path, '.thumbs', palRow()?.content_hash ?? 'x', 'grid.webp')),
        25000
      )
      await new Promise((r) => setTimeout(r, 900))
      // ⚠️ 判据只能写 `=== null`：写成 `(x?.palette ?? 'n/a') === null` 的话，
      // `??` 连 null 一起吞掉 → 永远得到 'n/a' → 这条断言永远红（本轮真就这么错的，
      // 而这恰恰是它要抓的那类「空值合并」坑）。
      check('S9 关掉色板后，新导入的图片不会再回写色板',
        thumbReady && palRow()?.palette === null,
        `缩略图=${thumbReady} palette=${String(palRow()?.palette)}`)
      await clickEl('[data-sp-palette]')
      await new Promise((r) => setTimeout(r, 250))
      check('S9 「生成主色板」已恢复成开', diskSettings().importing.palette === true)

      // —— S9c 色板补算：存量素材（缩略图已缓存、色板为空）必须能自动补上 ——
      // 这就是用户报的场景：nopal.png 是在开关关着时导入的，缩略图已生成并缓存，
      // 而旧实现只在「缩略图**本次新生成**」时回写色板 → 这张图的色板**永远补不上**，
      // 只能去清缓存重建。现在应该只要重跑一次 backfill 就补上。
      const nopalRow = (): { id: number; content_hash: string | null; palette: string | null } =>
        requireCurrent().db
          .prepare("SELECT id, content_hash, palette FROM assets WHERE name='nopal.png'")
          .get() as { id: number; content_hash: string | null; palette: string | null }
      const nopalGrid = (): string => join(lib.path, '.thumbs', nopalRow().content_hash ?? 'x', 'grid.webp')
      check(
        'S9c 前置：该素材此刻「缩略图已缓存 + 色板为空」（正是用户遇到的状态）',
        existsSync(nopalGrid()) && nopalRow().palette === null,
        `grid存在=${existsSync(nopalGrid())} palette=${String(nopalRow().palette)}`
      )

      await new Promise<void>((resolve) => {
        const rows = requireCurrent().db
          .prepare("SELECT id, type, ext, content_hash, rel_path FROM assets WHERE name='nopal.png'")
          .all() as Array<never>
        ensureBatch(rows, 'grid', resolve)
      })
      check(
        'S9c 打开色板后重跑 backfill，缩略图已缓存的存量素材也会补算色板（不必清缓存重建）',
        /^\["#/.test(String(nopalRow().palette)),
        String(nopalRow().palette)
      )
      await capture('shot-settings-import.png')
    }

    // ==================== S10 库与存储 ====================
    {
      await clickEl('[data-sp-group="library"]')
      const libOpen = await waitFor("!!document.querySelector('[data-sp-scan]')", 6000)
      await waitFor(
        "(document.querySelector('[data-sp-lib-missing]')?.textContent ?? '').trim() !== ''",
        6000
      )
      const nameShown =
        (await js<string>("document.querySelector('[data-sp-lib-name]')?.textContent.trim() ?? ''")) ?? ''
      const libAssets =
        (await js<string>("document.querySelector('[data-sp-lib-assets]')?.textContent.trim() ?? ''")) ?? ''
      check('S10 「库与存储」分组能打开且读到库信息', libOpen, libAssets)
      check('S10 显示的是当前库的名称', nameShown === lib.name, `dom=${nameShown} lib=${lib.name}`)
      check('S10 有「打开库目录 / 打开数据目录」入口',
        (await js<boolean>("!!document.querySelector('[data-sp-open-lib]')")) === true &&
          (await js<boolean>("!!document.querySelector('[data-sp-lib-data-dir]')")) === true)
      check('S10 读到了素材数与占用', /个/.test(libAssets) && /B|KB|MB|GB/.test(libAssets), libAssets)

      // —— 体检：在软件外删掉一个素材文件，应当被找出来 ——
      const victim = q<{ rel_path: string }>("SELECT rel_path FROM assets WHERE name='copy-me.png'")
      unlinkSync(join(lib.path, ...victim.rel_path.split('/')))
      await new Promise((r) => setTimeout(r, 600))
      await clickEl('[data-sp-scan]')
      const scanDone = await waitFor("!!document.querySelector('[data-sp-scan-result]')", 20000)
      const scanText = (await js<string>("document.querySelector('[data-sp-scan-result]')?.textContent.trim() ?? ''")) ?? ''
      check('S10 体检能跑出结果', scanDone, scanText)
      check('S10 体检找出了「文件已不在磁盘」的那个素材',
        scanText.includes('copy-me.png') && /1\s*个/.test(scanText), scanText)
      const missingTxt = (await js<string>("document.querySelector('[data-sp-lib-missing]')?.textContent.trim() ?? ''")) ?? ''
      check('S10 体检后「失效记录」数变成 1', /^1/.test(missingTxt), missingTxt)

      // —— 清理：点两次才生效，且**绝不碰磁盘上还在的文件** ——
      const rowCount = (): number => (q<{ c: number }>('SELECT count(*) AS c FROM assets')).c
      const survivor = q<{ rel_path: string }>("SELECT rel_path FROM assets WHERE name='s0.png'")
      const beforeRows = rowCount()
      await clickEl('[data-sp-clean-missing]')
      const armedTxt = (await js<string>("document.querySelector('[data-sp-clean-missing]')?.textContent.trim() ?? ''")) ?? ''
      check('S10 清理失效记录要先二次确认', armedTxt === '再点一次确认', armedTxt)
      check('S10 第一次点击不会真删', rowCount() === beforeRows, String(rowCount()))
      await clickEl('[data-sp-clean-missing]')
      await new Promise((r) => setTimeout(r, 900))
      check('S10 第二次点击才真的删掉失效索引行', rowCount() === beforeRows - 1, `${beforeRows} → ${rowCount()}`)
      check('S10 清理不碰磁盘上还在的素材文件', existsSync(join(lib.path, ...survivor.rel_path.split('/'))))
      const missingAfter = (await js<string>("document.querySelector('[data-sp-lib-missing]')?.textContent.trim() ?? ''")) ?? ''
      check('S10 清理后失效记录归零', /^0/.test(missingAfter), missingAfter)

      // —— 移除库（只删记录，不碰磁盘）：只验「要点两次」，不真点第二次（点了当前库就被关掉了，后面几段就没库可用）——
      await clickEl('[data-sp-delete-lib]')
      const delArmed = (await js<string>("document.querySelector('[data-sp-delete-lib]')?.textContent.trim() ?? ''")) ?? ''
      check('S10 移除库要先二次确认', delArmed === '再点一次确认', delArmed)
      check('S10 第一次点击不会真移除库', existsSync(join(lib.path, '.stash')))
      // 换个分组再回来：二次确认必须被收掉（不然回到这一组会让人以为已经点过一次了）
      await clickEl('[data-sp-group="shortcuts"]')
      await waitFor("!!document.querySelector('[data-sp-shortcuts]')", 6000)
      await clickEl('[data-sp-group="library"]')
      await waitFor("!!document.querySelector('[data-sp-delete-lib]')", 6000)
      const delReset = (await js<string>("document.querySelector('[data-sp-delete-lib]')?.textContent.trim() ?? ''")) ?? ''
      check('S10 换分组会收掉「移除」的二次确认', delReset === '移除此库', delReset)
      await capture('shot-settings-library.png')
    }

    // ==================== S11b 侧栏「占用空间」 ====================
    {
      // 关掉设置面板，让侧栏露出来
      await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
      await new Promise((r) => setTimeout(r, 400))

      // ① 位置与文案：必须在「设置」上方（用户明确要求的位置）
      const raw = (await js<string>(`(() => {
        const u = document.querySelector('[data-side-usage]')
        const s = document.querySelector('[data-open-settings]')
        if (!u || !s) return ''
        const ur = u.getBoundingClientRect()
        const sr = s.getBoundingClientRect()
        return JSON.stringify({
          ub: Math.round(ur.bottom),
          st: Math.round(sr.top),
          w: Math.round(ur.width),
          h: Math.round(ur.height),
          txt: (u.querySelector('[data-side-usage-value]')?.textContent ?? '').trim(),
          title: u.getAttribute('title') ?? ''
        })
      })()`)) as string | null
      const g = raw ? (JSON.parse(raw) as { ub: number; st: number; w: number; h: number; txt: string; title: string }) : null
      check('S11b 侧栏有「占用空间」这一行', !!g && g.w > 0 && g.h > 0, raw ?? '(元素不存在)')
      check('S11b 它排在「设置」上方', !!g && g.ub <= g.st + 1, g ? `usage.bottom=${g.ub} settings.top=${g.st}` : '')
      check('S11b 显示的是格式化后的大小（不是裸字节数）',
        !!g && /^\d+(\.\d+)? (B|KB|MB|GB)$/.test(g.txt), g?.txt)
      check('S11b 悬停提示里把素材与缓存分开列',
        !!g && /素材 .+ · 缩略图缓存 .+/.test(g.title), g?.title)
      await capture('shot-settings-usage.png')

      // ② 数值本身：素材取自索引、缓存是真扫目录算的
      const u1 = libraryUsage()
      const sumAssets = q<{ c: number }>('SELECT coalesce(sum(size),0) AS c FROM assets WHERE missing=0').c
      check('S11b 服务层：素材占用 = 索引里有效素材 size 之和', u1.assetsBytes === sumAssets,
        `${u1.assetsBytes} vs ${sumAssets}`)

      // 显式前置（铁律 G11 形态②/③）：证明「素材占用」与「缓存占用」两边都 > 0，
      // 否则下面的磁盘比对会退化成 `0 === 0` 式空转（什么都不验也绿）。
      check('S11b 前置：素材占用与缓存占用都 > 0（否则「缓存 == 磁盘实扫」会退化成 0===0 空转）',
        u1.assetsBytes > 0 && u1.thumbsBytes > 0,
        `assetsBytes=${u1.assetsBytes} thumbsBytes=${u1.thumbsBytes}`)

      // 独立口径（铁律 G11：判据不得复用被测实现 —— 这里**自写**一遍，不 import 产线的 `thumbsDirBytes()`）。
      // 原断言 `u1.totalBytes === u1.assetsBytes + u1.thumbsBytes` 是**定义式恒等式**：`totalBytes` 在主进程里
      // 就是这么加出来的（health.ts:91），把「定义」重念一遍 → 恒真，`thumbsDirBytes()` 整个漏算也照样绿。
      // 换成「与独立实现逐字节比对」才有鉴别力。
      //
      // ⚠️ **口径必须与产线严格一致**（否则这条断言会比产线更严 → 只会**假红**、不会假绿）：
      //   · 产线把 `.thumbs` 的每个顶层项**当作目录**去 `readdirSync`：顶层若是**文件**
      //     （如 `placeholder-{audio|text}.webp`、生成期的顶层 `*.tmp`）→ ENOTDIR → `continue` → **不计**；
      //   · 只在 `.thumbs/{hash}/` 这一层累加 `statSync(...).size`，**不再往下递归**（更深项只取其目录自身 size）。
      //   → 所以这里也严格照此口径：只对「能作为目录读出的顶层项」取其**直接子项**的 stat size；**顶层文件跳过、不递归**。
      //     （QA 实测复刻：旧的递归实现会把顶层占位图算进去 → 一旦库里有音频/文本素材就假红。）
      const thumbsDirBytesSameScope = (root: string): number => {
        let tops: Dirent[]
        try {
          tops = readdirSync(root, { withFileTypes: true })
        } catch {
          return 0 // 还没生成过任何缩略图（与产线语义一致）
        }
        let total = 0
        for (const t of tops) {
          if (!t.isDirectory()) continue // 顶层文件（占位图 / 临时文件）不计 —— 与产线口径一致
          const dir = join(root, t.name)
          let files: string[]
          try {
            files = readdirSync(dir)
          } catch {
            continue
          }
          for (const f of files) {
            try {
              total += statSync(join(dir, f)).size
            } catch {
              /* 正被写入 / 刚被清理 → 跳过 */
            }
          }
        }
        return total
      }
      const thumbsWalked = thumbsDirBytesSameScope(join(lib.path, '.thumbs'))
      check('S11b 服务层：缓存占用 == 独立实现（与产线同口径）实扫 .thumbs 的字节数（改前比的是 total==assets+thumbs 定义式恒等式，恒真无鉴别力）',
        u1.thumbsBytes === thumbsWalked,
        `产线 thumbsBytes=${u1.thumbsBytes} 独立实扫=${thumbsWalked}`)

      // 往 .thumbs 里塞 4KB 再读一次：数值必须跟着涨（证明不是写死的常量/缓存）
      const probeHash = join(lib.path, '.thumbs', 'zz-probe-usage')
      mkdirSync(probeHash, { recursive: true })
      writeFileSync(join(probeHash, 'grid.webp'), Buffer.alloc(4096))
      const u2 = libraryUsage()
      check('S11b 缓存占用是实扫目录算出来的（塞 4KB 进去，数值跟着涨）',
        u2.thumbsBytes === u1.thumbsBytes + 4096, `${u1.thumbsBytes} → ${u2.thumbsBytes}`)
      rmSync(probeHash, { recursive: true, force: true })
      check('S11b 移除探针后数值回落', libraryUsage().thumbsBytes === u1.thumbsBytes,
        String(libraryUsage().thumbsBytes))

      // ⚠️ 必须把面板开回去：后面的「快捷键页」段还要在设置面板里查 DOM。
      // 这一段为了看侧栏把面板 Esc 掉了，不恢复就会把下一段整片弄红（实测踩过）。
      await clickEl('[data-open-settings]')
      await waitFor("!!document.querySelector('[data-settings-panel]')", 6000)
    }

    // ==================== S11 快捷键（只读） ====================
    {
      await clickEl('[data-sp-group="shortcuts"]')
      const scOpen = await waitFor("!!document.querySelector('[data-sp-shortcuts]')", 6000)
      const rows = await js<Array<{ keys: string; what: string }>>(
        `[...document.querySelectorAll('[data-sp-shortcuts] .sp-key-row')].map((r) => ({
           keys: r.querySelector('.sp-kbd')?.textContent.trim() ?? '',
           what: r.querySelector('.sp-key-what')?.textContent.trim() ?? ''
         }))`
      )
      check('S11 快捷键页有内容', scOpen && (rows?.length ?? 0) >= 8, String(rows?.length))
      check('S11 每条键位都有说明（没有空行）',
        (rows ?? []).every((r) => r.keys.length > 0 && r.what.length > 0), JSON.stringify(rows))
      const keys = (rows ?? []).map((r) => r.keys)
      check('S11 列出的都是真实存在的键位（含 Esc / 复制 / 双击卡片）',
        keys.includes('Esc') && keys.some((k) => k.includes('Ctrl/⌘ + C')) && keys.some((k) => k.includes('双击')),
        JSON.stringify(keys))
      // 这一组**只读**：里面混进任何可点控件就说明开始做「假设置」了
      const interactive = await js<number>(
        "document.querySelectorAll('[data-sp-shortcuts] button, [data-sp-shortcuts] input, [data-sp-shortcuts] [role=\"switch\"]').length"
      )
      check('S11 快捷键页是只读的（没有可点控件）', interactive === 0, String(interactive))
      await capture('shot-settings-shortcuts.png')
    }

    // ==================== S3 持久化（reload 后仍然生效） ====================
    // 说明：这条验的是「启动时从后端重新读一次」，不是「落盘」—— 主进程的 config 有内存缓存，
    // 窗口 reload 不会清它。真正的落盘由上面那一堆 diskSettings() 断言负责，两条合起来才完整
    // （注入验证时确认过：把 save() 改坏，落盘断言全红、这条仍然是绿的）。
    await reload()
    await new Promise((r) => setTimeout(r, 500))
    const persisted = await js<{ view: string; badge: number; detail: boolean; zoom: number }>(
      `(() => ({
         view: document.querySelector('.masonry-card') ? 'masonry' : 'list',
         badge: document.querySelectorAll('.thumb-type').length,
         detail: !!document.querySelector('.detail'),
         zoom: Number(document.querySelector('[data-sp-zoom]')?.value ?? 0)
       }))()`
    )
    check('S3 reload 后设置仍然生效（不是只存在内存里）',
      persisted?.view === 'masonry' && persisted?.badge === 0 && persisted?.detail === false,
      JSON.stringify(persisted))

    // ==================== S4 旧 localStorage 偏好迁移 ====================
    // 造一份「老版本留下的偏好」再 reload：值要进 config，键要被清掉（因此只迁一次）
    await js(
      "localStorage.setItem('stash.viewZoom','245');" +
        "localStorage.setItem('stash.cardFields', JSON.stringify({ name: true, dims: false, size: true, time: false }));" +
        "localStorage.setItem('stash.detailCollapsed','1');'ok'"
    )
    await reload()
    await new Promise((r) => setTimeout(r, 500))
    const d = diskSettings()
    const legacyLeft = await js<boolean>(
      "(localStorage.getItem('stash.viewZoom') !== null || localStorage.getItem('stash.cardFields') !== null || localStorage.getItem('stash.detailCollapsed') !== null)"
    )
    check('S4 旧 localStorage 的缩放被迁进 config', d.viewZoom === 245, String(d.viewZoom))
    check('S4 旧 localStorage 的字段开关被迁进 config', d.cardFields.dims === false && d.cardFields.time === false,
      JSON.stringify(d.cardFields))
    check('S4 旧 localStorage 的「详情栏收起」被迁进 config', d.detailCollapsed === true)
    check('S4 迁移后旧键被清掉（因此只会迁一次）', legacyLeft === false)

    // ==================== S5 恢复默认 ====================
    await openPanel()
    await clickEl('[data-sp-reset]')
    const armedText = await js<string>("document.querySelector('[data-sp-reset]')?.textContent.trim() ?? ''")
    check('S5 恢复默认要点两次（第一次只是二次确认）', armedText === '再点一次确认', armedText ?? '')
    const stillNotDefault = diskSettings().viewZoom === 245
    check('S5 第一次点击不会真的重置', stillNotDefault, String(diskSettings().viewZoom))
    await clickEl('[data-sp-reset]')
    await new Promise((r) => setTimeout(r, 450))
    const after = diskSettings()
    const domDefault = await js<{ masonry: boolean; badge: number; detail: boolean }>(
      `(() => ({
         masonry: !!document.querySelector('.masonry-card'),
         badge: document.querySelectorAll('.thumb-type').length,
         detail: !!document.querySelector('.detail')
       }))()`
    )
    // ⚠️ 只比「外观」那几项：`恢复默认外观` 刻意不碰缩略图管线（那是性能设置，不是外观），
    // 拿整个 settings 去比会把 S7 改过的并发/质量也算进来 → 假红（第一版就是这么红的）
    const appearanceOf = (v: Settings): string =>
      JSON.stringify({
        defaultView: v.defaultView,
        viewZoom: v.viewZoom,
        cardFields: v.cardFields,
        detailCollapsed: v.detailCollapsed
      })
    check('S5 第二次点击后 config 回到默认外观',
      appearanceOf(after) === appearanceOf(DEFAULT_SETTINGS), JSON.stringify(after))
    check('S5 恢复默认外观不会顺手改掉缩略图管线设置',
      after.thumbs.concurrency === 2 && after.thumbs.quality === 92, JSON.stringify(after.thumbs))
    check('S5 恢复默认后 DOM 也跟着变回来（瀑布 + 角标 + 详情栏都在）',
      domDefault?.masonry === true && (domDefault?.badge ?? 0) > 0 && domDefault?.detail === true,
      JSON.stringify(domDefault))

    // ==================== S12 切换库不该串号 ====================
    // 用户报：「多个库切换，原来别的比例的预览图都变成 1:1」。
    // 根因：卡片「实测比例」那张 Map 以**素材 id** 为键、切库时又不清空，而每个库的 id 都从 1 开始；
    // 音频/文本的缩略图是 320×320 的占位图（实测比例 = 1），于是切到图片库之后，
    // 相同 id 的图片就全被渲染成正方形。
    // 这一段拿两个受控临时库复现：X 库 id=1 是 400×200 的图（比例 0.5），Y 库 id=1 是 txt（占位图 1:1）。
    {
      const xDir = mkdtempSync(join(tmpdir(), 'stash-smoke-ratio-x-'))
      const yDir = mkdtempSync(join(tmpdir(), 'stash-smoke-ratio-y-'))
      // 新库没有现成的文件夹行（createLibrary 只建 .thumbs 与 meta），所以先建一个再导入
      const makeFolder = (): number => mkdirRel('素材').id
      /** 导入并等这一批缩略图跑完 —— 不等的话渲染层切过去时 img 还没生成，量不到高度 */
      const importAndThumbs = async (path: string): Promise<void> => {
        await new Promise<void>((resolve) => {
          importFiles({ paths: [path], folderId: makeFolder(), mode: 'copy', onDone: () => resolve() })
        })
        await new Promise<void>((resolve) => {
          const rows = requireCurrent().db
            .prepare('SELECT id, type, ext, content_hash, rel_path FROM assets')
            .all() as Array<never>
          ensureBatch(rows, 'grid', resolve)
        })
      }

      const xLib = createLibrary({ name: 'ratio-x', parentDir: xDir })
      const widePng = join(xDir, 'wide.png')
      await sharp({ create: { width: 400, height: 200, channels: 3, background: '#336699' } }).png().toFile(widePng)
      const tallPng = join(xDir, 'tall.png')
      await sharp({ create: { width: 200, height: 400, channels: 3, background: '#996633' } }).png().toFile(tallPng)
      await importAndThumbs(widePng) // 先导这张 → 它拿到 id=1
      await importAndThumbs(tallPng) // 第二张只是让 X 库有 2 个卡片，好跟 Y 库（1 个）区分开

      const yLib = createLibrary({ name: 'ratio-y', parentDir: yDir })
      const noteTxt = join(yDir, 'note.txt')
      writeFileSync(noteTxt, 'ratio smoke')
      await importAndThumbs(noteTxt)

      // 主进程切回本套件原来的库；渲染层全程没动过，所以两边仍然一致
      openLibrary(lib.path)

      // ⚠️ 切库必须走**真实的 UI 入口**。IPC + location.reload() 那种做法会把组件状态一起清掉
      // （等于重启软件），而脏值本来只在内存里 —— 那样就复现不出来了。
      // 这里把系统目录选择框拦掉，点「打开库…」→ 走真实的 switchTo()。
      const origPickDialog = dialog.showOpenDialog
      let nextPick = ''
      dialog.showOpenDialog = (async () =>
        nextPick ? { canceled: false, filePaths: [nextPick] } : { canceled: true, filePaths: [] }) as typeof dialog.showOpenDialog

      const switchLibByPick = async (target: string): Promise<boolean> => {
        nextPick = target
        await js("document.querySelector('.lib-menu-backdrop')?.click(); true") // 先关掉可能开着的菜单
        await new Promise((r) => setTimeout(r, 150))
        await js("document.querySelector('.tab-select')?.click(); true")
        const opened = await waitFor("!!document.querySelector('.lib-menu')", 5000)
        if (!opened) return false
        const hit = await js<boolean>(
          `(() => {
             const el = [...document.querySelectorAll('.lib-menu .lib-menu-item.action')]
               .find((n) => (n.textContent ?? '').includes('打开库'))
             if (!el) return false
             el.click()
             return true
           })()`
        )
        if (!hit) return false
        // ⚠️ 必须等**标题栏的库名**变过去再继续：两个库的素材 id 都是 1，
        // 只等 `.masonry-card[data-id="1"]` 的话，上一个库的旧卡片还在 DOM 里 → 立刻命中
        // → 后面量到的还是旧库的几何，断言就假绿了（注入验证时踩到过）。
        const want = basename(target)
        return waitFor(
          `(document.querySelector('.tab-select')?.textContent ?? '').includes(${JSON.stringify(want)})`,
          20000
        )
      }
      /** 当前标题栏显示的库名（断言 detail 里带上它，假绿时一眼能看出停在了哪个库） */
      const libNameNow = async (): Promise<string> =>
        ((await js<string>("document.querySelector('.tab-select')?.textContent ?? ''")) ?? '').trim()
      const thumbH = async (id: number): Promise<number | null> => {
        const v = await js<number | null>(
          `(() => { const el = document.querySelector('.masonry-card[data-id="${id}"] .thumb'); return el ? Math.round(el.getBoundingClientRect().height) : null })()`
        )
        return typeof v === 'number' ? v : null
      }
      const cardW = async (id: number): Promise<number | null> => {
        const v = await js<number | null>(
          `(() => { const el = document.querySelector('.masonry-card[data-id="${id}"]'); return el ? Math.round(el.getBoundingClientRect().width) : null })()`
        )
        return typeof v === 'number' ? v : null
      }
      /**
       * 等「切库真的生效 + 这一库的列表真的渲染完 + 目标卡片的图真的加载完」。
       * 三重判据缺一不可：只等卡片的话，上一个库的旧卡片还在 DOM 里（两库的 id 都是 1），
       * 会立刻命中 → 量到旧库的几何 → 断言假绿。
       *
       * ⚠️ 「渲染完」的判据**不能**是 `querySelectorAll('.masonry-card').length === expectCards`
       * （§10.3 纪律 4「DOM 基数 ≠ 数据基数」）：容器宽度 / viewZoom / 卡片高度稍有不同，
       * 窗口渲染的条数就可能少于库里的条数，那条等号会永远等不到 → 假红；
       * 反过来，切库瞬间旧库的卡还没换掉 → 假绿。两个方向都错过。
       * 现在读 `__vsDebug().dataTotal`（= `assets.total`，即「这一库查出来几条」），
       * 再靠后面的「目标卡片的 img 真的加载完」证明**渲染**也到位。
       * `__vsDebug` 在切库瞬间可能短暂缺失（组件重建），所以用 `!!window.__vsDebug &&` 继续轮询。
       */
      const settledLib = async (libName: string, expectCards: number, id: number): Promise<boolean> => {
        const nameOk = await waitFor(
          `(document.querySelector('.tab-select')?.textContent ?? '').includes(${JSON.stringify(libName)})`,
          20000
        )
        if (!nameOk) return false
        const countOk = await waitFor(
          `!!window.__vsDebug && window.__vsDebug().dataTotal === ${expectCards}`,
          20000
        )
        if (!countOk) return false
        return waitFor(
          `(() => { const im = document.querySelector('.masonry-card[data-id="${id}"] img.thumb-img'); return !!im && im.complete && im.naturalWidth > 0 })()`,
          20000
        )
      }

      const goX = await switchLibByPick(xLib.path)
      const s1 = await settledLib('ratio-x', 2, 1)
      const h1 = await thumbH(1)
      const w1 = await cardW(1)

      const goY = await switchLibByPick(yLib.path)
      const s2 = await settledLib('ratio-y', 1, 1) // 这一步会让渲染层加载 1:1 的占位图（旧实现就在这记脏了 id=1）

      const backX = await switchLibByPick(xLib.path)
      const s3 = await settledLib('ratio-x', 2, 1)
      const h2 = await thumbH(1)
      // 判据说明：这条断言盯的是**判断顺序**（索引尺寸优先于实测值）——
      // 注入验证就是把 ratioOf 的顺序改回去、断言转红（detail 里会看到「切库后=186」，
      // 正好等于卡片内宽 = 正方形）。X 库的图 DB 有尺寸，所以键与「切库清空」这两处加固
      // 不在这条断言的覆盖范围内（它们管的是「DB 缺尺寸、只能靠实测兜底」的素材）。
      const nameAtEnd = await libNameNow()

      check(
        'S12 前置：X 库那张 400×200 的图确实按非正方形渲染（否则这条断言抓不到东西）',
        goX && goY && backX && s1 && s2 && s3 && h1 != null && w1 != null && h1 < w1 - 8,
        `切库=${goX}/${goY}/${backX} 就绪=${s1}/${s2}/${s3} 缩略图高=${h1} 卡片宽=${w1} 当前库=${nameAtEnd}`
      )
      check(
        'S12 切到别的库再切回来，图片的宽高比不会被带偏（不会变成 1:1）',
        h1 != null && h1 === h2,
        `首次=${h1} 切库后=${h2}（卡片宽=${w1}，若后者≈宽说明被渲染成正方形了）`
      )

      // 收尾：把系统对话框换回去、切回本套件原来的库、删掉两个临时库目录
      dialog.showOpenDialog = origPickDialog
      openLibrary(lib.path)
      for (const d of [xDir, yDir]) {
        try {
          rmSync(d, { recursive: true, force: true })
        } catch { /* 句柄没释放就留着，系统会回收 */ }
      }
    }

    // ==================== UF 检查更新 / GitHub 入口（QA 增补） ====================
    // ⚠️ 本段最硬的两条边界：**绝不碰真实网络、绝不真的拉起浏览器**。做法：
    //   · 纯函数（版本比较 / Location 解析 / 白名单）在主进程**直接 import 后调用**，不经过 IPC；
    //   · `checkLatest` 一律注入 `fetchLocation`（工程师专门留的注入口）→ 一个请求都不发；
    //   · IPC 只走**会被拒绝**的路径：`ERR_URL_NOT_ALLOWED` 在 `shell.openExternal` 之前就抛了；
    //   · 三态文案必须把 UI 真跑起来才看得见，而真实 `update:check` 会联网（本机 github.com 实测
    //     5036ms 超时 / 606ms 成功 —— 时通时不通，拿它做断言等于掷骰子）。所以这里把 IPC handler
    //     换成**测试替身**：渲染层 → preload → IPC → Vue 状态机 → DOM 这条真链路一条不少，
    //     只把「网络」那一层替掉（与注入 `fetchLocation` 同一思路，只是往下挪一层）。
    //     替身生效前先用探针自证（否则万一是真 handler 在跑，点 GitHub 图标就真弹浏览器了），
    //     跑完立刻在 finally 里还原成等价实现。
    {
      // ---------- UF-1 版本比较：必须逐段按数字比 ----------
      // 本单的命门：字符串比较里 `'0.1.10' < '0.1.9'`（'1' < '9'），而 0.1.10 恰恰是最常见的
      // 下一个版本号 —— 判反了就是「有新版」永远提示不出来，且「已最新」永远假绿。
      check('UF-1 版本比较：0.1.10 > 0.1.9（字符串比较会判反，这条必须有）',
        compareVersion('0.1.10', '0.1.9') === 1, String(compareVersion('0.1.10', '0.1.9')))
      const verCases: Array<[string, string, number]> = [
        ['0.2.0', '0.1.99', 1],
        ['1.0.0', '0.9.9', 1],
        ['0.1.8', '0.1.8', 0],
        ['v0.1.9', '0.1.8', 1],
        ['1.0.0', '1', 0], // 缺段补 0
        ['0.1.9', '0.1.10', -1] // 反向比较
      ]
      for (const [a, b, want] of verCases) {
        const got = compareVersion(a, b)
        check(`UF-1 版本比较：${a} vs ${b} → ${want}`, got === want, String(got))
      }

      // ---------- UF-2 从 302 的 Location 里解析 tag ----------
      const locCases: Array<[string, string | null]> = [
        ['https://github.com/o/r/releases/tag/v0.1.9', '0.1.9'],
        ['https://github.com/o/r/releases/tag/v0.1.9/', '0.1.9'], // 尾斜杠
        ['https://github.com/o/r/releases/tag/v0.1.9?foo=bar#x', '0.1.9'], // query / hash
        ['https://github.com/o/r/releases/tag/0.1.9', '0.1.9'], // 无 v 前缀
        ['https://evil.com/o/r/releases/tag/v0.1.9', null], // 非 GitHub 域名
        ['https://github.com/o/r/releases', null], // 没 /tag/ 段
        ['', null], // 空串
        ['file:///C:/releases/tag/v0.1.9', null], // 非 http(s)
        ['https://github.com/o/r/releases/tag/latest', null] // 段不是版本号
      ]
      for (const [input, want] of locCases) {
        const got = parseTagFromLocation(input)
        check(`UF-2 Location 解析：${input || '(空串)'} → ${want === null ? 'null' : want}`,
          got === want, String(got))
      }

      // ---------- UF-3 白名单：安全关键，逐条断 ----------
      // 只放行本仓库的 GitHub 页面。下面这些「像但不是」的一个都不能漏。
      const denyUrls: Array<[string, string]> = [
        ['http://github.com/Zizzp0318/Stash', '非 https'],
        ['https://github.com/evil/Stash', '别人的仓库'],
        ['https://github.com/Zizzp0318/StashX', '段边界（StashX 不是 Stash）'],
        ['https://github.com/Zizzp0318/Stash/../evil', '../ 规范化后越界'],
        ['https://github.com@evil.com/Zizzp0318/Stash', '前缀骗术（真的 host 是 evil.com）'],
        ['file:///C:/Windows/System32/cmd.exe', '本地文件协议'],
        ['', '空串']
      ]
      for (const [u, why] of denyUrls) {
        check(`UF-3 白名单必须拒绝：${u || '(空串)'}（${why}）`, isAllowedExternalUrl(u) === false)
      }
      const allowUrls: Array<[string, string]> = [
        [REPO_URL, '仓库主页'],
        [RELEASES_URL, 'Releases 页（GitHub 图标 / 去下载 用这个）'],
        [`${REPO_URL}/releases/tag/v0.1.9`, '某个 tag 页'],
        [`${REPO_URL}/`, '带尾斜杠']
      ]
      for (const [u, why] of allowUrls) {
        check(`UF-3 白名单必须放行：${u}（${why}）`, isAllowedExternalUrl(u) === true)
      }

      // ---------- UF-4 checkLatest 三态（全部注入，零网络） ----------
      const okRes: UpdateCheckResult = await checkLatest({
        fetchLocation: async () => `${REPO_URL}/releases/tag/v0.1.9`
      })
      check('UF-4 注入合法 Location → { latest:"0.1.9", url:RELEASES_URL }，且没有 error 键',
        !('error' in okRes) && okRes.latest === '0.1.9' && okRes.url === RELEASES_URL,
        JSON.stringify(okRes))
      // 顺带：非法 timeoutMs 不该把一次正常检查变成失败态（归一化在 checkLatest 里）
      const weirdTimeout: UpdateCheckResult = await checkLatest({
        timeoutMs: -1,
        fetchLocation: async () => `${REPO_URL}/releases/tag/v0.2.0`
      })
      check('UF-4 非法 timeoutMs 不影响结论（归一化到默认值，不 reject）',
        !('error' in weirdTimeout) && weirdTimeout.latest === '0.2.0', JSON.stringify(weirdTimeout))

      const noLoc: UpdateCheckResult = await checkLatest({ fetchLocation: async () => null })
      check('UF-4 注入 null → { error:"ERR_NO_LOCATION" }',
        'error' in noLoc && noLoc.error === 'ERR_NO_LOCATION', JSON.stringify(noLoc))

      const badLoc: UpdateCheckResult = await checkLatest({
        fetchLocation: async () => `${REPO_URL}/releases/tag/latest`
      })
      check('UF-4 注入非版本 tag（latest）→ { error:"ERR_BAD_LOCATION" }',
        'error' in badLoc && badLoc.error === 'ERR_BAD_LOCATION', JSON.stringify(badLoc))

      // 抛错（同步 / 异步各一）：必须收敛成 { error }，**绝不 throw** —— 否则 IPC 层 reject，
      // 渲染层的 checkUpdate() 会卡在 checking 态（没有 catch），按钮永远 disabled。
      const syncThrower = (): Promise<string | null> => {
        throw new Error('BOOM-SYNC')
      }
      let syncRes: UpdateCheckResult | null = null
      let syncThrew = ''
      try {
        syncRes = await checkLatest({ fetchLocation: syncThrower })
      } catch (e) {
        syncThrew = String((e as Error)?.message ?? e)
      }
      check('UF-4 fetchLocation 同步抛错 → 收敛成 { error }，绝不 throw',
        syncThrew === '' && syncRes !== null && 'error' in syncRes && syncRes.error === 'BOOM-SYNC',
        `threw=${syncThrew || '(none)'} res=${JSON.stringify(syncRes)}`)

      let asyncRes: UpdateCheckResult | null = null
      let asyncThrew = ''
      try {
        asyncRes = await checkLatest({ fetchLocation: () => Promise.reject(new Error('BOOM-ASYNC')) })
      } catch (e) {
        asyncThrew = String((e as Error)?.message ?? e)
      }
      check('UF-4 fetchLocation 异步 reject → 收敛成 { error }，绝不 throw',
        asyncThrew === '' && asyncRes !== null && 'error' in asyncRes && asyncRes.error === 'BOOM-ASYNC',
        `threw=${asyncThrew || '(none)'} res=${JSON.stringify(asyncRes)}`)

      // ---------- UF-5 白名单的 IPC 拒绝路径（会被拒、不会拉起浏览器） ----------
      check('UF-5 preload 暴露了 shell.openExternal 与 update.check',
        (await js<boolean>(
          "typeof window.stash?.shell?.openExternal === 'function' && typeof window.stash?.update?.check === 'function'"
        )) === true)

      const ipcDeny = await js<{ ok: boolean; error?: string }>(
        "window.stash.shell.openExternal('https://evil.com/Zizzp0318/Stash')"
      )
      check('UF-5 越界域名走真实 IPC → { ok:false, error 含 ERR_URL_NOT_ALLOWED }',
        ipcDeny?.ok === false && /ERR_URL_NOT_ALLOWED/.test(String(ipcDeny?.error ?? '')),
        JSON.stringify(ipcDeny))
      const ipcDenyFile = await js<{ ok: boolean; error?: string }>(
        "window.stash.shell.openExternal('file:///C:/Windows/System32/cmd.exe')"
      )
      check('UF-5 file:// 协议同样被 IPC 拒绝（否则等于把「发文件给系统执行」开放给渲染层）',
        ipcDenyFile?.ok === false && /ERR_URL_NOT_ALLOWED/.test(String(ipcDenyFile?.error ?? '')),
        JSON.stringify(ipcDenyFile))

      // ---------- UF-6 关于页版本行的 DOM 结构 ----------
      const panelUp =
        (await js<boolean>("!!document.querySelector('[data-settings-panel]')")) === true || (await openPanel())
      await clickEl('[data-sp-group="about"]')
      const aboutOk = await waitFor("document.querySelector('.sp-h')?.textContent.trim() === '关于'")
      check('UF-6 前置：设置面板能切到「关于」', panelUp && aboutOk)

      type VerLine = {
        hasGithub: boolean
        hasCheck: boolean
        bothInLine: boolean
        versionText: string
        githubLabel: string
        checkLabel: string
        checkDisabled: boolean
        idleNoResult: boolean
      }
      const verLine = await js<VerLine>(`(() => {
        const ver = document.querySelector('[data-sp-version]')
        const gh = document.querySelector('[data-sp-github]')
        const ck = document.querySelector('[data-sp-check-update]')
        const line = ver ? ver.closest('.sp-ver-line') : null
        return {
          hasGithub: !!gh,
          hasCheck: !!ck,
          bothInLine: !!line && !!gh && !!ck && line.contains(gh) && line.contains(ck) && line.contains(ver),
          versionText: (ver?.textContent ?? '').trim(),
          githubLabel: gh?.getAttribute('aria-label') ?? '',
          checkLabel: ck?.getAttribute('aria-label') ?? '',
          checkDisabled: ck?.disabled === true,
          idleNoResult: !document.querySelector('[data-sp-update-state]')
        }
      })()`)
      check('UF-6 版本行里有 GitHub 图标按钮与「检查更新」按钮',
        verLine?.hasGithub === true && verLine?.hasCheck === true, JSON.stringify(verLine))
      check('UF-6 两个按钮都在版本行内（和版本号同一行，不是散在别处）', verLine?.bothInLine === true)
      // 版本号仍是**纯版本号文本**：图标若被塞进 [data-sp-version] 里，这条会红
      check('UF-6 data-sp-version 仍是纯版本号文本（没被图标污染），且与主进程一致',
        /^\d+\.\d+\.\d+$/.test(verLine?.versionText ?? '') && verLine?.versionText === app.getVersion(),
        `dom=${verLine?.versionText} app=${app.getVersion()}`)
      check('UF-6 两个按钮都有可读的无障碍名称（不是「只有图标没有名字」）',
        (verLine?.githubLabel ?? '').length > 0 && (verLine?.checkLabel ?? '').length > 0,
        `github=${verLine?.githubLabel} check=${verLine?.checkLabel}`)
      check('UF-6 初始 idle：检查按钮可点、且页面上不存在任何结果文案',
        verLine?.checkDisabled === false && verLine?.idleNoResult === true)

      // ---------- UF-7 转圈动画真的能生效（纯 DOM 操作：不点按钮、不联网） ----------
      // 项目里原本没有 @keyframes，`sp-spin` 是这次新加的 —— 写成 `animation: spin ...`（名字写错）
      // 时浏览器会**静默忽略**（控制台都不报），只有读 computed style 才看得见。
      const animName = async (withClass: boolean): Promise<string> =>
        ((await js<string>(`(() => {
          const b = document.querySelector('[data-sp-check-update]')
          const svg = b ? b.querySelector('svg') : null
          if (!b || !svg) return 'no-svg'
          b.classList.toggle('checking', ${withClass})
          return getComputedStyle(svg).animationName
        })()`)) ?? '(eval 失败)')
      const animOn = await animName(true)
      const animOff = await animName(false)
      check('UF-7 加 .checking 后图标 animationName === sp-spin（新 keyframes 真的被引用到了）',
        animOn === 'sp-spin', animOn)
      check('UF-7 去掉 .checking 后不再旋转（动画不是无条件常开的）', animOff !== 'sp-spin', animOff)

      // ---------- UF-8 三态文案 / 检测中状态：真实 IPC → Vue → DOM，只把网络响应换成替身 ----------
      // 等价于 main.ts 里 `wrap()` 的形态：成功 {ok:true,data} / 失败 {ok:false,error}
      const wrapLike = (fn: () => unknown): Promise<unknown> =>
        Promise.resolve()
          .then(fn)
          .then((data) => ({ ok: true as const, data }))
          .catch((e) => ({ ok: false as const, error: String((e as Error)?.message ?? e) }))
      // 还原用：与 main.ts 的两个 handler 等价（本套件后续不再调用它们，纯粹是不给下一个跑的人留坑）
      const realUpdateCheck = (): Promise<unknown> =>
        wrapLike(async () => {
          const current = app.getVersion()
          const r = await checkLatest()
          if ('error' in r) throw new Error(r.error || 'ERR_UPDATE_CHECK')
          return { latest: r.latest, url: r.url, current, hasUpdate: compareVersion(r.latest, current) > 0 }
        })
      const realOpenExternal = (_e: unknown, url: unknown): Promise<unknown> =>
        wrapLike(async () => {
          const target = String(url ?? '')
          if (!isAllowedExternalUrl(target)) throw new Error('ERR_URL_NOT_ALLOWED')
          await shell.openExternal(target)
          return { opened: true }
        })
      const stubUpdateCheck = (impl: () => unknown): void => {
        ipcMain.removeHandler('update:check')
        ipcMain.handle('update:check', impl)
      }
      const stateNow = async (): Promise<{ state: string; text: string; download: boolean }> =>
        ((await js<{ state: string; text: string; download: boolean }>(`(() => {
          const el = document.querySelector('[data-sp-update-state]')
          return {
            state: el ? el.getAttribute('data-sp-update-state') : '',
            text: (el?.textContent ?? '').replace(/\\s+/g, '').trim(),
            download: !!el?.querySelector('[data-sp-update-download]')
          }
        })()`)) ?? { state: '', text: '', download: false })
      /** 等主进程里的某个变量成立（DOM 侧用 waitFor，这里等的是替身被真的调到） */
      const waitMain = async (fn: () => boolean, ms = 5000): Promise<boolean> => {
        const t0 = Date.now()
        while (Date.now() - t0 < ms) {
          if (fn()) return true
          await new Promise((r) => setTimeout(r, 60))
        }
        return fn()
      }

      try {
        // —— ① 检测中：把响应挂住，看按钮是不是真的在转圈 + disabled 防连点 ——
        let release: ((v: unknown) => void) | null = null
        stubUpdateCheck(() => new Promise((resolve) => { release = resolve }))
        const clicked = await clickEl('[data-sp-check-update]')
        const handedOff = await waitMain(() => release !== null)
        const spinning = await waitFor(
          "document.querySelector('[data-sp-check-update]')?.classList.contains('checking') === true"
        )
        const during = await js<{ cls: string; disabled: boolean; anim: string; busy: string }>(`(() => {
          const b = document.querySelector('[data-sp-check-update]')
          const svg = b ? b.querySelector('svg') : null
          return {
            cls: b ? (b.className || '') : '',
            disabled: b?.disabled === true,
            anim: svg ? getComputedStyle(svg).animationName : 'no-svg',
            busy: b?.getAttribute('aria-busy') ?? ''
          }
        })()`)
        check('UF-8 检测中：按钮转圈（class checking + svg animationName=sp-spin）且 disabled 防连点',
          clicked && handedOff && spinning && during?.disabled === true &&
            during?.anim === 'sp-spin' && during?.busy === 'true' && /(^|\s)checking(\s|$)/.test(during?.cls ?? ''),
          JSON.stringify(during))

        // —— ② 有新版：放行替身，看文案 ——
        const fn1 = release as ((v: unknown) => void) | null
        if (fn1) fn1({ ok: true, data: { latest: '0.1.99', url: RELEASES_URL, current: app.getVersion(), hasUpdate: true } })
        release = null
        const newerOk = await waitFor(
          "document.querySelector('[data-sp-update-state]')?.getAttribute('data-sp-update-state') === 'newer'"
        )
        const newer = await stateNow()
        check('UF-8 有新版：渲染「发现新版本 v0.1.99 · 去下载」并带出 data-sp-update-download',
          newerOk && newer.text === '发现新版本v0.1.99·去下载' && newer.download === true,
          JSON.stringify(newer))
        check('UF-8 检查结束后转圈收掉、按钮恢复可点（否则用户只能重启）',
          (await js<boolean>(`(() => {
            const b = document.querySelector('[data-sp-check-update]')
            const svg = b ? b.querySelector('svg') : null
            return !!b && b.disabled === false && !b.classList.contains('checking') &&
              !!svg && getComputedStyle(svg).animationName !== 'sp-spin'
          })()`)) === true)

        // —— ③ 已最新：文案换掉，且上一条的「去下载」必须消失（v-if / v-else-if 真的互斥）——
        stubUpdateCheck(async () => ({
          ok: true, data: { latest: app.getVersion(), url: RELEASES_URL, current: app.getVersion(), hasUpdate: false }
        }))
        await clickEl('[data-sp-check-update]')
        const latestOk = await waitFor(
          "document.querySelector('[data-sp-update-state]')?.getAttribute('data-sp-update-state') === 'latest'"
        )
        const latest = await stateNow()
        check('UF-8 已最新：渲染「已是最新版本」，且上一条「去下载」不再存在（三态互斥）',
          latestOk && latest.text === '已是最新版本' && latest.download === false, JSON.stringify(latest))

        // —— ④ 检查失败：错误也是值，不弹窗、不崩 ——
        stubUpdateCheck(async () => ({ ok: false, error: 'ERR_NO_LOCATION' }))
        await clickEl('[data-sp-check-update]')
        const failedOk = await waitFor(
          "document.querySelector('[data-sp-update-state]')?.getAttribute('data-sp-update-state') === 'failed'"
        )
        const failed = await stateNow()
        check('UF-8 检查失败：渲染「检查失败，请稍后再试」（失败态也就是一行小字）',
          failedOk && failed.text === '检查失败，请稍后再试' && failed.download === false,
          JSON.stringify(failed))

        // —— ⑤ 附加：GitHub 图标交给主进程的 URL 能过白名单 ——
        // ⚠️ 这里点了图标，但 handler 已换成替身：先用探针自证替身生效（真 handler 会拒探针 URL），
        //    确认之后 `shell.openExternal` 根本不会被调用 → **不会弹浏览器**。
        //    价值：UI 里那份 `GITHUB_RELEASES_URL` 是**另抄的一份常量**（没复用 update.ts 的），
        //    一旦哪天改歪，用户点图标只会看到「打开浏览器失败」。
        let capturedUrl: string | null = null
        ipcMain.removeHandler('shell:open-external')
        ipcMain.handle('shell:open-external', (_e, url: unknown) => {
          capturedUrl = String(url ?? '')
          return Promise.resolve({ ok: true, data: { opened: true } })
        })
        const probe = await js<{ ok: boolean }>("window.stash.shell.openExternal('https://evil.com/probe')")
        check('UF-8 附加前置：openExternal 替身已生效（探针 URL 走通了 = 下一条不会真拉起浏览器）',
          probe?.ok === true, JSON.stringify(probe))
        // ⚠️ 探针没通过就**绝不点**：真 handler 在跑的情况下点图标会真的弹浏览器
        let uiUrl: string | null = null
        if (probe?.ok === true) {
          await clickEl('[data-sp-github]')
          await waitMain(() => capturedUrl !== null)
          uiUrl = capturedUrl as string | null
        }
        check('UF-8 附加：GitHub 图标送给主进程的是 Releases 页，且能过白名单（UI 那份常量没跑偏）',
          uiUrl !== null && isAllowedExternalUrl(uiUrl) && /\/releases$/.test(uiUrl),
          `UI 送来的 URL=${uiUrl}`)
      } finally {
        // 还原两个 handler（等价实现），并把替身期间可能残留的状态清掉
        ipcMain.removeHandler('update:check')
        ipcMain.handle('update:check', realUpdateCheck)
        ipcMain.removeHandler('shell:open-external')
        ipcMain.handle('shell:open-external', realOpenExternal)
        // UF-7 手工加的类不能留下：留着会让下一次进关于页看到「一直在转圈」
        await js("document.querySelector('[data-sp-check-update]')?.classList.remove('checking'); true")
        await capture('shot-settings-about-update.png')
      }
    }

    // ==================== OP 开库性能 + 缩略图进度条（QA 增补：OP-1…OP-8） ====================
    // 验的是两件事：
    //   ① 开库回填「判断某个 hash 有没有 grid 缩略图」从**逐条 existsSync** 改成**一次 readdir 的目录集合**；
    //   ② 缩略图生成过程有进度条、且不抢点击 / 不压标题栏。
    //
    // 为什么每条都用**独立判据**：耗时、目录数、mtime、文件是否存在，全部由本段自己量
    // （`readdirSync` / `statSync` / `existsSync`），**不读 `thumbs.ts` 的内部变量** ——
    // 否则「实现写错、断言照抄同一份错误认知」会一起错（本项目 I2 的同源盲区）。
    // 唯一借用的生产入口是 `cache.clearCache` / `ensureBatch` / `thumb:*` IPC，那本身就是被测对象。
    //
    // ⚠️ 环境差异（**不要用本机数字反推用户效果**）：本机 warm cache、无杀软、NVMe，
    //    绝对耗时远低于用户环境（用户报的是 1–3 秒）。所以耗时判据以
    //    「同一台机器、同一份数据下 有缓存集合 vs 逐条 stat」的**比值**为主，
    //    绝对阈值（800ms）只作兜底上界。
    {
      const thumbsDir = join(lib.path, '.thumbs')
      const db = requireCurrent().db
      const opSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
      const fileIn = (rel: string): string => join(lib.path, ...rel.split('/'))
      const gridOf = (h: string): string => join(thumbsDir, h, 'grid.webp')
      const detailOf = (h: string): string => join(thumbsDir, h, 'detail.webp')
      const mtimeOf = (p: string): number => {
        try {
          return statSync(p).mtimeMs
        } catch {
          return -1
        }
      }
      /** 等到 `files` 全部存在（返回最终存在的个数，不抛） */
      const waitAll = async (files: string[], ms = 30000): Promise<number> => {
        const t0 = Date.now()
        let n = files.filter((f) => existsSync(f)).length
        while (n < files.length && Date.now() - t0 < ms) {
          await opSleep(150)
          n = files.filter((f) => existsSync(f)).length
        }
        return n
      }
      /**
       * 在渲染层装一对计数器（`thumb:progress` / `thumb:done` 广播次数）。
       * ⚠️ 由**真事件**驱动（主进程 `settleBatch` → webContents.send → preload → 这里），
       *    不是去读主进程变量 —— 顺便也证了「广播在真的发」。
       * 重复调用会先卸掉上一次的监听（`__opUnsub`），不会越挂越多。
       */
      const armThumbCounters = async (): Promise<void> => {
        await js(
          'window.__opProg = 0; window.__opDone = 0; window.__opUnsub = window.__opUnsub || [];' +
            'while (window.__opUnsub.length) { try { window.__opUnsub.pop()() } catch (e) {} }' +
            'window.__opUnsub.push(window.stash.thumb.onProgress(() => { window.__opProg++ }));' +
            'window.__opUnsub.push(window.stash.thumb.onDone(() => { window.__opDone++ }));' +
            'true'
        )
      }
      const thumbCounts = async (): Promise<{ prog: number; done: number }> =>
        ((await js<{ prog: number; done: number }>(
          '({ prog: window.__opProg || 0, done: window.__opDone || 0 })'
        )) ?? { prog: -1, done: -1 })

      /**
       * 直接读 `meta` 里那行脏标记 —— **独立判据**，不经过 `thumbs.ts` 的 getter。
       *
       * 为什么要两个来源：`gridPresenceState()` 可能「记得」内存里的标记（关库不清零），
       * 而 `meta` 是**唯一能跨进程存活**的载体。两条一起看，才分得清
       * 「内存标记在起作用」还是「真的持久化住了」。
       * ⚠️ 必须每次现取 `requireCurrent().db`：本段后面会 `closeCurrent()` 再重开，
       * 提前捕获的 `db` 句柄会变成 closed。值只应是 `'1'`；洗白是整行 DELETE（不该出现 `'0'`）。
       */
      const metaDirty = (): string | null => {
        try {
          const row = requireCurrent().db.prepare("SELECT value FROM meta WHERE key='grid_presence_dirty'").get() as
            | { value?: string }
            | undefined
          return row?.value ?? null
        } catch {
          return '(读不到)'
        }
      }

      // —— 前置：库里那些「文件真的还在磁盘上」的图片素材 ——
      // 只留这些：`ensureOne` 对源文件缺失的素材会返回 null，拿它做「必须重建」会让断言永远红。
      const imageRows = (
        db
          .prepare(
            "SELECT id, type, ext, content_hash, rel_path FROM assets " +
              "WHERE missing=0 AND type='image' AND content_hash IS NOT NULL ORDER BY id"
          )
          .all() as Array<{ id: number; type: string; ext: string; content_hash: string; rel_path: string }>
      ).filter((r) => existsSync(fileIn(r.rel_path)))
      // 同一个 content_hash 可能对应多行（重复导入 / 库内复制的旧数据）→ 文件级断言按 hash 去重
      const hashes = [...new Set(imageRows.map((r) => r.content_hash))]
      // 先把「每张 grid.webp 都存在」这个前提坐稳（前面 S7 清过缓存、S9 又导入过）
      const missingGrid = hashes.filter((h) => !existsSync(gridOf(h)))
      if (missingGrid.length > 0) {
        const rows = imageRows.filter((r) => missingGrid.includes(r.content_hash))
        await new Promise<void>((resolve) => ensureBatch(rows, 'grid', resolve))
      }
      check(
        'OP-0 前置：库里 ' + hashes.length + ' 个图片 hash 的 grid.webp 全部已在磁盘上（否则后面的「不重复生成」是空转）',
        hashes.length > 0 && hashes.every((h) => existsSync(gridOf(h))),
        `hashes=${hashes.length} 缺=${hashes.filter((h) => !existsSync(gridOf(h))).length}`
      )
      // 前置归位：把「索引字段欠账」（width/palette/duration_ms）清零，否则它们会被 `sink` 强制入队，
      // OP-2 的「一张都不生成」会变成假红。gen_state 置满位 → `backfillMeta` 也不再排元数据任务，
      // 让 OP-1 的耗时只反映缩略图回填本身。
      db.prepare(
        "UPDATE assets SET width=COALESCE(width,400), height=COALESCE(height,300), palette=COALESCE(palette,'[]'), gen_state=3 WHERE type='image'"
      ).run()
      // 归位：先跑一次全量回填，把可能残留的「目录集合脏标记」洗白。
      // 为什么必须洗：S7 里点过「清理缩略图」（走 IPC → `invalidateGridPresence()`），
      // 脏状态会让回填退回逐条 stat —— 那 OP-1 就会变成在测「慢路径」而不自知。
      await js("window.stash.thumb.backfill('grid')")
      check(
        'OP-1 前置：目录集合此刻是「可信」状态（dirty=false 且 meta 无脏行）—— 否则 OP-1 测到的是逐条 stat 的慢路径',
        gridPresenceState().dirty === false && metaDirty() === null,
        `dirty=${gridPresenceState().dirty} meta=${metaDirty()}`
      )

      // ==================== OP-1 全量回填耗时（1 万条夹具）====================
      // 夹具口径照 `smoke-vscroll.ts`：直插 1 万行，**不落 1 万个真缩略图**。
      // 但这里不能学它把 content_hash 置 NULL —— 那样 `ensureBatch` 的 filter 会在
      // `!a.content_hash` 处短路，根本走不到 `haveGrid` 那条分支，注入验证也就抓不到了。
      // 所以：每行给一个独立 content_hash，并在 `.thumbs` 下**只造一个空目录**（目录在、文件不在）。
      const OP_N = 10000
      // ⚠️ 复用**已存在**的文件夹行，绝不 `mkdirRel` 新建目录：新建真实目录会触发 watcher 的
      // addDir → library:external → 渲染层 refresh → 这 1 万行立刻进画廊，OP-1 的耗时与
      // OP-2 的「0 次广播」全部被污染。`.thumbs` 那一侧是安全的（watcher 显式忽略 `.thumbs*`）。
      const opFolder = db.prepare('SELECT id, path FROM folders ORDER BY id LIMIT 1').get() as
        | { id: number; path: string }
        | undefined
      if (!opFolder) throw new Error('OP: 库里没有文件夹行，无法造夹具')
      const tFx = Date.now()
      {
        const ins = db.prepare(
          'INSERT INTO assets (folder_id, name, rel_path, type, ext, size, width, height, content_hash,' +
            ' rating, is_fav, file_mtime, imported_at, missing)' +
            " VALUES (?, ?, ?, 'text', 'txt', 64, NULL, NULL, ?, 0, 0, ?, ?, 0)"
        )
        db.exec('BEGIN')
        try {
          for (let i = 0; i < OP_N; i++) {
            const k = String(i).padStart(5, '0')
            const h = `opfx${k}`
            mkdirSync(join(thumbsDir, h)) // 只造目录，不写文件（正是新实现赖以判断的那份「目录集合」）
            ins.run(opFolder.id, `op${k}.txt`, `${opFolder.path}/op${k}.txt`, h, tFx + i, tFx + i)
          }
          db.exec('COMMIT')
        } catch (e) {
          db.exec('ROLLBACK')
          throw e
        }
      }
      const fixtureMs = Date.now() - tFx
      const opDirs = readdirSync(thumbsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).length
      const totalRows = (db.prepare('SELECT COUNT(*) AS c FROM assets WHERE missing=0').get() as { c: number }).c
      check(
        `OP-1 前置：1 万条夹具已落库（${totalRows} 行）且 .thumbs 下真的有 1 万个空 hash 目录（目录在、grid.webp 不在）`,
        totalRows >= OP_N && opDirs >= OP_N,
        `行数=${totalRows} 目录数=${opDirs} 造夹具=${fixtureMs}ms`
      )

      // —— 反事实对照：把**旧实现**在同一份数据上原样跑一遍（SELECT + 逐条 existsSync）——
      // 这是「同一台机器、同一份数据」的公平对照，不受机器快慢影响（比值判据的依据）。
      const tOldSel0 = Date.now()
      const allRows = db
        .prepare('SELECT id, content_hash FROM assets WHERE missing=0')
        .all() as Array<{ id: number; content_hash: string | null }>
      const tOldSel = Date.now() - tOldSel0
      let oldMiss = 0
      const tOldStat0 = Date.now()
      for (const a of allRows) {
        if (a.content_hash && !existsSync(join(thumbsDir, a.content_hash, 'grid.webp'))) oldMiss++
      }
      const tOldStat = Date.now() - tOldStat0
      const tOld = tOldSel + tOldStat

      // —— 现实现：走**真实 IPC 往返**（渲染层 → preload → main handler → 回来）——
      // 先拍一次 mtime 快照：OP-2 要用「这三次回填有没有改动任何一张已有 grid.webp」来证明「不重复生成」
      const gridFiles = hashes.map(gridOf)
      const mtBefore = gridFiles.map(mtimeOf)
      await armThumbCounters()
      const ipcMs: number[] = []
      let backfillAllOk = true
      for (let k = 0; k < 3; k++) {
        const t0 = Date.now()
        const r = await js<{ ok: boolean; data?: { queued: number }; error?: string }>(
          "window.stash.thumb.backfill('grid')"
        )
        ipcMs.push(Date.now() - t0)
        if (!r || r.ok !== true) backfillAllOk = false
      }
      const tNew = Math.min(...ipcMs) // 取最好的一次（warm）；冷启动那次单独记录
      const afterCounts = await thumbCounts()
      check(
        `OP-1 一次 thumb:backfill 的 IPC 往返 ${tNew}ms < 800ms（实测三次=${ipcMs.join('/')}，1 万条）`,
        backfillAllOk && tNew < 800,
        `三次=${ipcMs.join('/')}ms 最好=${tNew}ms 对照旧实现=${tOld}ms（SELECT ${tOldSel} + 逐条 stat ${tOldStat}）`
      )
      check(
        `OP-1 相对判据：目录集合路径比逐条 stat 快 3 倍以上（实测 ${(tOld / Math.max(1, tNew)).toFixed(1)}×）`,
        tOld >= 3 * Math.max(1, tNew),
        `新=${tNew}ms（IPC 往返） 旧=${tOld}ms（SELECT+${allRows.length} 次 existsSync） 倍数=${(tOld / Math.max(1, tNew)).toFixed(1)}×`
      )

      // ==================== OP-2 grid 已有 → 一张都不重复生成 ====================
      // 上一段那三次回填就是「全量回填」本身：此时 fresh 应当为空 → 0 次广播、0 个文件被动过
      const mtAfter = gridFiles.map(mtimeOf)
      const changed = gridFiles.filter((_, i) => mtBefore[i] !== mtAfter[i]).length
      check(
        'OP-2 全量回填时「已有 grid」的素材一张都不重复生成（progress 广播 0 次 + 文件 mtime 全未变）',
        afterCounts.prog === 0 && afterCounts.done === 0 && changed === 0,
        `progress=${afterCounts.prog} done=${afterCounts.done} mtime 变化=${changed}/${gridFiles.length}`
      )
      check(
        'OP-2 附加：对照旧实现确实认为这些 hash「都缺」时才有意义（否则上一条是空转）',
        oldMiss >= OP_N && gridFiles.length > 0,
        `旧判据认为缺失=${oldMiss}（其中 1 万条是夹具：目录在、grid.webp 不在）`
      )

      // ==================== OP-3 detail 不被目录集合误判 ====================
      // 关键语义：`detail` 是**按需**生成的，所以「目录在」绝不代表「detail.webp 在」。
      // 注入「detail 也走目录集合」时，这里会一张都生成不出来。
      for (const f of hashes.map(detailOf)) {
        try {
          unlinkSync(f)
        } catch {
          /* 本来就没有 */
        }
      }
      await armThumbCounters()
      let detailBatchDone = false
      await new Promise<void>((resolve) => {
        ensureBatch(imageRows, 'detail', () => {
          detailBatchDone = true
          resolve()
        })
        void opSleep(30000).then(resolve) // 兜底，别把套件挂死
      })
      const detailFiles = hashes.map(detailOf)
      const detailBack = await waitAll(detailFiles, 15000)
      check(
        `OP-3 目录都在、detail.webp 都不在 → detail 批次必须把它们全部入队并生成（${detailBack}/${detailFiles.length}）`,
        detailBatchDone && detailBack === detailFiles.length,
        `done=${detailBatchDone} 生成=${detailBack}/${detailFiles.length}`
      )

      // ==================== OP-4 清缓存 → 重启（跨进程语义）→ 必须重建 ====================
      // 判据只依赖**磁盘**，不依赖任何模块标记：清完缓存后 hash 目录被 `rmdirSync` 收掉，
      // 于是「目录集合」自然重新变准 → 重启（关库再开库，模块状态回到初值）后回填必然重建。
      // 先做这一步的原因：此时各 hash 目录里还没有派生预览，rmdir 能真的删掉（干净的对照）。
      // 挡路的派生预览（S7X/S8 给 tiff 生成的 preview-{上限}.webp）先挪到一边，清完立刻放回。
      const parkDir = join(thumbsDir, '.op-park')
      mkdirSync(parkDir, { recursive: true })
      const parked: Array<{ from: string; to: string; name: string }> = []
      for (const h of hashes) {
        let names: string[] = []
        try {
          names = readdirSync(join(thumbsDir, h))
        } catch {
          continue
        }
        for (const n of names) {
          if (!n.startsWith('preview') || n.includes('.tmp')) continue
          const from = join(thumbsDir, h, n)
          const to = join(parkDir, `${h}__${n}`)
          try {
            writeFileSync(to, readFileSync(from))
            unlinkSync(from)
            parked.push({ from, to, name: n })
          } catch {
            /* 挪不动就算（会体现为下面 kept>0 的前置断言变红） */
          }
        }
      }
      // ⚠️ 走服务层 `clearCache` 而**不是** IPC handler：刻意绕开 `invalidateGridPresence()`，
      //    这样这一条只考「rmdirSync 是否让目录集合重新变准」，不靠脏标记救场。
      //    所以先取证「此刻确实不脏」—— 否则下面测到的可能是脏标记那条路（OP-9 才是它的主场）。
      const dirtyPre4 = gridPresenceState().dirty
      const metaPre4 = metaDirty()
      const pre4Grid = hashes.filter((h) => existsSync(gridOf(h))).length
      const cleared4 = clearCache('thumbs')
      const kept4 = hashes.filter((h) => existsSync(join(thumbsDir, h)))
      const dirtyPost4 = gridPresenceState().dirty
      const metaPost4 = metaDirty()
      check(
        'OP-4 前置：清理前不脏（dirty=false / 无 meta 行），且清理本身**不**置脏（服务层没走 IPC handler）',
        pre4Grid === hashes.length && dirtyPre4 === false && metaPre4 === null && dirtyPost4 === false,
        `清前 grid=${pre4Grid}/${hashes.length} dirty ${dirtyPre4}→${dirtyPost4} meta ${metaPre4}→${metaPost4}`
      )
      check(
        'OP-4 前置：清理后变空的 hash 目录被物理删除（rmdirSync 非递归生效，目录集合重新可信）',
        kept4.length === 0,
        `删除文件=${cleared4.removed} 残留目录=${kept4.length}${kept4.length ? '：' + kept4.join(',') : ''}`
      )
      // ⚠️ 派生预览**到这里还不能放回去**：`rmdirSync` 已经把那个变空的 hash 目录删掉了，
      //    此刻 `writeFileSync(p.from, …)` 会因为「父目录不存在」静默失败 —— 文件就丢了。
      //    （这条是 QA 自查抓到的：加了「真 preview-1920 是否仍在」的断言后立刻变红，
      //      实测 `真 preview-1920 还在=0/1`。所以放回必须等回填把目录重新建出来之后。）
      // 模拟重启：关库 → 重新打开。
      // 这一条的隔离靠 **OP-1 那三次全量回填 + 上面的「清理前 dirty=false」取证**：
      // 脏标记此时一定不在（内存与 meta 两处都验过），所以重建只可能来自 `rmdirSync`
      // 让目录集合重新变准这条路径。（脏标记那条路径由 OP-4b/OP-4c 单独考。）
      closeCurrent()
      openLibrary(lib.path)
      const r4 = await js<{ ok: boolean }>("window.stash.thumb.backfill('grid')")
      const rebuilt4 = await waitAll(hashes.map(gridOf), 30000)
      // 回填已经把 hash 目录重新建出来了 → 现在把真实派生预览放回原位
      let restored4 = 0
      for (const p of parked) {
        try {
          mkdirSync(join(p.from, '..'), { recursive: true })
          writeFileSync(p.from, readFileSync(p.to))
          unlinkSync(p.to)
          restored4++
        } catch {
          /* 放不回就让它红（下面的断言会暴露） */
        }
      }
      try {
        rmSync(parkDir, { recursive: true, force: true }) // 空的暂存目录一并收掉，别留在 .thumbs 里
      } catch {
        /* ignore */
      }
      check(
        'OP-4 收尾：真实派生预览（preview-1920.webp）确实放回了原位 —— 否则 OP-4b「原位不挪走」的前提是假的',
        parked.length >= 1 && restored4 === parked.length,
        `放回=${restored4}/${parked.length}`
      )
      check(
        `OP-4 清缓存后重启 → 回填必须把缩略图真的重建出来（${rebuilt4}/${hashes.length}）`,
        r4?.ok === true && rebuilt4 === hashes.length,
        `backfill.ok=${r4?.ok} 重建=${rebuilt4}/${hashes.length} 删除文件=${cleared4.removed} 放回派生=${restored4}/${parked.length}`
      )

      // ==================== OP-6 派生预览不能被连带删除 ====================
      // 给每个 hash 目录写一份 `preview-4x.webp`（派生预览就住在同一个 hash 目录里）：
      // `rmdirSync` 是**非递归**的，只要里面还有东西就删不掉 → 这正是「清理缩略图不得连带删派生」的护栏。
      const previewBytes = hashes.length > 0 ? readFileSync(gridOf(hashes[0])) : Buffer.alloc(0)
      for (const h of hashes) writeFileSync(join(thumbsDir, h, 'preview-4x.webp'), previewBytes)
      const gridBefore6 = hashes.filter((h) => existsSync(gridOf(h))).length
      const derBefore6 = hashes.filter((h) => existsSync(join(thumbsDir, h, 'preview-4x.webp'))).length
      // 这一条走**真实 IPC handler**（`cache:clear` → clearCache + invalidateGridPresence）
      const cleared5 = await js<{ ok: boolean; data?: { removed: number } }>("window.stash.cache.clear('thumbs')")
      const gridAfter6 = hashes.filter((h) => existsSync(gridOf(h))).length
      const derAfter6 = hashes.filter((h) => existsSync(join(thumbsDir, h, 'preview-4x.webp'))).length
      const dirsAfter6 = hashes.filter((h) => existsSync(join(thumbsDir, h))).length
      check(
        'OP-6 清理缩略图只删 grid/detail，绝不连带删同目录下的派生预览 preview-4x.webp',
        cleared5?.ok === true &&
          gridBefore6 === hashes.length &&
          gridAfter6 === 0 &&
          derBefore6 === hashes.length &&
          derAfter6 === hashes.length,
        `IPC.ok=${cleared5?.ok} 删除数=${cleared5?.data?.removed} grid ${gridBefore6}→${gridAfter6} preview ${derBefore6}→${derAfter6}`
      )
      check(
        'OP-6 附加：目录里有派生预览时 rmdir 删不掉 → hash 目录必须原地保留（非递归删除的证据）',
        dirsAfter6 === hashes.length,
        `目录保留=${dirsAfter6}/${hashes.length}`
      )
      // 走 IPC 清缓存必须**同时**置脏（内存 + meta 双写）—— 这是 OP-4b / OP-5 / OP-4c 的前提，
      // 也是「换个进程回来还记得」的唯一载体。
      const dirty6 = gridPresenceState().dirty
      const meta6 = metaDirty()
      check(
        "OP-4c① 清缩略图后必须置脏：gridPresenceState().dirty=true 且 meta['grid_presence_dirty']='1'（跨进程的唯一载体）",
        dirty6 === true && meta6 === '1',
        `dirty=${dirty6} meta=${meta6}`
      )

      // ==================== OP-4c③ 反向：非全量批次**不能**消费掉标记 ====================
      // 这是 OP-4b / OP-5 能成立的前提，也是实现里 `isFullScan()` 那段的唯一理由：
      // 清完缓存后渲染层先发的是「首屏那几十张」的局部批次，若它把标记洗白，
      // 紧随其后的全量回填又会被目录集合骗 → 整库不重建（用户看到「清了缓存，网格从此全 404」）。
      // 两个尺寸各测一次：
      //   · 9 条 → 故意 > SMALL_BATCH_MAX，确保它走的是「读脏标记」那条分支（而不是因为批次小才碰巧逐条 stat）；
      //   · 3 条 → lead 口径的原样复现（小批次连目录集合都不查，但也绝不能顺手洗白）。
      {
        const partRows = imageRows.slice(0, Math.min(9, imageRows.length))
        const missingBefore11 = partRows.filter((r) => !existsSync(gridOf(r.content_hash))).length
        await new Promise<void>((resolve) => {
          ensureBatch(partRows, 'grid', resolve)
          void opSleep(20000).then(resolve)
        })
        // 等这一批真的落盘（顺带证明「部分批次确实跑了」，否则下面 dirty 不变可能只是因为它没跑）
        const partBack = await waitAll(partRows.map((r) => gridOf(r.content_hash)), 15000)
        const stillDirty = gridPresenceState().dirty
        const metaStill = metaDirty()
        check(
          'OP-4c③ 反向：9 条非全量批次不会消费掉脏标记（isFullScan 判据生效）—— 否则紧随其后的全量回填会被目录集合骗',
          partRows.length >= 9 && missingBefore11 >= 9 && partBack === partRows.length && stillDirty === true && metaStill === '1',
          `批次=${partRows.length} 条、其中缺图=${missingBefore11}、补回=${partBack}；跑完 dirty=${stillDirty}（应 true） meta=${metaStill}（应 '1'）`
        )
        // 3 条（lead 口径）—— 小批次不走目录集合，但同样不能顺手洗白
        const tinyRows = imageRows.slice(0, Math.min(3, imageRows.length))
        await new Promise<void>((resolve) => {
          ensureBatch(tinyRows, 'grid', resolve)
          void opSleep(10000).then(resolve)
        })
        const stillDirty3 = gridPresenceState().dirty
        const metaStill3 = metaDirty()
        check(
          'OP-4c③ 反向：3 条批次同样不得消费脏标记（dirty 仍 true / meta 仍有那行）',
          tinyRows.length >= 3 && stillDirty3 === true && metaStill3 === '1',
          `批次=${tinyRows.length} 条；跑完 dirty=${stillDirty3}（应 true） meta=${metaStill3}（应 '1'）`
        )
      }

      // ==================== OP-5 同进程清缓存 → 脏标记必须救场 ====================
      // 此刻的状态正是最危险的组合：hash 目录**都在**（rmdir 删不掉）、grid.webp **都不在**。
      // 目录集合会撒谎 → 只有脏标记（由 cache:clear handler 置位、由下一次全量回填消费）
      // 能让回填退回逐条 existsSync。
      // 注入「去掉 handler 里的 invalidateGridPresence()」时，这一条必须变红。
      await armThumbCounters()
      const r5 = await js<{ ok: boolean }>("window.stash.thumb.backfill('grid')")
      const rebuilt5 = await waitAll(hashes.map(gridOf), 30000)
      const counts5 = await thumbCounts()
      check(
        `OP-5 同进程清缓存（目录还在）→ 回填必须全部重建（${rebuilt5}/${hashes.length}）`,
        r5?.ok === true && rebuilt5 === hashes.length,
        `backfill.ok=${r5?.ok} 重建=${rebuilt5}/${hashes.length} progress 广播=${counts5.prog}`
      )
      // 全量回填跑完必须把标记**洗白**：内存置 false，且 meta 那一行是**整行 DELETE**（不是写成 '0'）。
      // 写成 '0' 会让「值是字符串 '0'」和「没有这一行」变成两种语义，迟早有人 `if (value)` 判错。
      const dirty5 = gridPresenceState().dirty
      const meta5 = metaDirty()
      check(
        "OP-4c② 全量回填后必须洗白：dirty=false 且 meta 那一行被 DELETE 掉（不是写成 '0'）",
        dirty5 === false && meta5 === null,
        `dirty=${dirty5} meta=${meta5 === null ? '(行已删除)' : meta5}`
      )

      // ==================== OP-4b / OP-4c④⑤ 硬场景：派生预览**原位不挪走** + 跨进程脏标记 ====================
      // 这才是真回归面，也是本方案的**唯一理由**：
      //   ① 目录里有 `preview-*.webp` → `rmdirSync` 删不掉 → 目录原地保留（OP-6 已证）；
      //   ② 脏标记若只存在内存里，`closeCurrent()` 不会清零但它**属于旧库**、
      //      而真正的「重启软件」内存标记直接没了 —— 新进程只剩 meta。
      //   ③ 于是必须验证：脏标记真的写进了 meta，并且**下一个进程**读得回来 → 回填仍会重建。
      // 做法：先把内存标记「弄丢」（切到一个别的库再切回来，等价于新进程里内存标记为空），
      //      然后只靠 meta 问 `gridPresenceState()`。
      // ⚠️ 与 OP-4 的分工：OP-4 把派生预览**挪走**了（目录会变空 → 考的是 `rmdirSync` 那条路）；
      //    这里**原位不动**（目录必然删不掉 → 只能靠脏标记）。两条各考一半，缺一条就有覆盖洞。
      {
        // 此刻 hash 目录都在、preview-4x.webp 都在、grid.webp 都在 → 再走一次 IPC 清缩略图
        const gridBefore9 = hashes.filter((h) => existsSync(gridOf(h))).length
        const cleared9 = await js<{ ok: boolean }>("window.stash.cache.clear('thumbs')")
        const gridAfter9 = hashes.filter((h) => existsSync(gridOf(h))).length
        const dirsAfter9 = hashes.filter((h) => existsSync(join(thumbsDir, h))).length
        const derAfter9 = hashes.filter((h) => existsSync(join(thumbsDir, h, 'preview-4x.webp'))).length
        // 真实派生管线产出的那份 `preview-{上限}.webp`（OP-4 挪出去又放回来的，就在 tiff 的 hash 目录里）
        const realPreviewAlive = parked.filter((p) => existsSync(p.from)).length
        check(
          'OP-4b 前置：清缩略图后「目录全在、grid 全没、派生预览全在」—— 目录集合此刻必然撒谎（这才是真回归面）',
          gridBefore9 === hashes.length && cleared9?.ok === true && gridAfter9 === 0 &&
            dirsAfter9 === hashes.length && derAfter9 === hashes.length &&
            parked.length >= 1 && realPreviewAlive === parked.length,
          `IPC.ok=${cleared9?.ok} grid ${gridBefore9}→${gridAfter9} 目录=${dirsAfter9}/${hashes.length} preview-4x=${derAfter9} 真 preview-1920 还在=${realPreviewAlive}/${parked.length}`
        )
        // 模拟「重启软件」：内存标记属于旧库，切到另一个库再问 → 复位；切回来时**只剩 meta**
        const tmpBase = mkdtempSync(join(tmpdir(), 'stash-op-restart-'))
        const tmpLibPath = join(tmpBase, 'op-restart-lib')
        let dirtyInOther = true
        let dirtyBackFromMeta = false
        try {
          createLibrary({ name: 'op-restart-lib', parentDir: tmpBase })
          dirtyInOther = gridPresenceState().dirty // 新库没清过缓存 → 必须是 false（也证明内存标记没串库）
          openLibrary(lib.path)
          dirtyBackFromMeta = gridPresenceState().dirty // 内存已被复位 → 这个 true 只可能来自 meta
        } finally {
          try {
            forgetLibrary(tmpLibPath)
          } catch {
            /* ignore */
          }
          closeCurrent()
          openLibrary(lib.path)
          try {
            rmSync(tmpBase, { recursive: true, force: true })
          } catch {
            /* 句柄没释放就留着，系统会回收 */
          }
        }
        check(
          'OP-4c④ 持久化取证：清缓存后切库（内存标记复位）→ 回原库仍 dirty=true 且 meta 行仍在（只可能来自 meta）',
          dirtyInOther === false && dirtyBackFromMeta === true && metaDirty() === '1',
          `别的库 dirty=${dirtyInOther}（应 false，防串库） 回原库 dirty=${dirtyBackFromMeta}（应 true，只来自 meta） meta=${metaDirty()}`
        )
        // 此刻内存标记是「空」、只有 meta 脏 —— 正是「重启后」的真实状态：回填必须重建全部
        const r9 = await js<{ ok: boolean }>("window.stash.thumb.backfill('grid')")
        const rebuilt9 = await waitAll(hashes.map(gridOf), 30000)
        const derFinal9 = hashes.filter((h) => existsSync(join(thumbsDir, h, 'preview-4x.webp'))).length
        const realPreviewFinal = parked.filter((p) => existsSync(p.from)).length
        check(
          `OP-4b 「清缓存（派生预览原位、目录删不掉）」→ 回填必须全部重建：${rebuilt9}/${hashes.length}`,
          r9?.ok === true && rebuilt9 === hashes.length,
          `backfill.ok=${r9?.ok} 重建=${rebuilt9}/${hashes.length}`
        )
        check(
          'OP-4b 派生预览全程未被连带删除（preview-4x × ' + hashes.length + ' + 真实 preview-1920 那份）',
          derFinal9 === hashes.length && parked.length >= 1 && realPreviewFinal === parked.length,
          `preview-4x 仍在=${derFinal9}/${hashes.length} 真 preview-1920 仍在=${realPreviewFinal}/${parked.length}`
        )
        check(
          'OP-4c⑤ 重建后洗白（dirty=false 且 meta 行已 DELETE）—— 下一轮开库恢复 readdir 快路径',
          gridPresenceState().dirty === false && metaDirty() === null,
          `dirty=${gridPresenceState().dirty} meta=${metaDirty() === null ? '(行已删除)' : metaDirty()}`
        )

        // ==================== OP-10 小批次（≤8 条）必须逐条 existsSync ====================
        // `preview.ts` 的「新哈希补一张缩略图」就是**单条** grid 批次，而且在交互路径上
        // （每次打开高清预览都触发）。它不能依赖「目录存在」这种近似判据 —— 否则
        // 「目录在、grid.webp 没了」的素材永远补不回来。
        // 造这个大坑：删掉一张 grid.webp（目录与 preview-4x 都还在），然后只提交这一条。
        const victim = imageRows.find((r) => r.content_hash === hashes[0])
        if (victim) {
          try {
            unlinkSync(gridOf(hashes[0]))
          } catch {
            /* 本来就不在 */
          }
          const dirStillThere = existsSync(join(thumbsDir, hashes[0]))
          const dirtyBefore10 = gridPresenceState().dirty
          // 反空转：这条素材**不能**落在「索引字段欠账」（sink）里 —— sink 会让它无条件入队，
          // 那样即使实现用的是目录集合也照样会补图，断言就失去区分度。
          // 判据按 `derived.ts` 注册表对图片的定义手写（width/palette 都不能为空），不用生产代码自证。
          const vMeta = requireCurrent().db.prepare('SELECT width, palette FROM assets WHERE id=?').get(victim.id) as
            | { width: number | null; palette: string | null }
            | undefined
          const notInSink = vMeta !== undefined && vMeta.width != null && vMeta.palette != null
          let smallDone = false
          await new Promise<void>((resolve) => {
            ensureBatch([victim], 'grid', () => {
              smallDone = true
              resolve()
            })
            void opSleep(20000).then(resolve)
          })
          const oneBack = await waitAll([gridOf(hashes[0])], 15000)
          check(
            'OP-10 单条 grid 批次（≤8）必须逐条 existsSync：「目录在、grid.webp 没了」也要补回来',
            smallDone && notInSink && dirtyBefore10 === false && dirStillThere && oneBack === 1,
            `done=${smallDone} 不在 sink=${notInSink} 清前 dirty=${dirtyBefore10}(应 false) 目录还在=${dirStillThere} 补回来=${oneBack}/1`
          )
        } else {
          check('OP-10 前置：找得到用于小批次测试的那条素材', false)
        }
      }

      // ==================== OP-7 进度条出现 / 置满 / 消失（真实事件驱动）====================
      // ⚠️ 先等后台队列彻底排空：OP-5 走的是「逐条 existsSync」那一轮，1 万条夹具也各自入了一次队
      //    （源文件不存在 → `ensureOne` 立刻返回 null，不产生任何文件，但会照常广播 progress）。
      //    不等的话，它的广播会在 OP-7 期间把进度条的数字改掉 → 偶发假红。
      {
        const idleStart = Date.now()
        let quietSince = Date.now()
        let last = (await thumbCounts()).prog
        while (Date.now() - idleStart < 40000) {
          await opSleep(120)
          const now = (await thumbCounts()).prog
          if (now !== last) {
            last = now
            quietSince = Date.now()
          } else if (Date.now() - quietSince > 700) break
        }
      }
      // 先收掉设置面板（不然后面 S1 尾巴的 Esc 断言会退化成空转 —— 测完再打开还原）。
      await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
      const opPanelClosed = await waitFor("!document.querySelector('[data-settings-panel]')", 3000)
      await waitFor("!document.querySelector('.thumb-progress')", 6000) // 等前面那批的进度条彻底退场

      win.webContents.send('thumb:progress', { done: 3, total: 12 })
      const opBarShown = await waitFor("!!document.querySelector('.thumb-progress')", 3000)
      const opBar1 = await js<{
        pos: string
        pe: string
        text: string
        role: string
        now: string
        max: string
        h: number
      }>(`(() => {
        const el = document.querySelector('.thumb-progress')
        if (!el) return null
        const cs = getComputedStyle(el)
        const r = el.getBoundingClientRect()
        return {
          pos: cs.position, pe: cs.pointerEvents, h: Math.round(r.height * 100) / 100,
          text: (el.querySelector('.tp-label')?.textContent ?? '').replace(/\\s+/g, ''),
          role: el.getAttribute('role') ?? '',
          now: el.getAttribute('aria-valuenow') ?? '', max: el.getAttribute('aria-valuemax') ?? ''
        }
      })()`)
      check(
        'OP-7 收到 thumb:progress 就出现进度条：position=fixed / pointer-events=none / 文案含「生成缩略图 3/12」',
        opBarShown &&
          opBar1 !== null &&
          opBar1.pos === 'fixed' &&
          opBar1.pe === 'none' &&
          opBar1.text.includes('生成缩略图3/12') &&
          opBar1.role === 'progressbar' &&
          opBar1.now === '3' &&
          opBar1.max === '12',
        JSON.stringify(opBar1)
      )
      // 最后一个 done 常常是「差 1 个就满」的中间值（每 10 个才广播一次）→ 完成时必须先置满再淡出
      win.webContents.send('thumb:done', { done: 12, total: 12 })
      await opSleep(300)
      const opFull = await js<{ w: string; text: string }>(`(() => {
        const el = document.querySelector('.thumb-progress')
        if (!el) return null
        const fill = el.querySelector('.tp-fill')
        return {
          w: fill ? (fill.style.width || '') : '(无 tp-fill)',
          text: (el.querySelector('.tp-label')?.textContent ?? '').replace(/\\s+/g, '')
        }
      })()`)
      check(
        'OP-7 完成时进度条先置满 100%（不是停在 3/12）—— 满格要看得见',
        opFull?.w === '100%' && (opFull?.text ?? '').includes('12/12'),
        JSON.stringify(opFull)
      )
      await opSleep(300) // 距 thumb:done 约 600ms
      const opStillThere = await js<boolean>("!!document.querySelector('.thumb-progress')")
      await opSleep(1200) // 距 thumb:done 约 1.8s（800ms 停留 + 200ms 淡出）
      const opGone = await js<boolean>("!document.querySelector('.thumb-progress')")
      check(
        'OP-7 收尾节奏：800ms 内不立刻消失（留时间看到满格）、800ms+200ms 淡出后必须消失',
        opStillThere === true && opGone === true,
        `600ms 时还在=${opStillThere} 1.8s 后已消失=${opGone}`
      )

      // ==================== OP-8 进度条不遮挡 ====================
      win.webContents.send('thumb:progress', { done: 1, total: 4 })
      const opBarShown2 = await waitFor("!!document.querySelector('.thumb-progress')", 3000)
      const opGeo = await js<{
        bar: { top: number; bottom: number; h: number }
        label: { top: number; bottom: number; w: number; h: number; cx: number; cy: number } | null
        titleBottom: number
        pe: string
        z: string
        hitIsBar: boolean
      }>(`(() => {
        const el = document.querySelector('.thumb-progress')
        const title = document.querySelector('.titlebar')
        if (!el || !title) return null
        const bar = el.getBoundingClientRect()
        const label = el.querySelector('.tp-label')
        const lb = label ? label.getBoundingClientRect() : null
        const hit = lb ? document.elementFromPoint(lb.left + lb.width / 2, lb.top + lb.height / 2) : null
        return {
          bar: { top: bar.top, bottom: bar.bottom, h: Math.round(bar.height * 100) / 100 },
          label: lb ? {
            top: lb.top, bottom: lb.bottom, w: lb.width, h: lb.height,
            cx: lb.left + lb.width / 2, cy: lb.top + lb.height / 2
          } : null,
          titleBottom: title.getBoundingClientRect().bottom,
          pe: getComputedStyle(el).pointerEvents,
          z: getComputedStyle(el).zIndex,
          hitIsBar: hit ? !!(hit.closest && hit.closest('.thumb-progress')) : false
        }
      })()`)
      check(
        'OP-8 进度条贴在标题栏下沿、不压标题栏（细条高度 ≤3px，条与标签都在标题栏下方）',
        opBarShown2 &&
          opGeo !== null &&
          opGeo.bar.h <= 3 &&
          opGeo.bar.top >= opGeo.titleBottom - 0.5 &&
          opGeo.label !== null &&
          opGeo.label.top >= opGeo.titleBottom - 0.5,
        JSON.stringify(opGeo)
      )
      check(
        'OP-8 进度条不抢操作：pointer-events=none，且标签中心点的命中测试落不到它自己（点击能穿透）',
        opGeo?.pe === 'none' && opGeo?.hitIsBar === false,
        `pointer-events=${opGeo?.pe} z-index=${opGeo?.z} 命中到进度条自身=${opGeo?.hitIsBar}`
      )

      // 收尾：让进度条退场，并把设置面板重新打开（把状态交还给后面的 S1 尾巴）
      win.webContents.send('thumb:done', { done: 4, total: 4 })
      await waitFor("!document.querySelector('.thumb-progress')", 6000)
      const opReopened = await openPanel()
      check('OP 收尾：设置面板已重新打开（否则 S1 尾巴的 Esc 断言会变成空转）', opPanelClosed && opReopened)
    }

    // ==================== S1 尾巴：Esc 关闭 + 无运行期错误 ====================
    await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
    const closed = await waitFor("!document.querySelector('[data-settings-panel]')", 3000)
    check('S1 Esc 能关掉设置面板', closed)
    await collectErrors()
    check('S1 全流程渲染层无运行期错误', jsErrors.length === 0,
      jsErrors.length ? jsErrors.join(' | ').slice(0, 300) : undefined)
  } catch (e) {
    check('套件执行未抛异常', false, String((e as Error).message ?? e))
  } finally {
    // 把用户的真实偏好写回去（本套件直接动了 userData/config.json）
    try {
      patchSettings(backup)
    } catch { /* 还原失败不挡住退出 */ }
    closeCurrent()
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch { /* Windows 句柄未释放，忽略 */ }
    }
    const failed = checks.filter((c) => !c.pass)
    console.log('[SMOKE-SETTINGS] ' + JSON.stringify({ checks, failed, ok: failed.length === 0 }, null, 2))
    app.exit(0)
  }
}
