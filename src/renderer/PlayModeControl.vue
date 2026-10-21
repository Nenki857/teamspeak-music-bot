<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
const props = defineProps({ mode: { type: String, default: 'loop' }, disabled: Boolean });
const emit = defineEmits(['select']);
const modes = [
  { value: 'loop', label: '列表循环', paths: ['m17 2 4 4-4 4', 'M3 11V9a3 3 0 0 1 3-3h15', 'm7 22-4-4 4-4', 'M21 13v2a3 3 0 0 1-3 3H3'] },
  { value: 'single', label: '单曲循环', paths: ['m17 2 4 4-4 4', 'M3 11V9a3 3 0 0 1 3-3h15', 'm7 22-4-4 4-4', 'M21 13v2a3 3 0 0 1-3 3H3', 'm10 10 2-1v6m-2 0h4'] },
  { value: 'random', label: '随机播放', paths: ['m18 2 4 4-4 4', 'm18 14 4 4-4 4', 'M2 18h2a6 6 0 0 0 5-3l6-6a6 6 0 0 1 5-3h2', 'M2 6h2a6 6 0 0 1 5 3l6 6a6 6 0 0 0 5 3h2'] }
];
const current = computed(() => modes.find(item => item.value === (props.mode === 'rloop' ? 'random' : props.mode)) || modes[0]);
const open = ref(false); const root = ref(null); const trigger = ref(null); const menu = ref(null);
function closeMenu(restoreFocus = false) { open.value = false; if (restoreFocus) nextTick(() => trigger.value?.focus()); }
function focusOption(index) { menu.value?.querySelectorAll('[role="menuitemradio"]')[index]?.focus(); }
async function openMenu(last = false) {
  if (props.disabled) return;
  open.value = true; await nextTick(); focusOption(last ? modes.length - 1 : modes.indexOf(current.value));
}
function choose(item) {
  if (props.disabled) return;
  closeMenu(true); if (item.value !== current.value.value) emit('select', item.value);
}
function onMenuKey(event) {
  const index = [...menu.value.querySelectorAll('[role="menuitemradio"]')].indexOf(document.activeElement);
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
  else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    focusOption(event.key === 'Home' ? 0 : event.key === 'End' ? modes.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + modes.length) % modes.length);
  }
}
function onOutsidePointer(event) { if (open.value && !root.value?.contains(event.target)) closeMenu(); }
function onFocusOut(event) { if (!root.value?.contains(event.relatedTarget)) closeMenu(); }
watch(() => props.disabled, disabled => { if (disabled) closeMenu(); });
onMounted(() => document.addEventListener('pointerdown', onOutsidePointer, true));
onUnmounted(() => document.removeEventListener('pointerdown', onOutsidePointer, true));
</script>

<template>
  <div ref="root" class="play-mode-control" @focusout="onFocusOut">
    <button ref="trigger" class="mode-trigger" :class="{ expanded: open }" type="button" :title="current.label" :aria-label="'播放模式：' + current.label" aria-haspopup="menu" :aria-expanded="open" :disabled="disabled" @click="open ? closeMenu() : openMenu()" @keydown.down.prevent="openMenu()" @keydown.up.prevent="openMenu(true)">
      <svg class="mode-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path v-for="(path, i) in current.paths" :key="i" :d="path"/></svg>
    </button>
    <div v-if="open" ref="menu" class="mode-menu" role="menu" aria-label="选择播放模式" @keydown="onMenuKey">
      <div class="mode-menu-heading" role="presentation">播放模式</div>
      <button v-for="item in modes" :key="item.value" class="mode-option" :class="{ selected: item.value === current.value }" type="button" role="menuitemradio" :aria-checked="item.value === current.value" tabindex="-1" @click="choose(item)">
        <svg class="mode-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path v-for="(path, i) in item.paths" :key="i" :d="path"/></svg>
        <span>{{ item.label }}</span>
        <svg v-if="item.value === current.value" class="mode-check" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m5 12 4 4 10-10"/></svg>
      </button>
    </div>
  </div>
</template>
