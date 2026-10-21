<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { playlistDateName } from '../shared/playlist-format.mjs';
const props = defineProps({ song: { type: Object, required: true }, currentDraft: { type: Object, default: () => ({ ids: [] }) }, request: Function, runId: String, disabled: Boolean, supportsTargets: Boolean, supportsDescriptions: Boolean });
const emit = defineEmits(['draft', 'saved', 'close']);
const targets = ref([]); const loading = ref(false); const busy = ref(false); const error = ref(''); const filter = ref(''); const creating = ref(false); const newName = ref(playlistDateName()); const newDescription = ref(''); const nameInput = ref(null); const filterInput = ref(null); const root = ref(null);
let active = true; let previousFocus;
const locked = computed(() => props.disabled || busy.value);
const inDraft = computed(() => (props.currentDraft.ids || []).includes(props.song.id));
const draftFull = computed(() => (props.currentDraft.ids || []).length >= 500);
const available = computed(() => targets.value.filter(item => item.id !== props.currentDraft.editId));
const shown = computed(() => available.value.filter(item => item.name.toLocaleLowerCase().includes(filter.value.trim().toLocaleLowerCase())));
async function loadTargets() {
  if (!props.supportsTargets || props.disabled) return;
  loading.value = true; error.value = '';
  try { const data = await props.request('playlists.targets', { songId: props.song.id }); if (active) targets.value = data; }
  catch (e) { if (active) error.value = e.message; }
  finally { if (active) loading.value = false; }
}
async function save(fn) {
  if (locked.value) return;
  busy.value = true; error.value = '';
  try { const saved = await fn(); if (active) emit('saved', saved); }
  catch (e) { if (active) error.value = e.message; }
  finally { if (active) busy.value = false; }
}
function chooseDraft() { if (!locked.value && !props.currentDraft.busy && !inDraft.value && !draftFull.value) emit('draft', props.song); }
function chooseTarget(item) {
  if (item.containsSong || item.songCount >= 500) return;
  return save(() => props.request('playlist.addSong', { id: item.id, songId: props.song.id, expectedUpdatedAt: item.updatedAt, runId: props.runId }));
}
function createPlaylist() {
  if (!newName.value.trim()) return;
  return save(async () => ({ added: true, playlist: await props.request('playlist.create', { name: newName.value.trim(), ...(props.supportsDescriptions ? { description: newDescription.value } : {}), ids: [props.song.id], runId: props.runId }) }));
}
function onKey(event) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); emit('close'); }
  if (event.key !== 'Tab') return;
  const dialog = root.value?.closest('.modal') || root.value;
  const elements = [...dialog.querySelectorAll('button,input,select,textarea,[href],[tabindex="0"]')].filter(item => !item.disabled && item.getClientRects().length);
  if (!elements.length) { event.preventDefault(); return; }
  const first = elements[0], last = elements.at(-1);
  if (event.shiftKey && (document.activeElement === first || !elements.includes(document.activeElement))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || !elements.includes(document.activeElement))) { event.preventDefault(); first.focus(); }
}
onMounted(() => { previousFocus = document.activeElement; loadTargets(); document.addEventListener('keydown', onKey); root.value?.focus({ preventScroll: true }); });
onUnmounted(() => { active = false; document.removeEventListener('keydown', onKey); nextTick(() => { if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); }); });
</script>

<template>
  <section ref="root" class="playlist-picker" role="dialog" aria-modal="true" aria-labelledby="playlist-picker-title" tabindex="-1">
    <span class="eyebrow">ADD TO PLAYLIST</span><h2 id="playlist-picker-title">加入歌单</h2>
    <div class="playlist-picker-song"><span class="playlist-picker-note" aria-hidden="true">♫</span><div><strong>{{ song.name }}</strong><small>{{ song.artist || '未知歌手' }}</small></div></div>
    <button class="playlist-target-row current-draft-target" type="button" @click="chooseDraft" :disabled="locked || currentDraft.busy || inDraft || draftFull" :aria-label="'加入当前歌单草稿 ' + (currentDraft.name || '自建歌单')">
      <span class="playlist-target-icon" aria-hidden="true">☷</span><span><strong>{{ currentDraft.name || '当前自建歌单' }}</strong><small>{{ currentDraft.ids?.length || 0 }} 首 · {{ currentDraft.editId ? '正在编辑' : '当前草稿' }}，保存后生效</small></span><span v-if="inDraft" class="playlist-target-check">✓ 已加入</span><span v-else class="playlist-target-status">{{ currentDraft.busy ? '准备中' : draftFull ? '已满' : '加入' }}</span>
    </button>
    <div class="playlist-target-heading"><h3>已保存歌单</h3><span>仅显示可编辑的本地歌单</span></div>
    <input v-if="available.length > 6" ref="filterInput" v-model="filter" type="search" placeholder="查找目标歌单" aria-label="查找目标歌单" maxlength="80" class="playlist-target-filter">
    <p v-if="loading" class="playlist-target-hint" role="status">正在读取歌单…</p>
    <p v-else-if="!supportsTargets" class="playlist-target-hint">请保存队列后退出并重开工具，以选择已保存歌单。</p>
    <div v-else class="playlist-target-list">
      <button v-for="item in shown" :key="item.id" type="button" class="playlist-target-row saved-playlist-target" :aria-label="'加入已保存歌单 ' + item.name" @click="chooseTarget(item)" :disabled="locked || item.containsSong || item.songCount >= 500">
        <span class="playlist-target-icon" aria-hidden="true">♫</span><span><strong>{{ item.name }}</strong><small>{{ item.songCount }} 首 · {{ item.published ? '已开放' : '未开放' }}</small></span><span v-if="item.containsSong" class="playlist-target-check">✓ 已加入</span><span v-else class="playlist-target-status">{{ item.songCount >= 500 ? '已满' : '加入' }}</span>
      </button>
      <p v-if="!shown.length && !error" class="playlist-target-hint">{{ available.length ? '没有匹配的歌单。' : '还没有其他可编辑歌单，可先加入当前草稿。' }}</p>
    </div>
    <div v-if="error" class="error playlist-picker-error" role="alert"><span>{{ error }}</span><button v-if="!targets.length && supportsTargets" class="text-button" type="button" @click="loadTargets" :disabled="loading || locked">重试读取</button></div>
    <button v-if="!creating" type="button" class="playlist-picker-new" @click="creating = true; nextTick(() => nameInput?.focus())" :disabled="locked"><span aria-hidden="true">＋</span>新建歌单并加入</button>
    <form v-else class="playlist-picker-create" @submit.prevent="createPlaylist"><label class="field-label">新歌单名称<input ref="nameInput" v-model="newName" maxlength="80" aria-label="新歌单名称" :disabled="locked"></label><label v-if="supportsDescriptions" class="field-label playlist-description-field"><span>歌单简介 <small>选填 · {{ newDescription.length }} / 500</small></span><textarea v-model="newDescription" rows="2" maxlength="500" aria-label="新歌单简介" placeholder="为这个歌单写一段简介" :disabled="locked"></textarea></label><div class="inline-actions"><button class="primary" :disabled="locked || !newName.trim()">新建并加入</button><button type="button" class="text-button" @click="creating = false" :disabled="locked">取消</button></div></form>
    <p v-if="busy" class="playlist-target-hint" role="status">正在加入歌曲…</p>
  </section>
</template>
