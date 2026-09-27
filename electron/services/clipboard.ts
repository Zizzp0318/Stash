// 系统剪贴板里的「文件列表」读写 + 纯文本写入。
//
// 背景：Electron 44 把 `clipboard` 模块换成了 W3C 风格的 MIME 接口
// （只剩 clear / has / read / write / readText / writeText），
// 老的 `readBuffer('FileNameW')` / `availableFormats()` **已被移除**，
// 所以不能再按 CF_HDROP 直接读写原始字节，也不用 spawn PowerShell 绕。
//
// 实测（Windows 11 + Electron 44.4.5）：
//   - **读取**：从资源管理器 Ctrl+C 后，`clipboard.read()` 返回的 item 带 `text/uri-list`，
//     内容是 `file:///D:/...`（URL 编码，`#` 开头是注释行）的换行分隔列表 → 能直接解析出绝对路径。
//   - **写入**：`clipboard.write([new ClipboardItem({ 'text/uri-list': … })])` 之后，
//     **系统剪贴板的 FileDropList 里真的出现了这些文件**
//     （用 PowerShell `Get-Clipboard -Format FileDropList` 验证过），
//     即资源管理器里能直接 Ctrl+V 粘贴出来 —— Chromium 帮我们做了 uri-list → CF_HDROP 的转换。
// 因此两个方向都用原生 API 就够。
import { clipboard, ClipboardItem } from 'electron'
import { fileURLToPath, pathToFileURL } from 'url'

/**
 * 把文件的绝对路径写进系统剪贴板（= 「复制源文件」）。
 * uri-list 规范要求以 CRLF 分隔，最后一行也要有换行。
 */
export async function writeFiles(paths: string[]): Promise<{ count: number }> {
  if (!paths.length) return { count: 0 }
  const list = paths.map((p) => pathToFileURL(p).href).join('\r\n') + '\r\n'
  await clipboard.write([new ClipboardItem({ 'text/uri-list': list })])
  return { count: paths.length }
}

/**
 * 读系统剪贴板里的文件列表（= 「粘贴」时看剪贴板里有什么）。
 * 剪贴板里是纯文本 / 图片时返回空数组 —— 调用方据此判断「没有文件可粘贴」。
 */
export async function readFiles(): Promise<string[]> {
  const out: string[] = []
  let items: Awaited<ReturnType<typeof clipboard.read>> = []
  try {
    items = await clipboard.read()
  } catch {
    return out
  }
  for (const item of items) {
    if (!item.types.includes('text/uri-list')) continue
    let text = ''
    try {
      const payload = await item.getType('text/uri-list')
      text = await (payload as Blob).text()
    } catch {
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim()
      // uri-list 允许 `#` 开头的注释行
      if (!s || s.startsWith('#')) continue
      try {
        out.push(fileURLToPath(s))
      } catch {
        /* 非 file: 协议（http 等）忽略 */
      }
    }
  }
  return out
}

/** 写一段纯文本进剪贴板 */
export async function writeText(text: string): Promise<{ ok: true }> {
  await clipboard.writeText(text)
  return { ok: true }
}
