// 放大预览的媒体装载组合式：把「策略查询 → 派生等待 → 播放地址」收成一条线。
//
// 为什么要这一层（而不是组件里直接写 `<img :src="stash://media/id">`）：
//   `stash://media/{id}` 背后可能是**还没生成**的派生文件 —— 那个 URL 会 404
//   （设计如此：生成必须由渲染层显式发起，否则播放器会面对一个悬住几分钟的请求）。
//   所以要先问 `preview.info`：直出就给地址；要派生就先 `ensure` + 监听进度，
//   等派生文件就绪后再把地址交给媒体元素；unsupported 则交给 UI 显示回退。
import { ref, watch, type Ref } from 'vue'
import type { StashAssetRow, StashPreviewInfo } from '../../env'

export type PreviewStatus = 'loading' | 'ready' | 'deriving' | 'unsupported' | 'error'

export function usePreviewMedia(asset: Ref<StashAssetRow | null>) {
  const info = ref<StashPreviewInfo | null>(null)
  const status = ref<PreviewStatus>('loading')
  /** 就绪后才有值；带 ?v= 时间戳，同一素材重新派生后能强制重新加载 */
  const url = ref<string | null>(null)
  /** 派生进度 0..1（只有 deriving 阶段有意义） */
  const progress = ref(0)
  const error = ref<string | null>(null)

  /** 请求序号：切素材时 +1，晚到的旧响应一律丢弃（否则旧素材的图会闪进新浮层） */
  let seq = 0
  /** 上一轮派生的事件退订器：素材切换时必须退订，否则旧任务的回调还在改新素材的状态 */
  let offEvents: Array<() => void> = []

  function detach(): void {
    for (const off of offEvents) off()
    offEvents = []
  }

  function setUrl(id: number): void {
    url.value = `stash://media/${id}?v=${Date.now()}`
    status.value = 'ready'
  }

  async function load(id: number): Promise<void> {
    const my = ++seq
    detach()
    status.value = 'loading'
    info.value = null
    url.value = null
    progress.value = 0
    error.value = null

    const r = await window.stash.preview.info(id)
    if (my !== seq) return
    if (!r.ok || !r.data) {
      status.value = 'error'
      error.value = r.error ?? '读取预览策略失败'
      return
    }
    const inf = r.data
    info.value = inf

    if (inf.strategy === 'unsupported') {
      status.value = 'unsupported'
      return
    }
    if (inf.strategy === 'original' || inf.ready) {
      setUrl(id)
      return
    }

    // 需要派生：显式发起生成，进度与结果走事件（IPC 不等长任务）
    status.value = 'deriving'
    const finished = new Promise<boolean>((resolve) => {
      offEvents = [
        window.stash.preview.onProgress((d) => {
          if (d.assetId === id) progress.value = d.ratio
        }),
        window.stash.preview.onDone((d) => {
          if (d.assetId !== id) return
          detach()
          if (d.ok) {
            resolve(true)
          } else {
            status.value = 'error'
            error.value = d.error ?? '预览生成失败'
            resolve(false)
          }
        })
      ]
    })
    const started = await window.stash.preview.ensure(id)
    if (my !== seq) return
    if (!started.ok) {
      status.value = 'error'
      error.value = started.error ?? '发起预览生成失败'
      return
    }
    const ok = await finished
    if (my !== seq || !ok) return

    // 生成完再问一次策略：拿到派生文件的真实大小/尺寸
    const again = await window.stash.preview.info(id)
    if (my !== seq) return
    if (again.ok && again.data?.ready) {
      info.value = again.data
      setUrl(id)
    } else {
      status.value = 'error'
      error.value = '生成完成后仍不可用'
    }
  }

  watch(
    () => asset.value?.id,
    (id) => {
      if (id != null) void load(id)
    },
    { immediate: true }
  )

  return {
    info,
    status,
    url,
    progress,
    error,
    reload: (): void => {
      const id = asset.value?.id
      if (id != null) void load(id)
    }
  }
}
