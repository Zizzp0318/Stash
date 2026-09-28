<script setup lang="ts">
// 压缩对话框：确认目标格式 / 质量 / 长边上限后**原地替换**选中素材。
//
// 这是本项目里唯一「不可逆地改动用户原文件」的操作（删素材是删，这个是**换掉内容**），
// 所以三条要求：
//   ① 把后果写在按钮上而不是写在角落（「压缩并替换原文件」）；
//   ② 点两次确认（沿用项目里清理 / 删库 / 恢复默认的同一套习惯）；
//   ③ 选项一改就把二次确认收掉 —— 否则举着「再点一次确认」再去改参数，
//      用户会以为自己已经确认过这组新参数了。
//
// 选项直接读写全局设置（同一个 `compress` 段，设置面板里也有），所以这里改一次就记住了。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAssetStore } from '../stores/assets'
import { useSettingsStore } from '../stores/settings'
import { fmtSize } from '../utils/format'
import type { StashCompressSummary, StashSettingsChoices } from '../env'

const emit = defineEmits<{ (e: 'close'): void }>()

const assets = useAssetStore()
const settings = useSettingsStore()
const s = computed(() => settings.settings)

const choices = ref<StashSettingsChoices | null>(null)
/** 运行中 */
const running = ref(false)
/** 二次确认 */
const armed = ref(false)
/** 实时进度 */
const prog = ref({ done: 0, total: 0, name: '', status: '', reason: '', savedBytes: 0 })

const ids = computed(() => [...assets.selectedIds])
const count = computed(() => ids.value.length)
/** 选中项的合计体积。选中集永远是可见项的子集（store 会按 visible 过滤），所以从当前页取是准的 */
const totalBytes = computed(() => {
  const set = new Set(ids.value)
  return assets.items.filter((it) => set.has(it.id)).reduce((sum, it) => sum + (it.size ?? 0), 0)
})
const pct = computed(() => (prog.value.total ? Math.round((prog.value.done / prog.value.total) * 100) : 0))

function pickFormat(f: 'jpeg' | 'webp'): void {
  armed.value = false
  void settings.patch({ compress: { format: f } })
}
function pickQuality(q: number): void {
  armed.value = false
  void settings.patch({ compress: { quality: q } })
}
function pickMaxEdge(px: number): void {
  armed.value = false
  void settings.patch({ compress: { maxEdge: px } })
}
function toggleAlsoJpeg(): void {
  armed.value = false
  void settings.patch({ compress: { alsoJpeg: !s.value.compress.alsoJpeg } })
}
function edgeLabel(px: number): string {
  return px === 0 ? '不限制' : String(px)
}

async function run(): Promise<void> {
  if (!armed.value) {
    armed.value = true
    return
  }
  if (!count.value || running.value) return
  armed.value = false
  running.value = true
  prog.value = { done: 0, total: count.value, name: '', status: '', reason: '', savedBytes: 0 }

  const r = await window.stash.compress.run(ids.value, {
    format: s.value.compress.format,
    quality: s.value.compress.quality,
    maxEdge: s.value.compress.maxEdge,
    alsoJpeg: s.value.compress.alsoJpeg
  })
  running.value = false

  if (!r.ok || !r.data) {
    assets.notify('error', `压缩失败：${r.error ?? '未知原因'}`)
    emit('close')
    return
  }
  announce(r.data)
  // 文件名 / 路径 / 体积都变了，列表与详情都得重拉
  await assets.refresh()
  await assets.reloadDetail()
  emit('close')
}

/** 把结果说清楚：省了多少、跳过了什么、为什么跳 —— 「跳过了 5 张」不说明原因等于没说 */
function announce(sm: StashCompressSummary): void {
  const saved = fmtSize(sm.savedBytes)
  if (sm.done === 0) {
    const why = sm.items.find((i) => i.reason)?.reason ?? '无可压缩的图片'
    assets.notify('info', `没有压缩任何图片：${why}`)
    return
  }
  const parts = [`已压缩 ${sm.done} 张，省下 ${saved}`]
  if (sm.skipped) parts.push(`跳过 ${sm.skipped} 张`)
  if (sm.failed) parts.push(`失败 ${sm.failed} 张`)
  assets.notify(sm.failed ? 'error' : 'info', parts.join('，'))
}

let offProg: (() => void) | null = null
onMounted(async () => {
  // 进度是主进程推的，run() 的那个 Promise 要跑完才 resolve —— 光等它就没有中间态了
  offProg = window.stash.compress.onProgress((d) => {
    prog.value = {
      done: d.done,
      total: d.total,
      name: d.name,
      status: d.status,
      reason: '',
      savedBytes: d.savedBytes
    }
  })
  const r = await window.stash.settings.choices()
  if (r.ok && r.data) choices.value = r.data
})
onBeforeUnmount(() => offProg?.())

// 正常不会有「运行中被打断」的路径（模态期间点不到遮罩），但真发生时也要把确认收掉
watch(running, (v) => {
  if (!v) armed.value = false
})
</script>

<template>
  <div class="modal-mask" @click.self="running || emit('close')">
    <div class="modal cp-modal" data-cp-modal>
      <div class="modal-title">压缩 {{ count }} 张图片</div>

      <div class="modal-body">
        <!-- 运行中：只显示进度，别再让用户改参数（改了也不影响这一批） -->
        <template v-if="running">
          <div class="cp-prog-name" data-cp-prog-name>{{ prog.name }}</div>
          <div class="cp-prog-bar"><i :style="{ width: pct + '%' }"></i></div>
          <div class="cp-prog-sub" data-cp-prog-sub>
            {{ prog.done }} / {{ prog.total }} · 已省 {{ fmtSize(prog.savedBytes) }}
          </div>
        </template>

        <template v-else>
          <div class="cp-src">
            选中 <b>{{ count }}</b> 张，合计 <b>{{ fmtSize(totalBytes) }}</b>
          </div>

          <div class="cp-row">
            <span class="cp-label">目标格式</span>
            <div class="sp-seg" data-cp-format>
              <button type="button" :class="{ on: s.compress.format === 'jpeg' }" @click="pickFormat('jpeg')">JPG</button>
              <button type="button" :class="{ on: s.compress.format === 'webp' }" @click="pickFormat('webp')">WebP</button>
            </div>
          </div>

          <div class="cp-row">
            <span class="cp-label">质量</span>
            <div class="sp-seg" data-cp-quality>
              <button
                v-for="q in choices?.compressQuality ?? [90]"
                :key="q"
                type="button"
                :class="{ on: s.compress.quality === q }"
                @click="pickQuality(q)"
              >
                {{ q }}
              </button>
            </div>
          </div>

          <div class="cp-row">
            <span class="cp-label">长边上限</span>
            <div class="sp-seg" data-cp-maxedge>
              <button
                v-for="px in choices?.compressMaxEdge ?? [0]"
                :key="px"
                type="button"
                :class="{ on: s.compress.maxEdge === px }"
                @click="pickMaxEdge(px)"
              >
                {{ edgeLabel(px) }}
              </button>
            </div>
          </div>

          <div class="cp-row">
            <span class="cp-label">
              也重新压缩 JPG
              <span class="cp-sub">二次有损编码会叠加上一代的画质损失</span>
            </span>
            <button
              class="sp-sw"
              :class="{ on: s.compress.alsoJpeg }"
              type="button"
              role="switch"
              data-cp-alsojpeg
              :aria-checked="s.compress.alsoJpeg"
              @click="toggleAlsoJpeg"
            >
              <i></i>
            </button>
          </div>

          <div class="cp-warn" data-cp-warn>
            原文件会被<strong>删除并替换</strong>，不可恢复（本项目没有回收站）。
            压缩后如果反而更大、或校验不过，该张会<strong>自动跳过</strong>、原文件不动。
            动态图与无法解码的图一律不碰。
          </div>
        </template>
      </div>

      <div class="modal-foot">
        <button class="w-btn" :disabled="running" @click="emit('close')">取消</button>
        <button
          class="w-btn danger"
          :class="{ 'danger-strong': armed }"
          type="button"
          data-cp-run
          :disabled="running || !count"
          @click="run"
        >
          {{ armed ? '再点一次确认' : '压缩并替换原文件' }}
        </button>
      </div>
    </div>
  </div>
</template>
