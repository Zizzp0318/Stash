/**
 * 文件夹线框图标集 —— 取自 IconPark 1.4.2（字节跳动，Apache 2.0）。
 *
 * ⚠️ 内联 SVG 字符串，不是 npm 引包：零外部依赖，体积固定（61 个约 56KB）。
 * 源图 48×48 viewBox + 4px 描边；渲染 14px 时描边视觉约 1.17px，与项目既有 1.2px 线框一致。
 *
 * 与 emoji 的分工（见 folderEmojis.ts）：
 *   · icon  → 只有形状，可被「颜色」染色（侧栏用 color: var(--folder-tint)）
 *   · emoji → 自带颜色与情绪，不染色
 *
 * key 一旦被用户用过就**不要改名**（改了就丢设置）。
 */
export interface FolderIconDef {
  key: string
  label: string
  svg: string
}

export interface FolderIconGroup {
  id: string
  label: string
  items: FolderIconDef[]
}

export const FOLDER_ICON_GROUPS: FolderIconGroup[] = [
  {
    id: 'media',
    label: '媒体',
    items: [
      {
        key: 'folder',
        label: '文件夹',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 6C7 4.89543 7.89543 4 9 4H39C40.1046 4 41 4.89543 41 6V42C41 43.1046 40.1046 44 39 44H9C7.89543 44 7 43.1046 7 42V6Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 29H20" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 35H26" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 5C8 5 11.7647 18 24 18C36.2353 18 40 5 40 5" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="24" cy="18" r="4" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 4H9C7.89543 4 7 4.89543 7 6V12" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M33 4H39C40.1046 4 41 4.89543 41 6V12" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'folder-close',
        label: '文件夹',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 8C5 6.89543 5.89543 6 7 6H19L24 12H41C42.1046 12 43 12.8954 43 14V40C43 41.1046 42.1046 42 41 42H7C5.89543 42 5 41.1046 5 40V8Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M43 22H5" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M5 16V28" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M43 16V28" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'folder-download',
        label: '下载夹',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 8C5 6.89543 5.89543 6 7 6H19L24 12H41C42.1046 12 43 12.8954 43 14V40C43 41.1046 42.1046 42 41 42H7C5.89543 42 5 41.1046 5 40V8Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M30 28L23.9933 34L18 28.0134" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 20V34" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'folder-focus',
        label: '收藏夹',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 8C5 6.89543 5.89543 6 7 6H19L24 12H41C42.1046 12 43 12.8954 43 14V40C43 41.1046 42.1046 42 41 42H7C5.89543 42 5 41.1046 5 40V8Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M24 20L26.243 24.9128L31.6085 25.5279L27.6292 29.1792L28.7023 34.4721L24 31.816L19.2977 34.4721L20.3708 29.1792L16.3915 25.5279L21.757 24.9128L24 20Z" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'cabinet',
        label: '文件柜',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M42 4H6V14H42V4Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M42 19H6V29H42V19Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M42 34H6V44H42V34Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M21 9H27" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M21 24H27" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M21 39H27" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>`
      },
      {
        key: 'image',
        label: '图片',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M5 10C5 8.89543 5.89543 8 7 8L41 8C42.1046 8 43 8.89543 43 10V38C43 39.1046 42.1046 40 41 40H7C5.89543 40 5 39.1046 5 38V10Z" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path fill-rule="evenodd" clip-rule="evenodd" d="M14.5 18C15.3284 18 16 17.3284 16 16.5C16 15.6716 15.3284 15 14.5 15C13.6716 15 13 15.6716 13 16.5C13 17.3284 13.6716 18 14.5 18Z" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 24L20 28L26 21L43 34V38C43 39.1046 42.1046 40 41 40H7C5.89543 40 5 39.1046 5 38V34L15 24Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'images',
        label: '图库',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 44H38C39.1046 44 40 43.1046 40 42V14H30V4H10C8.89543 4 8 4.89543 8 6V42C8 43.1046 8.89543 44 10 44Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M30 4L40 14" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="18" cy="17" r="4" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 28V37H33V21L23.4894 31.5L15 28Z" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'camera',
        label: '相机',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15 12L18 6H30L33 12H15Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><rect x="4" y="12" width="40" height="30" rx="3" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M24 35C28.4183 35 32 31.4183 32 27C32 22.5817 28.4183 19 24 19C19.5817 19 16 22.5817 16 27C16 31.4183 19.5817 35 24 35Z" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'video',
        label: '视频',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 10C4 8.89543 4.89543 8 6 8H34C35.1046 8 36 8.89543 36 10V19L44 13V36L36 30V38C36 39.1046 35.1046 40 34 40H6C4.89543 40 4 39.1046 4 38V10Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="17" cy="21" r="5" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'film',
        label: '胶片',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="6" width="36" height="36" rx="3" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M16 6V42" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M32 6V42" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 15H16" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M32 15H42" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 33H16" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 24H42" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M32 33H42" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'music',
        label: '音乐',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M30 34.5C30 32.567 31.567 31 33.5 31H41V34.4C41 36.3882 39.3882 38 37.4 38H33.5C31.567 38 30 36.433 30 34.5Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M6 38.5C6 36.567 7.567 35 9.5 35H16V38.4C16 40.3882 14.3882 42 12.4 42H9.5C7.567 42 6 40.433 6 38.5Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M16 18.044V18.044L41 12.125" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 38V10L41 4V33.6924" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'headset',
        label: '耳机',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M42 30V24.4615C42 14.2655 33.9411 6 24 6C14.0589 6 6 14.2655 6 24.4615V30" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M34 32C34 29.7909 35.7909 28 38 28H42V42H38C35.7909 42 34 40.2091 34 38V32Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M42 32H44C45.1046 32 46 32.8954 46 34V36C46 37.1046 45.1046 38 44 38H42V32Z" fill="currentColor"/><path d="M6 32H4C2.89543 32 2 32.8954 2 34V36C2 37.1046 2.89543 38 4 38H6V32Z" fill="currentColor"/><path d="M6 28H10C12.2091 28 14 29.7909 14 32V38C14 40.2091 12.2091 42 10 42H6V28Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'mic',
        label: '录音',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="16" y="4" width="16" height="28" rx="8" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 21V24C10 31.732 16.268 38 24 38V38C31.732 38 38 31.732 38 24V21" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 5V11" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 16H21" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M27 16H32" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 22H21" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M27 22H32" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 38V44" stroke="currentColor" stroke-width="4"/><path d="M16 44H32" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'doc',
        label: '文档',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 38V44H38V38" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M38 20V14L30 4H10V20" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M28 4V14H38" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 12H20" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><rect x="4" y="20" width="40" height="18" rx="2" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M10 25V33" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M10 25H12C14.2091 25 16 26.7909 16 29V29C16 31.2091 14.2091 33 12 33H10" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><ellipse cx="24" cy="29" rx="3" ry="4" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M38 25H36C33.7909 25 32 26.7909 32 29V29C32 31.2091 33.7909 33 36 33H38" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'book',
        label: '书籍',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 40C8 36 8 10 8 10C8 6.68629 10.8654 4 14.4 4H40V36C40 36 19.9815 36 14.4 36C9.36225 36 8 36.6842 8 40Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path fill-rule="evenodd" clip-rule="evenodd" d="M12 44H40V36H12C9.79086 36 8 37.7909 8 40C8 42.2091 9.79086 44 12 44Z" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'bookmark',
        label: '书签',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 44C8.89543 44 8 43.1046 8 42V6C8 4.89543 8.89543 4 10 4H38C39.1046 4 40 4.89543 40 6V42C40 43.1046 39.1046 44 38 44H10Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path fill-rule="evenodd" clip-rule="evenodd" d="M21 22V4H33V22L27 15.7273L21 22Z" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 4H38" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      }
    ]
  },
  {
    id: 'design',
    label: '设计',
    items: [
      {
        key: 'edit',
        label: '编辑',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 42H43" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M11 26.7199V34H18.3172L39 13.3081L31.6951 6L11 26.7199Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'scissors',
        label: '剪刀',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="5" width="38" height="38" rx="3" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 19C21 22 21 26 19 29" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M36 14L21 24L36 34" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="16" cy="16" r="4" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="16" cy="32" r="4" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'ruler',
        label: '尺子',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M44 14L34 4L30.25 7.75L26.5 11.5L19 19L11.5 26.5L7.75 30.25L4 34L14 44L44 14Z" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M30.25 7.75L7.75 30.25" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 29L13 33" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 24L20 30" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 19L23 23" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 14L30 20" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M29 9L33 13" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'layers',
        label: '图层',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 11.9143L24 19L44 11.9143L24 5L4 11.9143Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M4 20L24 27L44 20" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 28L24 35L44 28" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 36L24 43L44 36" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'grid',
        label: '网格',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="5" width="38" height="38" rx="2" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 5V43" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 24H43" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      }
    ]
  },
  {
    id: 'nature',
    label: '自然',
    items: [
      {
        key: 'earth',
        label: '世界',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M24 44C35.0457 44 44 35.0457 44 24C44 12.9543 35.0457 4 24 4C12.9543 4 4 12.9543 4 24C4 35.0457 12.9543 44 24 44Z" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 24H44" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path fill-rule="evenodd" clip-rule="evenodd" d="M24 44C28.4183 44 32 35.0457 32 24C32 12.9543 28.4183 4 24 4C19.5817 4 16 12.9543 16 24C16 35.0457 19.5817 44 24 44Z" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.85791 10.1421C13.4772 13.7614 18.4772 16 24 16C29.5229 16 34.5229 13.7614 38.1422 10.1421" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M38.1422 37.8579C34.5229 34.2386 29.5229 32 24 32C18.4772 32 13.4772 34.2386 9.85791 37.8579" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'mountain',
        label: '山',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M18 10L32 38H4L18 10Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M28 29L33.6471 22L44 38H32" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 22L24 22" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 18L10 26" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 18L26 26" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'tree',
        label: '树',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13.0448 14C13.5501 8.3935 18.262 4 24 4C29.738 4 34.4499 8.3935 34.9552 14H35C39.9706 14 44 18.0294 44 23C44 27.9706 39.9706 32 35 32H13C8.02944 32 4 27.9706 4 23C4 18.0294 8.02944 14 13 14H13.0448Z" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 28L29 23" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 25L18 19" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 44V18" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'sun',
        label: '太阳',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9.15039 9.15088L11.3778 11.3783" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 24H6.15" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.15039 38.8495L11.3778 36.6221" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M38.8495 38.8495L36.6221 36.6221" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M44.9996 24H41.8496" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M38.8495 9.15088L36.6221 11.3783" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 3V6.15" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 36C30.6274 36 36 30.6274 36 24C36 17.3726 30.6274 12 24 12C17.3726 12 12 17.3726 12 24C12 30.6274 17.3726 36 24 36Z" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M24 45.0001V41.8501" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'moon',
        label: '月亮',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M28.0527 4.41085C22.5828 5.83695 18.5455 10.8106 18.5455 16.7273C18.5455 23.7564 24.2436 29.4545 31.2727 29.4545C37.1894 29.4545 42.1631 25.4172 43.5891 19.9473C43.8585 21.256 44 22.6115 44 24C44 35.0457 35.0457 44 24 44C12.9543 44 4 35.0457 4 24C4 12.9543 12.9543 4 24 4C25.3885 4 26.744 4.14149 28.0527 4.41085Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'snow',
        label: '雪花',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M24 4V44" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.72461 14L41.3656 34" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.71923 33.9773L41.2814 14.0228" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 10L15 19L6 21" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 27L15 29L12 38" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M36 10L33 19L42 21" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M42 27L33 29L36 38" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 7L24 13L30 7" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 41L24 35L30 41" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      }
    ]
  },
  {
    id: 'animals',
    label: '动物',
    items: [
      {
        key: 'cat',
        label: '猫',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M42 26C42 34.8366 33.9411 42 24 42C14.0589 42 6 34.8366 6 26M15 12.1405C17.6476 10.7792 20.7214 10 24 10C27.2786 10 30.3524 10.7792 33 12.1405" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M6 26V8.48814C6 6.757 8.05005 5.84346 9.33729 7.00098L15 12.093" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M42 26V8.48814C42 6.757 39.9499 5.84346 38.6627 7.00098L33 12.093" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="30" cy="22" r="2" fill="currentColor"/><circle cx="18" cy="22" r="2" fill="currentColor"/><circle cx="24" cy="28" r="2" fill="currentColor"/><path d="M16 30L4 31" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 35L7 41" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M32 30L44 31" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M29 35L41 41" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'dog',
        label: '狗',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M17.0001 10L14.9999 5C12.8332 5.83333 8.2 10.8 9 18" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M30.9999 10L33.0001 5C35.1668 5.83333 39.8 10.8 39 18" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M42 28.5C42 38.165 33.9411 43 24 43C14.0589 43 6 38.165 6 28.5C6 18.835 14.0589 9 24 9C33.9411 9 42 18.835 42 28.5Z" fill="none" stroke="currentColor" stroke-width="4"/><circle cx="20" cy="17" r="2" fill="currentColor"/><circle cx="28" cy="17" r="2" fill="currentColor"/><path d="M24 26C24 27.6569 24.5 31.5 21 31.5C19.3431 31.5 18 30.1569 18 28.5" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24.0249 26C24.0249 27.6569 23.5249 31.5 27.0249 31.5C28.6818 31.5 30.0249 30.1569 30.0249 28.5" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M26 25.75C26 26.4404 24 27.5 24 27.5C24 27.5 22 26.4404 22 25.75C22 25.0596 22.5 24.5 24 24.5C25.5 24.5 26 25.0596 26 25.75Z" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'bird',
        label: '鸟',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 14.0003L4 20.0689C4 20.0689 5.84913 27.035 11 32.0006C20.8896 41.5344 35.3341 35.304 41 31.0006C46.3568 26.6309 43.7169 25.6695 42 26.0006L37 27.0006C46.0654 12.6997 43.5754 11.173 41 12.0006L32 16.0006C26.2311 19.1785 23.5 17.5006 22 16.0006L19 13.0002C14.5 9 10.0302 12.8417 9 14.0003Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="14" cy="20" r="2" fill="currentColor"/></svg>`
      },
      {
        key: 'fish',
        label: '鱼',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M44 24C42.7848 28.6903 36.038 32.4667 33 32.9997C30.5696 38.9691 24.038 39.5327 21 38.9997L25 32.9997C20.5443 32.5733 15.0253 27.9544 13 26.0001C10.3861 28.8504 6.19409 31.0805 4 31.9688C7.64557 24.2939 5.51899 17.3097 4 15.0001C6.83544 15.0001 11.1435 18.2235 13 20.0001C15.0253 17.8681 21.962 14.8879 25 13.9997L21 8.99979C28.6962 8.147 32.1561 11.868 33 14C40.6962 15.7056 43.6624 21.6904 44 24Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="36" cy="24.0001" r="2" fill="currentColor"/></svg>`
      },
      {
        key: 'butterfly',
        label: '蝴蝶',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.0002 12.0003C8.66389 7.70613 19.0814 18.8191 24.0002 25C28.9191 18.8191 39.3366 7.70599 43.0002 12.0001C43.6787 12.6507 44.4427 14.877 42.0002 18C41.3217 18.9759 40.186 21.7059 41.0002 26C41.0002 27.1386 39.8852 28.9519 35.0002 27C37.3749 28.6266 41.8498 33.0962 39.0002 37C36.2864 40.4158 29.9649 44.4569 26.0002 35L24.0002 31L22.0002 35C18.0356 44.4569 11.7141 40.4158 9.00024 37C6.15071 33.0962 10.6255 28.6268 13.0001 27.0003C8.1152 28.9521 7.00011 27.1389 7.00011 26.0003C7.81438 21.7061 6.67867 18.9762 6.00012 18.0003C3.55766 14.8773 4.32174 12.6509 5.0002 12.0003Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24.0322 23C23.534 17.8642 28.9135 7 33 7" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M23.9678 23C24.466 17.8642 19.0865 7 15 7" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'bug',
        label: '虫子',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M24 42C36 42 38 31.5324 38 28C38 24.8379 38 20.1712 38 14H10C10 17.4423 10 22.109 10 28C10 31.4506 12 42 24 42Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M4 8L10 14" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M44 8L38 14" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 27H10" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M44 27H38" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 44L13 38" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M41 44L35 38" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 42V14" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M14.9204 39.0407C17.0024 40.783 19.9244 41.9998 23.9999 41.9998C28.1112 41.9998 31.0487 40.7712 33.1341 39.0137" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M32 12.3333C32 7.73096 28.4183 4 24 4C19.5817 4 16 7.73096 16 12.3333V14H32V12.3333Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`
      }
    ]
  },
  {
    id: 'places',
    label: '地点',
    items: [
      {
        key: 'home',
        label: '家',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 18V42H39V18L24 6L9 18Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 29V42H29V29H19Z" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M9 42H39" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>`
      },
      {
        key: 'building',
        label: '建筑',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M11 14L25 4V44H11V14Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M25 13L39 23V44" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 44H44" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'tent',
        label: '帐篷',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 12L4 36H16" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M38 12H10L16 36H44L38 12Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 18H39" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 12L13 24" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M38 12L41 24" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'compass',
        label: '指南针',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 44L22.6875 15.5" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M36 44L25.3125 15.5" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="24" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M37.57 33C33.6618 35.5307 29.0024 37 23.9998 37C18.9973 37 14.3379 35.5307 10.4297 33" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 8V4" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'globe',
        label: '地球',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M37.8261 4C41.6276 7.58886 44 12.6753 44 18.3158C44 29.1871 35.1871 38 24.3158 38C18.6753 38 13.5889 35.6276 10 31.8261" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path fill-rule="evenodd" clip-rule="evenodd" d="M24 32C31.732 32 38 25.732 38 18C38 10.268 31.732 4 24 4C16.268 4 10 10.268 10 18C10 25.732 16.268 32 24 32Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 38V44" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 44H30" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      }
    ]
  },
  {
    id: 'transport',
    label: '交通',
    items: [
      {
        key: 'car',
        label: '汽车',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M13.5 32C14.8807 32 16 30.8807 16 29.5C16 28.1193 14.8807 27 13.5 27C12.1193 27 11 28.1193 11 29.5C11 30.8807 12.1193 32 13.5 32Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M34.5 32C35.8807 32 37 30.8807 37 29.5C37 28.1193 35.8807 27 34.5 27C33.1193 27 32 28.1193 32 29.5C32 30.8807 33.1193 32 34.5 32Z" fill="currentColor"/><path d="M7 37C5.34315 37 4 35.6569 4 34L4 24.7097C4 22.4363 5.28486 20.3581 7.3186 19.3422L8.00053 19.0015L10.3105 9.09194C10.7326 7.28117 12.3467 6 14.206 6L33.8943 6C35.7675 6 37.3899 7.29998 37.7981 9.12816L40.0031 19.0015L40.6834 19.3416C42.716 20.358 44 22.4355 44 24.7081V34C44 35.6569 42.6569 37 41 37H39.0031V38C39.0031 40.2091 37.2107 42 35.0016 42C32.7924 42 31 40.2091 31 38V37H17V38.0003C17 40.2093 15.2093 42 13.0003 42C10.7913 42 9.00053 40.2093 9.00053 38.0003V37H7Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M14 22H34L32.348 14.5661C32.1447 13.6511 31.3331 13 30.3957 13L17.6043 13C16.6669 13 15.8553 13.6511 15.652 14.5661L14 22Z" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'plane',
        label: '飞机',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20.5 10.5372C20.5 6.5143 22.8333 4.50286 24 4C25.1667 4.50286 27.5 6.5143 27.5 10.5372V18.0801L43 31V35L27 27V36L32 44L24 41L16 44L21 36V27L5 35V31L20.5 18.0801V10.5372Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'ship',
        label: '轮船',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M6 20.3768L24 14L42 20.3768L36.6667 34H11.3333L6 20.3768Z" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 8H35L34.9976 17.8961L24 14L13 17.8958V8Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M24 8V4" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 24V16" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 40L13.5 44L17 40L20.5 44L24 40L27.5 44L31 40L34.5 44L38 40" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'train',
        label: '火车',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 8.83932C9 7.90724 9.43829 7.03279 10.2715 6.61502C12.2462 5.62486 16.6123 4 24 4C31.3877 4 35.7538 5.62486 37.7285 6.61502C38.5617 7.0328 39 7.90724 39 8.83932V36C39 37.1046 38.1046 38 37 38H11C9.89543 38 9 37.1046 9 36V8.83932Z" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M34 38V42" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 38V42" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M20.5 32C20.5 32.8284 19.8284 33.5 19 33.5C18.1716 33.5 17.5 32.8284 17.5 32C17.5 31.1716 18.1716 30.5 19 30.5C19.8284 30.5 20.5 31.1716 20.5 32Z" fill="currentColor" stroke="currentColor"/><path d="M30.5 32C30.5 32.8284 29.8284 33.5 29 33.5C28.1716 33.5 27.5 32.8284 27.5 32C27.5 31.1716 28.1716 30.5 29 30.5C29.8284 30.5 30.5 31.1716 30.5 32Z" fill="currentColor" stroke="currentColor"/><path d="M20 44L28 44" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><rect x="9" y="12" width="30" height="14" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M24 12V26" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 12L28 12" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 26L28 26" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'bike',
        label: '自行车',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10.5 42C15.1944 42 19 38.1944 19 33.5C19 28.8056 15.1944 25 10.5 25C5.80558 25 2 28.8056 2 33.5C2 38.1944 5.80558 42 10.5 42Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M37 42C41.9706 42 46 37.9706 46 33C46 28.0294 41.9706 24 37 24C32.0294 24 28 28.0294 28 33C28 37.9706 32.0294 42 37 42Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M18.9966 6H27.9971L36.9999 33" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path fill-rule="evenodd" clip-rule="evenodd" d="M11.0574 33L31.6819 16.7632L11.0574 33Z" fill="none"/><path d="M11.0574 33L31.6819 16.7632" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M31.6819 15H40.1539L42.0001 10" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 15.9736H15" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 16L18.2727 26.4211" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      }
    ]
  },
  {
    id: 'devices',
    label: '设备',
    items: [
      {
        key: 'laptop',
        label: '笔记本',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="8" width="32" height="20" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 28L4 41H44L40 28" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M19.9 35H28.1L30 41H18L19.9 35Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'desktop',
        label: '台式机',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="19" y="32" width="10" height="9" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><rect x="5" y="8" width="38" height="24" rx="2" fill="none" stroke="currentColor" stroke-width="4"/><path d="M22 27H26" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 41L34 41" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'phone',
        label: '手机',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 30H40V42C40 43.1046 39.1046 44 38 44H10C8.89543 44 8 43.1046 8 42V30Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M40 30V6C40 4.89543 39.1046 4 38 4H10C8.89543 4 8 4.89543 8 6V30" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M22 37H26" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>`
      },
      {
        key: 'game',
        label: '游戏',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M38.5121 9.5362C34.8466 6.10249 29.9188 4 24.5 4C13.1782 4 4 13.1782 4 24.5C4 35.8218 13.1782 45 24.5 45C30.1148 45 35.2024 42.7427 38.9048 39.0861L24 24L38.5121 9.5362Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M40 28C42.2091 28 44 26.2091 44 24C44 21.7909 42.2091 20 40 20C37.7909 20 36 21.7909 36 24C36 26.2091 37.7909 28 40 28Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M17 13V21" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 17H21" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'cpu',
        label: '芯片',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M38 8H10C8.89543 8 8 8.89543 8 10V38C8 39.1046 8.89543 40 10 40H38C39.1046 40 40 39.1046 40 38V10C40 8.89543 39.1046 8 38 8Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M30 18H18V30H30V18Z" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path fill-rule="evenodd" clip-rule="evenodd" d="M14.9092 2V8V2Z" fill="none"/><path d="M14.9092 2V8" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path fill-rule="evenodd" clip-rule="evenodd" d="M14.9092 40V46V40Z" fill="none"/><path d="M14.9092 40V46" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path fill-rule="evenodd" clip-rule="evenodd" d="M24 2V8V2Z" fill="none"/><path d="M24 2V8" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path fill-rule="evenodd" clip-rule="evenodd" d="M24 40V46V40Z" fill="none"/><path d="M24 40V46" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path fill-rule="evenodd" clip-rule="evenodd" d="M33.0908 2V8V2Z" fill="none"/><path d="M33.0908 2V8" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path fill-rule="evenodd" clip-rule="evenodd" d="M33.0908 40V46V40Z" fill="none"/><path d="M33.0908 40V46" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path fill-rule="evenodd" clip-rule="evenodd" d="M2 14.9092H8H2Z" fill="none"/><path d="M2 14.9092H8" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path fill-rule="evenodd" clip-rule="evenodd" d="M40 14.9092H46H40Z" fill="none"/><path d="M40 14.9092H46" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path fill-rule="evenodd" clip-rule="evenodd" d="M2 24H8H2Z" fill="none"/><path d="M2 24H8" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path fill-rule="evenodd" clip-rule="evenodd" d="M40 24H46H40Z" fill="none"/><path d="M40 24H46" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path fill-rule="evenodd" clip-rule="evenodd" d="M2 33.0908H8H2Z" fill="none"/><path d="M2 33.0908H8" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path fill-rule="evenodd" clip-rule="evenodd" d="M40 33.0908H46H40Z" fill="none"/><path d="M40 33.0908H46" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'disk',
        label: '硬盘',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M44 29H4V42H44V29Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M35.5 38C36.8807 38 38 36.8807 38 35.5C38 34.1193 36.8807 33 35.5 33C34.1193 33 33 34.1193 33 35.5C33 36.8807 34.1193 38 35.5 38Z" fill="currentColor"/><path d="M4 28.9998L9.03837 4.99902H39.0205L44 28.9998" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`
      }
    ]
  },
  {
    id: 'people',
    label: '人物',
    items: [
      {
        key: 'person',
        label: '个人',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.00372 42.2311C5.00372 42.6557 5.35807 42.9999 5.79521 42.9999L42.2023 43C42.6394 43 42.9938 42.6558 42.9938 42.2313V41.3131C43.012 41.0364 43.049 39.6555 42.1388 38.1289C41.5648 37.1663 40.7318 36.3347 39.6628 35.6573C38.3696 34.8378 36.7245 34.244 34.7347 33.8865C34.72 33.8846 33.2446 33.689 31.7331 33.303C29.101 32.6307 28.8709 32.0357 28.8694 32.0299C28.8539 31.9711 28.8315 31.9146 28.8028 31.8615C28.7813 31.7505 28.7281 31.3328 28.8298 30.2136C29.088 27.371 30.6128 25.691 31.838 24.3412C32.2244 23.9155 32.5893 23.5134 32.8704 23.1191C34.0827 21.4181 34.1952 19.4839 34.2003 19.364C34.2003 19.1211 34.1724 18.9214 34.1127 18.7363C33.9937 18.3659 33.7698 18.1351 33.6063 17.9666L33.6052 17.9654C33.564 17.923 33.5251 17.8828 33.4933 17.8459C33.4812 17.8318 33.449 17.7945 33.4783 17.603C33.5859 16.8981 33.6505 16.3079 33.6815 15.7456C33.7367 14.7438 33.7798 13.2456 33.5214 11.7875C33.4895 11.5385 33.4347 11.2755 33.3494 10.9622C33.0764 9.95814 32.6378 9.09971 32.0284 8.39124C31.9236 8.27722 29.3756 5.5928 21.9788 5.04201C20.956 4.96586 19.9449 5.00688 18.9496 5.05775C18.7097 5.06961 18.3812 5.08589 18.0738 5.16554C17.3101 5.36337 17.1063 5.84743 17.0528 6.11834C16.9641 6.56708 17.12 6.91615 17.2231 7.14718L17.2231 7.1472L17.2231 7.14723C17.2381 7.18072 17.2566 7.22213 17.2243 7.32997C17.0526 7.59588 16.7825 7.83561 16.5071 8.06273C16.4275 8.13038 14.5727 9.72968 14.4707 11.8189C14.1957 13.4078 14.2165 15.8834 14.5417 17.5944C14.5606 17.6889 14.5885 17.8288 14.5432 17.9233L14.5432 17.9233C14.1935 18.2367 13.7971 18.5919 13.7981 19.4024C13.8023 19.4839 13.9148 21.4181 15.1272 23.1191C15.408 23.5131 15.7726 23.9149 16.1587 24.3403L16.1596 24.3412L16.1596 24.3413C17.3848 25.6911 18.9095 27.371 19.1678 30.2135C19.2694 31.3327 19.2162 31.7505 19.1947 31.8614C19.166 31.9145 19.1436 31.971 19.1282 32.0298C19.1266 32.0356 18.8974 32.6287 16.2772 33.2996C14.7656 33.6867 13.2775 33.8845 13.2331 33.8909C11.2994 34.2173 9.66438 34.7963 8.37351 35.6115C7.30813 36.2844 6.47354 37.1175 5.89289 38.0877C4.96517 39.6379 4.99025 41.0497 5.00372 41.3074V42.2311Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'people',
        label: '人物',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="14" cy="29" r="5" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="34" cy="29" r="5" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="24" cy="9" r="5" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 44C24 38.4772 19.5228 34 14 34C8.47715 34 4 38.4772 4 44" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M44 44C44 38.4772 39.5228 34 34 34C28.4772 34 24 38.4772 24 44" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M34 24C34 18.4772 29.5228 14 24 14C18.4772 14 14 18.4772 14 24" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'baby',
        label: '宝宝',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M24 43.6C32.432 43.6 39.5606 36.9192 41.8935 29.2497C42.4179 27.5255 46 27.5255 46 23.8C46 20.0745 42.3839 19.8601 41.7987 18.048C39.3724 10.5346 32.3209 4 24 4C15.6745 4 8.61973 10.5407 6.19725 18.0606C5.61467 19.8691 2 20.0091 2 23.8C2 27.5909 5.59225 27.5909 6.1349 29.3421C8.4967 36.9639 15.6018 43.6 24 43.6Z" fill="none" stroke="currentColor" stroke-width="4"/><path d="M41.7987 18.048C39.3724 10.5346 32.3209 4 24 4" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M19.1002 21.5998C19.1002 22.4261 18.876 23.1516 18.5398 23.6559C18.2013 24.1637 17.7885 24.3998 17.4002 24.3998C17.0119 24.3998 16.5991 24.1637 16.2606 23.6559C15.9244 23.1516 15.7002 22.4261 15.7002 21.5998C15.7002 20.7735 15.9244 20.048 16.2606 19.5437C16.5991 19.0359 17.0119 18.7998 17.4002 18.7998C17.7885 18.7998 18.2013 19.0359 18.5398 19.5437C18.876 20.048 19.1002 20.7735 19.1002 21.5998Z" fill="currentColor" stroke="currentColor"/><path d="M32.2999 21.5998C32.2999 22.4261 32.0757 23.1516 31.7395 23.6559C31.401 24.1637 30.9882 24.3998 30.5999 24.3998C30.2116 24.3998 29.7988 24.1637 29.4603 23.6559C29.1241 23.1516 28.8999 22.4261 28.8999 21.5998C28.8999 20.7735 29.1241 20.048 29.4603 19.5437C29.7988 19.0359 30.2116 18.7998 30.5999 18.7998C30.9882 18.7998 31.401 19.0359 31.7395 19.5437C32.0757 20.048 32.2999 20.7735 32.2999 21.5998Z" fill="currentColor" stroke="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M18.498 31.7505C20.4289 33.0501 22.266 33.6999 24.0094 33.6999C25.7509 33.6999 27.4776 33.0515 29.1894 31.7547" fill="currentColor"/><path d="M18.498 31.7505C20.4289 33.0501 22.266 33.6999 24.0094 33.6999C25.7509 33.6999 27.4776 33.0515 29.1894 31.7547" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M31.7283 6.2002C31.9964 8.13368 31.4067 9.54651 29.9593 10.4387C28.5119 11.3309 26.1602 11.749 22.9043 11.693" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>`
      },
      {
        key: 'briefcase',
        label: '工作',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M32 16C32 9.92487 28.4183 4 24 4C19.5817 4 16 9.92487 16 16" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 16H39L40 28H27V25H21V28H8L9 16Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 28L6 42H42L40 28" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 25H27V31H21V25Z" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'gift',
        label: '礼物',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M41 44V20H7V44H41Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 44V20" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M41 44H7" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><rect x="4" y="12" width="40" height="8" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M16 4L24 12L32 4" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'calendar',
        label: '日程',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 19H43V40C43 41.1046 42.1046 42 41 42H7C5.89543 42 5 41.1046 5 40V19Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M5 9C5 7.89543 5.89543 7 7 7H41C42.1046 7 43 7.89543 43 9V19H5V9Z" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M16 4V12" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M32 4V12" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M28 34H34" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 34H20" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M28 26H34" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 26H20" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      }
    ]
  },
  {
    id: 'objects',
    label: '物件',
    items: [
      {
        key: 'star',
        label: '星标',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M23.9986 5L17.8856 17.4776L4 19.4911L14.0589 29.3251L11.6544 43L23.9986 36.4192L36.3454 43L33.9586 29.3251L44 19.4911L30.1913 17.4776L23.9986 5Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'heart',
        label: '喜欢',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M15 8C8.92487 8 4 12.9249 4 19C4 30 17 40 24 42.3262C31 40 44 30 44 19C44 12.9249 39.0751 8 33 8C29.2797 8 25.9907 9.8469 24 12.6738C22.0093 9.8469 18.7203 8 15 8Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'bolt',
        label: '灵感',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M19 4H37L26 18H41L17 44L22 25H8L19 4Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'crown',
        label: '皇冠',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 40L4 17L14 22L24 8L34 22L44 17L39 40H9Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M24 33C26.2091 33 28 31.2091 28 29C28 26.7909 26.2091 25 24 25C21.7909 25 20 26.7909 20 29C20 31.2091 21.7909 33 24 33Z" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'key',
        label: '钥匙',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M22.8682 24.2982C25.4105 26.7935 26.4138 30.4526 25.4971 33.8863C24.5805 37.32 21.8844 40.0019 18.4325 40.9137C14.9806 41.8256 11.3022 40.8276 8.79375 38.2986C5.02208 34.4141 5.07602 28.2394 8.91499 24.4206C12.754 20.6019 18.9613 20.5482 22.8664 24.3L22.8682 24.2982Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M23 24L40 7" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M30.3052 16.9001L35.7337 22.3001L42.0671 16.0001L36.6385 10.6001L30.3052 16.9001Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>`
      },
      {
        key: 'lock',
        label: '锁',
        svg: `<?xml version="1.0" encoding="UTF-8"?><svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="22" width="36" height="22" rx="2" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M14 22V14C14 8.47715 18.4772 4 24 4C29.5228 4 34 8.47715 34 14V22" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M24 30V36" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      }
    ]
  }
]

/** key → 条目。侧栏渲染与面板选中态都用它 */
export const FOLDER_ICON_MAP: Record<string, FolderIconDef> = Object.fromEntries(
  FOLDER_ICON_GROUPS.flatMap((g) => g.items).map((i) => [i.key, i])
)
