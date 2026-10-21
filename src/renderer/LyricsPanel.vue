<script setup>
import {computed,nextTick,onMounted,onUnmounted,ref,watch} from 'vue';
import {normalizeLyrics,activeLyricIndex} from '../shared/lyrics.mjs';
const props=defineProps({song:Object,elapsed:{type:Number,default:0},duration:{type:Number,default:0},playing:Boolean,loadLyrics:{type:Function,required:true}});
const expanded=ref(!window.matchMedia?.('(max-width: 650px)')?.matches),lines=ref([]),loading=ref(false),failure=ref(''),loaded=ref(false),follow=ref(true),scroller=ref(null);
let generation=0,disposed=false,timer;const clock=ref(Date.now()),anchor=ref(Date.now());
const songId=computed(()=>props.song && (!props.song.platform || props.song.platform==='netease') && /^\d{1,20}$/.test(String(props.song.id))?String(props.song.id):'');
const position=computed(()=>Math.min(props.duration>0?props.duration:Infinity,Math.max(0,props.elapsed||0)+(props.playing?Math.max(0,Math.min(1.5,(clock.value-anchor.value)/1000)):0)));
const active=computed(()=>activeLyricIndex(lines.value,position.value));
function anchorTime(){anchor.value=Date.now();clock.value=anchor.value;}
function updateTimer(){clearInterval(timer);if(expanded.value&&props.playing&&lines.value.length&&document.visibilityState!=='hidden')timer=setInterval(()=>{clock.value=Date.now();},250);}
async function fetchLyrics() {
  const id=songId.value;if(!id||!expanded.value||loading.value||loaded.value||failure.value||document.visibilityState==='hidden')return;
  const requestGeneration=generation;loading.value=true;
  try{const result=await props.loadLyrics(id);if(disposed||requestGeneration!==generation)return;if(String(result?.songId)!==id)throw new Error('歌词与当前歌曲不匹配');lines.value=normalizeLyrics(result.lines);loaded.value=true;}
  catch(error){if(!disposed&&requestGeneration===generation)failure.value=error?.message||'歌词暂时无法加载';}
  finally{if(!disposed&&requestGeneration===generation){loading.value=false;updateTimer();scrollCurrent();}}
}
async function scrollCurrent(){
  if(!follow.value||!expanded.value)return;await nextTick();if(disposed||!follow.value)return;
  const box=scroller.value,row=box?.querySelector('[aria-current="true"]');if(!box||!row||box.clientHeight<=0)return;
  const top=Math.max(0,box.scrollTop+row.getBoundingClientRect().top-box.getBoundingClientRect().top-(box.clientHeight-row.getBoundingClientRect().height)/2);
  box.scrollTo?.({top,behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches?'auto':'smooth'});
}
function resumeFollow(){follow.value=true;scrollCurrent();}
function retry(){if(loading.value)return;failure.value='';loaded.value=false;fetchLyrics();}
function onVisibility(){anchorTime();updateTimer();if(document.visibilityState!=='hidden')fetchLyrics();}
watch(songId,()=>{generation++;lines.value=[];loading.value=false;failure.value='';loaded.value=false;follow.value=true;anchorTime();updateTimer();fetchLyrics();},{immediate:true});
watch(()=>[props.elapsed,props.playing],()=>{anchorTime();updateTimer();});
watch(expanded,()=>{updateTimer();fetchLyrics();scrollCurrent();});
watch(active,scrollCurrent);
onMounted(()=>document.addEventListener('visibilitychange',onVisibility));
onUnmounted(()=>{disposed=true;generation++;clearInterval(timer);document.removeEventListener('visibilitychange',onVisibility);});
</script>

<template>
  <section class="lyrics-panel" aria-label="当前歌曲歌词">
    <div class="lyrics-heading"><h4>歌词</h4><div><button v-if="expanded && lines.length && !follow" type="button" class="lyrics-follow" @click="resumeFollow">跟随歌词</button><button type="button" class="lyrics-toggle" :aria-expanded="expanded" @click="expanded=!expanded">{{ expanded?'收起':'展开' }}</button></div></div>
    <template v-if="expanded">
      <div v-if="loading" class="lyrics-message" role="status">正在加载歌词…</div>
      <div v-else-if="failure" class="lyrics-message lyrics-failure" role="status"><span>{{ failure }}</span><button type="button" @click="retry">重试</button></div>
      <div v-else-if="!songId" class="lyrics-message">{{ song?'这首歌暂不支持歌词':'播放歌曲后显示歌词' }}</div>
      <div v-else-if="loaded && !lines.length" class="lyrics-message">暂无歌词，可能是纯音乐</div>
      <div v-else ref="scroller" class="lyrics-lines" tabindex="0" aria-label="滚动歌词" @wheel.passive="follow=false" @pointerdown="follow=false" @touchstart.passive="follow=false" @keydown="['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes($event.key) && (follow=false)">
        <div v-for="(line,index) in lines" :key="index" class="lyrics-line" :class="{active:index===active}" :aria-current="index===active?'true':undefined"><span>{{ line.text }}</span><small v-if="line.translation">{{ line.translation }}</small></div>
      </div>
    </template>
  </section>
</template>
