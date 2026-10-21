<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import {locateCurrentQueueRow} from '../shared/queue-focus.mjs';
const uiScale=()=>Number(document.documentElement.dataset.uiScale || 100)/100;
function layoutBox(element){const rect=element.getBoundingClientRect(),scale=uiScale();return {top:rect.top/scale,bottom:rect.bottom/scale,width:rect.width/scale,height:rect.height/scale};}
const props = defineProps({ desktop: Boolean, expanded: Boolean, currentEntryId: String, currentIndex: {type:Number,default:-1} });
const storageKey = 'tsmd.queue-width.v1';
function readWidth() { try { const value = Number(window.localStorage.getItem(storageKey)); return Number.isFinite(value) && value >= 160 && value <= 640 ? value : null; } catch { return null; } }
const preferred = ref(readWidth()); const panel = ref(null); const handle = ref(null);
const enabled = ref(false); const resizing = ref(false); const minimum = ref(240); const maximum = ref(640); const measuredWidth = ref(280);
const headingHeight=ref(76),coverLimit=ref(480),bodyHeight=ref(480);let workspace;let observer;let drag;let needsAutoLocate=false,locateScheduled=false,disposed=false;
function locateCurrent({smooth=true}={}){if(!props.expanded)return false;const located=locateCurrentQueueRow(panel.value,{currentEntryId:props.currentEntryId,smooth});if(located)needsAutoLocate=false;return located;}
function autoLocate(){if(!props.expanded||!needsAutoLocate||locateScheduled)return;locateScheduled=true;nextTick(()=>{locateScheduled=false;if(!disposed&&props.expanded&&needsAutoLocate&&props.currentEntryId&&props.currentIndex>=0)locateCurrent({smooth:false});});}
defineExpose({locateCurrent});
const width = computed(() => Math.round(Math.max(minimum.value, Math.min(maximum.value, preferred.value ?? measuredWidth.value))));
const panelStyle = computed(() => ({'--queue-heading-height':headingHeight.value+'px','--queue-cover-limit':coverLimit.value+'px','--queue-body-height':bodyHeight.value+'px',...(enabled.value && preferred.value !== null ? {width:width.value+'px'}:{})}));
function measure() {
  if (!workspace) return;
  const measuredHeading=(panel.value.querySelector('.queue-heading')?.getBoundingClientRect().height || 0)/uiScale();if(measuredHeading>0)headingHeight.value=Math.round(measuredHeading);
  if(props.expanded){
    const footer=(document.querySelector('.player-bar')?.getBoundingClientRect().height||0)/uiScale();
    const body=panel.value.querySelector('.queue-body'),card=panel.value.querySelector('.now-card'),cover=panel.value.querySelector('.cover-art');
    const bottom=props.desktop?layoutBox(workspace).bottom:window.innerHeight/uiScale()-footer;
    const padding=props.desktop?(parseFloat(window.getComputedStyle(workspace).paddingBottom)||0):20;
    if(body&&Number.isFinite(bottom)&&bottom>0)bodyHeight.value=Math.max(180,Math.floor(bottom-layoutBox(body).top-padding));
    if(card&&cover){const text=Math.max(0,layoutBox(card).height-layoutBox(cover).height);coverLimit.value=Math.max(96,Math.min(480,Math.floor(bodyHeight.value-text-12)));}
  }
  enabled.value = !props.expanded && workspace.clientWidth > 0 && (props.desktop || window.innerWidth/uiScale() > 600);
  if (!enabled.value) { finish(); return; }
  const style = window.getComputedStyle(workspace);
  const available = workspace.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0) - (parseFloat(style.columnGap) || 0);
  maximum.value = Math.max(160, Math.min(640, Math.floor(available - (props.desktop ? 420 : 300))));
  minimum.value = Math.min(props.desktop ? 240 : 200, maximum.value);
  measuredWidth.value = layoutBox(panel.value).width;
}
function setWidth(value) { preferred.value = Math.round(Math.max(minimum.value, Math.min(maximum.value, value))); }
function persist() { try { if (preferred.value === null) window.localStorage.removeItem(storageKey); else window.localStorage.setItem(storageKey, String(preferred.value)); } catch {} }
function begin(event) {
  if (!enabled.value || drag || event.button !== 0 || event.isPrimary === false) return;
  event.preventDefault(); measure();
  drag = { pointer: event.pointerId, x: event.clientX, width: layoutBox(panel.value).width };
  resizing.value = true; handle.value.focus({ preventScroll: true });
  document.documentElement.classList.add('queue-resizing');
  try { handle.value.setPointerCapture(event.pointerId); } catch {}
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish); window.addEventListener('blur', finish);
}
function move(event) { if (!drag || event.pointerId !== drag.pointer) return; event.preventDefault(); setWidth(drag.width + (drag.x - event.clientX)/uiScale()); }
function finish(event) {
  if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.pointer)) return;
  const pointer = drag.pointer; drag = null;
  try { handle.value?.releasePointerCapture(pointer); } catch {}
  resizing.value = false; document.documentElement.classList.remove('queue-resizing'); persist();
  window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish); window.removeEventListener('blur', finish);
}
function reset() { finish(); preferred.value = null; persist(); nextTick(measure); }
function onKey(event) {
  if (!enabled.value || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault(); measure();
  const current = layoutBox(panel.value).width;
  setWidth(event.key === 'Home' ? minimum.value : event.key === 'End' ? maximum.value : current + (event.key === 'ArrowLeft' ? 1 : -1) * (event.shiftKey ? 50 : 20)); persist();
}
onMounted(() => {
  workspace = panel.value.closest('.workspace'); measure();needsAutoLocate=props.expanded;autoLocate();
  if (workspace && window.ResizeObserver) { observer = new window.ResizeObserver(measure); observer.observe(workspace);const heading=panel.value.querySelector('.queue-heading');if(heading)observer.observe(heading);const card=panel.value.querySelector('.now-card');if(card)observer.observe(card); }
  window.addEventListener('resize', measure);
});
onUnmounted(() => { disposed=true;finish(); observer?.disconnect(); workspace = null; window.removeEventListener('resize', measure); });
watch(() => props.expanded, expanded => { finish();needsAutoLocate=expanded;nextTick(measure);autoLocate(); });
watch(()=>[props.currentEntryId,props.currentIndex],autoLocate);
</script>

<template>
  <aside ref="panel" class="queue-panel" :class="{ resizing, 'queue-expanded': expanded }" :style="panelStyle">
    <button v-if="enabled" ref="handle" class="queue-resize-handle" type="button" role="separator" aria-label="调整播放队列宽度" aria-orientation="vertical" :aria-valuemin="minimum" :aria-valuemax="maximum" :aria-valuenow="width" :aria-valuetext="'播放队列宽度 ' + width + ' 像素'" title="向左拖动扩大队列，双击恢复默认宽度" @pointerdown="begin" @lostpointercapture="finish" @keydown="onKey" @dblclick="reset"><span aria-hidden="true"></span></button>
    <slot/>
  </aside>
</template>
