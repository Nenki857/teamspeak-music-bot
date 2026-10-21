<script setup>
import { ref, watch, computed, onUnmounted } from 'vue';
import { touchSort } from '../shared/touch-sort.mjs';
import { playlistDateName, songMetadata } from '../shared/playlist-format.mjs';
import MusicSearchResults from './MusicSearchResults.vue';
const props = defineProps({ request: Function, canSearch: Boolean, canSave: Boolean, canEdit: Boolean, owner: Boolean, runId: String, busy: Boolean, initialMode: String, active: { type: Boolean, default: true }, running: Boolean, permissions: { type: Array, default: () => [] }, capabilities: { type: Object, default: () => ({}) }, publications: { type: Array, default: () => [] } });
const emit = defineEmits(['preview', 'created', 'published', 'notice', 'control', 'choosePlaylist', 'draftChange', 'modeChange']);
const mode = ref(props.initialMode || 'find'); const lookupMode = ref('nickname'); const query = ref(''); const users = ref([]); const userPage = ref(null); const selectedUid = ref(''); const offset = ref(0); const moreUsers = ref(false);
watch(() => props.initialMode, value => { if (['find','draft'].includes(value)) mode.value = value; });
const busy = ref(false); const error = ref(''); const draft = ref({ name: playlistDateName(), description: '', songs: [] }); const persisted = ref(true);
const failedCovers = ref(new Set());
const clearedSongs = ref(null);
const editTarget = ref(null); const dragging = ref(''); const dropTarget = ref('');
const dragIndex = computed(() => draft.value.songs.findIndex(song => song.id === dragging.value));
const draftQuery = ref(''); const draftResults = ref({ songs: [], playlists: [] }); const draftSearched = ref(''); const draftOffset = ref(0);
const draftType = ref('songs'); const draftSort = ref('default'); const draftArtist = ref(null); const draftPlaylist = ref(null); const draftSongLimit = ref(50); const draftPlaylistLimit = ref(40); const draftList = ref(null); let artistReturn;
const can = permission => props.owner || props.permissions.includes(permission);
const canPlayDraftPlaylist = computed(() => !!draftPlaylist.value && props.running && !locked.value && can('playlist') && (props.owner || !draftPlaylist.value.publicPreview || draftPlaylist.value.published));
const editable = () => props.canEdit && (props.owner || props.capabilities.collaborativePlaylists);
const canUpdateTarget = computed(() => !editTarget.value || editable(editTarget.value.id));
function uniqueSongs(values) { const seen = new Set(); const songs = []; for (const value of values) { const song = songMetadata(value); if (seen.has(song.id)) continue; seen.add(song.id); songs.push(song); if (songs.length === 500) break; } return songs; }
function formatTime(value) { const seconds = Math.max(0, Math.floor(value || 0)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
try { const saved = JSON.parse(localStorage.getItem('tsmd_playlist_draft_v1')); if (saved && Array.isArray(saved.songs)) { draft.value = { name: String(saved.name || playlistDateName()).slice(0, 80), description: typeof saved.description === 'string' ? saved.description.slice(0, 500) : '', songs: uniqueSongs(saved.songs) }; if (typeof saved.editTarget?.id === 'string' && Number.isSafeInteger(saved.editTarget.updatedAt)) editTarget.value = saved.editTarget; } } catch {}
watch([draft, editTarget], ([value, target]) => { try { localStorage.setItem('tsmd_playlist_draft_v1', JSON.stringify({ ...value, editTarget: target })); } catch { persisted.value = false; } }, { deep: true, immediate: true });
watch([draft, editTarget, busy], ([value, target, working]) => emit('draftChange', { name: value.name, ids: value.songs.map(song=>song.id), editId: target?.id || '', busy: working }), { deep: true, immediate: true });
const locked = computed(() => busy.value || props.busy);
watch(() => draft.value, () => { clearedSongs.value = null; }, { flush:'sync' });
watch(() => draft.value.songs.length, length => { if (length) clearedSongs.value = null; }, { flush:'sync' });
async function run(fn) { if (locked.value) return; busy.value = true; error.value = ''; try { return await fn(); } catch (e) { error.value = e.message; } finally { busy.value = false; } }
function open(value) { mode.value = value; error.value = ''; emit('modeChange', value); }
function addSong(value) {
  if (!props.canSave || locked.value) return;
  const song = songMetadata(value);
  if (draft.value.songs.some(item => item.id === song.id)) { emit('notice', '《' + song.name + '》已在自建歌单中，无需重复添加'); return; }
  if (draft.value.songs.length >= 500) { emit('notice', '自建歌单最多 500 首'); return; }
  draft.value.songs.push(song); emit('notice', '已加入自建歌单（' + draft.value.songs.length + ' 首）');
}
function usePlaylist(playlist) {
  if (!props.canSave || locked.value) return;
  const songs = uniqueSongs(playlist.songs); editTarget.value = null; draft.value = { name: playlist.name || playlistDateName(), description: typeof playlist.description === 'string' ? playlist.description.slice(0, 500) : '', songs }; open('draft');
  const duplicates = playlist.songs.length - new Set(playlist.songs.map(song => String(song.id))).size;
  if (duplicates) emit('notice', '已复制 ' + songs.length + ' 首歌曲，跳过 ' + duplicates + ' 首重复歌曲');
}
function editPlaylist(playlist) { if (!editable(playlist.id) || locked.value || playlist.source !== 'local' || !Number.isSafeInteger(playlist.updatedAt)) return; usePlaylist(playlist); editTarget.value = { id: playlist.id, updatedAt: playlist.updatedAt, published: playlist.published }; }
function saveAsNew() { editTarget.value = null; error.value = ''; }
function shift(index, direction) { if (locked.value || !props.canSave) return; const to = index + direction; if (to < 0 || to >= draft.value.songs.length) return; const [song] = draft.value.songs.splice(index, 1); draft.value.songs.splice(to, 0, song); }
const draftTouch = touchSort({ selector: '.draft-song-row', begin: (event,id) => { const item=draft.value.songs.find(song=>song.id===id); if (!item || locked.value || !props.canSave) return false; startDrag(event,item); return true; }, over: (event,id) => { const item=draft.value.songs.find(song=>song.id===id); if (item) overDrag(event,item); }, drop: (event,id) => { const item=draft.value.songs.find(song=>song.id===id); if (item) dropSong(event,item); }, end: clearDrag });
onUnmounted(() => draftTouch.cancel());
function clearDrag() { dragging.value = ''; dropTarget.value = ''; }
function clearSelectedSongs() {
  if (locked.value || !props.canSave || !draft.value.songs.length) return;
  const previous = [...draft.value.songs]; draftTouch.cancel(); clearDrag(); draft.value.songs = []; clearedSongs.value = previous;
  emit('notice', '已清空已选歌曲，可点击“撤销清空”恢复');
}
function undoClearSongs() {
  if (locked.value || !props.canSave || draft.value.songs.length || !clearedSongs.value) return;
  const previous = clearedSongs.value; clearedSongs.value = null; draft.value.songs = previous;
}

function startDrag(event, item) { if (locked.value || !props.canSave) { event.preventDefault(); return; } dragging.value = item.id; if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id); } }
function overDrag(event, item) { if (!dragging.value || dragging.value === item.id || locked.value || !props.canSave) return; event.preventDefault(); dropTarget.value = item.id; if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; }
function leaveDrag(event, item) { if (!event.currentTarget.contains(event.relatedTarget) && dropTarget.value === item.id) dropTarget.value = ''; }
function dropSong(event, item) { const from = dragIndex.value; const to = draft.value.songs.findIndex(song => song.id === item.id); clearDrag(); if (locked.value || !props.canSave || from < 0 || to < 0 || from === to) return; event.preventDefault(); const [song] = draft.value.songs.splice(from, 1); draft.value.songs.splice(to, 0, song); }
async function findUsers(more = false) {
  const next = more ? offset.value + 30 : 0;
  const data = await run(() => props.request('music.users', { query: query.value, mode: lookupMode.value, offset: next }));
  if (data) { users.value = more ? [...users.value, ...data.users] : data.users; moreUsers.value = data.more; userPage.value = null; offset.value = next; }
}
async function loadUser(user, more = false) {
  const next = more ? offset.value + 30 : 0;
  const data = await run(() => props.request('music.userPlaylists', { id: user.id, offset: next }));
  if (data) { userPage.value = { ...data, playlists: more ? [...userPage.value.playlists, ...data.playlists] : data.playlists }; selectedUid.value = user.id; offset.value = next; }
}
async function preview(item) { const data = await run(() => props.request('playlist.preview', { id: item.id })); if (data) emit('preview', data); }
async function share(item) { const saved = await run(() => props.request('playlist.share', { id: item.id, runId: props.runId })); if (saved) { emit('published'); emit('notice', '已加入开放歌单'); } }
async function searchDraft(more = false) {
  const text = more ? draftSearched.value : draftQuery.value.trim(); if (!text || !props.canSearch) return;
  const offset = more ? draftOffset.value + 30 : 0; const result = await run(() => props.request('music.search', { query: text, offset }));
  if (result) { draftResults.value = more ? { songs: [...draftResults.value.songs, ...result.songs], playlists: [...draftResults.value.playlists, ...result.playlists] } : result; draftSearched.value = text; draftOffset.value = offset; draftArtist.value = null; draftPlaylist.value = null; if (!more) draftPlaylistLimit.value = 40; }
}
async function openDraftArtist({ artist, order = 'hot', more = false }) {
  if (!props.canSearch || locked.value) return;
  if (props.capabilities.artistNameSearch || !artist.id) {
    const name = String(artist.name || '').trim(); if (!name) return;
    draftQuery.value = name; draftType.value = 'songs'; draftSort.value = 'default'; draftArtist.value = null; draftPlaylist.value = null;
    await searchDraft(); return;
  }
  const offset = more ? (draftArtist.value?.offset || 0) + 30 : 0;
  const result = await run(() => props.request('music.artist', { id: artist.id, order, offset }));
  if (result) { if (!draftArtist.value) artistReturn = draftPlaylist.value; draftArtist.value = { ...result, artist: { ...result.artist, name: result.artist.name || artist.name }, songs: (more ? [...draftArtist.value.songs, ...result.songs] : result.songs).slice(0,500), offset }; draftPlaylist.value = null; }
}
function closeDraftArtist() { draftArtist.value = null; draftPlaylist.value = artistReturn || null; }
async function openDraftPlaylist(item) {
  const method = !props.owner && !props.publications.some(playlist => playlist.id === item.id) ? 'playlist.preview' : 'playlist.detail';
  const result = await run(() => props.request(method, { id: item.id }));
  if (result) { draftPlaylist.value = result; draftArtist.value = null; draftSongLimit.value = 50; }
}
async function shareDraftPlaylist() {
  if (!draftPlaylist.value || !props.canSave) return;
  const saved = await run(() => props.request('playlist.share', { id: draftPlaylist.value.id, runId: props.runId }));
  if (saved) { draftPlaylist.value = { ...draftPlaylist.value, published: true, openedBy: saved.openedBy }; emit('published'); emit('notice','歌单已加入开放歌单'); }
}
function appendDraftPlaylist() {
  if (!draftPlaylist.value || !props.canSave || locked.value) return;
  const existing = new Set(draft.value.songs.map(song=>song.id)); let added = 0; let duplicates = 0; let full = 0;
  for (const value of draftPlaylist.value.songs) { const song = songMetadata(value); if (existing.has(song.id)) { duplicates++; continue; } if (draft.value.songs.length >= 500) { full++; continue; } existing.add(song.id); draft.value.songs.push(song); added++; }
  emit('notice', `已加入 ${added} 首歌曲${duplicates ? '，跳过 ' + duplicates + ' 首重复歌曲' : ''}${full ? '；达到 500 首上限，另有 ' + full + ' 首未加入' : ''}`);
}
async function saveDraft() {
  if (!props.canSave || !draft.value.songs.length || !canUpdateTarget.value) return;
  const target = editTarget.value; const saved = await run(() => props.request(target ? 'playlist.update' : 'playlist.create', { name: draft.value.name, ...(props.capabilities.playlistDescriptions ? { description: draft.value.description } : {}), ids: draft.value.songs.map(song => song.id), runId: props.runId, ...(target ? { id: target.id, expectedUpdatedAt: target.updatedAt } : {}) }));
  if (saved) { if (props.canEdit) editTarget.value = { id: saved.id, updatedAt: saved.updatedAt, published: saved.published }; emit('created', saved); emit('notice', target ? '歌单修改已保存，当前播放队列不受影响' : '自建歌单已保存并开放'); }
}
defineExpose({ open, addSong, usePlaylist, editPlaylist });
</script>

<template>
  <div class="community-library">
    <div class="community-mode-tabs" role="tablist" aria-label="自建歌单功能">
      <button v-if="canSave" type="button" role="tab" :aria-selected="mode === 'draft'" :class="{active:mode === 'draft'}" @click="open('draft')">编辑歌单</button>
      <button v-if="canSearch" type="button" role="tab" :aria-selected="mode === 'find'" :class="{active:mode === 'find'}" @click="open('find')">用户搜索</button>
    </div>
    <div class="error" v-if="error" role="alert">{{ error }}</div>
    <template v-if="mode === 'find' && canSearch">
      <form class="public-user-search" @submit.prevent="findUsers(false)"><select v-model="lookupMode" aria-label="用户查找方式"><option value="nickname">网易云昵称</option><option value="uid">UID / 主页链接</option></select><input v-model="query" maxlength="200" aria-label="查找网易云用户" :placeholder="lookupMode === 'nickname' ? '输入网易云昵称' : '输入网易云 UID 或用户主页链接'"><button class="primary" :disabled="locked || !query.trim()">查找用户</button></form>
      <p class="community-hint">仅查看公开歌单，无需登录朋友的账号。手机号无法用于查找，私密歌单不会显示。</p>
      <template v-if="userPage"><button class="text-button" @click="userPage = null">← 返回用户列表</button><h2 class="public-user-heading">{{ userPage.user.name }} 的公开歌单</h2><div class="public-playlist-list"><article v-for="item in userPage.playlists" :key="item.id"><button class="public-playlist-preview" @click="preview(item)" :disabled="locked"><img v-if="item.coverUrl" :src="item.coverUrl" loading="lazy" alt=""><span><strong>{{ item.name }}</strong><small>{{ item.songCount }} 首 · {{ item.creatorName || '网易云歌单' }}</small></span></button><button class="secondary" v-if="canSave" @click="share(item)" :disabled="locked">加入开放歌单</button></article></div><p v-if="!userPage.playlists.length" class="community-hint">该用户没有可读取的公开歌单。</p><button v-if="userPage.more" class="secondary load-more" @click="loadUser({id:selectedUid},true)" :disabled="locked">更多用户歌单</button></template>
      <template v-else><div class="public-user-list"><button v-for="user in users" :key="user.id" @click="loadUser(user)" :disabled="locked"><img v-if="user.avatarUrl" :src="user.avatarUrl" loading="lazy" alt=""><span><strong>{{ user.name }}</strong><small>UID {{ user.id }}</small></span><span>查看歌单 →</span></button></div><button v-if="moreUsers" class="secondary load-more" @click="findUsers(true)" :disabled="locked">更多用户</button><p v-if="!users.length" class="community-hint">同名用户可通过 UID 区分；没有结果时可切换 UID / 主页链接精确查找。</p></template>
    </template>
    <template v-if="mode === 'draft' && canSave">
      <label class="field-label">自建歌单名称<input v-model="draft.name" maxlength="80" aria-label="自建歌单名称"></label>
      <label v-if="capabilities.playlistDescriptions" class="field-label playlist-description-field"><span>歌单简介 <small>选填 · {{ draft.description.length }} / 500</small></span><textarea v-model="draft.description" maxlength="500" rows="3" aria-label="自建歌单简介" placeholder="介绍这个歌单的主题、风格或一起听歌的约定" :disabled="locked"></textarea></label>
      <p class="community-hint">在下方搜索歌曲，点击行末“加入歌单”图标选择目标，拖动歌曲调整顺序，同一首歌只保留一次。歌单保存在机器人主人的电脑上；所有自建歌单统一开放，获得保存歌单授权的朋友都可编辑和删除。</p>
      <div v-if="editTarget" class="draft-editing-label" role="status"><strong>正在编辑原歌单</strong> · 保存后更新原存档与开放歌单<button class="text-button" type="button" @click="saveAsNew" :disabled="locked">改为另存新歌单</button></div>
      <p v-if="!canUpdateTarget" class="community-hint">当前没有此歌单的编辑权限。可另存为新歌单，或联系机器人主人。</p>
      <p class="community-hint" v-if="!persisted">浏览器未允许保留草稿，离开前请保存歌单。</p>
      <section v-if="canSearch && active" class="draft-search" aria-label="为自建歌单搜索歌曲">
        <button v-if="draft.songs.length" class="text-button draft-selected-link" type="button" @click="draftList?.scrollIntoView({behavior:'smooth',block:'start'})">查看已选歌曲（{{ draft.songs.length }}）↓</button>
        <form class="search-box" @submit.prevent="searchDraft(false)"><span aria-hidden="true">⌕</span><input v-model="draftQuery" maxlength="100" placeholder="搜索歌曲、歌手或歌单" aria-label="自建歌单搜索"><button class="primary" aria-label="搜索歌曲" :disabled="locked || !draftQuery.trim()">{{ busy ? '搜索中…' : '搜索' }}</button></form>
        <MusicSearchResults :request="props.request" :result="draftResults" :search-type="draftType" :search-sort="draftSort" :selected-artist="draftArtist" :selected-playlist="draftPlaylist" :playlist-song-limit="draftSongLimit" :playlist-card-limit="draftPlaylistLimit" :searched-query="draftSearched" :offset="draftOffset" :local="owner" :is-busy="locked" :running="running" :permissions="permissions" :capabilities="capabilities" builder :draft-ids="draft.songs.map(song=>song.id)" @type="draftType = $event" @sort="draftSort = $event" @artist="openDraftArtist" @close-artist="closeDraftArtist" @playlist="openDraftPlaylist" @close-playlist="draftPlaylist = null" @more-songs="draftSongLimit += 50" @more-playlists="draftPlaylistLimit += 40" @search-more="searchDraft(true)" @draft="emit('choosePlaylist',$event)" @control="emit('control',$event)">
          <template #playlist-actions><button class="primary" :disabled="!canPlayDraftPlaylist" @click="emit('control',{method:'playlist.play',args:{id:draftPlaylist.id}})">▶ 播放歌单</button><button class="secondary" :disabled="!canPlayDraftPlaylist" @click="emit('control',{method:'playlist.play',args:{id:draftPlaylist.id,append:true}})">加入队列</button><button v-if="!owner && canSave && draftPlaylist.publicPreview && !draftPlaylist.published" class="secondary" :disabled="locked" @click="shareDraftPlaylist">加入开放歌单</button><button class="secondary" :disabled="locked || !canSave || draft.songs.length >= 500" @click="appendDraftPlaylist">全部加入当前歌单</button></template>
        </MusicSearchResults>
      </section>
      <div ref="draftList" class="draft-song-list"><div class="draft-selected-toolbar"><h3 class="draft-selected-heading">已选歌曲 <span>{{ draft.songs.length }}</span></h3><div class="draft-selected-actions"><button v-if="clearedSongs && !draft.songs.length" type="button" class="secondary" :disabled="locked" @click="undoClearSongs">撤销清空</button><button type="button" class="danger-button danger-button--small" :disabled="locked || !draft.songs.length" @click="clearSelectedSongs" title="清空当前编辑的已选歌曲，名称与简介保留">一键清空</button></div></div>
        <header v-if="draft.songs.length" class="draft-song-header"><span>#</span><span>歌曲</span><span class="draft-song-album">专辑</span><span class="draft-song-duration">时长</span><span></span></header>
        <div v-for="(item,i) in draft.songs" :key="item.id" class="draft-song-row" :data-sort-id="item.id" tabindex="0" :aria-label="item.name + '，拖动排序，也可按 Alt 加方向键移动'" @keydown.alt.up.prevent="shift(i,-1)" @keydown.alt.down.prevent="shift(i,1)" :class="{dragging:dragging === item.id, 'drop-target':dropTarget === item.id, 'drop-after':dropTarget === item.id && dragIndex < i}" :draggable="!locked && canSave" @dragstart="startDrag($event,item)" @dragover="overDrag($event,item)" @dragleave="leaveDrag($event,item)" @drop="dropSong($event,item)" @dragend="clearDrag">
          <span class="draft-song-number"><span class="draft-drag-grip sort-grip" title="拖动排序" @pointerdown="draftTouch.start($event,item.id)" aria-hidden="true">⠿</span>{{ String(i+1).padStart(2,'0') }}</span>
          <div class="draft-song-info"><div class="draft-song-cover"><img v-if="item.coverUrl && !failedCovers.has(item.coverUrl)" :src="item.coverUrl" loading="lazy" decoding="async" alt="" @error="failedCovers.add(item.coverUrl)"><span v-else aria-hidden="true">♫</span></div><div class="draft-song-title"><strong :title="item.name">{{ item.name }}</strong><small :title="item.artist">{{ item.artist || '未知歌手' }}</small></div></div>
          <span class="draft-song-album" :title="item.album">{{ item.album || '—' }}</span><span class="draft-song-duration">{{ formatTime(item.duration) }}</span>
          <div class="draft-song-actions"><button type="button" class="danger-button danger-icon" @click="draft.songs.splice(i,1)" :disabled="locked" :aria-label="'移除自建歌曲 ' + item.name" title="移除">×</button></div>
        </div>
        <p v-if="!draft.songs.length" class="community-hint draft-empty-state">还没有歌曲，点击搜索结果行末的歌单图标添加吧。</p>
      </div>
      <div class="inline-actions"><button class="primary" @click="saveDraft" :disabled="locked || !draft.songs.length || !draft.name.trim() || !canUpdateTarget">{{ editTarget ? '保存歌单修改' : '保存自建歌单并开放' }}</button><span>{{ draft.songs.length }} / 500 首 · 拖动排序</span></div>
    </template>
  </div>
</template>
