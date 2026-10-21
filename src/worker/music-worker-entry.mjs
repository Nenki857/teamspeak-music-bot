import { LyricsCache } from './lyrics-cache.mjs';
import { artistAlbums, albumPage } from './album-catalog.mjs';
import { createMusicRequestGate } from './music-request-gate.mjs';
import { createMusicAudit } from './music-audit.mjs';
import { isServerMusic } from './server-music-session.mjs';
import { dataDir } from './paths.mjs';
import { publicMusic } from './public-music.mjs';
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { coreRoot, requireCore, root } from './paths.mjs';
import { CATALOG_METHODS } from './catalog-client.mjs';
import { musicRequestError } from './music-request-error.mjs';
import { createNeteaseApiSession } from './netease-api-session.mjs';
import { neteaseWebRequest } from './netease-web-requests.mjs';
import { MAINTAINED_NETEASE_MODULE, neteaseMaintainedRequest, validateNeteaseSourceIP } from './netease-library.mjs';
import { createNeteaseBrowserApi } from './netease-browser-api.mjs';

const METHODS = new Set(['search', 'getSongUrl', 'getSongDetail', 'getPlaylistSongs', 'getRecommendPlaylists', 'getAlbumSongs',
  'getLyrics', 'getQrCode', 'checkQrCodeStatus', 'getAuthStatus', 'getPersonalFm', 'getDailyRecommendSongs', 'getUserPlaylists', 'getPlaylistDetail', 'getArtistPage', 'getArtistAlbums', 'getAlbumPage', 'searchUsers', 'getPublicUserPlaylists', 'getPublicPlaylist', 'getPublicSongs']);
const CATALOG = new Set(CATALOG_METHODS);
let cookie = ''; let quality = 'exhigh'; let generation = 0; let catalogPort; let NeteaseProvider; let mapSongs; let ncm;
const maintainedLibrary = process.env.TSMD_NETEASE_MAINTAINED_API === '1';
const browserClient = process.platform === 'linux' && process.env.TSMD_NETEASE_WEB_CLIENT === '1' && !workerData?.apiModule;
const sourceIP = maintainedLibrary && !browserClient && process.platform === 'linux' ? validateNeteaseSourceIP(process.env.TSMD_NETEASE_SOURCE_IP) : '';
const serverMusic = isServerMusic();
const audit = serverMusic ? createMusicAudit(resolve(dataDir, 'logs/netease-requests.jsonl')) : () => {};
const requestGate = serverMusic ? createMusicRequestGate({ log: entry => audit({ ...entry, transport: browserClient ? 'web-session' : 'legacy-api' }) }) : null;
try {
  ({ NeteaseProvider, mapNeteaseSongs: mapSongs } = await import(pathToFileURL(resolve(coreRoot, 'dist/music/netease.js')).href));
  ncm = workerData?.apiModule ? (await import(workerData.apiModule)).default : browserClient ? createNeteaseBrowserApi({ requestGate, requireLibrary: createRequire(requireCore.resolve('NeteaseCloudMusicApi')) }) : requireCore(maintainedLibrary ? resolve(root, MAINTAINED_NETEASE_MODULE) : 'NeteaseCloudMusicApi');
} catch { parentPort.postMessage({ type: 'fatal' }); throw new Error('Music library initialization failed'); }
const musicApi = createNeteaseApiSession(ncm, { enabled: process.env.TSMD_NETEASE_SESSION_FIX === '1' && !browserClient });


function providerForRequest(publicOnly = false) {
  const provider = new NeteaseProvider('http://127.0.0.1'); provider.setCookie(publicOnly ? '' : cookie); provider.setQuality(quality);
  provider.api = { get: async (route, options = {}) => {
    const method = route.slice(1).replaceAll('/', '_'); if (typeof ncm[method] !== 'function') throw new Error('音乐接口不可用');
    const params = neteaseWebRequest(method, neteaseMaintainedRequest(method, { ...options.params, timeout: 15000 }, maintainedLibrary, sourceIP), process.env.TSMD_NETEASE_WEB_REQUESTS === '1');
    // The app supports 500 tracks; limit before fetching/mapping instead of slicing 1000 afterwards.
    if (route === '/playlist/track/all') params.limit = 500;
    const invoke = async () => {
      const response = await musicApi.call(method, params);
      const code = Number(response.body?.code);
      if (response.status >= 400 || [301,401,403,429,-460,-462].includes(code)) throw { status: response.status >= 400 ? response.status : 400, body: { code: Number.isFinite(code) ? code : response.status } };
      return response;
    };
    let timer;
    try {
      const response = await Promise.race([(requestGate && !browserClient ? requestGate.run(method, invoke) : invoke()), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('音乐服务响应超时')), 20000); })]);
      if (response.status >= 400 || response.body?.code === 301) throw Object.assign(new Error('音乐服务请求失败'), { status: response.body?.code || response.status });
      return { data: response.body };
    } finally { clearTimeout(timer); }
  } };
  return provider;
}

const lyricsCache = new LyricsCache({directory:workerData?.apiModule?null:resolve(dataDir,'cache/lyrics'),load:id=>providerForRequest().getLyrics(id)});

async function artistPage(provider, id, order = 'hot', offset = 0) {
  if (serverMusic) throw new Error('歌手歌曲专用接口已停用，请直接搜索歌手名字');
  if (!/^\d{1,20}$/.test(String(id)) || !['hot', 'time'].includes(order)) throw new Error('Invalid artist request');
  const params = { id: String(id), ...(provider.getCookie() ? { cookie: provider.getCookie() } : {}) };
  const limit = Math.min(30, 500 - offset);
  let detail, list;
  [detail, list] = await Promise.all([provider.api.get('/artist/detail', { params }).catch(() => null), provider.api.get('/artist/songs', { params: { ...params, order, limit, offset } })]);
  const raw = detail?.data?.data?.artist || detail?.data?.artist || {};
  const songs = mapSongs(list.data?.songs).slice(0, limit);
  return { artist: { id: String(id), name: String(raw.name || '').slice(0, 160), coverUrl: raw.cover || raw.picUrl || '', description: String(raw.briefDesc || '').slice(0, 1200), songCount: Number(raw.musicSize) || Number(list.data?.total) || null },
    songs, order, more: (list.data?.more === undefined ? songs.length === limit : !!list.data.more) && offset + songs.length < 500 };
}

async function perform(message, replyTo, catalogOnly = false) {
  if (!(catalogOnly ? CATALOG : METHODS).has(message.method)) { replyTo.postMessage({ id: message.id, ok: false, generation, error: '音乐操作不可用' }); return; }
  if (serverMusic && message.method === 'getArtistPage') { replyTo.postMessage({ id: message.id, ok: false, generation, error: '歌手歌曲专用接口已停用，请直接搜索歌手名字' }); return; }
  const startedGeneration = generation;
  const isPublic = ['searchUsers', 'getPublicUserPlaylists', 'getPublicPlaylist', 'getPublicSongs'].includes(message.method);
  try {
    const provider = providerForRequest(isPublic); let result = message.method === 'getLyrics' ? await lyricsCache.get(message.args[0]) : isPublic ? await publicMusic(message.method, provider, mapSongs, ...message.args) : message.method === 'getArtistAlbums' ? await artistAlbums(provider, ...message.args) : message.method === 'getAlbumPage' ? await albumPage(provider, message.args[0], mapSongs) : message.method === 'getArtistPage' ? await artistPage(provider, ...message.args) : await provider[message.method](...(message.method === 'getAuthStatus' && serverMusic ? [{ propagateErrors: true }] : message.args));
    if (message.method === 'getPlaylistSongs') result = result.slice(0, 500);
    if (startedGeneration !== generation) { replyTo.postMessage({ id: message.id, ok: false, generation, error: '账号状态已变化，请重试' }); return; }
    const reply = { id: message.id, ok: true, result, generation };
    if (message.method === 'checkQrCodeStatus' && result === 'confirmed') reply.cookie = provider.getCookie();
    replyTo.postMessage(reply);
  } catch (error) {
    const failure = musicRequestError(error, { publicOnly: isPublic });
    replyTo.postMessage({ id: message.id, ok: false, generation, error: failure.message, status: isPublic ? undefined : failure.status, neteaseCode: isPublic ? undefined : failure.code, localCooldown: failure.localCooldown, retryAfterMs: failure.retryAfterMs });
  }
}
parentPort.on('message', message => {
  if (message.type === 'config') { cookie = String(message.cookie || ''); quality = message.quality || 'exhigh'; generation++; catalogPort?.postMessage({ type: 'invalidate', generation }); return; }
  if (message.type === 'catalog-port') {
    catalogPort?.close(); catalogPort = message.port;
    catalogPort.on('message', request => {
      if (request.type === 'sync') { catalogPort.postMessage({ type: 'synced', id: request.id, generation }); return; }
      if (request.type === 'call') perform(request, catalogPort, true);
    });
    catalogPort.postMessage({ type: 'ready', generation }); return;
  }
  if (message.type !== 'call') return;
  if (message.method === 'syncConfiguration') { parentPort.postMessage({ id: message.id, ok: true, result: null, generation }); return; }
  perform(message, parentPort);
});
parentPort.postMessage({ type: 'ready' });
