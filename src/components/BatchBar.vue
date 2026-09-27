<script setup lang="ts">
// 底部悬浮批量操作条：选中 ≥1 项时出现
// 只做「批量该做的事」——打标按需求不提供，标签仍在右侧详情里单个编辑
import { ref } from 'vue'
import { useAssetStore } from '../stores/assets'

const assets = useAssetStore()
const emit = defineEmits<{ (e: 'move'): void; (e: 'remove'): void }>()

// 悬停时预览评分（不影响已选中的公共评分）
const hoverStar = ref(0)

/**
 * 星标是否点亮：悬停预览优先，未悬停时用选中项的公共评分（0 = 全部未评分）。
 * 关态必须同时给出 stroke，否则 `fill: none` + 无描边 = 整颗星不可见，
 * 表现就是「只有鼠标移上去才看得见」。
 */
const starOn = (n: number): boolean => n <= (hoverStar.value || assets.selectedRating)
</script>

<template>
  <Transition name="raise">
    <div v-if="assets.selectedCount > 0" class="batchbar">
      <span class="bb-count">已选 <b>{{ assets.selectedCount }}</b> 项</span>
      <span class="bb-div"></span>

      <div class="bb-rate">
        <span class="bb-mini">评分</span>
        <svg
          v-for="n in 5"
          :key="n"
          class="bb-star"
          :class="{ on: starOn(n) }"
          viewBox="0 0 12 12"
          :fill="starOn(n) ? 'currentColor' : 'none'"
          :stroke="starOn(n) ? 'none' : 'currentColor'"
          stroke-width="1"
          stroke-linejoin="round"
          :title="`设为 ${n} 星`"
          @mouseenter="hoverStar = n"
          @mouseleave="hoverStar = 0"
          @click="assets.bulkRate(assets.selectedRating === n ? 0 : n)"
        >
          <path d="M6 1.2l1.45 2.95 3.25.5-2.35 2.3.55 3.25L6 8.7 3.1 10.2l.55-3.25L1.3 4.65l3.25-.5L6 1.2z" />
        </svg>
        <span v-if="assets.selectedRatingMixed" class="bb-mixed" title="选中项评分不一致">混合</span>
      </div>

      <button class="bb-btn" :class="{ on: assets.selectedAllFav }" @click="assets.bulkFav(!assets.selectedAllFav)">
        <svg viewBox="0 0 13 13" :fill="assets.selectedAllFav ? 'currentColor' : 'none'">
          <path d="M6.5 10.8S1.8 8.2 1.8 4.9c0-1.5 1.2-2.7 2.6-2.7 1 0 1.7.6 2.1 1.2.4-.6 1.1-1.2 2.1-1.2 1.4 0 2.6 1.2 2.6 2.7 0 3.3-4.7 5.9-4.7 5.9z" stroke="currentColor" stroke-width="1.1" />
        </svg>
        {{ assets.selectedAllFav ? '取消喜欢' : '喜欢' }}
      </button>

      <button class="bb-btn" @click="emit('move')">
        <svg viewBox="0 0 13 13" fill="none">
          <path d="M1.6 4.2h9.8v6.2H1.6z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
          <path d="M1.6 4.2V2.6h3.1l1.1 1.6" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
        </svg>
        移动
      </button>

      <button class="bb-btn danger" @click="emit('remove')">
        <svg viewBox="0 0 13 13" fill="none">
          <path d="M2.4 3.6h8.2M5.1 3.6V2.4h2.8v1.2M3.4 3.6l.5 7h5.2l.5-7" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        删除
      </button>

      <span class="bb-div"></span>
      <button class="bb-btn ghost" @click="assets.clearSelection()">取消选择</button>
    </div>
  </Transition>
</template>
