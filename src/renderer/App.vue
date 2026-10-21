<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import QRCode from 'qrcode';
import PlayModeControl from './PlayModeControl.vue';
import UiScaleControl from './UiScaleControl.vue';
import VolumeControl from './VolumeControl.vue';
import LyricsPanel from './LyricsPanel.vue';
import ResizableQueuePanel from './ResizableQueuePanel.vue';
import ResourceMonitor from './ResourceMonitor.vue';
import AudioHealthPanel from './AudioHealthPanel.vue';
import CommunityLibrary from './CommunityLibrary.vue';
import MusicSearchResults from './MusicSearchResults.vue';
import PlaylistPicker from './PlaylistPicker.vue';
import OwnerConsolePanel from './OwnerConsolePanel.vue';
import AdminActionsPanel from './AdminActionsPanel.vue';
import NeteaseCookieImport from './NeteaseCookieImport.vue';
import OfficialBrowserLogin from './OfficialBrowserLogin.vue';
import { touchSort } from '../shared/touch-sort.mjs';
import { visitorName } from '../shared/visitor.mjs';
import { playlistDateName, playlistFile, readPlaylistFile } from '../shared/playlist-format.mjs';
const pickerSong = ref(null); const currentDraft = ref({name:'',ids:[],editId:''});
const communityMode = ref('find'); const community = ref(null); const guestDraft = ref(''); const guestRemembered = ref(true);
const guestHistory = ref([]); const guestHistoryFilter = ref(''); const guestHistoryLoading = ref(false); const guestHistoryError = ref('');
const shownGuestHistory = computed(() => { const query = guestHistoryFilter.value.trim().toLocaleLowerCase(); return guestHistory.value.filter(name => name.toLocaleLowerCase().includes(query)); });
try { guestDraft.value = localStorage.getItem('tsmd_guest_name_v1') || ''; } catch {}
const local = !!window.musicDesk;
const desktop = window.musicDesk;
const serverOwner = Boolean(desktop?.server);
const failedQueueCovers = ref(new Set());const queuePanel=ref(null);
// NetEase sometimes returns HTTP or scheme-relative CDN links. Share pages use HTTPS.
function artworkUrl(value) { return typeof value === 'string' ? value.trim().replace(/^(?:http:)?\/\/((?:[a-z0-9-]+\.)*music\.126\.net)(?=[/:?#]|$)/i, 'https://$1') : ''; }
const names = { view: '查看播放', search: '搜索歌曲', add: '加入队列', transport: '暂停 / 继续', skip: '上一首 / 下一首', playNow: '立即播放', playlist: '切换开放歌单', volume: '调节音量', seek: '调整进度', queue: '移除 / 清空队列', reorder: '调整队列顺序', mode: '播放模式', savePlaylist: '保存 / 编辑开放歌单' };
const state = ref({ ready: false, phase: 'initializing', presets: [], grants: [], publications: [], player: {}, auth: {}, permissions: [] });
const page = ref('queue'); const musicTab = ref('search'); const guestSection = ref('search'); const error = ref(''); const notice = ref(''); const busy = ref(''); const terminal = ref(''); const selected = ref('');
const authorizedFeatures = computed(() => (state.value.permissions || []).filter(permission => names[permission]).map(permission => names[permission]));
const pageTitle = computed(() => page.value === 'queue' ? '播放队列' : page.value === 'community' ? '自建歌单' : page.value === 'music' ? ({ search: '搜索', shared: '开放歌单', mine: '我的歌单', recommend: '发现歌单', local: '已存自建歌单', draft: '自建歌单', find: '用户歌单' }[guestSection.value] || '音乐与歌单') : ({ home: '控制台', sharing: '分享控制', settings: '设置与状态' }[page.value]));
const query = ref(''); const searchedQuery = ref(''); const searchType = ref('songs'); const result = ref({ songs: [], playlists: [] }); const playlists = ref([]); const selectedPlaylist = ref(null); const playlistType = ref('mine'); const offset = ref(0);
const playlistSongLimit = ref(50); const playlistCardLimit = ref(40);
const searchSort = ref('default'); const selectedArtist = ref(null); let artistReturn;
const savePlaylistName = ref(''); const savePlaylistDescription = ref(''); const savePlaylistTarget = ref('new'); const playlistImport = ref(null); const deletingPlaylist = ref(null);
const modal = ref(''); const editing = ref(null); const qr = ref(''); const qrStatus = ref(''); const channels = ref([]); const form = ref({});
const authMethod = ref('qr');
const presetForm = ref(null);
const grantName = ref('我的朋友'); const grantPermissions = ref(Object.keys(names)); const shareQr = ref(''); const shareQrLink = ref('');
let csrf = sessionStorage.getItem('tsmd_csrf') || ''; let socket; let timer; let qrTimer; let unsubscribe;
const serverSidebar = computed(() => serverOwner || Boolean(state.value.capabilities?.serverResources));
const running = computed(() => state.value.phase === 'running');
const isBusy = computed(() => Boolean(busy.value));
const connecting = computed(() => state.value.phase === 'starting' || busy.value === '连接 TS');
const connectionError = ref('');
const player = computed(() => state.value.player || {}); const song = computed(() => player.value.currentSong); const preset = computed(() => state.value.presets?.find(p => p.id === selected.value));
const currentSongArtists = computed(() => {
  const artists=(Array.isArray(song.value?.artists)?song.value.artists:[]).filter(artist=>typeof artist?.name==='string'&&artist.name.trim()).map(artist=>({id:String(artist.id||''),name:artist.name.trim()}));
  if(!artists.length&&typeof song.value?.artist==='string'&&song.value.artist.trim())artists.push({id:'',name:song.value.artist.trim()});
  return [...new Map(artists.map(artist=>[artist.id||artist.name,artist])).values()];
});
function currentArtistLabel(artist){return ((serverOwner||state.value.capabilities?.artistNameSearch||!artist.id)?'搜索歌手 ':'查看歌手 ')+artist.name;}

const queueCurrentIndex = computed(() => song.value?.entryId ? (player.value.queue || []).findIndex(item => item.entryId === song.value.entryId) : -1);
const queueDrag = ref(null); const queueDropTarget = ref('');
const queueDragIndex = computed(() => (player.value.queue || []).findIndex(item => item.entryId === queueDrag.value?.entryId));
const can = permission => local || state.value.permissions?.includes(permission);
const canSavePlaylist = computed(() => local || (can('savePlaylist') && state.value.capabilities?.sharedPlaylistSaving));
const canDeletePlaylist = item => local || (item?.source === 'local' && canSavePlaylist.value && state.value.capabilities?.openLocalPlaylists);
const canEditPlaylist = item => item?.source === 'local' && state.value.capabilities?.playlistEditing && (local || (canSavePlaylist.value && state.value.capabilities?.collaborativePlaylists));
const phases = { initializing: '正在准备组件', starting: '正在连接服务器', running: '机器人在线', stopped: '机器人未启动', disconnected: '服务器已断开', error: '服务异常' };
const formatTime = seconds => { const s = Math.max(0, Math.floor(seconds || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const duration = computed(() => player.value.effectiveDuration || song.value?.duration || 0);
async function request(method, args = {}) {
  // Match the JSON wire format and strip nested reactive proxies before IPC.
  if (local) return window.musicDesk.rpc(method, JSON.parse(JSON.stringify(args)));
  const response = await fetch('/api/share/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TSMD-CSRF': csrf }, body: JSON.stringify({ method, args, id: crypto.randomUUID() }) });
  const data = await response.json(); if (!data.ok) throw new Error(data.error); return data.result;
}
function update(next) { state.value = next; if (!selected.value && local) selected.value = next.defaultPreset || next.presets?.[0]?.id || ''; if (next.phase === 'running' && next.activePreset) selected.value = next.activePreset; if (musicTab.value === 'playlists' && playlistType.value === 'shared' && Array.isArray(next.publications)) playlists.value = next.publications; if (musicTab.value === 'playlists' && playlistType.value === 'local' && Array.isArray(next.localPlaylists)) playlists.value = next.localPlaylists; }
async function sharedResources() {
  const response=await fetch('/api/share/resources',{method:'POST',headers:{'Content-Type':'application/json','X-TSMD-CSRF':csrf},body:'{}'});
  const data=await response.json();if(!data.ok)throw new Error(data.error || '资源读取失败');return data.result;
}
async function refresh() { try { update(await request('status')); } catch (e) { if (!local) terminal.value = e.message; else error.value = e.message; } }
async function action(label, fn, refreshState = true) { if (busy.value) return; busy.value = label; error.value = ''; try { const data = await fn(); if (local && refreshState) await refresh(); return data; } catch (e) { error.value = e.message; } finally { busy.value = ''; } }
function notify(message) { notice.value = message; setTimeout(() => { notice.value = ''; }, 3500); }
function closeModal() { modal.value = ''; clearInterval(qrTimer); }
function dismissBackdrop() { if (modal.value !== 'preset') closeModal(); }
async function control(method, args = {}) { const result = await action(method, () => request(method, { ...args, expectedRevision: player.value.revision, runId: state.value.runId })); if (result && !local) { await refresh(); } }
async function playQueueItem(item) {
  if (!running.value || isBusy.value || !can('playNow') || (item.entryId === song.value?.entryId && player.value.playing)) return;
  const played = await action('播放队列歌曲', () => request('queue.play', { entryId: item.entryId, expectedRevision: player.value.revision, runId: state.value.runId }));
  if (!local || !played) await refresh();
}
function canReorder(index) { return running.value && !isBusy.value && can('reorder') && index > queueCurrentIndex.value && index < (player.value.queue?.length || 0); }
async function moveQueue(entryId, targetEntryId, revision = player.value.revision, runId = state.value.runId) {
  const moved = await action('调整队列', () => request('queue.move', { entryId, targetEntryId, expectedRevision: revision, runId }));
  if (!local || !moved) await refresh();
}
async function shiftQueue(item, index, direction) {
  const target = index + direction;
  if (!canReorder(index) || !canReorder(target)) return;
  await moveQueue(item.entryId, player.value.queue[target].entryId);
}
const queueTouch = touchSort({ selector: '.queue-item', begin: (event, id) => { const index = player.value.queue.findIndex(item => item.entryId === id); const item = player.value.queue[index]; if (!item || !canReorder(index)) return false; startQueueDrag(event,item,index); return true; }, over: (event,id) => { const index = player.value.queue.findIndex(item=>item.entryId===id); if (index >= 0) overQueueDrag(event,player.value.queue[index],index); }, drop: (event,id) => { const index=player.value.queue.findIndex(item=>item.entryId===id); if (index>=0) dropQueueDrag(event,player.value.queue[index],index); }, end: clearQueueDrag });
function clearQueueDrag() { queueDrag.value = null; queueDropTarget.value = ''; }
function startQueueDrag(event, item, index) {
  if (!canReorder(index)) { event.preventDefault(); return; }
  queueDrag.value = { entryId: item.entryId, revision: player.value.revision, runId: state.value.runId };
  if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.entryId); }
}
function overQueueDrag(event, item, index) {
  if (!queueDrag.value || !canReorder(index) || item.entryId === queueDrag.value.entryId) return;
  event.preventDefault(); queueDropTarget.value = item.entryId;
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
}
function leaveQueueDrag(event, item) { if (!event.currentTarget.contains(event.relatedTarget) && queueDropTarget.value === item.entryId) queueDropTarget.value = ''; }
async function dropQueueDrag(event, item, index) {
  const dragged = queueDrag.value; clearQueueDrag();
  if (!dragged || !canReorder(index) || dragged.entryId === item.entryId) return;
  event.preventDefault(); await moveQueue(dragged.entryId, item.entryId, dragged.revision, dragged.runId);
}
function newPreset(existing) { editing.value = existing || null; form.value = existing ? { ...existing, serverPassword: undefined, channelPassword: undefined } : { name: '', serverAddress: '', serverPort: 9987, nickname: 'Music Desk', defaultChannel: '', channelId: '', serverPassword: '', channelPassword: '' }; modal.value = 'preset'; }
async function savePreset() {
  if (busy.value || !presetForm.value?.reportValidity()) return;
  const values = JSON.parse(JSON.stringify(form.value));
  const saved = await action('保存预设', () => request('presets.save', values));
  if (saved) { selected.value = saved.id; modal.value = ''; notify('预设已保存'); }
}
async function removePreset(item) { const done = await action('删除预设', () => request('presets.remove', { id: item.id })); if (done) { if (selected.value === item.id) selected.value = state.value.defaultPreset || ''; notify('预设已删除'); } }
async function start() {
  if (busy.value || connecting.value) return;
  connectionError.value = '';
  if (!preset.value) { connectionError.value = '请先选择一个服务器预设'; return; }
  await action('连接 TS', async () => {
    try { return await request('bot.start', { id: selected.value }); }
    catch (e) { connectionError.value = e.message; throw e; }
  });
}
async function stop() { await action('停止机器人', () => request('bot.stop')); }
async function runAdminAction(kind) {
  if (!serverOwner || isBusy.value) throw new Error('请等待当前操作完成');
  const target = state.value.activePreset || selected.value || state.value.defaultPreset;
  if (kind === 'restart' && !state.value.presets.some(item => item.id === target)) throw new Error('请先在控制台选择服务器预设');
  busy.value = '管理操作';
  try {
    if (kind === 'owner') { await desktop.quit(); return; }
    if (kind === 'music') await request('auth.logout');
    else if (kind === 'stop') await request('bot.stop');
    else if (kind === 'restart') await request('bot.start', { id: target });
    else throw new Error('未知管理操作');
    await refresh(); notify({ music: '已退出网易云登录', stop: '机器人已关闭，管理网页继续运行', restart: '机器人已重新连接' }[kind]);
  } catch (failure) { if (kind === 'restart' || kind === 'stop') await refresh(); throw failure; }
  finally { busy.value = ''; }
}
async function login() { modal.value = 'login'; authMethod.value = serverOwner ? 'browser' : 'qr'; if (authMethod.value === 'qr') await getQr(); }
async function officialLoginDone() { closeModal(); notify('官网登录会话已保存，请测试搜索和播放'); await refresh(); }
async function switchAuthMethod(value) { clearInterval(qrTimer); authMethod.value = value; error.value = ''; if (value === 'qr') await getQr(); }
async function importLoginCookie(cookie) {
  const result = await action('验证登录会话', () => request('auth.importCookie', { cookie }));
  if (result) { closeModal(); notify('网易云登录会话已导入'); await refresh(); }
}
async function getQr() { clearInterval(qrTimer); qr.value = ''; qrStatus.value = '正在获取二维码…'; const result = await action('获取二维码', () => request('auth.qr')); if (!result) { qrStatus.value = '获取失败，可以重新获取'; return; } qr.value = result.qrImg || await QRCode.toDataURL(result.qrUrl); qrStatus.value = '用网易云音乐 App 扫码，在手机上确认登录'; qrTimer = setInterval(async () => { if (modal.value !== 'login') { clearInterval(qrTimer); return; } try { const checked = await request('auth.check'); if (checked.status === 'scanned') qrStatus.value = '已扫码，请在手机上确认'; if (checked.status === 'expired') { qrStatus.value = '二维码已过期，请刷新'; clearInterval(qrTimer); } if (checked.status === 'confirmed') { clearInterval(qrTimer); modal.value = ''; notify('网易云账号已登录'); await refresh(); } } catch (e) { qrStatus.value = e.message; clearInterval(qrTimer); } }, 2500); }
async function search(more = false) {
  const text = more ? searchedQuery.value : query.value.trim(); if (!text || isBusy.value) return;
  const nextOffset = more ? offset.value + 30 : 0;
  const data = await action('搜索音乐', () => request('music.search', { query: text, offset: nextOffset }), false);
  if (data) { result.value = more ? { songs: [...result.value.songs, ...data.songs], playlists: [...result.value.playlists, ...data.playlists] } : data; if (!more) playlistCardLimit.value = 40; offset.value = nextOffset; searchedQuery.value = text; selectedPlaylist.value = null; selectedArtist.value = null; musicTab.value = 'search'; }
}
async function loadPlaylists(type = playlistType.value) { if (isBusy.value) return; if (playlistType.value !== type) playlists.value = []; guestSection.value = type; playlistType.value = type; playlistCardLimit.value = 40; musicTab.value = 'playlists'; selectedPlaylist.value = null; selectedArtist.value = null; const data = await action('读取歌单', () => request('playlists.list', { type }), false); if (data) playlists.value = data; }
async function openPlaylist(item) { const data = await action('读取歌单', () => request(!local && state.value.capabilities?.community && !state.value.publications?.some(p => p.id === item.id) ? 'playlist.preview' : 'playlist.detail', { id: item.id }), false); if (data) { playlistSongLimit.value = 50; selectedArtist.value = null; selectedPlaylist.value = data; } }
async function publishPlaylist(item) { const opening = !item.published; const data = await action(opening ? '开放歌单' : '取消开放', () => request(opening ? 'playlist.publish' : 'playlist.unpublish', { id: item.id })); if (data) { item.published = opening; notify(opening ? '歌单已开放，下次分享仍可使用' : '已取消开放，已保存的本地歌单仍保留'); } }
async function removeOpenPlaylist(item) {
  if (!local || isBusy.value) return;
  if (item.source === 'local') { deletingPlaylist.value = item; modal.value = 'deletePlaylist'; return; }
  const removed = await action('删除开放歌单', () => request('playlist.unpublish', { id: item.id }));
  if (removed) { playlists.value = state.value.publications || []; if (selectedPlaylist.value?.id === item.id) selectedPlaylist.value = null; notify('已移除网易云歌单引用，当前队列保留'); }
}
async function openArtist(artist, order = 'hot', more = false) {
  if (isBusy.value || !can('search')) return;
  if (serverOwner || state.value.capabilities?.artistNameSearch || !artist.id) {
    const name = String(artist.name || '').trim(); if (!name) return;
    query.value = name; searchType.value = 'songs'; searchSort.value = 'default'; page.value = 'music'; guestSection.value = 'search'; musicTab.value = 'search'; selectedArtist.value = null; selectedPlaylist.value = null;
    await search(false); return;
  }
  const nextOffset = more ? (selectedArtist.value.offset || 0) + 30 : 0;
  const data = await action('读取歌手歌曲', () => request('music.artist', { id: artist.id, order, offset: nextOffset }), false);
  if (data) {
    if (!selectedArtist.value) artistReturn = { playlist: selectedPlaylist.value, tab: musicTab.value };
    const songs = more ? [...selectedArtist.value.songs, ...data.songs] : data.songs;
    selectedArtist.value = { ...data, artist: { ...data.artist, name: data.artist.name || artist.name }, songs: songs.slice(0, 500), offset: nextOffset };
    selectedPlaylist.value = null;
  }
}
function closeArtist() { selectedArtist.value = null; selectedPlaylist.value = artistReturn?.playlist || null; musicTab.value = artistReturn?.tab || 'search'; }
function openSavePlaylist() { if (!canSavePlaylist.value || !(player.value.queue || []).length) return; savePlaylistName.value = playlistDateName(); savePlaylistDescription.value = ''; savePlaylistTarget.value = 'new'; modal.value = 'savePlaylist'; error.value = ''; }
function chooseSaveTarget() { const target = state.value.localPlaylists?.find(item => item.id === savePlaylistTarget.value); savePlaylistName.value = target?.name || playlistDateName(); savePlaylistDescription.value = target?.description || ''; }
async function saveQueuePlaylist() {
  if (!canSavePlaylist.value || !savePlaylistName.value.trim() || isBusy.value) return;
  if (!state.value.capabilities?.savedPlaylists) { error.value = '请先导出队列，重开工具后导入歌单'; return; }
  const saved = await action('保存队列歌单', () => request('playlist.saveQueue', { name: savePlaylistName.value, ...(state.value.capabilities?.playlistDescriptions ? { description: savePlaylistDescription.value } : {}), runId: state.value.runId, ...(local && savePlaylistTarget.value !== 'new' ? { id: savePlaylistTarget.value } : {}) }));
  if (saved && !local) await refresh();
  if (saved) { modal.value = ''; page.value = 'music'; guestSection.value = 'shared'; musicTab.value = 'playlists'; playlistType.value = 'shared'; playlists.value = state.value.publications || []; selectedArtist.value = null; selectedPlaylist.value = saved; playlistSongLimit.value = 50; notify('歌单已保存并开放，下次分享仍会保留'); }
}
function exportQueueFile() {
  try {
    const data = playlistFile(savePlaylistName.value, player.value.queue || [], state.value.publications || [], savePlaylistDescription.value); const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = data.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-') + '.json'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); notify('队列已导出，可重开后通过“导入歌单”保存');
  } catch (e) { error.value = e.message; }
}
async function importPlaylistFile(event) {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file || isBusy.value) return;
  if (file.size > 2 * 1024 * 1024) { error.value = '歌单文件不能超过 2 MiB'; return; }
  const saved = await action('导入歌单', async () => { const raw = JSON.parse(await file.text()); readPlaylistFile(raw); return request('playlist.import', { file: raw }); });
  if (saved) { page.value = 'music'; guestSection.value = 'shared'; musicTab.value = 'playlists'; playlistType.value = 'shared'; playlists.value = state.value.publications || []; selectedArtist.value = null; selectedPlaylist.value = saved; notify('歌单已导入并开放'); }
}
async function deletePlaylist() { const item = deletingPlaylist.value; const done = await action('删除歌单', () => request('playlist.delete', { id: item.id, runId: state.value.runId, expectedUpdatedAt: item.updatedAt })); if (done) { if (!local) await refresh(); modal.value = ''; selectedPlaylist.value = null; playlists.value = playlistType.value === 'local' ? state.value.localPlaylists || [] : state.value.publications || []; notify(item.source === 'local' ? '歌单已删除，当前播放队列不受影响' : '已移除开放歌单，网易云原歌单保留'); } }
async function copy(text) { if (!text) return; try { if (local) await window.musicDesk.copy(text); else await navigator.clipboard.writeText(text); notify('链接已复制'); } catch { error.value = '复制失败，请手动选中链接复制'; } }
async function createGrant() { const data = await action('创建授权', () => request('sharing.create', { name: grantName.value, permissions: grantPermissions.value })); if (data) notify('授权已创建'); }
async function changePermission(grant, permission, checked) { const permissions = checked ? [...grant.permissions, permission] : grant.permissions.filter(p => p !== permission); await action('修改权限', () => request('sharing.permissions', { id: grant.id, permissions })); }
watch(modal, async (value, previous, onCleanup) => {
  if (value !== 'identity' || local || !state.value.capabilities?.visitorHistory) return;
  let active = true; onCleanup(() => { active = false; });
  guestHistoryFilter.value = ''; guestHistoryLoading.value = true; guestHistoryError.value = ''; guestHistory.value = [];
  try { const history = await request('identity.history'); if (active) guestHistory.value = history.names; }
  catch { if (active) guestHistoryError.value = '曾用昵称暂时读取失败，仍可输入昵称使用。'; }
  finally { if (active) guestHistoryLoading.value = false; }
});
async function saveGuestIdentity(value) {
  if (isBusy.value) return;
  let name; try { name = visitorName(typeof value === 'string' ? value : guestDraft.value); } catch (e) { error.value = e.message; return; }
  guestDraft.value = name;
  const saved = await action('保存点播 ID', () => request('identity.set', { name }));
  if (saved) { guestRemembered.value = true; try { localStorage.setItem('tsmd_guest_name_v1', name); } catch { guestRemembered.value = false; } await refresh(); modal.value = ''; notify(guestRemembered.value ? '点播 ID 已记住' : '点播 ID 已设置，浏览器未允许保存'); }
}
async function removeGuestHistory(name) {
  const removed = await action('删除曾用昵称', () => request('identity.remove', { name }));
  if (removed) {
    guestHistory.value = guestHistory.value.filter(item => item !== name);
    if (guestHistory.value.length <= 8) guestHistoryFilter.value = '';
    try { if (localStorage.getItem('tsmd_guest_name_v1') === name) localStorage.removeItem('tsmd_guest_name_v1'); } catch {}
    notify('已删除曾用昵称，当前点播署名保持不变');
  }
}
function openCommunity(mode) { page.value = 'community'; guestSection.value = mode; error.value = ''; communityMode.value = mode; musicTab.value = 'community'; selectedPlaylist.value = null; selectedArtist.value = null; community.value?.open(mode); }
function openPlaylistPicker(item) { if (!canSavePlaylist.value || isBusy.value) return; pickerSong.value = item; modal.value = 'playlistPicker'; error.value = ''; }
function addToCurrentDraft(item) { community.value?.addSong(item); closeModal(); }
async function playlistPickerSaved(result) { closeModal(); await refresh(); const saved = result.playlist; if (selectedPlaylist.value?.id === saved.id) selectedPlaylist.value = saved; notify(result.added ? '已加入歌单《' + saved.name + '》' : '《' + saved.name + '》已包含这首歌'); }
function communityPreview(detail) { selectedPlaylist.value = detail; selectedArtist.value = null; musicTab.value = 'search'; playlistSongLimit.value = 50; }
async function communityCreated(detail) { await refresh(); communityPreview(detail); }
async function sharePublicPlaylist() { const saved = await action('加入开放歌单', () => request('playlist.share', { id: selectedPlaylist.value.id, runId: state.value.runId })); if (saved) { await refresh(); selectedPlaylist.value = { ...selectedPlaylist.value, published: true, openedBy: saved.openedBy }; notify('歌单已加入开放歌单'); } }
function editSelectedPlaylist() { community.value?.editPlaylist(selectedPlaylist.value); openCommunity('draft'); }
function copyPlaylistToDraft() { community.value?.usePlaylist(selectedPlaylist.value); openCommunity('draft'); }
function openGuestSearch() { page.value = 'music'; guestSection.value = 'search'; musicTab.value = 'search'; selectedPlaylist.value = null; selectedArtist.value = null; error.value = ''; }
async function openSharedPlaylists(item) { page.value = 'music'; guestSection.value = 'shared'; await loadPlaylists('shared'); if (item) await openPlaylist(item); }
async function openOwnerCollection(type) { page.value = 'music'; error.value = ''; await loadPlaylists(type); }
function choosePlaylistCreation(mode) { closeModal(); openCommunity(mode); }
async function configureAnnouncement(grant, enabled) { await action('设置自动分发', () => request('sharing.announce', { grantId: grant.id, enabled })); }
async function showShareQr(url) { if (!url) return; shareQr.value = await QRCode.toDataURL(url, { width: 320, margin: 2 }); shareQrLink.value = url; modal.value = 'shareQr'; }
function previewGrant(grant) { return desktop.openLink(serverOwner ? `${location.origin}/#invite=${new URL(grant.localUrl).hash.slice(8)}` : grant.localUrl); }
async function readChannels() { const data = await action('读取频道', () => request('bot.channels')); if (data) { channels.value = data; modal.value = 'channels'; } }
function openPage(next) { page.value = next; error.value = ''; if (next === 'music' && musicTab.value === 'playlists') loadPlaylists(); }
function connectEvents() { if (socket) socket.close(); socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/events?delta=1`); socket.onmessage = event => { const message = JSON.parse(event.data); if (message.type === 'state') { terminal.value = ''; update(message.partial ? { ...state.value, ...message.state, player: { ...state.value.player, ...message.state.player } } : message.state); } if (message.type === 'revoked') { terminal.value = '链接已失效：机器人已关闭或主人撤销了授权。'; sessionStorage.removeItem('tsmd_csrf'); } }; socket.onclose = () => { if (!terminal.value) setTimeout(connectEvents, 4000); }; }
onMounted(async () => {
  if (local) { unsubscribe = window.musicDesk.subscribe(update); await refresh(); timer = setInterval(refresh, 6000); }
  else {
    const fragment = new URLSearchParams(location.hash.slice(1)); const invite = fragment.get('invite'); if (!document.documentElement.hasAttribute('data-persistent-invitations')) history.replaceState({}, '', location.pathname);
    if (invite) { try { const response = await fetch('/api/share/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: invite }) }); const data = await response.json(); if (!data.ok) throw new Error(data.error); csrf = data.csrf; sessionStorage.setItem('tsmd_csrf', csrf); } catch (e) { terminal.value = e.message; return; } }
    if (!csrf) { terminal.value = '请通过机器人主人发给你的完整分享链接打开此页面。'; return; }
    await refresh();
    if (!terminal.value && state.value.capabilities?.community) {
      if (guestDraft.value) { try { await request('identity.set', { name: guestDraft.value, remember: false }); await refresh(); } catch { modal.value = 'identity'; } }
      else modal.value = 'identity';
    }
    if (!terminal.value) { connectEvents(); timer = setInterval(() => { if (socket?.readyState !== WebSocket.OPEN) refresh(); }, 10000); }
  }
});
onUnmounted(() => { queueTouch.cancel(); clearInterval(timer); clearInterval(qrTimer); unsubscribe?.(); socket?.close(); });
</script>

<template>
  <div v-if="terminal && !local" class="expired-screen"><div class="brand-mark"><img :src="'./logo.png'" alt="TS Music Desk Logo"></div><h1>此控制链接暂时不可用</h1><p>{{ terminal }}</p><span>TS Music Desk · 共享控制</span></div>
  <div v-else class="app-shell" :class="{ shared: !local, desktop: local, 'server-owner': serverOwner }">
    <aside class="sidebar adaptive-sidebar" :class="{ 'server-sidebar': serverSidebar }">
      <div class="sidebar-top">
      <div class="brand"><div class="brand-mark"><img :src="'./logo.png'" alt="TS Music Desk Logo"></div><div>Music Desk<small>TEAMSPEAK BOT</small></div><span class="version">1.2</span></div>
      <div class="sidebar-caption">{{ local ? '你的音乐空间' : '朋友的音乐空间' }}</div>
      <nav aria-label="音乐分页">
          <button :class="{ active: page === 'queue' }" @click="openPage('queue')" aria-label="播放队列"><svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 6h12M4 12h12M4 18h7"/><path d="m17 15 4 3-4 3z"/></svg>播放队列</button>
          <button v-if="can('search')" :class="{ active: page === 'music' && guestSection === 'search' }" @click="openGuestSearch" aria-label="打开搜索"><svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>搜索</button>
          <button v-if="state.capabilities?.community && (canSavePlaylist || can('search'))" :class="{ active: page === 'community' }" @click="openCommunity(canSavePlaylist ? 'draft' : 'find')" aria-label="自建歌单"><svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 4h16v16H4zM8 4v16M12 9h5M12 13h5M12 17h3"/></svg>自建歌单</button>
          <button :class="{ active: page === 'music' && guestSection === 'shared' }" @click="openSharedPlaylists()" aria-label="开放歌单"><svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 18V5l11-2v13M9 9l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="17" cy="16" rx="3" ry="2"/></svg>开放歌单</button>
      </nav>
      <details v-if="local" class="sidebar-owner-library" :open="page === 'music' && ['mine','recommend','local'].includes(guestSection)"><summary>我的音乐库</summary><div>
        <button :class="{ active: page === 'music' && guestSection === 'mine' }" @click="openOwnerCollection('mine')">我的歌单</button>
        <button :class="{ active: page === 'music' && guestSection === 'recommend' }" @click="openOwnerCollection('recommend')">发现歌单</button>
        <button :class="{ active: page === 'music' && guestSection === 'local' }" @click="openOwnerCollection('local')" :disabled="!state.capabilities?.savedPlaylists">已存自建歌单</button>
      </div></details>
      <nav v-if="local" class="sidebar-admin-nav" aria-label="管理员功能">
        <button :class="{ active: page === 'home' }" @click="openPage('home')" aria-label="控制台"><span aria-hidden="true">⌂</span>控制台</button>
        <button v-if="local" :class="{ active: page === 'sharing' }" @click="openPage('sharing')"><span>↗</span>分享控制</button>
        <button v-if="local" :class="{ active: page === 'settings' }" @click="openPage('settings')"><span>⚙</span>设置与状态</button>
      </nav>
      </div>
      <div class="guest-playlists" aria-label="侧栏开放歌单">
        <button v-for="item in state.publications" :key="item.id" class="guest-playlist-link" :class="{active:page === 'music' && guestSection === 'shared' && selectedPlaylist?.id === item.id}" :title="item.name + ' · ' + (item.openedBy || '主人') + ' 开放'" @click="openSharedPlaylists(item)" :disabled="isBusy">
          <img v-if="item.coverUrl" :src="artworkUrl(item.coverUrl)" loading="lazy" decoding="async" alt=""><span v-else class="guest-playlist-placeholder" aria-hidden="true">♫</span><span><strong>{{ item.name }}</strong><small>{{ item.openedBy || '主人' }} 开放</small></span>
        </button>
        <button v-if="state.capabilities?.community && (canSavePlaylist || can('search'))" class="guest-playlist-add" :class="{active:page === 'community'}" @click="modal = 'addPlaylist'" aria-label="添加歌单" title="自建歌单或查找用户歌单"><span aria-hidden="true">＋</span>添加歌单</button>
      </div>
      <div class="sidebar-footer">
      <button v-if="local" class="sidebar-exit" type="button" @click="serverOwner ? modal = 'adminActions' : desktop.quit()" :title="serverOwner ? '管理登录、网易云账号和机器人运行' : '停止机器人并退出，控制链接将失效'" :aria-haspopup="serverOwner ? 'dialog' : undefined">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3v9M18.36 6.64a9 9 0 1 1-12.72 0"/></svg>
        <span>{{ serverOwner ? '管理操作' : '退出工具' }}</span>
      </button>
      <button v-if="local" class="account" @click="login"><img v-if="state.auth?.avatarUrl" :src="artworkUrl(state.auth.avatarUrl)" alt=""><div class="account-icon" v-else>♪</div><div>{{ state.auth?.nickname || (state.auth?.hasSession ? '网易云会话已保存' : '连接网易云音乐') }}<small>{{ state.auth?.checkFailed ? '登录检查暂未完成 · 会话已保留' : state.auth?.loggedIn ? (serverOwner ? '已登录 · 点击管理登录' : '已登录 · 点击重新扫码') : state.auth?.checking ? '正在检查账号' : (serverOwner ? '登录或导入你的账号' : '扫码登录，使用你的歌单') }}</small></div></button>
      <ResourceMonitor v-if="local || serverSidebar" :server="serverSidebar" :load-sample="local ? undefined : sharedResources" />
      </div>
    </aside>

    <main>
      <header class="topbar"><span>{{ pageTitle }}</span><div><UiScaleControl /><button v-if="!local && state.capabilities?.community" class="visitor-button" @click="guestDraft = state.visitor?.name || guestDraft; modal = 'identity'" :title="'修改点播 ID：' + (state.visitor?.name || '未设置')">ID：{{ state.visitor?.name || '设置昵称' }}</button><button v-if="!local" class="guest-permissions-button" @click="modal = 'permissions'" title="查看已授权的具体功能">权限 {{ authorizedFeatures.length }}</button><span class="status-pill" :class="{ online: running }"><i></i>{{ phases[state.phase] }}</span></div></header>
      <div class="notice" v-if="notice">✓ {{ notice }}</div>
      <div class="error" v-if="error || state.error"><span>{{ error || state.error }}</span><button @click="error = ''; state.error = ''">×</button></div>
      <div v-if="local && ['starting','retrying','error'].includes(state.autoSharing?.status)" class="auto-sharing-banner" :class="{failed:state.autoSharing.status === 'error'}" role="status"><span>{{ state.autoSharing.status === 'retrying' ? '首次自动共享未完成，2 秒后自动重试一次…' : state.autoSharing.status === 'starting' ? (state.autoSharing.attempt === 2 ? '正在重试自动共享（最后一次）…' : '机器人已连接，正在自动建立并发送控制链接…') : state.autoSharing.error }}</span><button class="text-button" @click="openPage('sharing')">查看分享控制 →</button></div>
      <div class="loading-banner" v-if="!state.ready && !state.error"><span class="spinner"></span>正在启动本地音乐服务…</div>
      <div class="workspace" :class="{ 'queue-home': page === 'queue' }">
        <section class="content" v-show="page !== 'queue'">
          <template v-if="page === 'home'">
            <div class="hero"><div><span class="eyebrow">YOUR CHANNEL. YOUR SOUND.</span><h1>把音乐带进你的频道</h1><p>选择一个服务器预设，连接后就可以点歌。<br>把控制链接交给朋友，一起决定下一首。</p><div class="hero-actions"><button class="primary" @click="state.presets.length ? start() : newPreset()" :disabled="isBusy || connecting || !state.ready || running">{{ connecting ? '连接中…' : state.presets.length ? '▶ 启动机器人' : '+ 添加第一个服务器' }}</button><button class="subtle" @click="openGuestSearch">打开搜索 ↗</button></div></div><div class="hero-art"><span class="art-orbit"></span><div class="record"><div>♫</div></div><span class="wave w1"></span><span class="wave w2"></span><span class="wave w3"></span><span class="art-label">LIVE IN TEAMSPEAK</span></div></div>
            <div class="section-title"><div><h2>服务器预设</h2><p>记住服务器和频道，下次直接连接</p></div><button class="secondary" @click="newPreset()" :disabled="isBusy">+ 添加预设</button></div>
            <div v-if="!state.presets.length" class="empty-presets"><span>⌁</span><h3>还没有服务器预设</h3><p>填写服务器地址和频道，密码仅加密保存在本机。</p><button class="text-button" @click="newPreset()">添加服务器 →</button></div>
            <div class="preset-grid"><article v-for="item in state.presets" :key="item.id" class="preset-card" :class="{ selected: selected === item.id }" @click="selected = item.id"><div class="preset-top"><div class="server-icon">TS</div><span v-if="state.defaultPreset === item.id" class="badge">默认</span><span v-if="state.activePreset === item.id && running" class="badge green">已连接</span><button class="icon-button" @click.stop="newPreset(item)" title="编辑预设">✎</button></div><h3>{{ item.name }}</h3><p class="server-address">{{ item.serverAddress }}:{{ item.serverPort }}</p><p class="channel-name"># {{ item.channelId ? '频道 ID ' + item.channelId : item.defaultChannel || '服务器默认频道' }}</p><div class="preset-bottom"><span>{{ item.nickname }}</span><button @click.stop="selected = item.id">{{ selected === item.id ? '✓ 已选择' : '选择' }}</button></div></article></div>
            <div class="connect-bar" v-if="state.presets.length"><div><strong>{{ preset?.name || '选择服务器预设' }}</strong><small>{{ running ? '目标频道 ' + player.channelId : '连接后即可点歌，查看频道为可选操作' }}</small></div><button v-if="running" class="secondary" @click="readChannels" :disabled="isBusy">查看频道</button><button class="primary" v-if="!running" @click="start" :disabled="!selected || isBusy || connecting || !state.ready">{{ connecting ? '连接中…' : '连接 TS 服务器' }}</button><button class="danger-outline" v-else @click="stop" :disabled="isBusy">停止机器人</button></div>
            <p v-if="connecting" class="connection-feedback" role="status"><span class="spinner"></span>正在连接服务器并进入目标频道…</p>
            <p v-else-if="connectionError || (!running && state.activePreset === selected && state.error)" class="connection-feedback connection-error" role="alert">{{ connectionError || state.error }}</p>
            <OwnerConsolePanel :server="serverOwner" :friend-only="state.runtime?.friendOnlyEndpoint" :tunnel="state.tunnel" :grants="state.grants" :change-password="desktop?.changePassword" :busy="isBusy" @notice="notify" @sharing="openPage('sharing')" />
            <div class="steps"><div><b>01</b><strong>保存服务器</strong><p>地址、昵称与目标频道</p></div><div><b>02</b><strong>扫码连接音乐账号</strong><p>使用网易云 App 确认登录</p></div><div><b>03</b><strong>开启音乐与分享</strong><p>在频道里一起收听</p></div></div>
          </template>

          <div v-show="page === 'music' || page === 'community'" class="music-page">
            <div class="page-heading"><div><span class="eyebrow">MUSIC LIBRARY</span><h1>{{ pageTitle }}</h1><p>{{ page === 'community' ? communityMode === 'find' ? '查找网易云用户，浏览并开放他的公开歌单' : '添加简介、整理歌曲，再保存到开放歌单' : guestSection === 'shared' ? '保存的歌单一直保留，新的控制链接也能打开' : guestSection === 'mine' ? '网易云账号中创建与收藏的歌单' : guestSection === 'recommend' ? '发现网易云推荐歌单' : guestSection === 'local' ? '保存在机器人上的自建歌单' : '搜索歌曲、歌手和相关歌单，在 TS 频道里一起收听' }}</p></div></div>
            <form v-if="page === 'music' && can('search') && musicTab !== 'community' && guestSection === 'search'" class="search-box" @submit.prevent="search(false)"><span>⌕</span><input v-model="query" placeholder="搜索歌曲、歌手或歌单" aria-label="搜索音乐"><button class="primary" :disabled="isBusy || !state.ready">{{ busy === '搜索音乐' ? '搜索中…' : '搜索' }}</button></form>
            <CommunityLibrary v-if="state.capabilities?.community" v-show="musicTab === 'community'" ref="community" :initial-mode="communityMode" :active="musicTab === 'community'" :request="request" :can-search="can('search')" :can-save="canSavePlaylist" :can-edit="canSavePlaylist && !!state.capabilities?.playlistEditing" :owner="local" :run-id="state.runId" :busy="isBusy" :running="running" :permissions="state.permissions" :capabilities="state.capabilities" :publications="state.publications" @mode-change="communityMode = $event; guestSection = $event" @choose-playlist="openPlaylistPicker" @draft-change="currentDraft = $event" @control="control($event.method,$event.args)" @preview="communityPreview" @created="communityCreated" @published="refresh" @notice="notify"/>
            <div v-if="local && page === 'music' && musicTab !== 'community'" class="library-actions"><input ref="playlistImport" type="file" accept="application/json,.json" hidden @change="importPlaylistFile"><button class="text-button" :disabled="isBusy || !state.capabilities?.savedPlaylists" @click="playlistImport.click()">导入歌单</button></div>
            <button v-if="page === 'community' && musicTab !== 'community'" type="button" class="text-button community-preview-back" @click="openCommunity(communityMode)">{{ communityMode === 'find' ? '← 返回用户搜索' : '← 返回编辑歌单' }}</button>
            <MusicSearchResults :request="request" v-if="musicTab !== 'community'" :result="result" :music-tab="musicTab" :search-type="searchType" :search-sort="searchSort" :selected-artist="selectedArtist" :selected-playlist="selectedPlaylist" :playlists="playlists" :playlist-song-limit="playlistSongLimit" :playlist-card-limit="playlistCardLimit" :searched-query="searchedQuery" :offset="offset" :local="local" :is-busy="isBusy" :running="running" :permissions="state.permissions" :capabilities="state.capabilities" :draft-ids="currentDraft.ids" @type="searchType = $event" @sort="searchSort = $event" @artist="openArtist($event.artist,$event.order,$event.more)" @close-artist="closeArtist" @playlist="openPlaylist" @close-playlist="page === 'community' ? openCommunity(communityMode) : (selectedPlaylist = null)" @more-songs="playlistSongLimit += 50" @more-playlists="playlistCardLimit += 40" @search-more="search(true)" @control="control($event.method,$event.args)" @draft="openPlaylistPicker">
              <template #playlist-actions><button class="primary" @click="control('playlist.play', { id: selectedPlaylist.id })" :disabled="!running || isBusy || !can('playlist') || (!local && selectedPlaylist.publicPreview && !selectedPlaylist.published)">▶ 播放歌单</button><button class="secondary" @click="control('playlist.play', { id: selectedPlaylist.id, append: true })" :disabled="!running || isBusy || !can('playlist') || (!local && selectedPlaylist.publicPreview && !selectedPlaylist.published)">加入队列</button><button v-if="!local && state.capabilities?.community && can('savePlaylist') && selectedPlaylist.publicPreview && !selectedPlaylist.published" class="secondary" @click="sharePublicPlaylist" :disabled="isBusy">加入开放歌单</button><button v-if="canEditPlaylist(selectedPlaylist)" class="secondary" @click="editSelectedPlaylist" :disabled="isBusy">编辑歌单</button><button v-if="state.capabilities?.community && can('savePlaylist')" class="secondary" @click="copyPlaylistToDraft" :disabled="isBusy">用此歌单建单</button><button :class="selectedPlaylist.published ? 'danger-button' : 'secondary'" v-if="local && selectedPlaylist.source !== 'local'" @click="publishPlaylist(selectedPlaylist)" :disabled="isBusy">{{ selectedPlaylist.published ? '取消开放' : '开放给朋友' }}</button><button class="danger-button" v-if="canDeletePlaylist(selectedPlaylist) && (selectedPlaylist.source === 'local' || (!local && selectedPlaylist.published))" @click="deletingPlaylist = selectedPlaylist; modal = 'deletePlaylist'" :disabled="isBusy">{{ local ? '删除存档' : '删除歌单' }}</button></template>
              <template #playlist-card-actions="{item}">                <button v-if="local && musicTab === 'playlists' && playlistType === 'shared'" class="playlist-remove danger-button danger-button--small" :aria-label="(item.source === 'local' ? '删除歌单 ' : '从开放歌单移除 ') + item.name" :title="item.source === 'local' ? '删除自建歌单' : '移除网易云歌单引用，保留网易云原歌单'" :disabled="isBusy" @click.stop="removeOpenPlaylist(item)"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5"/></svg><span>删除</span></button>
                <button v-if="!local && canDeletePlaylist(item)" class="playlist-remove danger-button danger-button--small" :aria-label="'删除歌单 ' + item.name" :disabled="isBusy" @click.stop="deletingPlaylist = item; modal = 'deletePlaylist'"><span>删除</span></button></template>
              <template #empty>            <div>♫</div><h3>{{ musicTab === 'search' ? searchedQuery ? searchType === 'songs' ? '没有找到相关歌曲' : '没有找到相关歌单' : '下一首，从这里开始' : local && !state.auth?.loggedIn && playlistType === 'mine' ? '扫码登录后读取你的歌单' : '暂时没有歌单' }}</h3><p>{{ musicTab === 'search' ? searchedQuery ? '换个关键词试试，或切换搜索结果类型' : '输入歌名、歌手或歌单名称开始搜索' : local ? '可以登录账号或切换到发现歌单' : '主人开放歌单后，会显示在这里' }}</p><button v-if="local && musicTab === 'playlists' && playlistType === 'mine' && !state.auth?.loggedIn" class="secondary" @click="login">{{ serverOwner ? '登录账号' : '扫码登录' }}</button></template>
            </MusicSearchResults>
          </div>

          <template v-if="page === 'sharing' && local">
            <div class="page-heading"><div><span class="eyebrow">LISTEN TOGETHER</span><h1>让朋友加入你的播放台</h1><p>发送网页链接，朋友打开就能操作你允许的功能。</p></div></div>
            <div v-if="state.capabilities?.automaticSharing" class="auto-sharing panel"><label><input type="checkbox" :checked="state.autoSharing?.enabled" @change="action('设置自动共享', () => request('sharing.auto', { enabled: $event.target.checked }))" :disabled="isBusy"><strong>连接机器人后自动开启公网、创建链接并发送</strong></label><p>进入 TS 后，公网链接一就绪就主动向频道发送一次，无需等人进入。机器人已在线时开启此开关也会立即执行。初次失败会在 2 秒后自动重试一次。自动链接默认全选权限，可在下方修改。</p><div class="auto-sharing-result" role="status"><span>{{ state.autoSharing?.status === 'retrying' ? '首次失败，2 秒后自动重试一次…' : state.autoSharing?.status === 'starting' ? (state.autoSharing.attempt === 2 ? '正在进行最后一次自动重试…' : '正在准备并发送首次链接…') : state.autoSharing?.status === 'ready' ? (serverOwner && state.runtime?.audioBackend === 'official' ? '首次链接已提交给官方客户端' : '首次链接已发送，服务器已确认') : state.autoSharing?.status === 'error' ? state.autoSharing.error : state.autoSharing?.enabled ? '连接后立即准备并发送首次链接' : '自动共享已关闭，可手动设置' }}</span><button v-if="state.autoSharing?.status === 'error' && state.autoSharing.enabled" class="secondary" @click="action('重试自动共享', () => request('sharing.autoRetry'))" :disabled="isBusy || !running">重试自动共享</button></div></div>
            <div class="sharing-status panel"><div class="share-icon">↗</div><div><h3>{{ state.tunnel?.status === 'online' ? '公网控制已开启' : state.tunnel?.status === 'connecting' ? '正在建立公网连接' : '开启公网控制' }}</h3><p>{{ state.tunnel?.error || (serverOwner && state.tunnel?.kind === 'fixed' ? '通过服务器固定 HTTPS 地址访问，不使用临时通道。' : '无需路由器端口映射。通过 Cloudflare 临时通道访问。') }}</p></div><button v-if="state.tunnel?.status !== 'online'" class="primary" @click="action('开启公网', () => request('sharing.enable'))" :disabled="!running || isBusy">{{ busy === '开启公网' ? '连接中…' : '开启公网控制' }}</button><button v-else class="secondary" @click="action('关闭公网', () => request('sharing.disable'))" :disabled="isBusy">关闭公网入口</button></div>
            <div v-if="serverOwner && state.runtime?.persistentShares" class="info-note">固定链接加密保存在服务器，机器人重启后仍可使用。停止机器人或关闭共享时暂不可用；重新开启后用原链接进入。撤销授权会永久使该链接失效，已打开的网页在服务重启后需刷新。</div>
            <div v-else class="info-note">链接在本次机器人运行期间一直有效。停止机器人、退出工具或撤销授权后，旧链接和已打开的网页都会失效。暂停音乐不会结束授权。</div>
            <div v-if="state.capabilities?.linkAnnouncements" class="info-note">新建链接和公网地址更新后，会自动向机器人所在频道发送一次。新建链接默认开启入频道分发；有人加入时，只发送最新创建或你选中的一条。</div>
            <div class="panel grant-form"><div class="section-title compact"><h2>创建一个控制链接</h2><span class="badge">免注册</span></div><label class="field-label">授权名称<input v-model="grantName" placeholder="例如：周末开黑的朋友" maxlength="40"></label><div class="permission-grid"><label v-for="(label, permission) in names" :key="permission"><input type="checkbox" :value="permission" v-model="grantPermissions" :disabled="permission === 'view'"><span>{{ label }}</span></label></div><div class="form-footer"><small>拿到链接的人即可操作，请发给信任的朋友。</small><button class="primary" @click="createGrant" :disabled="!running || isBusy">+ 创建授权链接</button></div></div>
            <div class="section-title"><div><h2>已授权的链接 <span class="count">{{ state.grants.length }}</span></h2><p>权限修改即时生效，可以独立撤销每一个链接</p></div></div>
            <div v-if="!state.grants.length" class="empty-state short"><p>还没有分享授权</p></div>
            <article class="grant-card panel" v-for="grant in state.grants" :key="grant.id">
              <div class="grant-heading"><div><h3>{{ grant.name }}</h3><small>{{ serverOwner && state.runtime?.persistentShares ? '重启后沿用，直到主人撤销' : '有效至机器人关闭或本机撤销' }}</small></div><button class="danger-button" @click="action('撤销授权', () => request('sharing.revoke', { id: grant.id }))" :disabled="isBusy">撤销</button></div>
              <div class="link-row"><input :value="grant.url || '开启公网后生成可分享的网页地址'" readonly aria-label="分享链接"><button class="secondary" @click="copy(grant.url)" :disabled="!grant.url">复制链接</button><button class="secondary" @click="showShareQr(grant.url)" :disabled="!grant.url">二维码</button></div>
              <div class="permission-grid"><label v-for="(label, permission) in names" :key="permission"><input type="checkbox" :checked="grant.permissions.includes(permission)" :disabled="permission === 'view' || isBusy" @change="changePermission(grant, permission, $event.target.checked)"><span>{{ label }}</span></label></div>
              <div v-if="state.capabilities?.channelAnnouncements" class="grant-announcement">
                <p v-if="state.capabilities?.linkAnnouncements" class="link-delivery-status" :class="{ 'announcement-error': grant.delivery?.status === 'error' }" role="status">{{ grant.delivery?.status === 'sent' ? '当前链接已发送到频道' : grant.delivery?.status === 'error' ? grant.delivery.error : grant.delivery?.status === 'pending' ? '正在发送当前链接…' : '公网链接可用后自动发送' }}<button v-if="grant.delivery?.status === 'error'" class="text-button" @click="action('重试发送链接', () => request('sharing.send', { grantId: grant.id }))" :disabled="isBusy || !running || !grant.url">重试发送</button></p>
                <label><input type="checkbox" :checked="state.shareAnnouncement?.grantId === grant.id" :disabled="isBusy || !running || (!grant.url && state.shareAnnouncement?.grantId !== grant.id)" @change="configureAnnouncement(grant, $event.target.checked)"><span>有人入频道时自动发送此链接</span></label>
                <p>发送到机器人所在频道，按此链接的权限开放；{{ state.shareAnnouncement?.cooldownSeconds ?? 3 }} 秒内多次进入合并发送。入频道分发每次只选择一条链接。</p>
                <p v-if="state.shareAnnouncement?.grantId === grant.id" class="announcement-status" role="status">{{ state.tunnel?.status !== 'online' ? '等待公网入口恢复，暂不发送' : state.shareAnnouncement.lastSentAt ? '已开启，最近发送于 ' + new Date(state.shareAnnouncement.lastSentAt).toLocaleTimeString() : '已开启，等待成员进入频道' }}</p>
                <p v-if="state.shareAnnouncement?.grantId === grant.id && state.shareAnnouncement.error && grant.delivery?.status !== 'error'" class="announcement-error" role="status">{{ state.shareAnnouncement.error }}</p>
              </div>
              <div class="grant-local"><button class="text-button" @click="previewGrant(grant)">{{ serverOwner ? '预览朋友页面 ↗' : '在本机预览朋友页面 ↗' }}</button></div>
            </article>
            <div class="panel published"><h3>开放给朋友的歌单</h3><p>自建歌单统一开放、可共同编辑。网易云账号歌单需手动选择开放，不会自动展示。</p><div class="published-row" v-for="item in state.publications" :key="item.id"><span>{{ item.name }}</span><span v-if="item.source === 'local'" class="community-hint">自建歌单 · 共同编辑</span><button v-else class="danger-button danger-button--small" @click="action('取消开放', () => request('playlist.unpublish', { id: item.id }))">取消开放</button></div></div>
          </template>

          <template v-if="page === 'settings' && local">
            <div class="page-heading"><div><span class="eyebrow">{{ serverOwner ? 'SERVER & PRIVATE' : 'LOCAL & PRIVATE' }}</span><h1>设置与运行状态</h1><p>{{ serverOwner ? '账号和服务器密码加密保存在机器人服务器。' : '账号和服务器密码加密保存在本机。' }}</p></div></div>
            <AudioHealthPanel :health="state.audioHealth || {}" />
            <div class="panel settings-panel"><h2>音乐账号</h2><div class="settings-row"><div><strong>网易云音乐</strong><p>{{ state.auth?.loggedIn ? '已登录：' + state.auth.nickname : '未登录。免费歌曲可尝试播放，部分功能需要登录。' }}</p></div><button class="secondary" @click="login" :disabled="isBusy">{{ serverOwner ? '登录账号' : (state.auth?.loggedIn ? '重新扫码' : '扫码登录') }}</button><button v-if="state.auth?.loggedIn" class="danger-button" @click="action('退出账号', () => request('auth.logout'))" :disabled="isBusy">退出账号</button></div><div class="settings-row"><div><strong>音乐源音质</strong><p>实际可用音质和试听范围取决于账号与歌曲授权。</p></div><select :value="state.quality" @change="action('保存音质', () => request('settings.quality', { value: $event.target.value }))"><option value="standard">标准 · 128k</option><option value="higher">较高 · 192k</option><option value="exhigh">极高 · 320k</option><option value="lossless">无损 FLAC</option><option value="hires">Hi-Res</option><option value="jymaster">超清母带</option></select></div></div>
            <div v-if="serverOwner" class="panel settings-panel"><h2>服务器运行</h2><div class="settings-row"><div><strong>关闭网页后继续播放</strong><p>退出主人登录不会停止机器人。需要停止时，请在控制台点击“停止机器人”。</p></div><span class="badge green">后台运行</span></div><div class="settings-row"><div><strong>运行数据</strong><p>{{ state.runtime?.dataDirectory || '保存在机器人服务器' }}；歌单、预设和账号信息由服务器统一保存。</p></div></div><div class="settings-row"><div><strong>退出主人登录</strong><p>结束当前浏览器的管理会话，朋友的控制授权保持有效。</p></div><button class="secondary" @click="desktop.quit()">退出登录</button></div></div>
            <div v-else class="panel settings-panel"><h2>本地运行</h2><div class="settings-row"><div><strong>关闭窗口后继续运行</strong><p>在系统托盘里重新打开；点击“停止机器人”会结束所有分享授权。</p></div><span class="badge green">已启用</span></div><div class="settings-row"><div><strong>运行数据</strong><p>预设、加密凭据和播放历史保存在这台电脑，点击可查看位置。</p></div><button class="secondary" @click="desktop.openData()">打开数据目录</button></div><div class="settings-row"><div><strong>停止机器人并退出</strong><p>关闭机器人连接、公网入口和全部分享授权。</p></div><button class="danger-outline" @click="desktop.quit()">退出工具</button></div></div>
            <div class="panel settings-panel"><h2>组件状态</h2><div class="component-grid"><div><strong>TSMusicBot</strong><small>v1.13.2 · TS3 协议内核</small><span>已加载</span></div><div><strong>FFmpeg + Opus</strong><small>音频转码与语音发送</small><span>本机运行</span></div><div><strong>Cloudflare Tunnel</strong><small>临时公网入口</small><span>{{ state.tunnel?.status === 'online' ? '已连接' : '未开启' }}</span></div></div><div class="diagnostic" v-if="state.diagnostics?.length"><h3>最近运行提示</h3><p v-for="(entry, i) in state.diagnostics.slice(-6)" :key="i"><time>{{ new Date(entry.time).toLocaleTimeString() }}</time>{{ entry.message }}</p></div></div>
          </template>
        </section>

        <ResizableQueuePanel ref="queuePanel" :desktop="local" :expanded="page === 'queue'" :current-entry-id="song?.entryId" :current-index="queueCurrentIndex">
          <div class="queue-heading"><h2>播放队列 <span>{{ player.queue?.length || 0 }}</span></h2><div class="queue-heading-actions"><button v-if="page==='queue'" type="button" class="queue-locate" @click="queuePanel?.locateCurrent()" :disabled="!song?.entryId || queueCurrentIndex<0" title="定位到当前正在播放的歌曲">定位当前播放</button><button v-if="canSavePlaylist" title="保存当前队列为开放歌单" @click="openSavePlaylist" :disabled="isBusy || !player.queue?.length">保存</button><button class="danger-button danger-button--small" title="清空队列并停止音乐" @click="control('queue.clear')" :disabled="!running || isBusy || !player.queue?.length || !can('queue')" v-if="can('queue')">清空</button></div></div>
          <div class="queue-body">
          <div class="now-card"><span class="eyebrow">NOW PLAYING</span><div class="cover-art"><img v-if="song?.coverUrl" :src="artworkUrl(song.coverUrl)" alt="正在播放的封面"><span v-else>♫</span><div v-if="player.playing" class="equalizer"><i></i><i></i><i></i><i></i></div></div><h3 :title="song?.name">{{ song?.name || '频道准备好了，音乐呢？' }}</h3><p class="now-artists" :title="song?.artist"><template v-if="currentSongArtists.length"><template v-for="(artist,index) in currentSongArtists" :key="artist.id || artist.name"><span v-if="index" aria-hidden="true"> / </span><button v-if="can('search')" type="button" class="artist-link" :disabled="isBusy || !state.ready" :aria-label="currentArtistLabel(artist)" :title="currentArtistLabel(artist)" @click="openArtist(artist)">{{ artist.name }}</button><span v-else>{{ artist.name }}</span></template></template><template v-else>从音乐库添加第一首歌曲</template></p><span class="trial" v-if="song && player.effectiveDuration && player.effectiveDuration < song.duration">当前为试听片段</span><LyricsPanel v-if="page==='queue' && state.capabilities?.lyrics" :song="song" :elapsed="player.elapsed || 0" :duration="duration" :playing="!!player.playing" :load-lyrics="id => request('music.lyrics', { id })"/></div>
          <div class="queue-list-pane">
          <p class="queue-order-hint" v-if="can('reorder') && player.queue?.length">{{ ['random', 'rloop'].includes(player.playMode) ? '可调整列表位置；随机模式仍随机选歌' : '拖动歌曲调整待播放顺序' }}</p>
          <div class="queue-items" v-if="player.queue?.length">
            <div v-for="(item, i) in player.queue" :key="item.entryId" class="queue-item" :data-sort-id="item.entryId"
              :aria-current="item.entryId===song?.entryId ? 'true' : undefined" :class="{ current: item.entryId === song?.entryId, sortable: canReorder(i), dragging: queueDrag?.entryId === item.entryId, 'drop-target': queueDropTarget === item.entryId, 'drop-after': queueDropTarget === item.entryId && queueDragIndex < i }"
              :tabindex="canReorder(i) ? 0 : -1" :aria-label="item.name + (canReorder(i) ? '，拖动排序，也可按 Alt 加方向键移动' : '')" @keydown.alt.up.prevent="shiftQueue(item,i,-1)" @keydown.alt.down.prevent="shiftQueue(item,i,1)" :draggable="canReorder(i)" @dragstart="startQueueDrag($event, item, i)" @dragover="overQueueDrag($event, item, i)"
              @dragleave="leaveQueueDrag($event, item)" @drop="dropQueueDrag($event, item, i)" @dragend="clearQueueDrag">
              <span class="queue-index"><span v-if="canReorder(i)" class="sort-grip" title="拖动排序" @pointerdown="queueTouch.start($event,item.entryId)" aria-hidden="true">⠿</span>{{ item.entryId === song?.entryId ? '♫' : i + 1 }}</span>
              <div class="queue-thumb"><img v-if="item.coverUrl && !failedQueueCovers.has(item.coverUrl)" :src="artworkUrl(item.coverUrl)" loading="lazy" decoding="async" draggable="false" alt="" @error="failedQueueCovers.add(item.coverUrl)"><span v-else aria-hidden="true">♫</span></div>
              <div class="queue-song"><strong :title="item.name">{{ item.name }}</strong><small>{{ item.requestedBy ? item.requestedBy + ' 点播 · ' : '' }}{{ item.artist }}</small></div>
              <span class="queue-actions">
                <button v-if="can('playNow')" class="queue-play" @click="playQueueItem(item)" :disabled="!running || isBusy || (item.entryId === song?.entryId && player.playing)" :title="item.entryId === song?.entryId && player.playing ? '正在播放' : item.entryId === song?.entryId && player.paused ? '继续播放' : '播放这首歌'" :aria-label="'播放队列歌曲 ' + item.name"><svg class="transport-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5v14l12-7z"/></svg></button>
                <button class="danger-button danger-icon" v-if="can('queue') && item.entryId !== song?.entryId" @click="control('queue.remove', { entryId: item.entryId })" :disabled="!running || isBusy" title="移除歌曲" :aria-label="'移除 ' + item.name">×</button>
              </span>
            </div>
          </div>
          <div v-else class="queue-empty"><span>≡</span><p>队列是空的<br><small>下一首由你决定</small></p></div>
          </div>
          </div>
        </ResizableQueuePanel>
      </div>
    </main>

    <footer class="player-bar"><div class="player-song"><div class="small-cover"><img v-if="song?.coverUrl" :src="artworkUrl(song.coverUrl)" alt=""><span v-else>♫</span></div><div><strong>{{ song?.name || '等待播放' }}</strong><small class="player-artists"><template v-if="currentSongArtists.length"><template v-for="(artist,index) in currentSongArtists" :key="artist.id || artist.name"><span v-if="index" aria-hidden="true"> / </span><button v-if="can('search')" type="button" class="artist-link" :disabled="isBusy || !state.ready" :aria-label="currentArtistLabel(artist)" :title="currentArtistLabel(artist)" @click="openArtist(artist)">{{ artist.name }}</button><span v-else>{{ artist.name }}</span></template></template><template v-else>TS Music Desk</template></small></div></div><div class="player-center"><div class="transport"><button @click="control('player.prev')" :disabled="!running || isBusy || !can('skip')" title="上一首">◀❙</button><button class="play-button" @click="control(player.paused ? 'player.resume' : player.playing ? 'player.pause' : 'player.resume')" :disabled="!running || isBusy || !can('transport')" :title="player.playing ? '暂停' : '播放'" :aria-label="player.playing ? '暂停' : '播放'"><svg class="transport-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><template v-if="player.playing"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></template><path v-else d="M8 5v14l12-7z"/></svg></button><button @click="control('player.next')" :disabled="!running || isBusy || !can('skip')" title="下一首">❙▶</button><PlayModeControl :mode="player.playMode || 'loop'" :disabled="!running || isBusy || !can('mode')" @select="control('player.mode', { value: $event })"/></div><div class="progress"><span>{{ formatTime(player.elapsed) }}</span><input type="range" :min="0" :max="duration || 1" :value="player.elapsed || 0" @change="control('player.seek', { value: Number($event.target.value) })" :disabled="!song || isBusy || !can('seek')" aria-label="播放进度"><span>{{ formatTime(duration) }}</span></div></div><VolumeControl :volume="player.volume ?? 50" :disabled="!running || isBusy || !can('volume')" :set-volume="value => control('player.volume', { value })"/></footer>
  </div>

  <div v-if="modal" class="modal-backdrop" @click.self="dismissBackdrop"><div class="modal" :class="{ wide: modal === 'preset', 'server-login-modal': modal === 'login' && serverOwner, 'official-browser-modal': modal === 'login' && serverOwner && authMethod === 'browser' }"><button class="modal-close" type="button" @click="closeModal">×</button>
    <AdminActionsPanel v-if="serverOwner && modal === 'adminActions'" :logged-in="!!(state.auth?.loggedIn || state.auth?.hasSession)" :running="running" :can-restart="!!(state.activePreset || selected || state.defaultPreset) && !connecting" :busy="isBusy" :run="runAdminAction" @done="closeModal" />
    <PlaylistPicker v-if="modal === 'playlistPicker' && pickerSong" :song="pickerSong" :current-draft="currentDraft" :request="request" :run-id="state.runId" :disabled="!canSavePlaylist" :supports-targets="!!state.capabilities?.playlistPicker" :supports-descriptions="!!state.capabilities?.playlistDescriptions" @draft="addToCurrentDraft" @saved="playlistPickerSaved" @close="closeModal"/>
    <template v-if="modal === 'preset'">
      <span class="eyebrow">SERVER PRESET</span><h2>{{ editing ? '编辑服务器预设' : '添加服务器预设' }}</h2><p>保存后，下次只需选择预设就能连接。</p>
      <form ref="presetForm" @submit.prevent>
        <div class="form-grid">
          <label class="field-label full">预设名称<input v-model="form.name" required placeholder="例如：朋友的开黑频道" maxlength="80"></label>
          <label class="field-label">服务器地址<input v-model="form.serverAddress" required placeholder="域名或 IP，可带 :9987"></label>
          <label class="field-label">语音端口<input v-model.number="form.serverPort" type="number" min="1" max="65535" required></label>
          <label class="field-label">机器人昵称<input v-model="form.nickname" maxlength="30" placeholder="Music Desk"></label>
          <label class="field-label">服务器密码<input v-model="form.serverPassword" type="password" autocomplete="new-password" :placeholder="editing?.hasServerPassword ? '留空保持原密码' : '没有密码可留空'"></label>
          <label class="field-label">目标频道名称<input v-model="form.defaultChannel" placeholder="可留空，进入默认频道"></label>
          <label class="field-label">目标频道 ID<input v-model="form.channelId" inputmode="numeric" placeholder="选填，优先于频道名称"></label>
          <label class="field-label full">频道密码<input v-model="form.channelPassword" type="password" autocomplete="new-password" :placeholder="editing?.hasChannelPassword ? '留空保持原密码' : '没有密码可留空'"></label>
        </div>
        <p class="form-hint">频道重名时请填写 ID。密码仅保存在本机，以 Windows 凭据保护的密钥加密。</p>
        <div class="form-footer">
          <div class="inline-actions" v-if="editing"><button type="button" class="text-button" @click="action('默认预设', () => request('presets.default', { id: editing.id }))" :disabled="isBusy">设为默认</button><button type="button" class="danger-button" @click="removePreset(editing); modal = ''" :disabled="isBusy || (running && state.activePreset === editing.id)">删除</button></div>
          <button type="button" class="primary" @click="savePreset" :disabled="isBusy || (running && state.activePreset === editing?.id)">保存预设</button>
        </div>
      </form>
    </template>
    <template v-if="modal === 'addPlaylist'">
      <span class="eyebrow">BUILD YOUR LIBRARY</span><h2>添加歌单</h2><p>创建自己的收藏，或查找网易云用户的公开歌单。</p>
      <div class="playlist-creation-choices"><button v-if="canSavePlaylist" @click="choosePlaylistCreation('draft')"><span aria-hidden="true">☷</span><strong>自建歌单</strong><small>加入歌曲、拖动排序，保存后开放给朋友</small></button><button v-if="can('search')" @click="choosePlaylistCreation('find')"><span aria-hidden="true">⌕</span><strong>用户歌单</strong><small>通过网易云昵称或 UID 查找公开歌单</small></button></div>
    </template>
    <template v-if="modal === 'permissions'"><span class="eyebrow">YOUR CONTROLS</span><h2>已授权的功能</h2><p>此链接当前允许你使用以下 {{ authorizedFeatures.length }} 项功能，主人修改后会即时更新。</p><ul class="permission-feature-list"><li v-for="feature in authorizedFeatures" :key="feature"><span aria-hidden="true">✓</span>{{ feature }}</li></ul></template>
    <template v-if="modal === 'identity'">
      <span class="eyebrow">YOUR REQUEST NAME</span><h2>设置你的点播 ID</h2>
      <section v-if="state.capabilities?.visitorHistory" class="guest-history" aria-label="选择曾用昵称">
        <h3>选择曾用昵称</h3><p class="guest-history-hint">换了分享链接？点一下自己的昵称即可使用。</p>
        <p v-if="guestHistoryLoading" role="status">正在读取曾用昵称…</p>
        <p v-else-if="guestHistoryError" role="status">{{ guestHistoryError }}</p>
        <template v-else-if="guestHistory.length">
          <input v-if="guestHistory.length > 8" v-model="guestHistoryFilter" type="search" aria-label="筛选曾用昵称" placeholder="查找你的昵称" maxlength="64">
          <div class="guest-history-list"><div v-for="name in shownGuestHistory" :key="name" class="guest-history-item"><button class="guest-history-use" type="button" :aria-label="'使用曾用昵称 ' + name" :title="name" @click="saveGuestIdentity(name)" :disabled="isBusy">{{ name }}</button><button v-if="state.capabilities?.visitorHistoryRemoval" class="guest-history-delete danger-button danger-icon" type="button" :aria-label="'删除曾用昵称 ' + name" title="删除这条曾用记录，不修改当前署名" @click.stop="removeGuestHistory(name)" :disabled="isBusy">×</button></div></div>
          <p v-if="state.capabilities?.visitorHistoryRemoval" class="guest-history-hint">点击昵称使用，点击右侧 × 从曾用名单删除。删除不会修改当前署名或已有歌单。</p>
          <p v-if="!shownGuestHistory.length" role="status">没有匹配的昵称，可以在下方输入新昵称。</p>
        </template>
        <p v-else>暂无曾用昵称，填写一次后会保存在机器人本机。</p>
      </section>
      <form class="identity-form" @submit.prevent><label class="field-label">点播 ID<input v-model="guestDraft" maxlength="64" aria-label="点播 ID" aria-describedby="request-name-hint" placeholder="例如：小明" autocomplete="nickname"></label><p id="request-name-hint" class="field-hint">点歌后显示为“你的 ID 点播”，无需填写网易云账号或手机号。</p><p v-if="state.capabilities?.visitorHistory">同一网址会自动记住；换链接后可点选曾用昵称。昵称保存在机器人本机，已获授权的人可见，仅用于点播署名。</p><p v-else>当前浏览器会记住昵称；更换临时分享域名后需要重填。</p><div class="modal-actions"><button class="primary" type="button" @click="saveGuestIdentity" :disabled="isBusy || !guestDraft.trim()">记住并使用此 ID</button></div></form>
    </template>
    <template v-if="modal === 'savePlaylist'"><span class="eyebrow">SAVE YOUR QUEUE</span><h2>保存播放队列</h2><form class="save-playlist-form" @submit.prevent><label class="field-label">歌单名称<input v-model="savePlaylistName" maxlength="80" required aria-label="歌单名称"></label><label v-if="state.capabilities?.playlistDescriptions" class="field-label playlist-description-field"><span>歌单简介 <small>选填 · {{ savePlaylistDescription.length }} / 500</small></span><textarea v-model="savePlaylistDescription" rows="3" maxlength="500" aria-label="歌单简介" placeholder="为这份歌单写一段简介"></textarea></label><label v-if="local && state.localPlaylists?.length" class="field-label">保存方式<select v-model="savePlaylistTarget" @change="chooseSaveTarget" aria-label="保存方式"><option value="new">另存为新歌单</option><option v-for="item in state.localPlaylists" :key="item.id" :value="item.id">更新：{{ item.name }}</option></select></label><p>在{{ local ? '本机' : '机器人主人的电脑上' }}保存当前队列的 {{ player.queue?.length || 0 }} 首歌曲与顺序，统一加入开放歌单，不会写入网易云账号。退出或下次分享后仍会保留；以后加歌需要再次保存{{ local ? '或更新' : '为新歌单' }}。</p><p v-if="!local">所有自建歌单统一开放，获得保存歌单授权的朋友都可编辑和删除，重启或换链接后也可继续修改。</p><p v-if="!state.capabilities?.savedPlaylists" class="save-upgrade-hint">当前服务需要重开才能保存。请先导出这批队列，再通过“退出工具”重开，随后点击“导入歌单”。</p><div class="modal-actions"><button v-if="local" class="secondary" type="button" @click="exportQueueFile" :disabled="isBusy">导出当前队列</button><button class="primary" type="button" @click="saveQueuePlaylist" :disabled="isBusy || !canSavePlaylist || !state.capabilities?.savedPlaylists || !savePlaylistName.trim()">{{ savePlaylistTarget === 'new' ? '保存并开放' : '更新并开放' }}</button></div></form></template>
    <template v-if="modal === 'deletePlaylist'"><h2>删除歌单？</h2><p>{{ deletingPlaylist?.source === 'local' ? '删除“' + deletingPlaylist?.name + '”的本机存档，并取消开放。' : '从开放列表移除“' + deletingPlaylist?.name + '”，网易云原歌单保留。' }}当前播放队列不会改变。</p><div class="modal-actions"><button class="secondary" @click="closeModal">取消</button><button class="danger-button" @click="deletePlaylist" :disabled="isBusy">删除歌单</button></div></template>
    <template v-if="modal === 'login'">
      <span class="eyebrow">NETEASE CLOUD MUSIC</span><h2>{{ serverOwner ? '连接网易云音乐' : '扫码连接网易云音乐' }}</h2>
      <div v-if="serverOwner" class="music-login-tabs" role="tablist" aria-label="网易云登录方式">
        <button role="tab" :class="{ selected: authMethod === 'browser' }" :aria-selected="authMethod === 'browser'" @click="switchAuthMethod('browser')" :disabled="isBusy">官网登录</button>
        <button role="tab" :class="{ selected: authMethod === 'cookie' }" :aria-selected="authMethod === 'cookie'" @click="switchAuthMethod('cookie')" :disabled="isBusy">导入会话</button>
        <button role="tab" :class="{ selected: authMethod === 'qr' }" :aria-selected="authMethod === 'qr'" @click="switchAuthMethod('qr')" :disabled="isBusy">扫码登录</button>
      </div>
      <OfficialBrowserLogin v-if="serverOwner && authMethod === 'browser'" :request="request" :available="!!state.runtime?.officialBrowserLogin" @logged-in="officialLoginDone"/>
      <NeteaseCookieImport v-else-if="serverOwner && authMethod === 'cookie'" :busy="isBusy" @submit="importLoginCookie"/>
      <template v-else><p>登录仅在{{ serverOwner ? '这台服务器' : '这台电脑' }}上使用。朋友无法查看你的账号凭据。</p><div class="qr-area"><img v-if="qr" :src="qr" alt="网易云登录二维码"><span v-else class="spinner"></span></div><p class="qr-status">{{ qrStatus }}</p><button class="secondary" @click="getQr" :disabled="isBusy">刷新二维码</button></template>
    </template>
      <template v-if="modal === 'shareQr'"><h2>扫码打开控制台</h2><p>持有此链接的人可以使用已授权的功能。</p><div class="qr-area"><img :src="shareQr" alt="分享二维码"></div><button class="primary" @click="copy(shareQrLink)">复制分享链接</button></template>
    <template v-if="modal === 'channels'"><h2>服务器可见频道</h2><p>将频道 ID 填入预设，停止机器人后保存并重新连接。</p><div class="channel-row" v-for="channel in channels" :key="channel.id"><span>#{{ channel.id }}</span><strong>{{ channel.name }}</strong><button class="text-button" @click="copy(channel.id)">复制 ID</button></div></template>
    <div class="error modal-error" v-if="error">{{ error }}</div>
  </div></div>
</template>

