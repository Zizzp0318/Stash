/**
 * `.vue` 单文件组件的模块声明。
 *
 * ⚠️ 必须单独放一个**非模块**（script 模式）的 `.d.ts`：`env.d.ts` 含顶层 `export`，是模块文件，
 * 那里的 `declare module '*.vue'` 会被 TS 当成**模块增强**而非全局环境声明 → 不生效
 * （表现：`src/main.ts` 报 `Cannot find module './App.vue'`）。
 * 本文件用内联 `import('vue')` 而**不用顶层 import**，正是为了保持 script 模式，声明才会被当作环境模块。
 *
 * 为什么不直接上 `vue-tsc`：那要新增依赖并改检查链；而本项目的 .vue 只被 `main.ts` 以「组件值」方式引用，
 * 用通用声明即可满足类型检查。若日后要校验 .vue 内部的模板/脚本类型，再评估引入 vue-tsc。
 */
declare module '*.vue' {
  const component: import('vue').DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}
