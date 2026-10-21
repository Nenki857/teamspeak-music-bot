<script setup>
import { computed, nextTick, ref, watch } from 'vue';
const props = defineProps({ volume: { type: Number, default: 50 }, disabled: Boolean, setVolume: { type: Function, required: true } });
const editing = ref(false), draft = ref(''), input = ref(null), trigger = ref(null), pending = ref(null), failure = ref('');
const confirmed = computed(() => Math.max(0, Math.min(100, Math.round(Number.isFinite(props.volume) ? props.volume : 50))));
const shown = computed(() => pending.value ?? confirmed.value);
const locked = computed(() => props.disabled || pending.value !== null);
async function begin() {
  if (locked.value) return;
  draft.value = String(shown.value); failure.value = ''; editing.value = true;
  await nextTick(); input.value?.focus(); input.value?.select();
}
function cancel(restoreFocus = false) {
  editing.value = false; failure.value = '';
  if (restoreFocus) nextTick(() => trigger.value?.focus());
}
async function submit(value) {
  if (locked.value || value === confirmed.value) return;
  pending.value = value; failure.value = '';
  try { await props.setVolume(value); }
  catch { failure.value = '音量调整失败，请重试'; }
  finally { pending.value = null; }
}
async function commit(restoreFocus = false) {
  if (!editing.value) return;
  const text = draft.value.trim(); editing.value = false;
  const value = text && /^[+-]?\d+(?:\.\d+)?$/.test(text) ? Number(text) : NaN;
  if (Number.isFinite(value)) await submit(Math.max(0, Math.min(100, Math.round(value))));
  if (restoreFocus) nextTick(() => trigger.value?.focus());
}
watch(() => props.disabled, disabled => { if (disabled && editing.value) cancel(); });
</script>

<template>
  <div class="volume" :aria-busy="pending !== null">
    <svg class="volume-icon" viewBox="0 0 24 24" role="img" :aria-label="shown === 0 ? '静音' : '音量'"><path fill="currentColor" d="M11 4 6 8H3v8h3l5 4z"/><g v-if="shown > 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M15 8a6 6 0 0 1 0 8"/><path v-if="shown >= 50" d="M18 5a10 10 0 0 1 0 14"/></g><path v-else d="m16 9 5 6m0-6-5 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
    <input class="volume-slider" type="range" min="0" max="100" :value="shown" @change="submit(Number($event.target.value))" :disabled="locked" aria-label="音量">
    <label v-if="editing" class="volume-edit"><input ref="input" v-model="draft" type="text" inputmode="numeric" maxlength="6" autocomplete="off" aria-label="输入音量百分比" title="输入 0–100，回车确认，Esc 取消" @keydown.enter.prevent="commit(true)" @keydown.esc.prevent.stop="cancel(true)" @blur="commit()"><span aria-hidden="true">%</span></label>
    <button v-else ref="trigger" class="volume-value" type="button" :disabled="locked" :title="failure || '点击输入音量（0–100）'" :aria-label="'音量 ' + shown + '%，点击输入'" @click="begin">{{ shown }}%</button>
    <span v-if="failure" class="volume-error" role="alert">{{ failure }}</span>
  </div>
</template>
