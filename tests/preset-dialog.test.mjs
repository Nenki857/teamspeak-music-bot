import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parse, compileScript } from '@vue/compiler-sfc';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ALL_PERMISSIONS } from '../src/shared/security.mjs';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const name of ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'Event', 'sessionStorage']) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
}
const { createApp, nextTick } = await import('vue');
const output = resolve('work/renderer-tests/App.mjs'); mkdirSync(resolve('work/renderer-tests'), { recursive: true });
for (const component of readdirSync(resolve('src/renderer')).filter(name => name.endsWith('.vue')).map(name => name.slice(0, -4))) {
  const { descriptor } = parse(readFileSync(resolve(`src/renderer/${component}.vue`), 'utf8'));
  const compiled = compileScript(descriptor, { id: component + '-regression', inlineTemplate: true });
  writeFileSync(resolve(`work/renderer-tests/${component}.mjs`), compiled.content.replace(/(['"])\.\/([A-Za-z0-9-]+)\.vue\1/g, (_match, quote, name) => quote + './' + name + '.mjs' + quote).replace('./PlayModeControl.vue', './PlayModeControl.mjs').replace('./ResizableQueuePanel.vue', './ResizableQueuePanel.mjs').replace('./ResourceMonitor.vue', './ResourceMonitor.mjs').replace('./AudioHealthPanel.vue', './AudioHealthPanel.mjs').replace('./CommunityLibrary.vue', './CommunityLibrary.mjs').replace('./MusicSearchResults.vue', './MusicSearchResults.mjs').replace('./PlaylistPicker.vue', './PlaylistPicker.mjs').replace('./OwnerConsolePanel.vue', './OwnerConsolePanel.mjs').replace("'../shared/touch-sort.mjs'", JSON.stringify(pathToFileURL(resolve('src/shared/touch-sort.mjs')).href)).replace("'../shared/visitor.mjs'", JSON.stringify(pathToFileURL(resolve('src/shared/visitor.mjs')).href)).replace("'../shared/playlist-format.mjs'", JSON.stringify(pathToFileURL(resolve('src/shared/playlist-format.mjs')).href)).replace("'../shared/album-song-collector.mjs'", JSON.stringify(pathToFileURL(resolve('src/shared/album-song-collector.mjs')).href)).replace("'../shared/queue-focus.mjs'", JSON.stringify(pathToFileURL(resolve('src/shared/queue-focus.mjs')).href)).replace("'../shared/lyrics.mjs'", JSON.stringify(pathToFileURL(resolve('src/shared/lyrics.mjs')).href)).replace("'../shared/ui-scale.mjs'", JSON.stringify(pathToFileURL(resolve('src/shared/ui-scale.mjs')).href)));
}
const { default: App } = await import(pathToFileURL(output).href);
const settle = async () => { for (let i = 0; i < 4; i++) { await Promise.resolve(); await nextTick(); } };
async function fixture(t, options = {}) {
  let listener; let statusReads = 0; const writes = []; const grants = []; const moves = []; const plays = []; const searches = []; const listTypes = []; const modes = []; const saves = []; const artistCalls = []; const albumCalls = []; const volumeCalls = []; const lyricsCalls = [];
  let state = { ready: true, phase: 'stopped', presets: [], grants: [], publications: [], localPlaylists: [], capabilities: { savedPlaylists: true }, player: { queue: [] }, auth: { loggedIn: false }, permissions: [], ...options.state };
  window.musicDesk = {
    server: !!options.server,
    changePassword: options.changePassword,
    subscribe(callback) { listener = callback; return () => { listener = null; }; },
    async rpc(method, args) {
      // Electron IPC uses structured cloning and rejects nested Vue proxies.
      args = structuredClone(args);
      if (method === 'status') { statusReads++; return structuredClone(state); }
      if (method === 'bot.start' && options.connect) return options.connect(args);
      if (method === 'music.search') { searches.push(args); return options.search ? options.search(args) : options.results || { songs: [], playlists: [] }; }
      if (method === 'music.artistAlbums' || method === 'music.album') { albumCalls.push({method,args}); return options.albums(method,args); }
      if (method === 'music.artist') { artistCalls.push(args); return options.artist(args); }
      if (method === 'playlist.saveQueue') {
        saves.push(args); const id = args.id || 'local:00000000-0000-0000-0000-000000000001';
        const saved = { id, name: args.name, source: 'local', published: true, songs: structuredClone(state.player.queue), songCount: state.player.queue.length };
        state = { ...state, localPlaylists: [...state.localPlaylists.filter(item => item.id !== id), saved], publications: [...state.publications.filter(item => item.id !== id), saved] }; return saved;
      }
      if (method === 'playlists.list') { listTypes.push(args.type); return options.playlists?.[args.type] || []; }
      if (method === 'playlist.detail') return options.playlistDetails?.[args.id];
      if (method === 'music.lyrics') { lyricsCalls.push(args); return { songId: args.id, lines: [{ time: 0, text: 'Fixture lyrics' }] }; }
      if (method === 'player.volume') { volumeCalls.push(args); if (options.setVolume) await options.setVolume(args); state = { ...state, player: { ...state.player, volume: args.value, revision: state.player.revision + 1 } }; return structuredClone(state.player); }
      if (method === 'player.mode') { modes.push(args); if (options.setMode) await options.setMode(args); state = { ...state, player: { ...state.player, playMode: args.value, revision: state.player.revision + 1 } }; return structuredClone(state.player); }
      if (method === 'queue.play') {
        plays.push(args); if (options.playQueue) await options.playQueue(args);
        const item = state.player.queue.find(item => item.entryId === args.entryId);
        state = { ...state, player: { ...state.player, currentSong: item, playing: true, paused: false, elapsed: 0, revision: state.player.revision + 1 } }; return structuredClone(state.player);
      }
      if (method === 'queue.move') {
        moves.push(args); if (options.moveQueue) await options.moveQueue(args);
        const queue = [...state.player.queue]; const from = queue.findIndex(item => item.entryId === args.entryId); const to = queue.findIndex(item => item.entryId === args.targetEntryId);
        const [entry] = queue.splice(from, 1); queue.splice(to, 0, entry);
        state = { ...state, player: { ...state.player, queue, revision: state.player.revision + 1 } }; return structuredClone(state.player);
      }
      if (method === 'sharing.create') { if (options.createGrant) await options.createGrant(args); const grant = { ...JSON.parse(JSON.stringify(args)), id: 'test-grant', url: '', localUrl: '' }; grants.push(grant); state = { ...state, grants: [...state.grants, grant] }; return grant; }
      if (method === 'presets.save') { const preset = { ...JSON.parse(JSON.stringify(args)), id: 'saved-preset' }; writes.push(preset); state = { ...state, presets: [preset], defaultPreset: preset.id }; return preset; }
      throw new Error('Unexpected test RPC: ' + method);
    }
  };
  const container = document.createElement('div'); document.body.append(container); const app = createApp(App); app.mount(container); await settle();
  t.after(() => { app.unmount(); container.remove(); });
  const click = element => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const button = text => [...container.querySelectorAll('button')].find(el => el.textContent.trim() === text);
  const field = text => [...container.querySelectorAll('.modal .field-label')].find(el => el.textContent.trim() === text)?.querySelector('input');
  const input = (el, value) => { el.value = value; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
  if (options.openPreset !== false) { click(button('⌂控制台')); await settle(); click(button('+ 添加预设')); await settle(); }
  return { container, writes, grants, moves, plays, searches, listTypes, modes, saves, artistCalls, albumCalls, volumeCalls, lyricsCalls, get statusReads() { return statusReads; }, click, button, field, input, emit: next => { state = { ...state, ...next }; listener(structuredClone(state)); } };
}

test('queue saving uses a timestamp name, supports updating a named snapshot and keeps the old-service export available', async t => {
  const ui = await fixture(t, { openPreset: false, state: { phase: 'running', player: { queue: [{ id: '1', entryId: 'a', name: 'A' }, { id: '2', entryId: 'b', name: 'B' }] } } });
  ui.click(ui.button('保存')); await settle(); const input = ui.container.querySelector('[aria-label="歌单名称"]');
  assert.match(input.value, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  ui.input(input, 'Friends playlist'); ui.click(ui.button('保存并开放')); await settle();
  assert.equal(ui.saves[0].name, 'Friends playlist'); assert.equal(ui.container.querySelector('.playlist-heading h2').textContent, 'Friends playlist');
  assert.match(ui.container.querySelector('nav[aria-label="音乐分页"] button.active').textContent, /开放歌单$/);
  ui.click(ui.button('保存')); await settle(); const target = ui.container.querySelector('[aria-label="保存方式"]'); target.value = 'local:00000000-0000-0000-0000-000000000001'; target.dispatchEvent(new window.Event('change', { bubbles: true })); await settle();
  assert.equal(ui.container.querySelector('[aria-label="歌单名称"]').value, 'Friends playlist'); ui.click(ui.button('更新并开放')); await settle(); assert.equal(ui.saves[1].id, target.value);
  ui.emit({ capabilities: undefined }); ui.click(ui.button('保存')); await settle();
  assert.equal(ui.button('保存并开放').disabled, true); assert.equal(ui.button('导出当前队列').disabled, false); assert.match(ui.container.querySelector('.save-upgrade-hint').textContent, /先导出/);
});

for (const server of [false, true]) test(`${server ? 'server' : 'desktop'} owner uses the guest music pages and keeps management controls`, async t => {
  const saved = { id: 'local:00000000-0000-0000-0000-000000000002', name: 'Sidebar saved', source: 'local', songs: [{ id: '1', name: 'Song' }] };
  const ui = await fixture(t, { server, openPreset: false, state: { capabilities: { savedPlaylists: true, community: true }, publications: [saved] }, playlists: { shared: [saved] }, playlistDetails: { [saved.id]: saved } });
  const nav = ui.container.querySelector('nav[aria-label="音乐分页"]');
  assert.deepEqual([...nav.querySelectorAll('button')].map(button => button.getAttribute('aria-label')), ['播放队列', '打开搜索', '自建歌单', '开放歌单']);
  assert.ok(ui.container.querySelector('.queue-expanded')); assert.match(nav.querySelector('.active').textContent, /播放队列/);
  ui.click(nav.querySelector('[aria-label="打开搜索"]')); await settle();
  assert.ok(ui.container.querySelector('.search-box')); assert.equal(nav.querySelectorAll('.active').length, 1); assert.match(nav.querySelector('.active').textContent, /搜索/);
  ui.click(nav.querySelector('[aria-label="开放歌单"]')); await settle();
  assert.equal(ui.container.querySelector('.search-box'), null); assert.equal(nav.querySelectorAll('.active').length, 1);
  ui.click(ui.container.querySelector('.guest-playlist-link')); await settle(); await settle(); assert.equal(ui.container.querySelector('.playlist-heading h2').textContent, saved.name);
  ui.click(ui.button('⌂控制台')); await settle(); assert.ok(ui.button('+ 添加预设')); assert.ok(ui.button('↗分享控制')); assert.ok(ui.button('⚙设置与状态'));
  assert.equal(ui.container.querySelector('#current-console-address').value, server ? 'http://localhost/admin' : '本地桌面控制台');
  assert.equal(!!ui.button('修改主人密码'), server);
});

test('owner console shows admin and friend addresses separately and validates password confirmation', async t => {
  const calls = []; const ui = await fixture(t, { server: true, openPreset: false, changePassword: async value => { calls.push(value); }, state: { tunnel: { status: 'online', url: 'https://example.trycloudflare.com' }, grants: [{ url: 'https://example.trycloudflare.com/#invite=guest' }] } });
  ui.click(ui.button('⌂控制台')); await settle();
  assert.equal(ui.container.querySelector('#public-console-address').value, 'https://example.trycloudflare.com/admin');
  assert.equal(ui.container.querySelector('#friend-console-address').value, 'https://example.trycloudflare.com/#invite=guest');
  ui.click(ui.button('修改主人密码')); await settle();
  const fields = ui.container.querySelectorAll('.owner-password-form input');
  ui.input(fields[0], 'synthetic-old-password'); ui.input(fields[1], 'synthetic-new-password'); ui.input(fields[2], 'different-password');
  ui.container.querySelector('.owner-password-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.equal(calls.length, 0); assert.match(ui.container.querySelector('.owner-console-error').textContent, /不一致/);
  ui.input(fields[2], 'synthetic-new-password'); ui.container.querySelector('.owner-password-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.deepEqual(calls, [{ currentPassword: 'synthetic-old-password', newPassword: 'synthetic-new-password' }]);
  assert.equal(ui.container.querySelector('.owner-password-form'), null); assert.match(ui.container.querySelector('.notice').textContent, /密码已修改/);
});

test('search popularity sorts loaded results stably and artist links support hot/latest, paging and returning', async t => {
  const songs = [{ id: '1', name: 'A', popularity: 20 }, { id: '2', name: 'B', popularity: 99 }, { id: '3', name: 'C', popularity: 20 }, { id: '4', name: 'D' }].map(item => ({ ...item, artist: 'Artist', artists: [{ id: '99', name: 'Artist' }], duration: 180 }));
  const ui = await fixture(t, { openPreset: false, results: { songs, playlists: [] }, artist: args => ({ artist: { id: '99', name: 'Artist page' }, order: args.order, more: args.offset === 0, songs: [{ ...songs[0], id: String(args.offset + 9), name: args.order + args.offset }] }) });
  ui.click(ui.container.querySelector('[aria-label="打开搜索"]')); await settle(); ui.input(ui.container.querySelector('[aria-label="搜索音乐"]'), 'Artist'); ui.container.querySelector('.search-box').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle();
  const titles = () => [...ui.container.querySelectorAll('.song-row:not(.table-head) .song-title strong')].map(element => element.textContent.trim());
  ui.click(ui.button('人气优先')); await settle(); assert.deepEqual(titles(), ['B', 'A', 'C', 'D']); ui.click(ui.button('综合')); await settle(); assert.deepEqual(titles(), ['A', 'B', 'C', 'D']);
  ui.click(ui.container.querySelector('[title="查看歌手 Artist"]')); await settle(); assert.equal(ui.container.querySelector('.artist-heading h2').textContent, 'Artist page'); assert.deepEqual(ui.artistCalls[0], { id: '99', order: 'hot', offset: 0 });
  ui.click(ui.button('最新歌曲')); await settle(); ui.click(ui.button('加载更多歌手歌曲')); await settle(); assert.deepEqual(ui.artistCalls.at(-1), { id: '99', order: 'time', offset: 30 }); assert.deepEqual(titles(), ['time0', 'time30']);
  ui.click(ui.button('← 返回上一页')); await settle(); assert.deepEqual(titles(), ['A', 'B', 'C', 'D']);
});

test('NetEase artwork is upgraded to HTTPS across search, playlists and the player without rewriting unrelated hosts', async t => {
  const covers = ['http://p1.music.126.net/a.jpg?param=80y80', '//p5.music.126.net/b.jpg', 'https://p10.music.126.net/c.jpg', 'http://p1.music.126.net.attacker.invalid/d.jpg'];
  const songs = covers.map((coverUrl, i) => ({ id: String(i + 1), name: 'Song ' + i, artist: 'Artist', coverUrl, duration: 180 }));
  const playlist = { id: 'list', name: 'Playlist', coverUrl: 'http://p6.music.126.net/playlist.jpg', songs, songCount: 4 };
  const ui = await fixture(t, { openPreset: false, state: { phase: 'running', player: { currentSong: songs[0], queue: songs, playing: true } }, results: { songs, playlists: [playlist] }, playlistDetails: { list: playlist } });
  ui.click(ui.container.querySelector('[aria-label="打开搜索"]')); await settle();
  ui.input(ui.container.querySelector('[aria-label="搜索音乐"]'), 'Artwork');
  ui.container.querySelector('.search-box').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.deepEqual([...ui.container.querySelectorAll('.song-title img')].map(img => img.getAttribute('src')), [
    'https://p1.music.126.net/a.jpg?param=80y80', 'https://p5.music.126.net/b.jpg', 'https://p10.music.126.net/c.jpg', covers[3]
  ]);
  assert.equal(ui.container.querySelector('.cover-art img').getAttribute('src'), 'https://p1.music.126.net/a.jpg?param=80y80');
  assert.equal(ui.container.querySelector('.small-cover img').getAttribute('src'), 'https://p1.music.126.net/a.jpg?param=80y80');
  ui.click(ui.container.querySelectorAll('.search-result-tabs button')[1]); await settle();
  assert.equal(ui.container.querySelector('.playlist-card img').getAttribute('src'), 'https://p6.music.126.net/playlist.jpg');
  ui.click(ui.container.querySelector('.playlist-card')); await settle();
  assert.equal(ui.container.querySelector('.playlist-heading img').getAttribute('src'), 'https://p6.music.126.net/playlist.jpg');
  assert.equal(songs[0].coverUrl, covers[0], 'display normalization must not change the provider or queue data');
});

test('large playlists render incrementally with lazy artwork and browsing avoids redundant full-state refreshes', async t => {
  const songs = Array.from({ length: 500 }, (_, i) => ({ id: String(i + 1), name: 'Song ' + i, coverUrl: 'https://example.invalid/cover.png', duration: 180 }));
  const lists = Array.from({ length: 90 }, (_, i) => ({ id: String(i + 1), name: 'Playlist ' + i, coverUrl: 'https://example.invalid/list.png' }));
  const ui = await fixture(t, { openPreset: false, playlists: { mine: lists }, playlistDetails: { '1': { id: '1', name: 'Large playlist', songs } } });
  const initial = ui.statusReads;
  ui.click(ui.container.querySelector('[aria-label="打开搜索"]')); await settle(); ui.click(ui.button('我的歌单')); await settle();
  assert.equal(ui.container.querySelectorAll('.playlist-card').length, 40); assert.equal(ui.statusReads, initial);
  assert.equal(ui.container.querySelector('.playlist-card img').getAttribute('loading'), 'lazy');
  ui.click(ui.button('显示更多歌单')); await settle(); assert.equal(ui.container.querySelectorAll('.playlist-card').length, 80);
  ui.click(ui.container.querySelector('.playlist-card')); await settle();
  assert.equal(ui.container.querySelectorAll('.song-row:not(.table-head)').length, 50);
  const more = [...ui.container.querySelectorAll('button')].find(button => button.textContent.startsWith('显示更多歌曲'));
  ui.click(more); await settle(); assert.equal(ui.container.querySelectorAll('.song-row:not(.table-head)').length, 100);
  assert.equal(ui.container.querySelector('.song-title img').getAttribute('decoding'), 'async'); assert.equal(ui.statusReads, initial);
});
test('nickname composition and Enter never save; backdrop/status updates keep the draft open; explicit save works', async t => {
  const ui = await fixture(t);
  ui.input(ui.field('预设名称'), '朋友频道'); ui.input(ui.field('服务器地址'), 'ts.example.com');
  const nickname = ui.field('机器人昵称'); nickname.focus();
  nickname.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true }));
  ui.input(nickname, '测试音乐机器人');
  nickname.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229, bubbles: true }));
  const form = ui.container.querySelector('.modal form');
  // Browser implicit submission can occur when Enter confirms an IME candidate.
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(ui.writes.length, 0, 'IME confirmation must not save a preset');
  assert.ok(ui.container.querySelector('.modal'), 'typing must keep the dialog open');
  nickname.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })); await settle();
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.equal(ui.writes.length, 0, 'ordinary Enter must not save a preset either');
  ui.click(ui.container.querySelector('.modal-backdrop')); await settle();
  assert.ok(ui.container.querySelector('.modal'), 'outside clicks must not dismiss an unfinished preset');
  ui.emit({ player: { queue: [], elapsed: 15 } }); await settle();
  assert.equal(ui.field('机器人昵称').value, '测试音乐机器人');
  assert.equal(ui.field('服务器地址').value, 'ts.example.com');
  ui.click(ui.button('保存预设')); await settle();
  assert.equal(ui.writes.length, 1); assert.equal(ui.writes[0].nickname, '测试音乐机器人');
  assert.equal(ui.container.querySelector('.modal'), null, 'successful explicit save closes the dialog');
});
test('explicit save retains required-field validation and closing with X is still possible', async t => {
  const ui = await fixture(t); ui.input(ui.field('机器人昵称'), '音乐机器人');
  ui.click(ui.button('保存预设')); await settle();
  assert.equal(ui.writes.length, 0, 'missing server/name must not be saved');
  assert.ok(ui.container.querySelector('.modal'));
  ui.click(ui.container.querySelector('.modal-close')); await settle();
  assert.equal(ui.container.querySelector('.modal'), null);
});
test('connecting is shown immediately and a failure remains next to the button', async t => {
  let reject; let calls = 0; const pending = new Promise((_, fail) => { reject = fail; });
  const ui = await fixture(t, { openPreset: false, state: { presets: [{ id: 'ts-preset', name: 'Test TS', serverAddress: 'example.test', serverPort: 9987 }], defaultPreset: 'ts-preset' }, connect: () => { calls++; return pending; } });
  ui.click(ui.button('⌂控制台')); await settle();
  ui.click(ui.button('连接 TS 服务器')); await settle();
  assert.equal(calls, 1); assert.ok(ui.container.querySelector('.connection-feedback[role="status"]'));
  assert.ok([...ui.container.querySelectorAll('button')].filter(button => button.textContent.trim() === '连接中…').every(button => button.disabled));
  reject(new Error('服务器权限不足，请检查机器人进入目标频道的权限')); await settle();
  assert.match(ui.container.querySelector('.connection-error').textContent, /服务器权限不足/);
  assert.equal(ui.button('连接 TS 服务器').disabled, false);
});
test('an online playing bot can create an authorization link while idle', async t => {
  let complete; const pending = new Promise(resolve => { complete = resolve; });
  const ui = await fixture(t, { openPreset: false, state: { phase: 'running', player: { playing: true, queue: [] } }, createGrant: () => pending });
  ui.click(ui.button('⌂控制台')); await settle();
  assert.equal(ui.button('+ 添加预设').disabled, false, 'other idle buttons must also be enabled');
  ui.click(ui.button('↗分享控制')); await settle();
  const create = ui.button('+ 创建授权链接');
  assert.equal(create.disabled, false, 'empty idle label must not become a present disabled attribute');
  assert.equal(ui.button('开启公网控制').disabled, false);
  ui.click(create); await settle();
  assert.equal(create.disabled, true, 'a pending request still disables duplicate operations');
  assert.equal(ui.grants.length, 0);
  ui.emit({ player: { playing: true, queue: [], elapsed: 20 } }); await settle();
  assert.equal(create.disabled, true, 'playback updates must not clear a pending operation');
  complete(); await settle();
  assert.equal(ui.grants.length, 1); assert.equal(ui.grants[0].name, '我的朋友');
  assert.deepEqual(ui.grants[0].permissions, ALL_PERMISSIONS, 'all permissions are selected by default and arrive intact through IPC');
  assert.equal(create.disabled, false, 'button becomes available again after the request finishes');
});

test('authorization link creation follows bot connection state', async t => {
  const ui = await fixture(t, { openPreset: false });
  ui.click(ui.button('↗分享控制')); await settle();
  const create = ui.button('+ 创建授权链接');
  assert.equal(create.disabled, true, 'a stopped bot cannot issue links');
  ui.emit({ phase: 'running' }); await settle();
  assert.equal(create.disabled, false, 'connection enables sharing even without music playing');
  ui.emit({ phase: 'disconnected' }); await settle();
  assert.equal(create.disabled, true, 'a disconnected bot cannot issue links');
});

test('new grants default to all permissions without broadening existing links and can still be customized', async t => {
  const oldGrant = { id: 'old-link', name: '只读朋友', permissions: ['view'] };
  const ui = await fixture(t, { openPreset: false, state: { phase: 'running', grants: [oldGrant] } });
  ui.click(ui.button('↗分享控制')); await settle();
  const defaults = [...ui.container.querySelectorAll('.grant-form .permission-grid input')];
  assert.equal(defaults.length, ALL_PERMISSIONS.length); assert.ok(defaults.every(input => input.checked));
  assert.equal(ui.container.querySelectorAll('.grant-card .permission-grid input:checked').length, 1);
  const queue = defaults.find(input => input.value === 'queue'); queue.click(); await settle();
  ui.emit({ player: { queue: [], elapsed: 42 } }); await settle();
  ui.click(ui.button('+ 创建授权链接')); await settle();
  assert.deepEqual(ui.grants[0].permissions, ALL_PERMISSIONS.filter(permission => permission !== 'queue'));
  assert.equal(ui.container.querySelectorAll('.grant-card:first-of-type .permission-grid input:checked').length, 1);
});

test('my playlists and discovery have independent active tabs and content', async t => {
  const ui = await fixture(t, { openPreset: false, playlists: { mine: [{ id: '1', name: '我的收藏' }], recommend: [{ id: '2', name: '发现推荐' }] } });
  ui.click(ui.container.querySelector('[aria-label="打开搜索"]')); await settle();
  ui.click(ui.button('我的歌单')); await settle();
  const active = () => [...ui.container.querySelectorAll('.sidebar-owner-library button.active')].map(button => button.textContent.trim());
  assert.deepEqual(active(), ['我的歌单']); assert.match(ui.container.querySelector('.playlist-card').textContent, /我的收藏/);
  ui.click(ui.button('发现歌单')); await settle();
  assert.deepEqual(active(), ['发现歌单']); assert.match(ui.container.querySelector('.playlist-card').textContent, /发现推荐/);
  ui.emit({ player: { queue: [], elapsed: 12 } }); await settle(); assert.deepEqual(active(), ['发现歌单']);
  ui.click(ui.button('我的歌单')); await settle(); assert.deepEqual(active(), ['我的歌单']);
  assert.deepEqual(ui.listTypes, ['mine', 'recommend', 'mine']);
});

test('search result switches expose related playlists at the top and preserve songs, paging and playlist navigation', async t => {
  const song = { id: '1', name: '测试歌曲', artist: '歌手', album: '专辑', duration: 180 };
  const list = { id: '2', name: '测试歌单', songs: [song], songCount: 1 };
  const ui = await fixture(t, { openPreset: false, results: { songs: [song], playlists: [list] }, playlistDetails: { 2: list } });
  ui.click(ui.container.querySelector('[aria-label="打开搜索"]')); await settle();
  ui.input(ui.container.querySelector('[aria-label="搜索音乐"]'), ' 测试 ');
  ui.container.querySelector('.search-box').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.deepEqual(ui.searches, [{ query: '测试', offset: 0 }]);
  const switches = () => [...ui.container.querySelectorAll('.search-result-tabs button')];
  assert.equal(switches()[0].getAttribute('aria-pressed'), 'true');
  assert.ok(ui.container.querySelector('.song-list')); assert.equal(ui.container.querySelector('.playlist-card'), null);
  assert.ok(ui.container.querySelector('.search-result-tabs').compareDocumentPosition(ui.container.querySelector('.song-list')) & Node.DOCUMENT_POSITION_FOLLOWING);
  ui.click(switches()[1]); await settle();
  assert.equal(switches()[1].getAttribute('aria-pressed'), 'true');
  assert.equal(ui.container.querySelector('.song-list'), null); assert.match(ui.container.querySelector('.playlist-card').textContent, /测试歌单/);
  assert.equal(ui.searches.length, 1, 'changing result type uses the existing results');
  ui.click(ui.container.querySelector('.playlist-card')); await settle();
  assert.ok(ui.container.querySelector('.playlist-heading')); assert.ok(ui.container.querySelector('.song-list'));
  ui.click(ui.button('← 返回列表')); await settle(); assert.ok(ui.container.querySelector('.playlist-card'));
  ui.input(ui.container.querySelector('[aria-label="搜索音乐"]'), '尚未搜索的新词');
  ui.click(ui.button('加载更多歌单')); await settle();
  assert.deepEqual(ui.searches[1], { query: '测试', offset: 30 }, 'paging retains the searched query rather than mixing in unsent text');
  assert.equal(switches()[1].getAttribute('aria-pressed'), 'true');
  ui.click(switches()[0]); await settle(); assert.equal(ui.container.querySelectorAll('.song-row:not(.table-head)').length, 2);
});

test('an empty playlist search result has its own empty state and a failed page can be retried', async t => {
  let attempt = 0; const song = { id: '1', name: '只有歌曲' };
  const ui = await fixture(t, { openPreset: false, search: ({ offset }) => { if (offset && attempt++ === 0) throw new Error('搜索暂时失败'); return { songs: [song], playlists: [] }; } });
  ui.click(ui.container.querySelector('[aria-label="打开搜索"]')); await settle();
  ui.input(ui.container.querySelector('[aria-label="搜索音乐"]'), '歌曲');
  ui.container.querySelector('.search-box').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle();
  ui.click(ui.container.querySelectorAll('.search-result-tabs button')[1]); await settle();
  assert.match(ui.container.querySelector('.empty-state h3').textContent, /没有找到相关歌单/);
  assert.equal(ui.container.querySelector('.load-more'), null);
  ui.click(ui.container.querySelectorAll('.search-result-tabs button')[0]); await settle();
  ui.click(ui.button('加载更多歌曲')); await settle(); assert.match(ui.container.querySelector('.error').textContent, /搜索暂时失败/);
  ui.click(ui.button('加载更多歌曲')); await settle();
  assert.deepEqual(ui.searches.map(args => args.offset), [0, 30, 30]);
  assert.equal(ui.container.querySelectorAll('.song-row:not(.table-head)').length, 2);
});

const orderEntries = ['已播放', '正在播放', 'A', 'B', 'C'].map((name, index) => ({ name, entryId: 'entry-' + index, id: '42', artist: 'Artist', duration: 180 }));
const orderState = () => ({ phase: 'running', runId: 'current-run', player: { playing: true, currentSong: orderEntries[1], queue: [...orderEntries], elapsed: 37, playMode: 'seq', revision: 7 } });
const orderNames = ui => [...ui.container.querySelectorAll('.queue-item strong')].map(el => el.textContent);
const orderButton = (ui, label) => ui.container.querySelector(`[aria-label="${label}"]`);

test('mode icon opens a radio menu and changes mode through existing playback controls', async t => {
  const ui = await fixture(t, { openPreset: false, state: orderState() });
  const trigger = ui.container.querySelector('.mode-trigger');
  assert.equal(trigger.textContent.trim(), ''); assert.ok(trigger.querySelector('svg')); assert.equal(trigger.title, '列表循环');
  ui.click(trigger); await settle();
  const menu = ui.container.querySelector('[role="menu"]'); const options = [...menu.querySelectorAll('[role="menuitemradio"]')];
  assert.deepEqual(options.map(item => item.textContent.trim()), ['列表循环', '单曲循环', '随机播放']);
  assert.equal(options[0].getAttribute('aria-checked'), 'true');
  ui.click(options[2]); await settle();
  assert.deepEqual(ui.modes, [{ value: 'random', expectedRevision: 7, runId: 'current-run' }]);
  assert.equal(trigger.title, '随机播放'); assert.equal(ui.container.querySelector('[role="menu"]'), null);
  assert.deepEqual(orderNames(ui), ['已播放', '正在播放', 'A', 'B', 'C']);
  ui.click(trigger); await settle();
  const current = ui.container.querySelector('[role="menuitemradio"][aria-checked="true"]');
  assert.equal(current.textContent.trim(), '随机播放'); ui.click(current); await settle(); assert.equal(ui.modes.length, 1);
  ui.click(trigger); await settle(); ui.click(ui.container.querySelectorAll('[role="menuitemradio"]')[1]); await settle(); assert.equal(ui.modes[1].value, 'single'); assert.equal(trigger.title, '单曲循环');
});

test('mode menu supports keyboard navigation, escape, outside dismissal and disconnected state', async t => {
  const ui = await fixture(t, { openPreset: false, state: orderState() }); const trigger = ui.container.querySelector('.mode-trigger');
  trigger.focus(); trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); await settle();
  assert.equal(document.activeElement.textContent.trim(), '列表循环');
  const key = value => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  key('ArrowUp'); await settle(); assert.equal(document.activeElement.textContent.trim(), '随机播放');
  key('Home'); await settle(); assert.equal(document.activeElement.textContent.trim(), '列表循环');
  key('End'); await settle(); assert.equal(document.activeElement.textContent.trim(), '随机播放');
  key('Escape'); await settle(); assert.equal(document.activeElement, trigger); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  ui.click(trigger); await settle(); document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true })); await settle();
  assert.equal(ui.container.querySelector('[role="menu"]'), null);
  ui.click(trigger); await settle(); ui.emit({ phase: 'stopped' }); await settle();
  assert.equal(trigger.disabled, true); assert.equal(ui.container.querySelector('[role="menu"]'), null); assert.equal(ui.modes.length, 0);
});

test('a failed mode change preserves the confirmed icon and releases the pending controls', async t => {
  let reject; const pending = new Promise((_, fail) => { reject = fail; });
  const ui = await fixture(t, { openPreset: false, state: orderState(), setMode: () => pending });
  const trigger = ui.container.querySelector('.mode-trigger'); ui.click(trigger); await settle();
  ui.click(ui.container.querySelectorAll('[role="menuitemradio"]')[1]); await settle();
  assert.equal(trigger.disabled, true); assert.equal(trigger.title, '列表循环');
  reject(new Error('模式修改失败')); await settle();
  assert.equal(trigger.disabled, false); assert.equal(trigger.title, '列表循环'); assert.match(ui.container.querySelector('.error').textContent, /模式修改失败/);
});

test('queue drag and keyboard sorting reorder only upcoming entries without arrow buttons', async t => {
  const ui = await fixture(t, { openPreset: false, state: orderState() });
  assert.equal(ui.container.querySelectorAll('.queue-thumb').length, 5); assert.equal(orderButton(ui, '上移 正在播放'), null); assert.equal(orderButton(ui, '上移 已播放'), null);
  assert.equal(orderButton(ui, '上移 A'), null); assert.equal(orderButton(ui, '下移 C'), null);
  ui.container.querySelectorAll('.queue-item')[4].dispatchEvent(new window.KeyboardEvent('keydown', { key:'ArrowUp', altKey:true, bubbles:true, cancelable:true })); await settle();
  assert.deepEqual(orderNames(ui), ['已播放', '正在播放', 'A', 'C', 'B']);
  assert.deepEqual(ui.moves[0], { entryId: 'entry-4', targetEntryId: 'entry-3', expectedRevision: 7, runId: 'current-run' });
  ui.container.querySelectorAll('.queue-item')[2].dispatchEvent(new window.KeyboardEvent('keydown', { key:'ArrowDown', altKey:true, bubbles:true, cancelable:true })); await settle();
  assert.deepEqual(orderNames(ui), ['已播放', '正在播放', 'C', 'A', 'B']);
  const rows = [...ui.container.querySelectorAll('.queue-item')];
  assert.equal(rows[0].draggable, false); assert.equal(rows[1].draggable, false); assert.equal(rows[4].draggable, true);
  rows[4].dispatchEvent(new window.Event('dragstart', { bubbles: true, cancelable: true })); await settle();
  const blocked = new window.Event('dragover', { bubbles: true, cancelable: true }); rows[1].dispatchEvent(blocked);
  assert.equal(blocked.defaultPrevented, false, 'current song is not a drop target');
  const over = new window.Event('dragover', { bubbles: true, cancelable: true }); rows[2].dispatchEvent(over); await settle();
  assert.equal(over.defaultPrevented, true); assert.ok(rows[2].classList.contains('drop-target'));
  rows[2].dispatchEvent(new window.Event('drop', { bubbles: true, cancelable: true })); await settle();
  assert.deepEqual(orderNames(ui), ['已播放', '正在播放', 'B', 'C', 'A']);
  assert.equal(ui.moves[2].expectedRevision, 9); assert.equal(ui.moves.length, 3);
  assert.equal(ui.container.querySelector('.queue-item.current strong').textContent, '正在播放');
  assert.equal(ui.container.querySelector('.dragging'), null);
  const movedRows = [...ui.container.querySelectorAll('.queue-item')];
  movedRows[2].dispatchEvent(new window.Event('dragstart', { bubbles: true, cancelable: true }));
  movedRows[4].dispatchEvent(new window.Event('dragover', { bubbles: true, cancelable: true })); await settle();
  assert.ok(movedRows[4].classList.contains('drop-after'), 'moving down previews insertion after the target');
  movedRows[4].dispatchEvent(new window.Event('drop', { bubbles: true, cancelable: true })); await settle();
  assert.deepEqual(orderNames(ui), ['已播放', '正在播放', 'C', 'A', 'B']);
});

test('dragging retains its initial revision and move failures restore controls', async t => {
  let reject; const pending = new Promise((_, fail) => { reject = fail; });
  const ui = await fixture(t, { openPreset: false, state: orderState(), moveQueue: () => pending });
  const rows = [...ui.container.querySelectorAll('.queue-item')];
  rows[4].dispatchEvent(new window.Event('dragstart', { bubbles: true, cancelable: true }));
  ui.emit({ player: { ...orderState().player, revision: 8, playMode: 'random' } }); await settle();
  rows[2].dispatchEvent(new window.Event('drop', { bubbles: true, cancelable: true })); await settle();
  assert.equal(ui.moves[0].expectedRevision, 7, 'a change during dragging must not silently use a newer revision');
  assert.ok([...ui.container.querySelectorAll('.queue-actions button')].every(button => button.disabled));
  reject(new Error('播放状态已变化，已刷新，请再次操作')); await settle();
  assert.match(ui.container.querySelector('.error').textContent, /播放状态已变化/);
  assert.equal(ui.container.querySelectorAll('.queue-item')[4].draggable, true);
  assert.match(ui.container.querySelector('.queue-order-hint').textContent, /随机模式仍随机/);
  assert.deepEqual(orderNames(ui), ['已播放', '正在播放', 'A', 'B', 'C']);
});

test('queue play buttons select an existing entry, retain the queue and show the new current row', async t => {
  const ui = await fixture(t, { openPreset: false, state: orderState() });
  assert.equal(orderButton(ui, '播放队列歌曲 正在播放').disabled, true);
  const target = orderButton(ui, '播放队列歌曲 C'); assert.ok(target.querySelector('svg'));
  ui.click(target); await settle();
  assert.deepEqual(ui.plays, [{ entryId: 'entry-4', expectedRevision: 7, runId: 'current-run' }]);
  assert.deepEqual(orderNames(ui), ['已播放', '正在播放', 'A', 'B', 'C']);
  assert.equal(ui.container.querySelector('.queue-item.current strong').textContent, 'C');
  assert.equal(orderButton(ui, '播放队列歌曲 C').disabled, true);
  assert.equal(orderButton(ui, '播放队列歌曲 已播放').disabled, false);
  ui.emit({ player: { ...orderState().player, playing: false, paused: true } }); await settle();
  assert.equal(orderButton(ui, '播放队列歌曲 正在播放').disabled, false);
  assert.equal(orderButton(ui, '播放队列歌曲 正在播放').title, '继续播放');
  ui.emit({ player: { ...orderState().player, playing: false, paused: false } }); await settle();
  assert.equal(orderButton(ui, '播放队列歌曲 正在播放').disabled, false);
  assert.equal(orderButton(ui, '播放队列歌曲 正在播放').title, '播放这首歌');
});

test('queue play requests lock controls while pending and recover from a failure without clearing the queue', async t => {
  let reject; const pending = new Promise((_, fail) => { reject = fail; });
  const ui = await fixture(t, { openPreset: false, state: orderState(), playQueue: () => pending });
  ui.click(orderButton(ui, '播放队列歌曲 A')); await settle();
  assert.ok([...ui.container.querySelectorAll('.queue-actions button')].every(button => button.disabled));
  reject(new Error('这首歌暂时无法播放')); await settle();
  assert.match(ui.container.querySelector('.error').textContent, /暂时无法播放/);
  assert.equal(orderButton(ui, '播放队列歌曲 A').disabled, false);
  assert.deepEqual(orderNames(ui), ['已播放', '正在播放', 'A', 'B', 'C']);
  assert.equal(ui.container.querySelector('.queue-item.current strong').textContent, '正在播放');
});

for(const server of [true,false])test('artist clicks run standard name search for '+(server?'server owner':'server capability')+' without artist API',async t=>{
  const songs=[{id:'1',name:'First song',artist:'歌手甲',artists:[{id:'21',name:'歌手甲'},{id:'33',name:'歌手乙'}],duration:180}];
  const ui=await fixture(t,{server,openPreset:false,state:{capabilities:{artistNameSearch:true}},results:{songs,playlists:[]}});
  ui.click(ui.container.querySelector('[aria-label="打开搜索"]'));await settle();ui.input(ui.container.querySelector('[aria-label="搜索音乐"]'),'Original');ui.container.querySelector('.search-box').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle();
  ui.click(ui.button('人气优先'));await settle();ui.click(ui.container.querySelector('[title="搜索歌手 歌手甲"]'));await settle();
  assert.deepEqual(ui.searches.at(-1),{query:'歌手甲',offset:0});assert.equal(ui.container.querySelector('[aria-label="搜索音乐"]').value,'歌手甲');assert.equal(ui.container.querySelector('.artist-heading'),null);
  ui.click(ui.container.querySelector('[title="搜索歌手 歌手乙"]'));await settle();assert.deepEqual(ui.searches.at(-1),{query:'歌手乙',offset:0});assert.deepEqual(ui.artistCalls,[]);
});

test('server owner artist clicks open album list and then album songs through the shared catalog UI',async t=>{
  const song={id:'1',name:'Song',artists:[{id:'21',name:'Singer'}],duration:180};const album={id:'21001',name:'Test album',artist:'Singer',songCount:1};
  const ui=await fixture(t,{server:true,openPreset:false,state:{capabilities:{artistNameSearch:true,artistAlbums:true}},results:{songs:[song],playlists:[]},albums:(method,args)=>method==='music.artistAlbums'?{artist:{id:args.id},albums:[album],more:false}:{...album,songs:[song]}});
  ui.click(ui.container.querySelector('[aria-label="打开搜索"]'));await settle();ui.input(ui.container.querySelector('[aria-label="搜索音乐"]'),'Original');ui.container.querySelector('.search-box').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle();
  ui.click(ui.container.querySelector('[title="查看歌手歌曲 Singer"]'));await settle();await settle();assert.deepEqual(ui.albumCalls,[{method:'music.artistAlbums',args:{id:'21',offset:0}},{method:'music.album',args:{id:'21001'}}]);assert.deepEqual(ui.artistCalls,[]);assert.equal(ui.container.querySelector('.album-song-heading h3').textContent,'Test album');ui.click(ui.button('专辑列表'));await settle();assert.equal(ui.container.querySelector('.artist-album-grid strong').textContent,'Test album');
  ui.click(ui.container.querySelector('.artist-album-grid button'));await settle();assert.deepEqual(ui.albumCalls.at(-1),{method:'music.album',args:{id:'21001'}});assert.equal(ui.container.querySelector('.playlist-heading h2').textContent,'Test album');assert.equal(ui.container.querySelector('.song-title strong').textContent.trim(),'Song');
});

test('queue opens at the current track once, manual locate makes no RPC and returning to the page locates the new current track',async t=>{
 const originalRect=window.HTMLElement.prototype.getBoundingClientRect,originalScroll=window.HTMLElement.prototype.scrollTo,originalStyle=window.getComputedStyle;
 const oldHeight=Object.getOwnPropertyDescriptor(window.HTMLElement.prototype,'clientHeight'),oldScrollHeight=Object.getOwnPropertyDescriptor(window.HTMLElement.prototype,'scrollHeight');const scrolls=[];
 window.HTMLElement.prototype.getBoundingClientRect=function(){
  if(this.classList.contains('queue-item'))return{top:164+Number(this.dataset.sortId.split('-').at(-1))*72-(this.closest('.workspace')?.scrollTop||0),height:72,width:500};
  if(this.classList.contains('workspace'))return{top:64,height:700,width:1200};if(this.classList.contains('queue-heading'))return{height:76};if(this.classList.contains('now-card'))return{height:400};return originalRect.call(this);
 };
 Object.defineProperty(window.HTMLElement.prototype,'clientHeight',{configurable:true,get(){return this.classList.contains('workspace')?700:0;}});Object.defineProperty(window.HTMLElement.prototype,'scrollHeight',{configurable:true,get(){return this.classList.contains('workspace')?15000:0;}});
 window.HTMLElement.prototype.scrollTo=function(options){scrolls.push({...options,id:this.querySelector('.queue-item.current')?.dataset.sortId});this.scrollTop=options.top;};window.getComputedStyle=element=>element.classList.contains('workspace')?{overflowY:'auto',paddingLeft:'0',paddingRight:'0',columnGap:'0'}:originalStyle(element);
 t.after(()=>{window.HTMLElement.prototype.getBoundingClientRect=originalRect;window.HTMLElement.prototype.scrollTo=originalScroll;window.getComputedStyle=originalStyle;if(oldHeight)Object.defineProperty(window.HTMLElement.prototype,'clientHeight',oldHeight);else delete window.HTMLElement.prototype.clientHeight;if(oldScrollHeight)Object.defineProperty(window.HTMLElement.prototype,'scrollHeight',oldScrollHeight);else delete window.HTMLElement.prototype.scrollHeight;});
 const queue=Array.from({length:100},(_,i)=>({id:String(i),entryId:'entry-'+i,name:'Song '+i,artist:'Artist'}));
 const ui=await fixture(t,{server:true,openPreset:false,state:{phase:'running',player:{queue,revision:1}}});assert.equal(scrolls.length,0);assert.equal(ui.button('定位当前播放').disabled,true);
 ui.emit({player:{queue,currentSong:queue[49],playing:true,revision:1}});await settle();await settle();assert.equal(scrolls.length,1);assert.equal(scrolls[0].id,'entry-49');assert.equal(scrolls[0].behavior,'auto');assert.ok(scrolls[0].top>1000);assert.equal(ui.container.querySelector('[aria-current="true"]').dataset.sortId,'entry-49');
 const reads=ui.statusReads;ui.click(ui.button('定位当前播放'));await settle();assert.equal(scrolls.length,2);assert.equal(scrolls[1].id,'entry-49');assert.equal(ui.statusReads,reads);
 ui.emit({player:{queue,currentSong:queue[59],playing:true,revision:2}});await settle();assert.equal(scrolls.length,2);
 ui.click(ui.container.querySelector('[aria-label="打开搜索"]'));await settle();ui.click(ui.container.querySelector('[aria-label="播放队列"]'));await settle();await settle();assert.equal(scrolls.length,3);assert.equal(scrolls[2].id,'entry-59');
});


test('numeric volume uses the existing revision-checked player control and prevents duplicate requests during server delay', async t => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const ui = await fixture(t, { openPreset: false, server: true, state: { phase: 'running', runId: 'volume-run', player: { queue: [], volume: 50, revision: 9 } }, setVolume: () => waiting });
  ui.click(ui.container.querySelector('.volume-value')); await settle();
  const field = ui.container.querySelector('[aria-label="输入音量百分比"]'); ui.input(field, '68');
  field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); field.dispatchEvent(new window.Event('blur')); await settle();
  assert.deepEqual(ui.volumeCalls, [{ value: 68, expectedRevision: 9, runId: 'volume-run' }]);
  assert.equal(ui.container.querySelector('.volume-value').textContent, '68%'); assert.equal(ui.container.querySelector('.volume-value').disabled, true);
  release(); await settle(); await settle();
  assert.equal(ui.container.querySelector('.volume-value').textContent, '68%'); assert.equal(ui.container.querySelector('.volume-value').disabled, false);
  assert.equal(ui.volumeCalls.length, 1);
});

test('current lyrics appear under the cover on the queue page and do not add status polling or playback commands',async t=>{
 const song={id:'123',entryId:'lyrics-1',platform:'netease',name:'Song',artist:'Artist'};
 const ui=await fixture(t,{openPreset:false,server:true,state:{phase:'running',capabilities:{lyrics:true},player:{currentSong:song,queue:[song],elapsed:0,playing:false}}});await settle();
 assert.ok(ui.container.querySelector('.now-card .lyrics-panel'));assert.match(ui.container.querySelector('.lyrics-panel').textContent,/Fixture lyrics/);assert.deepEqual(ui.lyricsCalls,[{id:'123'}]);
 const status=ui.statusReads;ui.emit({player:{currentSong:song,queue:[song],elapsed:12,playing:false}});await settle();assert.equal(ui.statusReads,status);assert.equal(ui.lyricsCalls.length,1);assert.deepEqual(ui.plays,[]);
});

for(const server of [true]) test('cover artist names open standard name search without artist API for '+(server?'server':'desktop'),async t=>{
 const song={id:'1',entryId:'cover-1',name:'Track',artist:'Singer A / Singer B',artists:[{id:'11',name:'Singer A'},{id:'22',name:'Singer B'}]};
 const ui=await fixture(t,{openPreset:false,server,state:{phase:'running',capabilities:{artistAlbums:true},player:{currentSong:song,queue:[song]}},results:{songs:[],playlists:[]}});
 assert.equal(ui.container.querySelectorAll('.now-artists button').length,2);ui.click(ui.container.querySelector('[aria-label="搜索歌手 Singer B"]'));await settle();
 assert.equal(ui.container.querySelector('[aria-label="搜索音乐"]').value,'Singer B');assert.equal(ui.searches.length,1);assert.equal(ui.searches[0].query,'Singer B');assert.deepEqual(ui.artistCalls,[]);assert.deepEqual(ui.albumCalls,[]);assert.deepEqual(ui.plays,[]);
 ui.click(ui.container.querySelector('.player-song [aria-label="搜索歌手 Singer A"]'));await settle();assert.equal(ui.searches[1].query,'Singer A');assert.deepEqual(ui.albumCalls,[]);
 ui.click(ui.container.querySelector('[aria-label="播放队列"]'));await settle();ui.emit({player:{currentSong:{...song,artists:[],artist:'AC/DC'},queue:[song]}});await settle();
 ui.click(ui.container.querySelector('[aria-label="搜索歌手 AC/DC"]'));await settle();assert.equal(ui.searches[2].query,'AC/DC');
});

test('desktop cover and footer artist links retain artist identity and open the original artist page',async t=>{
 const song={id:'1',entryId:'local-cover',name:'Track',artist:'Singer A / Singer B',artists:[{id:'11',name:'Singer A'},{id:'22',name:'Singer B'}]};
 const ui=await fixture(t,{openPreset:false,state:{phase:'running',capabilities:{artists:true,lyrics:true},player:{currentSong:song,queue:[song]}},artist:args=>({artist:{id:args.id,name:args.id==='11'?'Singer A':'Singer B',description:'Local artist profile'},songs:[],more:false})});
 ui.click(ui.container.querySelector('.now-artists [aria-label="查看歌手 Singer B"]'));await settle();assert.equal(ui.artistCalls[0].id,'22');assert.match(ui.container.querySelector('.artist-heading').textContent,/Local artist profile/);assert.equal(ui.searches.length,0);assert.equal(ui.albumCalls.length,0);
 ui.click(ui.container.querySelector('.player-song [aria-label="查看歌手 Singer A"]'));await settle();assert.equal(ui.artistCalls[1].id,'11');assert.ok(ui.container.querySelector('[aria-label="控制台"]'));assert.ok(ui.container.querySelector('.sidebar-exit'));
 ui.click(ui.container.querySelector('[aria-label="播放队列"]'));await settle();assert.ok(ui.container.querySelector('.now-card .lyrics-panel'));
 ui.emit({player:{currentSong:{...song,artists:[],artist:'AC/DC'},queue:[song]}});await settle();ui.click(ui.container.querySelector('[aria-label="搜索歌手 AC/DC"]'));await settle();assert.equal(ui.searches[0].query,'AC/DC');
});
