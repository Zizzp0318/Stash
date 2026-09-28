import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: 'electron/main.ts' }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: 'electron/preload.ts' }
    }
  },
  renderer: {
    root: 'src',
    plugins: [
      vue({
        template: {
          compilerOptions: {
            // media-chrome 是一组**原生自定义元素**（<media-controller> / <media-play-button> …）。
            // 不告诉 Vue 它们是原生标签，模板编译时会去组件表里找，控制台会刷
            // "Failed to resolve component" 警告，而且会被当成未知组件处理。
            isCustomElement: (tag) => tag.startsWith('media-')
          }
        }
      })
    ],
    build: {
      rollupOptions: {
        input: resolve('src/index.html')
      }
    },
    resolve: {
      alias: {
        '@': resolve('src')
      }
    }
  }
})
