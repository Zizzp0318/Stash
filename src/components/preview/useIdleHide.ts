// 「指针静止 / 离开画面 → 浮层淡出」的共用逻辑。
//
// 现在有两处用它：中栏视频浮层的播放条（`PreviewPlayerBar`）、图片预览底部的操作提示（`PreviewImage`）。
// 共同点是「浮层压在**任意亮度的画面**上，长期存在既挡内容、又未必看得清」。
//
// 为什么不用纯 CSS 的 `:hover`：CSS 看不出「指针还在画面里、但已经静止了多久」，
// 也做不到「离开画面立刻收起（不等计时）」与「静止 N 秒淡出」两套规则的组合。
//
// 四条约定（都踩过，别改）：
// ① 隐藏只用 `opacity` + `pointer-events: none`，**绝不用 v-if / display 移除 DOM** ——
//    控件不重挂载、位置不跳，隐藏时点画面仍能落到下面的「播放 / 暂停 / 缩放」上，
//    自动化断言也才能靠读 opacity 验行为（元素一直在）；
// ② 监听挂在**判定区**（被覆盖的那块画面）而不是浮层自己 —— 浮层只占画面一条，
//    指针在画面任意处一动就该把它叫回来，不必先摸到那一条；
// ③ 模板 ref 的赋值晚于子节点首渲染，所以判定区拿不到时必须**退回 root 的父级**（就是它盖着的那块）；
// ④ `hold` 是「绝不隐藏」的附加条件（正在拖进度条、指针正停在浮层上…）——
//    正要点播放键它自己没了最恼人。
import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { useSettingsStore } from '../../stores/settings'

export interface IdleHideOptions {
  /** 是否启用。返回 false 时完全不动（`shown` 恒为 true） */
  enabled: () => boolean
  /** 要显隐的那个节点 */
  root: () => HTMLElement | null
  /** 判定区（一般是被覆盖的画面）；不给就用 root 的父级 */
  target?: () => HTMLElement | null
  /** 静止多久收起；不传就用设置里的值（`preview.idleHideMs`，0 = 不自动隐藏） */
  idleMs?: number
  /** 附加的「绝不隐藏」条件 */
  hold?: () => boolean
}

export interface IdleHide {
  shown: Ref<boolean>
  /** 亮起并重新计时 */
  reveal: () => void
  /** 只重新计时（不改可见性），如「松手后重新开始静止计时」 */
  reschedule: () => void
  /** 立刻收起（不等计时） */
  hideNow: () => void
}

export function useIdleHide(opts: IdleHideOptions): IdleHide {
  const shown = ref(true)
  const settings = useSettingsStore()
  /** 现读：用户在设置里把延迟调了，下一次计时就该按新值走（不做 setup 期快照） */
  const idleMs = (): number => opts.idleMs ?? settings.settings.preview.idleHideMs
  let timer: number | null = null

  function clearTimer(): void {
    if (timer != null) {
      window.clearTimeout(timer)
      timer = null
    }
  }
  function reschedule(): void {
    clearTimer()
    if (!opts.enabled() || opts.hold?.()) return
    const ms = idleMs()
    if (ms <= 0) return // 0 = 用户明确要求「不自动隐藏」
    timer = window.setTimeout(() => {
      timer = null
      shown.value = false
    }, ms)
  }
  function reveal(): void {
    if (!opts.enabled()) return
    shown.value = true
    reschedule()
  }
  function hideNow(): void {
    if (!opts.enabled() || opts.hold?.()) return
    clearTimer()
    shown.value = false
  }

  let detach: Array<() => void> = []
  function attach(): void {
    for (const off of detach) off()
    detach = []
    const t = opts.target?.() ?? opts.root()?.parentElement ?? null
    // ⚠️ 这里**只挡「没有判定区」**，不能连 `enabled()` 一起挡：`enabled` 常常是
    // 「素材已就绪」这类**会从 false 变 true** 的条件，挂载时还轮不到它（图片预览就是
    // status: loading）。一旦在这里 return，监听就永远没挂上 —— 表现是「能自动隐藏、
    // 但指针动一下再也叫不回来」（hide 有 `watch(status)` 兜底，reveal 没有）。
    // 所以 enabled 一律交给下面各 handler 自己判。
    if (!t) return
    const bind: Array<[string, EventListener]> = [
      ['pointermove', () => reveal()],
      ['pointerdown', () => reveal()],
      ['pointerenter', () => reveal()],
      ['pointerleave', () => hideNow()],
      // 合成事件（自动化）里没有真指针，pointerleave 不一定会来，mouseleave 兜一层
      ['mouseleave', () => hideNow()]
    ]
    for (const [type, fn] of bind) {
      t.addEventListener(type, fn)
      detach.push(() => t.removeEventListener(type, fn))
    }
    reschedule() // 先亮一会儿再淡出，否则用户压根不知道这里有东西
  }

  onMounted(attach)
  watch(() => opts.target?.(), attach)
  onBeforeUnmount(() => {
    clearTimer()
    for (const off of detach) off()
    detach = []
  })

  return { shown, reveal, reschedule, hideNow }
}
