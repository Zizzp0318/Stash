/**
 * HEIC / HEIF 解码 —— 本项目**唯一**入口。
 *
 * ## 为什么要单开一个模块
 *
 * 预编译 sharp（libvips 8.18.6）里的 libheif **不带 HEVC 解码器**（libde265 / dav1d 都不在
 * `libvips-42.dll` 里），所以 `.heic` 交给 sharp 只会静默失败：卡片灰、不报错。
 * 这里改用 `heif2jpeg`（Rust N-API，内含 libheif + libde265，全程跑在 libuv 线程池上）
 * 把 HEIC 解成 **JPEG 中间件**，再交回 sharp 做原有的「摆正 / 转 sRGB / 缩放 / 取色 / 派生」——
 * 后处理链路一行都不用改，两种来源在缩略图、详情预览、色板三处的观感天然一致。
 *
 * ## 实测（本机，4 个真样本，含 iPhone 12MP 的 5 格 tile-grid 形态）
 *
 * | 样本 | 尺寸 | 解码 | 解码 + sharp 缩到 800 → webp |
 * |---|---|---|---|
 * | mif1 1440×960 | 0.9 MP | 113 ms | 158 ms |
 * | msf1 1280×720 | 0.9 MP | 102 ms | 139 ms |
 * | mif1 1280×854 | 1.1 MP | 163 ms | 218 ms |
 * | heic 3992×2992（5 tile） | 12 MP | 627 ms | 722 ms |
 *
 * 4 张 12MP 并发 1828 ms（≈460 ms/张）；10ms 心跳期间仍能正常触发 → **主线程不被钉住**。
 * 对照另外两条路（同一台机器、同样样本）：换 ffmpeg 9.0.2 走「PNG 管道 + sharp」是 1123 ms，
 * libheif-js（WASM）纯解码就要 1396 ms 且峰值 RSS 253 MB。
 *
 * ## 三条纪律
 *
 * 1. **不要**把它接回 `sharp()` 的输入路径去「试试能不能解」—— sharp 解不了 HEVC，这不是配置问题。
 * 2. 中间件是 JPEG（q92）：只用于缩略图 / 派生预览，**绝不落回素材本体**。
 *    （原始 HEIC 一个字节都不动，压缩/替换那条线也不会碰这三个扩展名。）
 * 3. 解码结果是**已经应用过容器旋转（irot）**的像素，所以拿到 buffer 之后不要再 `.rotate()`
 *    去等 EXIF —— JPEG 中间件本身没有 EXIF，`.rotate()` 是空操作，无害但也没用。
 */
import { readFileSync, statSync } from 'fs'
import { heifToJpeg } from 'heif2jpeg'

/**
 * 认这三个扩展名。
 *
 * ⚠️ 必须与 `importer.ts` 的 `EXT_TYPE` 完全一致 —— 那里是「能不能进库」的唯一真相源，
 * 这里是「要不要走解码器」的唯一真相源。加一个减一个两边一起改，否则会出现
 * 「进库了但永远灰卡」或「能解但进不了库」。
 */
export const HEIF_EXT: ReadonlySet<string> = new Set(['heic', 'heif', 'hif'])

/** 扩展名（可带点、任意大小写）→ 是否 HEIC 系。传空值一律当「不是」，别让调用方在这里炸 */
export function isHeifExt(ext: string | null | undefined): boolean {
  if (!ext) return false
  return HEIF_EXT.has(ext.replace(/^\./, '').toLowerCase())
}

/**
 * 读进内存的上限（200 MB）。
 * 正常 HEIC 是几百 KB ~ 十几 MB；12MP 解码后 RGBA 约 48 MB，但**我们只拿 JPEG 产物**（4 MB 级）。
 * 设上限只为挡住「有人把 200 MB 的未知文件改成 .heic 丢进来」这种情形。
 */
const MAX_BYTES = 200 * 1024 * 1024

/**
 * 中间件质量。
 * 92 是「再压一次也看不出来」的档位，同时让 12MP 的 JPEG 只有 4 MB 左右 ——
 * 后面还要被 sharp 缩到 320/800/2560，压太狠会在**色板**上先露馅（大色块边缘发糊）。
 */
const INTERMEDIATE_QUALITY = 92

/**
 * 把一个库内的 HEIC/HEIF 文件解成 JPEG buffer。
 *
 * 错误码（渲染层有对应中文文案，见 `utils/format.ts`）：
 *   · `ERR_ASSET_MISSING` —— 文件不在了（外部删掉 / 搬走了）
 *   · `ERR_HEIF_EMPTY` —— 0 字节
 *   · `ERR_HEIF_TOO_LARGE` —— 超过 200 MB 上限
 *   · `ERR_HEIF_DECODE` —— 解码器本身失败（损坏文件、非 HEVC 的 HEIF 变体、缺省图等），
 *     `cause` 里挂着原始错误，排错时看它
 */
export async function decodeHeifToJpeg(abs: string, quality: number = INTERMEDIATE_QUALITY): Promise<Buffer> {
  let size = 0
  try {
    size = statSync(abs).size
  } catch {
    throw new Error('ERR_ASSET_MISSING')
  }
  if (size <= 0) throw new Error('ERR_HEIF_EMPTY')
  if (size > MAX_BYTES) throw new Error('ERR_HEIF_TOO_LARGE')
  try {
    // readFileSync 而不是流式：HEIC 通常几百 KB~十几 MB，一次读完比流式简单，
    // 也符合 `thumbs.openSource()` 那条「读进内存再解码，别让解码器长期持有源文件句柄」的纪律
    // （Windows 上句柄会挡住所在的文件夹改名）。
    return await heifToJpeg(readFileSync(abs), { quality })
  } catch (e) {
    const err = new Error('ERR_HEIF_DECODE') as Error & { cause?: unknown }
    err.cause = e
    throw err
  }
}
