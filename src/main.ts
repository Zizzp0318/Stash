import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './assets/styles/main.css'
import './assets/styles/preview.css'
import { applyThemeToDocument, readThemeHint } from './utils/theme'

/*
 * 首帧先按「上一次的有效主题」铺一遍。
 *
 * 为什么必须放在挂载之前：主题的真相在主进程 `config.json`，要过一轮 IPC 才拿得到；
 * 而那之间 `<html>` 上什么都没有 → 命中 `:root`（深色）。
 * 深色用户本来就无感，浅色用户则会看到「白窗口闪一下变黑再变白」——这一行就是消掉那一下的。
 * 缓存的过期 / 读失败都不影响正确性：settings.init() 之后 App.vue 会以配置为准再铺一次。
 */
applyThemeToDocument(readThemeHint())

createApp(App).use(createPinia()).mount('#app')
