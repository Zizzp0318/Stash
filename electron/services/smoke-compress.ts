// 图像压缩冒烟：electron . --smoke-compress
//
// 覆盖 services/compress.ts（本项目唯一「改掉用户原文件内容」的操作）：
//   C1 大图替换     —— 真的落到磁盘（png 消失、jpg 出现）、索引同步、体积变小、
//                      note/评分/收藏/标签/生成参数不丢、旧缩略图缓存被清 + 新缩略图重建
//   C2 保护规则     —— 压不小就跳过 / 已是 JPG 默认不碰 / 动图不碰 / 透明先压白底（不是纯黑）
//   C3 长边限制     —— 超限的图等比缩小
//   C4 二次有损开关 —— 打开后才会去压已经是 JPG 的图
//   C5 界面         —— 批量条按钮 / 右键菜单 / 对话框控件 / 二次确认（改选项会收掉）/ 设置组
//   C6 收尾一致性   —— watcher 没插出重复行、没把行标 missing、没留临时文件
//
// ⚠️ 会写真实的 userData/config.json（压缩档位存在那儿），开头快照、finally 原样还原。
import { app, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { FFMPEG } from './ffmpeg'
import { closeCurrent, createLibrary, mkdirRel, requireCurrent } from './library'
import { importFiles } from './importer'
import { getSettings, patchSettings, type Settings } from './config'
import { compressAssets, type CompressSummary } from './compress'

interface Check { name: string; pass: boolean; detail?: string }

interface Row {
  id: number
  name: string
  rel_path: string
  ext: string
  type: string
  size: number
  content_hash: string | null
  note: string | null
  rating: number
  is_fav: number
  gen_meta: string | null
  gen_state: number | null
  ai_source: string | null
  missing: number
  width: number | null
  height: number | null
}

/** 大 PNG：用 SVG 的渐变 + 形状栅格化，构图接近照片 —— 转 JPEG 收益明显 */
async function makeBigPng(w: number, h: number, hue: number): Promise<Buffer> {
  const circles = Array.from({ length: 26 }, (_, i) => {
    const cx = ((i * 137) % 100) + 0
    const cy = ((i * 61) % 100) + 0
    const r = 4 + (i % 7)
    return `<circle cx="${cx}%" cy="${cy}%" r="${r}%" fill="hsl(${(hue + i * 13) % 360} 70% ${30 + (i % 5) * 9}%)" opacity="0.72"/>`
  }).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="hsl(${hue} 65% 55%)"/>
        <stop offset="0.5" stop-color="hsl(${(hue + 40) % 360} 55% 38%)"/>
        <stop offset="1" stop-color="hsl(${(hue + 90) % 360} 60% 22%)"/>
      </linearGradient>
      <radialGradient id="r" cx="0.7" cy="0.3" r="0.8">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.55"/>
        <stop offset="1" stop-color="#000000" stop-opacity="0.35"/>
      </radialGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    ${circles}
    <rect width="${w}" height="${h}" fill="url(#r)"/>
  </svg>`
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9, effort: 7 }).toBuffer()
}

const fmtSize = (n: number): string => (n < 1024 ? n + ' B' : (n / 1024).toFixed(0) + ' KB')

export async function runSmokeCompress(win: BrowserWindow): Promise<void> {
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
  const waitFor = async (cond: string, timeout = 10000): Promise<boolean> => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      if ((await js<boolean>(`!!(${cond})`)) === true) return true
      await new Promise((r) => setTimeout(r, 120))
    }
    return false
  }
  const jsErrors: string[] = []
  const armErrors = async (): Promise<void> => {
    // ⚠️ `ResizeObserver loop completed with undelivered notifications` 是浏览器在
    // 「一次布局里又改了尺寸」时给的无害提示，不是运行期错误。不过滤掉的话，
    // 凡是有元素展开/收起（对话框、进度条）就必然收进来 —— 这条断言会永远红。
    await js(
      'window.__scErrors = [];' +
        'const IGN = /ResizeObserver loop/;' +
        "window.addEventListener('error', (e) => { const m = String(e.message); if (!IGN.test(m)) window.__scErrors.push(m) });" +
        "window.addEventListener('unhandledrejection', (e) => { const m = String(e.reason); if (!IGN.test(m)) window.__scErrors.push(m) });"
    )
  }
  const capture = async (name: string): Promise<void> => {
    await new Promise((r) => setTimeout(r, 350))
    try {
      writeFileSync(join(process.cwd(), name), (await win.webContents.capturePage()).toPNG())
    } catch { /* 截图失败不影响结论 */ }
  }
  const clickEl = async (selector: string): Promise<boolean> =>
    (await js<boolean>(
      `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.click(); return true })()`
    )) === true
  const q = <T>(sql: string): T => requireCurrent().db.prepare(sql).get() as T
  const rowOf = (name: string): Row | undefined =>
    q<Row | undefined>(
      `SELECT id,name,rel_path,ext,type,size,content_hash,note,rating,is_fav,gen_meta,gen_state,
              ai_source,missing,width,height FROM assets WHERE name='${name}'`
    )
  const assetCount = (): number => q<{ c: number }>('SELECT count(*) AS c FROM assets').c
  const relAbs = (rel: string): string => join(libPath(), ...rel.split('/'))
  const libPath = (): string => requireCurrent().path
  /** 递归找库里的残留临时文件（压缩管线自己造的） */
  const strayTmp = (): string[] => {
    const out: string[] = []
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === '.stash' || e.name === '.thumbs') continue
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.startsWith('.stash-compress-')) out.push(p)
      }
    }
    try { walk(libPath()) } catch { /* ignore */ }
    return out
  }
  const thumbDir = (hash: string): string => join(libPath(), '.thumbs', hash)

  // ==================== 准备测试库 ====================
  const backup = JSON.parse(JSON.stringify(getSettings())) as Settings
  let dir: string | null = null
  try {
    dir = mkdtempSync(join(tmpdir(), 'stash-smoke-compress-'))
    const lib = createLibrary({ name: 'compress-lib', parentDir: dir })
    const folder = mkdirRel('素材')
    const src = join(dir, 'src')
    mkdirSync(src)

    // ① 大 PNG（要替换的主角）—— 1600×2400，转 JPEG 收益明显
    writeFileSync(join(src, 'big.png'), await makeBigPng(1600, 2400, 15))
    // ② 带透明的 PNG：四角全透明，用来验「压白底而不是纯黑」
    const alphaSvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">' +
        '<circle cx="300" cy="300" r="240" fill="#cc3322"/></svg>'
    )
    writeFileSync(join(src, 'alpha.png'), await sharp(alphaSvg).png({ compressionLevel: 9 }).toBuffer())
    // ③ 极小的 PNG：JPEG 只会更大 → 必须走「跳过」这条分支
    writeFileSync(
      join(src, 'tiny.png'),
      await sharp({ create: { width: 24, height: 24, channels: 3, background: '#3a7a4a' } })
        .png({ compressionLevel: 9, effort: 10 })
        .toBuffer()
    )
    // ④ 已经是 JPEG（q98 留足余量，方便 C4 验「打开开关后真的会压它」）
    writeFileSync(
      join(src, 'photo.jpg'),
      await sharp({ create: { width: 900, height: 900, channels: 3, background: '#8a6a3a' } })
        .jpeg({ quality: 98 })
        .toBuffer()
    )
    // ⑤ 动图（6 帧）—— 转单帧等于破坏，必须不碰
    execFileSync(FFMPEG, [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x160:rate=6', '-loop', '0',
      join(src, 'anim.gif')
    ], { stdio: 'ignore' })
    // ⑥ 长条图 1800×400：验「长边限制」
    writeFileSync(join(src, 'tall.png'), await makeBigPng(1800, 400, 200))
    // ⑦⑧ 两张给界面测试用的（选两张能让进度条真的出现一瞬）
    writeFileSync(join(src, 'ui1.png'), await makeBigPng(1400, 2000, 300))
    writeFileSync(join(src, 'ui2.png'), await makeBigPng(1400, 2000, 80))

    const names = ['big.png', 'alpha.png', 'tiny.png', 'photo.jpg', 'anim.gif', 'tall.png', 'ui1.png', 'ui2.png']
    patchSettings({ compress: { format: 'jpeg', quality: 90, maxEdge: 0, alsoJpeg: false } })
    await new Promise<void>((resolve) => {
      importFiles({ paths: names.map((n) => join(src, n)), folderId: folder.id, mode: 'copy', onDone: () => resolve() })
    })

    await js(`window.stash.library.open(${JSON.stringify(lib.path)}).then(() => location.reload())`)
    await waitFor("document.querySelector('.masonry-card')", 15000)
    await armErrors()
    await new Promise((r) => setTimeout(r, 400))

    check('C0 八个测试素材都导进来了', assetCount() === 8, String(assetCount()))

    // ==================== C1 大图替换 ====================
    {
      const before = rowOf('big.png') as Row
      const beforeSize = statSync(relAbs(before.rel_path)).size
      // 先把「用户数据」挂在它身上，压完必须一条不少
      requireCurrent().db
        .prepare("UPDATE assets SET note='我手写的提示词', rating=4, is_fav=1, gen_meta='{\"prompt\":\"x\"}', gen_state=3, ai_source='comfyui' WHERE id=?")
        .run(before.id)
      requireCurrent().db
        .prepare("INSERT INTO tags(name,color) VALUES('smoke-tag','#fff')")
        .run()
      const tagId = q<{ id: number }>("SELECT id FROM tags WHERE name='smoke-tag'").id
      requireCurrent().db.prepare('INSERT INTO asset_tags(asset_id,tag_id) VALUES(?,?)').run(before.id, tagId)
      const tagCountBefore = q<{ c: number }>('SELECT count(*) AS c FROM asset_tags WHERE asset_id=' + before.id).c

      const sm: CompressSummary = await compressAssets([before.id], { format: 'jpeg', quality: 90, maxEdge: 0 })
      const item = sm.items[0]

      check('C1 报告状态是 done', item?.status === 'done', JSON.stringify(item))
      check('C1 磁盘上真的换了文件：png 消失、jpg 出现',
        existsSync(relAbs('素材/big.jpg')) && !existsSync(relAbs('素材/big.png')),
        `jpg=${existsSync(relAbs('素材/big.jpg'))} png=${existsSync(relAbs('素材/big.png'))}`)
      const after = rowOf('big.jpg')
      const afterSize = after ? statSync(relAbs(after.rel_path)).size : -1
      check('C1 体积确实变小了', afterSize > 0 && afterSize < beforeSize,
        `${fmtSize(beforeSize)} → ${fmtSize(afterSize)}（${Math.round((afterSize / beforeSize) * 100)}%）`)
      check('C1 索引同步：name / rel_path / ext 都指向新文件',
        after?.name === 'big.jpg' && after?.rel_path === '素材/big.jpg' && after?.ext === 'jpg',
        JSON.stringify({ n: after?.name, r: after?.rel_path, e: after?.ext }))
      check('C1 索引里的 size 与磁盘实测一致', after?.size === afterSize, `db=${after?.size} disk=${afterSize}`)
      check('C1 content_hash 更新了（缩略图缓存路径靠它）',
        after?.content_hash !== before.content_hash && /^[0-9a-f]{20}$/.test(after?.content_hash ?? ''),
        `${before.content_hash} → ${after?.content_hash}`)
      check('C1 同一行（没有新插一行，也没有丢行）',
        after?.id === before.id && assetCount() === 8, `id ${before.id}→${after?.id} 共${assetCount()}`)

      // —— 用户数据一条都不能丢 ——
      check('C1 手写的提示词没被覆盖', after?.note === '我手写的提示词', String(after?.note))
      check('C1 评分 / 收藏保持', after?.rating === 4 && after?.is_fav === 1, `${after?.rating}/${after?.is_fav}`)
      check('C1 已提取的 AI 生成参数保持（压缩后不再重扫，不该被清掉）',
        after?.gen_meta?.includes('prompt') === true && after?.gen_state === 3 && after?.ai_source === 'comfyui',
        `state=${after?.gen_state} ai=${after?.ai_source}`)
      check('C1 标签关联保持',
        q<{ c: number }>(`SELECT count(*) AS c FROM asset_tags WHERE asset_id=${before.id}`).c === tagCountBefore,
        String(tagCountBefore))

      // —— 缩略图缓存：旧的清掉、新的重建 ——
      const oldHash = before.content_hash ?? ''
      check('C1 旧 hash 的缩略图缓存目录被清掉了',
        !existsSync(thumbDir(oldHash)),
        `old=${oldHash} 还在=${existsSync(thumbDir(oldHash))}`)
      const newThumb = join(thumbDir(after?.content_hash ?? ''), 'grid.webp')
      const t0 = Date.now()
      let rebuilt = false
      while (Date.now() - t0 < 25000) {
        if (existsSync(newThumb)) { rebuilt = true; break }
        await new Promise((r) => setTimeout(r, 300))
      }
      check('C1 新缩略图已重建（不然卡片就是一块灰）', rebuilt, newThumb.replace(libPath(), '<lib>'))
    }

    // ==================== C2 保护规则 ====================
    {
      const tiny = rowOf('tiny.png') as Row
      const photo = rowOf('photo.jpg') as Row
      const anim = rowOf('anim.gif') as Row
      const sm = await compressAssets([tiny.id, photo.id, anim.id], { format: 'jpeg', quality: 90, maxEdge: 0 })
      const byId = new Map(sm.items.map((i) => [i.id, i]))

      const t = byId.get(tiny.id)
      check('C2 压不小就跳过（小 PNG 不会被换成更大的 JPG）',
        t?.status === 'skipped' && t.reason.includes('没有更小'), `${t?.status}: ${t?.reason}`)
      check('C2 跳过时原文件一动没动', existsSync(relAbs(tiny.rel_path)) && !existsSync(relAbs('素材/tiny.jpg')))

      const p = byId.get(photo.id)
      check('C2 已是 JPG 默认不碰（避免二次有损编码）',
        p?.status === 'skipped' && p.reason.includes('已是 JPG'), `${p?.status}: ${p?.reason}`)

      const a = byId.get(anim.id)
      check('C2 动图不碰（转成单帧等于破坏）',
        a?.status === 'skipped' && a.reason.includes('动图'), `${a?.status}: ${a?.reason}`)
      check('C2 动图仍然存在且还是原来的扩展名', existsSync(relAbs(anim.rel_path)))

      // —— 透明：必须压成白底，不能变纯黑 ——
      const al = rowOf('alpha.png') as Row
      const sm2 = await compressAssets([al.id], { format: 'jpeg', quality: 90, maxEdge: 0 })
      check('C2 带透明的 PNG 能被压（hasAlpha 不该被当成不可处理）',
        sm2.items[0]?.status === 'done', JSON.stringify(sm2.items[0]))
      const alphaJpg = relAbs('素材/alpha.jpg')
      const px = await sharp(alphaJpg).extract({ left: 3, top: 3, width: 1, height: 1 }).raw().toBuffer()
      check('C2 透明区压成了白底（不 flatten 会变成纯黑 0,0,0）',
        px[0] > 240 && px[1] > 240 && px[2] > 240, `左上角 RGB = ${px[0]},${px[1]},${px[2]}`)
      const center = await sharp(alphaJpg).extract({ left: 300, top: 300, width: 1, height: 1 }).raw().toBuffer()
      check('C2 原图的不透明部分内容还在（不是整张变成白板）',
        center[0] > 120 && center[1] < 120, `中心 RGB = ${center[0]},${center[1]},${center[2]}`)
    }

    // ==================== C3 长边限制 ====================
    {
      const tall = rowOf('tall.png') as Row
      const sm = await compressAssets([tall.id], { format: 'jpeg', quality: 90, maxEdge: 800 })
      check('C3 超限的图能压成功', sm.items[0]?.status === 'done', JSON.stringify(sm.items[0]))
      const m = await sharp(relAbs('素材/tall.jpg')).metadata()
      check('C3 长边被等比缩到上限内（1800×400 → 长边 800）',
        Math.max(m.width ?? 0, m.height ?? 0) <= 801 && m.width === 800 && m.height === 178,
        `${m.width}x${m.height}`)
      const row = rowOf('tall.jpg') as Row
      check('C3 索引里的宽高跟着更新', row?.width === 800 && row?.height === 178, `${row?.width}x${row?.height}`)
    }

    // ==================== C4 二次有损开关 ====================
    {
      const photo = rowOf('photo.jpg') as Row
      const sm = await compressAssets([photo.id], { format: 'jpeg', quality: 90, maxEdge: 0, alsoJpeg: true })
      const it = sm.items[0]
      check('C4 打开「也重新压缩 JPG」后，JPG 会被真的处理（要么压小、要么因压不小而跳过）',
        it?.status === 'done' || (it?.status === 'skipped' && !it.reason.includes('已是 JPG')),
        `${it?.status}: ${it?.reason}`)
    }

    // ==================== C5 界面 ====================
    {
      const ui1 = rowOf('ui1.png') as Row
      const ui2 = rowOf('ui2.png') as Row
      // 选中两张：批量条应该出现
      await js(`(() => {
        const grid = document;
        const a = grid.querySelector('.masonry-card[data-id="${ui1.id}"]');
        const b = grid.querySelector('.masonry-card[data-id="${ui2.id}"]');
        if (a) a.click();
        if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
        return true;
      })()`)
      const barUp = await waitFor("document.querySelector('[data-bb-compress]')", 5000)
      check('C5 批量条出现了「压缩」动作', barUp)

      await clickEl('[data-bb-compress]')
      const dlgUp = await waitFor("document.querySelector('[data-cp-modal]')", 5000)
      const ctrl = await js<Record<string, boolean>>(
        `(() => ({
           fmt: !!document.querySelector('[data-cp-format]'),
           qual: !!document.querySelector('[data-cp-quality]'),
           edge: !!document.querySelector('[data-cp-maxedge]'),
           alsoJpeg: !!document.querySelector('[data-cp-alsojpeg]'),
           warn: !!document.querySelector('[data-cp-warn]'),
           run: !!document.querySelector('[data-cp-run]')
         }))()`
      )
      check('C5 对话框打开且六个部件齐全（含不可逆警示）',
        dlgUp && Object.values(ctrl ?? {}).every(Boolean), JSON.stringify(ctrl))
      const title = (await js<string>("document.querySelector('[data-cp-modal] .modal-title')?.textContent.trim() ?? ''")) ?? ''
      check('C5 标题写明了会动几张', /2/.test(title), title)
      await capture('shot-compress-dialog.png')

      // 第一次点击只应进入二次确认，不该动手
      await clickEl('[data-cp-run]')
      const armedTxt = (await js<string>("document.querySelector('[data-cp-run]')?.textContent.trim() ?? ''")) ?? ''
      check('C5 第一次点击只是二次确认（按钮文案变了）', armedTxt === '再点一次确认', armedTxt)
      check('C5 第一次点击没有动任何文件', existsSync(relAbs(ui1.rel_path)) && existsSync(relAbs(ui2.rel_path)))

      // 改选项必须把确认收掉：举着「再点一次确认」再去改参数，会让人以为新参数也确认过了
      await clickEl('[data-cp-quality] button:nth-child(1)')
      await new Promise((r) => setTimeout(r, 250))
      const resetTxt = (await js<string>("document.querySelector('[data-cp-run]')?.textContent.trim() ?? ''")) ?? ''
      check('C5 改了选项之后二次确认被收掉', resetTxt === '压缩并替换原文件', resetTxt)
      check('C5 改质量落盘（对话框与设置同一份偏好）',
        getSettings().compress.quality === 75, String(getSettings().compress.quality))

      // 真跑一次。⚠️ 按钮语义是「点一次=确认一下、再点一次=执行」，
      // 而上面改质量已经把确认收掉了 —— 所以要**再点两次**才轮得到执行。
      // 只点一次的话只是又进了一次确认态，什么都不会发生（第一版就这么写的，跑出来一片红）。
      await clickEl('[data-cp-run]')
      const armedAgain = (await js<string>("document.querySelector('[data-cp-run]')?.textContent.trim() ?? ''")) ?? ''
      if (armedAgain !== '再点一次确认') check('C5 重新进入二次确认态', false, armedAgain)
      await clickEl('[data-cp-run]')
      const busy = await waitFor("document.querySelector('[data-cp-prog-sub]')", 8000)
      check('C5 运行中切到进度视图（而不是干等着）', busy)
      const doneOne = await (async (): Promise<boolean> => {
        const t0 = Date.now()
        while (Date.now() - t0 < 60000) {
          if (existsSync(relAbs('素材/ui1.jpg')) && existsSync(relAbs('素材/ui2.jpg'))) return true
          await new Promise((r) => setTimeout(r, 300))
        }
        return false
      })()
      check('C5 界面跑出来的结果真的落盘了（两张都换成了 jpg）', doneOne,
        `ui1=${existsSync(relAbs('素材/ui1.jpg'))} ui2=${existsSync(relAbs('素材/ui2.jpg'))}`)
      check('C5 跑完对话框自动关闭', await waitFor("!document.querySelector('[data-cp-modal]')", 8000))
      const toast = (await js<string>("document.querySelector('.notice-toast')?.textContent.trim() ?? ''")) ?? ''
      check('C5 结果提示里说了省下多少', /省下/.test(toast), toast)
      await capture('shot-compress-done.png')

      // —— 设置面板里的那一组 ——
      await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
      await new Promise((r) => setTimeout(r, 300))
      await clickEl('.side-footer .side-item')
      const panelUp = await waitFor("!!document.querySelector('[data-sp-group=\"compress\"]')", 6000)
      check('C5 设置面板里有「图像压缩」分组', panelUp)
      await clickEl('[data-sp-group="compress"]')
      const spCtrl = await js<Record<string, boolean>>(
        `(() => ({
           fmt: !!document.querySelector('[data-sp-cp-format]'),
           qual: !!document.querySelector('[data-sp-cp-quality]'),
           edge: !!document.querySelector('[data-sp-cp-maxedge]'),
           alsoJpeg: !!document.querySelector('[data-sp-cp-alsojpeg]')
         }))()`
      )
      check('C5 设置组四个控件都在', Object.values(spCtrl ?? {}).every(Boolean), JSON.stringify(spCtrl))
      await clickEl('[data-sp-cp-maxedge] button:nth-child(2)') // 2560
      await new Promise((r) => setTimeout(r, 300))
      check('C5 设置里改长边上限会落盘', getSettings().compress.maxEdge === 2560,
        String(getSettings().compress.maxEdge))
      await capture('shot-compress-settings.png')
      await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
    }

    // ==================== C6 收尾一致性（watcher 不能被自己人骗） ====================
    {
      // chokidar 的 awaitWriteFinish 是 800ms，等够再断言
      await new Promise((r) => setTimeout(r, 2200))
      check('C6 没有多出重复素材行（替换被 watcher 当成了外部新增就会多）',
        assetCount() === 8, String(assetCount()))
      const missing = q<{ c: number }>('SELECT count(*) AS c FROM assets WHERE missing=1').c
      check('C6 没有行被误标为 missing（旧文件是我们自己删的，不该进失效列表）',
        missing === 0, String(missing))
      const strays = strayTmp()
      check('C6 没有残留的临时文件', strays.length === 0, strays.join(' | ').replace(libPath(), '<lib>'))
      const pngLeft = ['big.png', 'alpha.png', 'tall.png', 'ui1.png', 'ui2.png'].filter((n) =>
        existsSync(relAbs('素材/' + n))
      )
      check('C6 被压缩的那些 PNG 都已从磁盘消失', pngLeft.length === 0, pngLeft.join(','))
      check('C6 没被压缩的（tiny / anim）仍在', existsSync(relAbs('素材/tiny.png')) && existsSync(relAbs('素材/anim.gif')))

      const errs = await js<string[]>('window.__scErrors || []')
      if (Array.isArray(errs)) jsErrors.push(...errs)
      check('C6 全流程渲染层无运行期错误', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '))
    }
  } catch (e) {
    check('套件执行未抛异常', false, String((e as Error)?.message ?? e))
  } finally {
    try {
      patchSettings(backup)
    } catch { /* 还原失败不挡住退出 */ }
    try {
      closeCurrent()
    } catch { /* 库已经关了 */ }
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch { /* Windows 句柄未释放，忽略 */ }
    }
    const failed = checks.filter((c) => !c.pass)
    console.log('[SMOKE-COMPRESS] ' + JSON.stringify({ checks, failed, ok: failed.length === 0 }, null, 2))
    app.exit(0)
  }
}
