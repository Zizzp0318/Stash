<script setup lang="ts">
/**
 * 开库全屏加载层。
 *
 * 为什么是「全屏」而不是只盖中栏：用户切进一个大库（8000+ 素材、Windows 刚开机、
 * 文件缓存是冷的）时，主进程会同步扫全库，几十秒内任何 IPC 都不回。这段时间里
 * 左右栏还显示着上一个库的文件夹与标签 —— 只盖中栏会让人以为「已经好了」，伸手一点没反应。
 *
 * 三条硬约束（都是踩过的坑）：
 *   1. **进度必须由渲染层自己跑**。主进程卡住时 `thumb:progress` / `library:usage` 一个都发不出来，
 *      任何「等真实事件」的进度条都会停在原地 —— 那比没有更让人焦虑。这里用 rAF 自驱的渐近进度。
 *   2. **永不到 100%**。停在 92% 等真实完成，比「99% 卡二十秒」诚实得多；真实完成时组件直接卸载，
 *      背后内容已经就绪，硬切不闪。
 *   3. **可见性不依赖进场动画**。整层由 `v-if` 与静态样式决定可见；动画只负责好看，
 *      窗口在后台被节流也照样看得见。
 *
 * 视觉参数与 `docs/ui-preview/boot-overlay-theme.html` 一致；颜色全部走 `main.css` 的变量，
 * 深/浅两套主题自动跟随，组件里不写死任何颜色（除了模拟素材的色块）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useLibraryStore } from '../stores/library'

const lib = useLibraryStore()

/** 跳过这几秒的开场 → App 立即进入淡出（不等到最小展示时间） */
const emit = defineEmits<{ (e: 'skip'): void }>()

/** 固定窗口时长（App 传 lib.bootMinMs）。0/未传时按 9 秒算 */
const props = defineProps<{ minMs?: number; pending?: number }>()

/** 主标题固定：换库/开库对用户是同一件事 */
const TITLE = '正在打开素材库'

/**
 * 文案时间线。不接任何后端事件 —— 卡顿期间也照常推进。
 * 阈值取自实机：8000 条冷盘约 15~40s，前 1.2s 先把「打开」这一步演完，
 * 5s 后进入「逐个核对」，11s 后才提示慢（太早提示会显得软件很虚弱）。
 */
const PHASES = [
  { at: 0, text: '正在连接索引…' },
  { at: 1.6, text: '正在读取素材索引…' },
  { at: 5.2, text: '索引较大，正在逐个核对…' },
  { at: 11, text: '正在从磁盘读取，请稍候…' }
] as const

const caption = ref<string>(PHASES[0].text)
const pct = ref(0)
const elapsed = ref(0)

/** 超过 `bootStuckAfterMs` 才说「慢」——测试缝会把它调小，生产恒 8s */
const slow = computed(() => elapsed.value * 1000 >= lib.bootStuckAfterMs)

/**
 * 副标题：前 5 秒走阶段文案（连接索引 → 读取索引），之后若还有缩略图欠账，
 * 就换成「还剩 N 张」—— 让「为什么还没好」变得可解释，而不是一直转圈。
 *
 * ⚠️ 必须定义在 `caption` / `elapsed` 之后：setup 是顺序执行，提前引用会踩 TDZ。
 */
const subText = computed(() => {
  if (elapsed.value >= 5 && props.pending && props.pending > 0) {
    return `正在整理缩略图（还剩 ${props.pending.toLocaleString()} 张）`
  }
  return caption.value
})

let raf = 0
let t0 = 0
let lastPhase = -1

function tick(now: number): void {
  const s = (now - t0) / 1000
  elapsed.value = s

  /*
   * 渐近曲线：1.2s 线性冲到 34%（让人觉得「确实在动」），
   * 之后 34 + 58·(1-e^(-t/4.5)) 逼近 92%。
   *
   * 但固定窗口是 9 秒，光靠渐近曲线到点只有 80% 出头 —— 会在「没满」的状态下淡出。
   * 所以再叠一条「窗口进度」：按 dur 线性走到 92%，两者取大。
   * 前段仍是 34% 的冲刺（窗口进度那时才 14%），中段由窗口进度接管，到点时正好 92%。
   */
  const dur = props.minMs && props.minMs > 0 ? props.minMs : 9000
  const base = s < 1.2 ? (s / 1.2) * 34 : 34 + 58 * (1 - Math.exp(-(s - 1.2) / 4.5))
  const byWindow = dur > 0 ? (s * 1000) / dur * 92 : 92
  // 起点给 8%：第一帧就有可见的一小截，否则 0% 时像“还没开始”
  pct.value = Math.min(Math.max(Math.max(base, byWindow), 8), 92)

  let idx = 0
  for (let i = 0; i < PHASES.length; i++) if (s >= PHASES[i].at) idx = i
  if (idx !== lastPhase) {
    lastPhase = idx
    caption.value = PHASES[idx].text
  }

  raf = requestAnimationFrame(tick)
}

onMounted(() => {
  t0 = performance.now()
  raf = requestAnimationFrame(tick)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
})
</script>

<template>
  <!-- data-boot-layer / -pill / -label / -ratio / -hint 是冒烟锚点，改名要同步 smoke-boot.ts -->
  <div class="boot-overlay" data-boot-layer role="status" aria-live="polite">
    <div class="boot-glow" aria-hidden="true"></div>
    <div class="boot-vignette" aria-hidden="true"></div>

    <div class="boot-card" data-boot-pill>
      <!-- 固定 9 秒窗口 + 可跳过：不是「防闪白」，而是把这段时间当成开场。
           没有出口的 9 秒会让人觉得软件卡死，所以入口必须一直在。 -->
      <button class="boot-skip" type="button" data-boot-skip @click="emit('skip')">跳过</button>
      <div class="boot-head">
        <div class="boot-orb" aria-hidden="true"></div>
        <div class="boot-titles">
          <div class="boot-title" data-boot-label>{{ TITLE }}</div>
          <div class="boot-sub">{{ subText }}</div>
        </div>
      </div>

      <div class="boot-track">
        <div class="boot-fill" :style="{ width: pct + '%' }" :data-boot-ratio="pct.toFixed(1)"></div>
      </div>

      <div class="boot-foot">
        <span class="boot-note">约 9 秒后自动进入，可随时跳过</span>
        <span v-if="slow" class="boot-hint" data-boot-hint>首次打开或刚开机会慢一些</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * 整层：fixed 覆盖视口（不受 .app 的 overflow 影响），z-index 高于导入浮层(100)。
 * -webkit-app-region: drag —— 全窗都盖住了，但窗口仍然拖得动：
 * 用户判断「卡死」的第一依据就是窗口拖不动，这一点不能让磨砂层吃掉。
 */
.boot-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--bg-app) 42%, transparent);
  -webkit-backdrop-filter: blur(22px) saturate(1.3) brightness(0.8);
  backdrop-filter: blur(22px) saturate(1.3) brightness(0.8);
  animation: boot-in 0.35s ease-out both;
  /* 固定窗口结束时淡出（.is-leaving 由 App 加上），而不是「啪」一下消失 */
  transition: opacity 0.42s ease;
  -webkit-app-region: drag;
}
/*
 * 离场：必须先 animation:none —— `boot-in` 带 fill-mode both，结束后会把 opacity
 * 锁在 1，transition 改不动它（表现就是「加了过渡但没淡出」）。
 */
.boot-overlay.is-leaving {
  animation: none;
  opacity: 0;
  /*
   * 淡出期间不能继续吃点击：层还挂在 DOM 上（等 420ms 结束才卸载），
   * opacity:0 不会解除命中测试 —— 这 420ms 里用户点哪儿都没反应，
   * 表现为「骨架刚淡出，界面却点不动」。
   */
  pointer-events: none;
}

/* 跳过：右上角常驻。固定 9 秒窗口如果没有出口，观感就是「卡死了」 */
.boot-skip {
  position: absolute;
  top: 10px;
  right: 10px;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--border-soft);
  background: transparent;
  color: var(--text-3);
  font-size: 11px;
  font-family: var(--font);
  cursor: pointer;
  -webkit-app-region: no-drag;
}
.boot-skip:hover {
  color: var(--text-1);
  background: var(--bg-hover);
}

/* 浅色：从「压暗」改成「提亮」。米白界面被压暗会变成水泥灰 */
:global([data-theme='light'] .boot-overlay) {
  background: color-mix(in srgb, var(--bg-canvas) 40%, transparent);
  -webkit-backdrop-filter: blur(16px) saturate(1.1) brightness(1);
  backdrop-filter: blur(16px) saturate(1.1) brightness(1);
}

/* 氛围光：磨砂背后垫一层色，避免大面积死黑；浅色换暖色，冷色压米白会发脏 */
.boot-glow {
  position: absolute;
  inset: -25%;
  pointer-events: none;
  background:
    radial-gradient(42% 38% at 22% 24%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 68%),
    radial-gradient(36% 32% at 78% 30%, rgba(167, 139, 250, 0.1), transparent 68%),
    radial-gradient(46% 40% at 58% 84%, color-mix(in srgb, var(--accent) 9%, transparent), transparent 70%);
  filter: blur(46px);
  animation: boot-drift 22s ease-in-out infinite alternate;
}

:global([data-theme='light'] .boot-glow) {
  background:
    radial-gradient(44% 40% at 20% 22%, rgba(224, 168, 96, 0.1), transparent 68%),
    radial-gradient(40% 36% at 80% 32%, color-mix(in srgb, var(--accent) 7%, transparent), transparent 68%),
    radial-gradient(46% 40% at 58% 84%, rgba(224, 168, 96, 0.07), transparent 70%);
}

/* 暗角：把注意力收进中间 */
.boot-vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(110% 85% at 50% 42%, transparent 42%, rgba(0, 0, 0, 0.46) 100%);
}

:global([data-theme='light'] .boot-vignette) {
  background: radial-gradient(110% 85% at 50% 42%, transparent 44%, rgba(74, 60, 40, 0.12) 100%);
}

/* 卡片：双层玻璃（磨砂 + 渐变描边） */
.boot-card {
  position: relative;
  z-index: 2;
  width: 408px;
  max-width: calc(100vw - 48px);
  padding: 26px 28px 24px;
  border-radius: 20px;
  background: linear-gradient(
    158deg,
    color-mix(in srgb, var(--bg-raised) 84%, transparent),
    color-mix(in srgb, var(--bg-panel) 92%, transparent)
  );
  -webkit-backdrop-filter: blur(22px) saturate(1.45);
  backdrop-filter: blur(22px) saturate(1.45);
  border: 1px solid var(--border-soft);
  box-shadow: var(--shadow-modal), 0 1px 0 var(--hairline) inset;
  -webkit-app-region: no-drag;
}

:global([data-theme='light'] .boot-card) {
  background: linear-gradient(
    158deg,
    color-mix(in srgb, #ffffff 94%, transparent),
    color-mix(in srgb, var(--bg-raised) 96%, transparent)
  );
  border-color: var(--border);
  -webkit-backdrop-filter: blur(22px) saturate(1.2);
  backdrop-filter: blur(22px) saturate(1.2);
}

/* 1px 渐变描边：远看是玻璃的边缘厚度 */
.boot-card::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: linear-gradient(140deg, var(--accent-border), var(--border-soft) 38%, var(--accent-soft));
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
}

.boot-head {
  display: flex;
  align-items: center;
  gap: 13px;
  margin-bottom: 6px;
}

/* 呼吸光点 */
.boot-orb {
  position: relative;
  width: 38px;
  height: 38px;
  border-radius: 12px;
  flex: none;
  background: var(--accent-soft);
  border: 1px solid var(--accent-border);
  display: grid;
  place-items: center;
}

.boot-orb::before {
  content: '';
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 14px var(--accent-border);
  animation: boot-breathe 2.6s ease-in-out infinite;
}

.boot-orb::after {
  content: '';
  position: absolute;
  inset: -8px;
  border-radius: 20px;
  background: radial-gradient(circle, var(--accent-soft), transparent 70%);
  animation: boot-breathe 2.6s ease-in-out infinite;
}

.boot-titles {
  min-width: 0;
}

.boot-title {
  font-size: 16px;
  font-weight: 500;
  color: var(--text-1);
  letter-spacing: 0.2px;
  line-height: 1.35;
}

.boot-sub {
  margin-top: 3px;
  font-size: 12.5px;
  color: var(--text-2);
  line-height: 1.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.boot-track {
  margin-top: 22px;
  height: 6px;
  border-radius: 999px;
  background: var(--track);
  overflow: hidden;
  position: relative;
}

.boot-fill {
  height: 100%;
  width: 0;
  /* 起点也留一截：进度 0% 时完全不可见，会让人以为“没开始” */
  min-width: 6px;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 78%, #ffffff));
  box-shadow: 0 0 14px var(--accent-soft);
  transition: width 0.45s cubic-bezier(0.22, 0.61, 0.36, 1);
  position: relative;
  overflow: hidden;
}

/* 流光：即使 rAF 被后台节流，这一条也还在动（合成线程） */
.boot-fill::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(100deg, transparent 22%, rgba(255, 255, 255, 0.42) 50%, transparent 78%);
  animation: boot-shimmer 1.9s linear infinite;
}

.boot-foot {
  margin-top: 13px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 11.5px;
  color: var(--text-3);
}

.boot-note {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.boot-hint {
  color: var(--text-2);
  white-space: nowrap;
}

@keyframes boot-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes boot-drift {
  from { transform: translate3d(-1.5%, -1%, 0) scale(1); }
  to { transform: translate3d(2%, 1.5%, 0) scale(1.06); }
}

@keyframes boot-breathe {
  0%, 100% { opacity: 0.55; transform: scale(0.94); }
  50% { opacity: 1; transform: scale(1.04); }
}

@keyframes boot-shimmer {
  from { transform: translateX(-110%); }
  to { transform: translateX(110%); }
}

@media (prefers-reduced-motion: reduce) {
  .boot-overlay,
  .boot-glow,
  .boot-orb::before,
  .boot-orb::after,
  .boot-fill::after {
    animation: none;
  }
}
</style>
