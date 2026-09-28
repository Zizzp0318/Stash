// media-chrome 的自定义元素注册。
//
// 这是**有副作用的 import**（执行 `customElements.define`），全应用只需要跑一次，
// 所以集中在一个文件里，组件只 `import './media-chrome'`。
//
// 按需引入这一组就够了（容器 + 控制条 + 播放/进度/时间/音量/全屏/加载中），
// 刻意**不引 `media-chrome` 根入口** —— 那会把字幕、投屏、弹幕菜单等一整套全拉进来。
//
// 另外：`media-chrome` 只是套在原生 `<video>/<audio>` 外面的**控制条**，
// 它不改变解码能力（能不能播完全由 Chromium 的解码器决定，见 preview.ts 的说明）。
import 'media-chrome/dist/media-container.js'
import 'media-chrome/dist/media-controller.js'
import 'media-chrome/dist/media-control-bar.js'
import 'media-chrome/dist/media-play-button.js'
import 'media-chrome/dist/media-time-range.js'
import 'media-chrome/dist/media-time-display.js'
import 'media-chrome/dist/media-duration-display.js'
import 'media-chrome/dist/media-mute-button.js'
import 'media-chrome/dist/media-volume-range.js'
import 'media-chrome/dist/media-fullscreen-button.js'
import 'media-chrome/dist/media-loading-indicator.js'
