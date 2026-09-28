// 从项目 LOGO 生成 Windows 图标（build/icon.ico）+ 一张 512 的 PNG。
//
// 零新依赖：sharp 负责栅格化，ICO 容器自己拼（Vista 起 ICO 允许直接放 PNG 数据）。
// LOGO 与 TitleBar 的 `.brand-mark` / 欢迎页的 `.w-logo` 同源：
// 金黄底（--accent #E8B04B）+ 圆角 + 深色中心圆与四向短线（viewBox 12 单位）。
import sharp from 'sharp'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

const OUT_DIR = join(process.cwd(), 'build')
const SIZES = [16, 24, 32, 48, 64, 128, 256]

/**
 * 画 LOGO。`size` 只用于设置 SVG 的宽高属性。
 * 小尺寸刻意**加粗**十字线：1.3/12 单位在 16px 下不足 1.7 物理像素，会糊成一团灰。
 */
function logoSvg(size) {
  const stroke = size <= 32 ? 1.8 : 1.3
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" width="${size}" height="${size}">` +
      `<rect width="12" height="12" rx="3.6" fill="#E8B04B"/>` +
      `<circle cx="6" cy="6" r="2.2" fill="#242629"/>` +
      `<path d="M6 0.5v2.4M6 9.1v2.4M0.5 6h2.4M9.1 6h2.4" stroke="#242629" stroke-width="${stroke}" stroke-linecap="round"/>` +
      `</svg>`
  )
}

const pngAt = (size) =>
  sharp(logoSvg(size), { density: 384 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9, effort: 7 })
    .toBuffer()

const pngs = []
for (const s of SIZES) pngs.push(await pngAt(s))

// ---- ICO 容器 ----
// 头 6 字节：reserved=0 / type=1(图标) / count
// 每个目录项 16 字节：w,h(0 表示 256) / 调色板数 / reserved / planes / bitCount / 数据长度 / 数据偏移
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(SIZES.length, 4)

const entries = []
const blobs = []
let offset = 6 + 16 * SIZES.length
for (let i = 0; i < SIZES.length; i++) {
  const s = SIZES[i]
  const e = Buffer.alloc(16)
  e.writeUInt8(s >= 256 ? 0 : s, 0)
  e.writeUInt8(s >= 256 ? 0 : s, 1)
  e.writeUInt8(0, 2) // 调色板颜色数（真彩=0）
  e.writeUInt8(0, 3) // reserved
  e.writeUInt16LE(1, 4) // planes
  e.writeUInt16LE(32, 6) // 位深
  e.writeUInt32LE(pngs[i].length, 8)
  e.writeUInt32LE(offset, 12)
  offset += pngs[i].length
  entries.push(e)
  blobs.push(pngs[i])
}

mkdirSync(OUT_DIR, { recursive: true })
const ico = Buffer.concat([header, ...entries, ...blobs])
writeFileSync(join(OUT_DIR, 'icon.ico'), ico)
writeFileSync(join(OUT_DIR, 'icon.png'), await pngAt(512))

console.log(`build/icon.ico  ${SIZES.join('/')}  共 ${(ico.length / 1024).toFixed(1)} KB`)
console.log(`build/icon.png  512x512  ${((await pngAt(512)).length / 1024).toFixed(1)} KB`)
