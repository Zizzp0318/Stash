/**
 * 标签调色板（渲染层）。
 *
 * ⚠️ 与主进程 `electron/services/assets.ts` 的 `TAG_PALETTE` **必须逐字一致**：
 * 跨进程没有共享模块，主进程那份负责「新建标签时自动配色」，这份负责「右键改色的色块」。
 * 两边不一致的后果是：自动分配到的颜色在色板里选不中，用户会觉得"这个颜色是哪来的"。
 *
 * 选色原则：深色主题（近黑背景）下都要能看清，相邻色相拉开距离，
 * 且不要用纯 `#FF0000` 这类刺眼值（一排小圆点看久了会累）。
 */
export const TAG_COLORS: ReadonlyArray<{ hex: string; label: string }> = [
  { hex: '#E06C6C', label: '红' },
  { hex: '#E0925F', label: '橙' },
  { hex: '#D9B45B', label: '琥珀' },
  { hex: '#8FBF6A', label: '绿' },
  { hex: '#5FBFA8', label: '青绿' },
  { hex: '#5AA9D6', label: '蓝' },
  { hex: '#7C8FD9', label: '靛蓝' },
  { hex: '#A97CD9', label: '紫' },
  { hex: '#D07CB0', label: '粉' },
  { hex: '#8C8F96', label: '灰' }
] as const
