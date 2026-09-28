#!/usr/bin/env node
// 只读自查：这张图里到底有没有「AI 生成参数」可以被提取出来。
//
// 用法：
//   node scripts/check-image-meta.mjs "E:/某个目录"
//   node scripts/check-image-meta.mjs "E:/a.png" "E:/b.jpg"
//
// 为什么值得先跑一下：AI 提示词（ComfyUI 的 prompt/workflow、A1111 的 parameters）都存在
// **PNG 的文本块**里，而 JPG / WebP **装不下文本块** —— 一旦转成 JPG/WebP，提示词就物理消失了，
// 之后任何软件都读不回来（不是「软件不支持」）。本脚本只读元数据，不改动任何文件。
import sharp from 'sharp'
import { readdirSync, statSync } from 'fs'
import { join, extname, basename } from 'path'

/** 各家把生成参数放在哪个块里（与 electron/services/genmeta.ts 的判据一致） */
const KNOWN_CHUNKS = {
  prompt: 'ComfyUI（API 工作流 JSON）',
  workflow: 'ComfyUI（可拖回复原的 UI 工作流）',
  parameters: 'A1111 / Forge / Fooocus',
  fooocus_scheme: 'Fooocus',
  invokeai_metadata: 'InvokeAI',
  Comment: 'NovelAI',
  comment: 'NovelAI',
  Description: 'Midjourney（就是提示词原文）',
  AIGC: '国内 AIGC 隐式标识'
}
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.tif', '.tiff', '.heic'])

function collect(paths) {
  const out = []
  for (const p of paths) {
    let st
    try {
      st = statSync(p)
    } catch {
      console.log(`✗ 读不到：${p}`)
      continue
    }
    if (st.isDirectory()) {
      for (const e of readdirSync(p, { withFileTypes: true })) {
        if (e.isDirectory()) continue
        if (IMG_EXT.has(extname(e.name).toLowerCase())) out.push(join(p, e.name))
      }
    } else out.push(p)
  }
  return out
}

const args = process.argv.slice(2)
if (!args.length) {
  console.log('用法：node scripts/check-image-meta.mjs <文件或目录> [...]')
  process.exit(1)
}

let withMeta = 0
let without = 0

for (const abs of collect(args)) {
  console.log(`\n=== ${basename(abs)}`)
  let md
  try {
    md = await sharp(abs).metadata()
  } catch (e) {
    console.log(`  ✗ 无法解码：${e.message}`)
    continue
  }
  const comments = md.comments ?? []
  const chunks = comments.map((c) => `${c.keyword}(${String(c.text).length} 字)`)
  console.log(`  格式 ${md.format} ${md.width}x${md.height}  ${(statSync(abs).size / 1024).toFixed(0)} KB`)
  console.log(`  文本块：${chunks.length ? chunks.join('、') : '无'}`)
  console.log(`  EXIF：${md.exif ? md.exif.length + ' 字节' : '无'}   XMP：${md.xmp ? '有' : '无'}`)

  const hits = comments.filter((c) => KNOWN_CHUNKS[c.keyword])
  if (hits.length) {
    withMeta++
    for (const c of hits) console.log(`  ✓ 可提取：${c.keyword} → ${KNOWN_CHUNKS[c.keyword]}`)
  } else {
    without++
    console.log('  ✗ 文件里没有生成参数')
    if (md.format === 'jpeg' || md.format === 'webp') {
      console.log('    ↳ 这是 JPG/WebP：格式本身装不下 PNG 文本块。若原图是 PNG，提示词已被转格式丢掉，无法找回。')
    } else if (md.exif) {
      console.log('    ↳ 只有相机 EXIF（拍摄信息），没有生成参数。')
    }
  }
}

console.log(`\n——— 汇总：${withMeta} 个带生成参数，${without} 个没有 ———`)
if (without) {
  console.log('提示：带生成参数的请用**原始 PNG**。JPG/WebP 已经装不下文本块，换软件也读不出来。')
}
