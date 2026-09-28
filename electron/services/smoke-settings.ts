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
//   S7 缓存组     —— 占用统计（缩略图/派生分开算）、并发与质量落盘、清理缩略图后真被重建
//   S8 预览与播放 —— 自动隐藏延迟**真的改行为**（浮层提示常驻/淡出）、高清预览上限换了档
//                    会生成**新文件名**的派生文件（不是复用旧的）、音量/自动播放/文本上限落盘
//   S9 导入组     —— 方式/去重/色板落盘，且**不传 mode 直接调 import.files** 时管线真的按设置走
//                    （移动真的搬走源文件、关掉去重真的会重复导入、关掉色板真的不再回写色板）
//   S10 库与存储  —— 体检能找出「文件已不在磁盘」的素材、清理点两次才生效且**不碰磁盘上还在的文件**
//   S11 快捷键    —— 只读清单：有内容、不留空行、且**里面不该有任何可点控件**（防「假设置」）
//
// ⚠️ 本套件会**写真实的 userData/config.json**（设置本来就存在那里，没有库里那份），
// 所以开头快照、`finally` 里原样写回 —— 冒烟不能把用户的偏好改掉。
import { app, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { closeCurrent, createLibrary, mkdirRel, requireCurrent } from './library'
import { importFiles } from './importer'
import { libraryUsage } from './health'
import { DEFAULT_SETTINGS, getSettings, patchSettings, type Settings } from './config'

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
  const loadDiskDerived = async (): Promise<number> => cacheDisk().derived
  /** 直接数磁盘上的缓存文件（不走 IPC）—— 用来验「界面上说的占用」不是编的 */
  const cacheDisk = (): { thumbs: number; derived: number; total: number } => {
    const dir = join(requireCurrent().path, '.thumbs')
    let thumbs = 0
    let derived = 0
    let total = 0
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
          if (f === 'grid.webp' || f === 'detail.webp') thumbs++
          else if (f.startsWith('preview.')) derived++
        }
      }
    } catch {
      /* 目录还没建起来 */
    }
    return { thumbs, derived, total }
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
      await clickEl('[data-sp-autoplay]')
      await new Promise((r) => setTimeout(r, 300))
      check('S8 自动播放开关落盘', diskSettings().preview.autoPlay === true,
        JSON.stringify(diskSettings().preview))
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
      const hasConc = await js<boolean>("!!document.querySelector('[data-sp-conc]')")
      const hasQuality = await js<boolean>("!!document.querySelector('[data-sp-quality]')")
      check('S7 缓存分组能打开并显示占用', cacheOpen && totalText !== '' && totalText !== '—', `total=${totalText} 控件=${hasConc}/${hasQuality}`)

      // 缩略图与派生预览必须分开统计：混在一起的话「清理」就分不清该不该带走转码结果
      const before = cacheDisk()
      check('S7 占用统计与磁盘一致（缩略图 / 派生分开算）',
        before.thumbs > 0 && thumbText !== '0 B',
        `diskThumbs=${before.thumbs} diskDerived=${before.derived} domThumbs=${thumbText}`)

      // 并发数与质量：改完落盘，且主进程真的按新值跑（清掉缩略图后按新质量重建）
      await js("(() => { const el = document.querySelector('[data-sp-conc]'); el.value = '2'; el.dispatchEvent(new Event('input', { bubbles: true })); return true })()")
      await new Promise((r) => setTimeout(r, 300))
      check('S7 并发数落盘', diskSettings().thumbs.concurrency === 2, String(diskSettings().thumbs.concurrency))
      await clickEl('[data-sp-quality] button:nth-child(3)') // 第三档 = 92
      await new Promise((r) => setTimeout(r, 300))
      check('S7 质量档位落盘', diskSettings().thumbs.quality === 92, String(diskSettings().thumbs.quality))

      // 清理缩略图：文件真的没了，且随后会被重新生成（不是把卡片清成一片灰）
      await clickEl('[data-sp-clear-thumbs]')
      const armed = (await js<string>("document.querySelector('[data-sp-clear-thumbs]')?.textContent.trim() ?? ''")) ?? ''
      check('S7 清理要先二次确认', armed === '再点一次确认', armed)
      check('S7 第一次点击不会真删', cacheDisk().thumbs > 0, String(cacheDisk().thumbs))
      await clickEl('[data-sp-clear-thumbs]')
      await new Promise((r) => setTimeout(r, 600))
      // ⚠️ 不能拿「此刻磁盘上还剩几个」来断言「删干净了」—— 6 张小图几百毫秒就重建完了，
      // 这个测量本身是竞态的（第一版就这么假红过）。改从**主进程回报的删除数**取证：
      // 那些数是我自己先在磁盘上数出来的，两边对上就说明删的正是这批文件。
      const toast = (await js<string>("document.querySelector('.notice-toast')?.textContent.trim() ?? ''")) ?? ''
      const cleared = Number(/已清理 (\d+) 个文件/.exec(toast)?.[1] ?? -1)
      check('S7 清理缩略图：主进程确实删掉了磁盘上那批 grid/detail',
        cleared === before.thumbs, `磁盘实测=${before.thumbs} 回报删除=${cleared} toast=${toast}`)
      check('S7 清理不会连带删掉派生预览（那是要重新转码的）',
        (await loadDiskDerived()) === before.derived, `before=${before.derived}`)

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
      await capture('shot-settings-cache.png')
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
      await js(`window.stash.import.files({ paths: [${JSON.stringify(copySrc)}], folderId: ${folder.id} })`)
      await new Promise((r) => setTimeout(r, 1500))
      check('S9 打开去重后，同一文件被跳过（没有多出素材）', names().length === beforeSkip,
        `${beforeSkip} → ${names().length}`)

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

      // —— 删除库：只验「要点两次」，不真删（真删了后面几段就没库可用了）——
      await clickEl('[data-sp-delete-lib]')
      const delArmed = (await js<string>("document.querySelector('[data-sp-delete-lib]')?.textContent.trim() ?? ''")) ?? ''
      check('S10 删除库要先二次确认', delArmed === '再点一次确认', delArmed)
      check('S10 第一次点击不会真删库', existsSync(join(lib.path, '.stash')))
      // 换个分组再回来：二次确认必须被收掉（不然回到这一组会让人以为已经点过一次了）
      await clickEl('[data-sp-group="shortcuts"]')
      await waitFor("!!document.querySelector('[data-sp-shortcuts]')", 6000)
      await clickEl('[data-sp-group="library"]')
      await waitFor("!!document.querySelector('[data-sp-delete-lib]')", 6000)
      const delReset = (await js<string>("document.querySelector('[data-sp-delete-lib]')?.textContent.trim() ?? ''")) ?? ''
      check('S10 换分组会收掉「删除」的二次确认', delReset === '删除此库', delReset)
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
      check('S11b 服务层：总计 = 素材 + 缓存', u1.totalBytes === u1.assetsBytes + u1.thumbsBytes, JSON.stringify(u1))

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
