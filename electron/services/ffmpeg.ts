// ffmpeg 可执行文件的**唯一入口**。
//
// 为什么单独一个模块（而不是各处 `import ffmpegPath from 'ffmpeg-static'`）：
// ① `ffmpeg-static` 的默认导出在**打包后**指向 asar 包内的路径，而 .exe 必须落在
//    真实磁盘上才能 spawn —— electron-builder 会按 asarUnpack 把它解到
//    `app.asar.unpacked/...`。这个路径修正在这里做一次，其它模块只管用 `FFMPEG`。
// ② 将来若换掉 ffmpeg-static（例如改用自建的 LGPL 构建，见 M8 的许可证议题），
//    只需要改这一个文件，调用方一处都不用动。
import ffmpegStatic from 'ffmpeg-static'

/**
 * 把 asar 内路径映射到 asar.unpacked。
 * 用正则而不是拼 `sep`：ffmpeg-static 返回的字符串在 Windows 上是 `\` 分隔，
 * 但这个模块也应当在别的平台/别的分隔符下正常工作。
 */
function resolveFfmpegPath(): string {
  const raw = (ffmpegStatic as string | null) ?? ''
  if (!raw) throw new Error('ERR_FFMPEG_NOT_FOUND')
  return raw.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

/** ffmpeg 可执行文件的绝对路径 */
export const FFMPEG: string = resolveFfmpegPath()
