/**
 * 文件夹外观：颜色 ID 与取值。
 *
 * 为什么存 ID 而不是 hex：深浅两个主题需要**两套色值**（深色下要亮、浅色下要压深），
 * 存 hex 就只能在切主题后发灰。ID 是稳定的，具体值由 main.css 的
 * `--folder-tint-*` 变量按主题给。
 *
 * 色值取向自 Serpent（MIT），与它的外观系统保持同一套观感。
 */
export const FOLDER_COLOR_IDS = [
  'blue',
  'indigo',
  'purple',
  'pink',
  'orange',
  'green',
  'teal',
  'red'
] as const

export type FolderColorId = (typeof FOLDER_COLOR_IDS)[number]

export const FOLDER_COLORS: ReadonlyArray<{ id: FolderColorId; label: string }> = [
  { id: 'blue', label: '蓝' },
  { id: 'indigo', label: '靛蓝' },
  { id: 'purple', label: '紫' },
  { id: 'pink', label: '粉' },
  { id: 'orange', label: '橙' },
  { id: 'green', label: '绿' },
  { id: 'teal', label: '青' },
  { id: 'red', label: '红' }
] as const

const COLOR_SET = new Set<string>(FOLDER_COLOR_IDS)

export function isFolderColorId(v: string | null | undefined): v is FolderColorId {
  return !!v && COLOR_SET.has(v)
}

/**
 * 颜色 ID → CSS 变量引用。未知值（老数据里的 hex、手改库）一律返回 undefined，
 * 绝不把库里的字符串直接拼进 CSS —— 那等于把一个注入点交给数据。
 */
export function folderTint(colorId: string | null | undefined): string | undefined {
  return isFolderColorId(colorId) ? `var(--folder-tint-${colorId})` : undefined
}
