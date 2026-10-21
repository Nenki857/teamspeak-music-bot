<script setup>
import {ref,onMounted,onUnmounted} from 'vue';
import {uiScaleOptions,uiScaleKey,readUiScale,applyUiScale,saveUiScale} from '../shared/ui-scale.mjs';
const value=ref(readUiScale());
function change(event){value.value=saveUiScale(event.target.value);}
function sync(event){if(event.key===uiScaleKey){value.value=readUiScale();applyUiScale(value.value);}}
onMounted(()=>window.addEventListener('storage',sync));onUnmounted(()=>window.removeEventListener('storage',sync));
</script>
<template><label class="ui-scale-control"><span>界面缩放</span><select :value="value" @change="change" aria-label="界面缩放" title="仅调整当前浏览器显示大小，自动记住选择"><option v-for="option in uiScaleOptions" :key="option" :value="option">{{option}}%</option></select></label></template>
