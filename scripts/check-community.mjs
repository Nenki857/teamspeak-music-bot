import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import koffi from 'koffi';
import { IsolatedMusicProvider } from '../src/worker/music-provider.mjs';
import { createVault, ALL_PERMISSIONS } from '../src/shared/security.mjs';
process.env.TSMD_DATA_DIR = resolve('work/community-browser-data-' + randomUUID());
const [{ Service }, { createShareServer }] = await Promise.all([import('../src/worker/service.mjs'), import('../src/worker/share-server.mjs')]);
const output = resolve('work/community-browser'); mkdirSync(output, { recursive: true });
if (process.platform === 'win32') koffi.load('kernel32.dll').func('uint32 __stdcall SetErrorMode(uint32)')(0x8003);
let service; let server; let otherServer; let browser; let provider; let queue = []; let revision = 1; const errors = []; const key = randomBytes(32);
async function start() {
  provider = new IsolatedMusicProvider({ apiModule: new URL('../tests/fixtures/music-api.mjs', import.meta.url).href }); await provider.ready; provider.setCookie('owner-fixture-cookie');
  service = new Service(createVault(key), () => server?.broadcast(), { createCore: () => ({ init() {}, close: () => provider.close(), provider, health: () => ({}), exportQueue: async () => queue,
    status: () => ({ queue, revision, connected: true, playing: !!queue.length, currentSong: queue[0], playMode: 'seq', volume: 30 }),
    command: async (method, args, name) => {
      if (method === 'music.add' || method === 'music.playNow') { const song = await provider.getSongDetail(args.id); queue.push({ ...song, entryId: randomUUID(), requestedBy: name }); }
      else if (method === 'playlist.loadLocal') queue = args.songs.map(song => ({ ...song, entryId: randomUUID(), requestedBy: name }));
      else if (method === 'playlist.play') queue = (await provider.getPlaylistSongs(args.id)).map(song => ({ ...song, entryId: randomUUID(), requestedBy: name }));
      else throw new Error('Unexpected synthetic playback call'); revision++; return { queue, revision };
    } }) });
  await service.init(); service.phase = 'running'; service.authority.beginRun(); server = await createShareServer(service); return `http://127.0.0.1:${server.port}`;
}
try {
  const origin = await start(); const grant = service.authority.create('One shared link', ALL_PERMISSIONS);
  const executablePath = [process.env.TSMD_BROWSER_PATH, chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path => path && existsSync(path));
  browser = await chromium.launch({ executablePath, headless: true });
  async function context() { const c = await browser.newContext({ viewport: { width: 1360, height: 1000 } }); await c.route('**/*', route => { const url = new URL(route.request().url()); if (url.hostname === '127.0.0.1') return route.continue(); if (url.hostname.endsWith('.music.126.net')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" rx="16" fill="#243d36"/><circle cx="50" cy="50" r="34" fill="#b7f576"/><circle cx="50" cy="50" r="12" fill="#151a25"/></svg>' }); return route.abort(); }); return c; }
  async function pageIn(c, base = origin) { const p = await c.newPage(); p.on('pageerror', error => errors.push(error.message)); await p.goto(`${base}/#invite=${grant.raw}`); return p; }
  async function identify(p, name) { await p.getByRole('textbox', { name: '点播 ID', exact: true }).fill(name); await p.getByRole('button', { name: '记住并使用此 ID', exact: true }).click(); await p.getByRole('button', { name: 'ID：' + name, exact: true }).waitFor(); }
  async function openSearch(p) { await p.locator('.sidebar nav').getByRole('button', { name: '打开搜索', exact: true }).click(); await p.getByPlaceholder('搜索歌曲、歌手或歌单').waitFor(); }
  async function chooseCommunity(p, mode) { await p.getByRole('button', { name: '添加歌单', exact: true }).click(); await p.locator('.modal').getByRole('button', { name: new RegExp(mode) }).click(); }
  async function addToDraft(p,index) { await p.locator('.playlist-save-trigger').nth(index).click(); await p.locator('.current-draft-target').click(); await p.locator('.playlist-picker').waitFor({state:'detached'}); }
  const aliceContext = await context(); const alice = await pageIn(aliceContext);
  await alice.getByRole('textbox', { name: '点播 ID', exact: true }).focus();
  for (const width of [1360,390]) {
    await alice.setViewportSize({width,height:1000});
    const gap = await alice.evaluate(() => document.querySelector('#request-name-hint').getBoundingClientRect().top - document.querySelector('.identity-form input').getBoundingClientRect().bottom);
    assert.ok(gap >= 10, 'focused input outline must not obscure its helper text');
    await alice.locator('.modal').screenshot({path:resolve(output,`nickname-focus-${width}.png`),animations:'disabled'});
  }
  await alice.setViewportSize({width:1360,height:1000}); await identify(alice, 'Alice');
  assert.equal(await alice.locator('.queue-expanded').count(), 1); assert.equal(await alice.locator('.content').isVisible(), false); assert.equal(await alice.getByRole('separator', {name:'调整播放队列宽度'}).count(), 0);
  await alice.locator('.guest-permissions summary').click(); assert.equal(await alice.locator('.guest-permissions li').count(), 13);
  await alice.getByRole('button', { name: '权限 13', exact: true }).click(); assert.equal(await alice.locator('.permission-feature-list li').count(), 13); await alice.locator('.modal-close').click();
  await alice.screenshot({ path: resolve(output,'queue-empty-desktop.png'), fullPage:true }); await openSearch(alice);
  await alice.getByPlaceholder('搜索歌曲、歌手或歌单').fill('Artist'); await alice.getByRole('button', { name: '搜索', exact: true }).click(); await alice.locator('.song-actions').first().waitFor();
  await alice.locator('.song-actions button[title="加入队列"]').first().click(); await alice.locator('.queue-items').getByText(/Alice 点播/).waitFor();
  await addToDraft(alice,0);
  await alice.locator('.playlist-save-trigger').nth(0).click(); assert.equal(await alice.locator('.current-draft-target').isDisabled(),true); assert.match(await alice.locator('.current-draft-target').innerText(),/已加入/); await alice.locator('.modal-close').click();
  await addToDraft(alice,1);
  // Exercise cleanup of a draft saved by the older version, including its actual browser storage.
  await alice.evaluate(() => { const saved = JSON.parse(localStorage.getItem('tsmd_playlist_draft_v1')); saved.songs.push(saved.songs[0]); localStorage.setItem('tsmd_playlist_draft_v1', JSON.stringify(saved)); });
  await alice.reload(); await alice.getByRole('button', { name: 'ID：Alice', exact: true }).waitFor();
  await chooseCommunity(alice, '自建歌单'); const draft = alice.locator('.community-library');
  assert.equal(await draft.locator('.draft-song-row').count(), 2);
  assert.equal(await alice.evaluate(() => JSON.parse(localStorage.getItem('tsmd_playlist_draft_v1')).songs.length), 2);
  assert.equal(await draft.locator('.draft-song-cover img').count(), 2);
  await alice.waitForFunction(() => [...document.querySelectorAll('.draft-song-cover img')].every(img => img.complete && img.naturalWidth > 0));
  await draft.getByRole('textbox', { name: '自建歌单名称', exact: true }).fill('Alice 的夜间歌单');
  await draft.locator('.draft-song-row').nth(0).dragTo(draft.locator('.draft-song-row').nth(1)); await alice.waitForFunction(() => document.querySelector('.draft-song-title strong')?.textContent === 'Song 1');
  await draft.screenshot({ animations: 'disabled', path: resolve(output, 'builder-desktop.png') }); await draft.getByRole('button', { name: '保存自建歌单并开放', exact: true }).click();
  await alice.getByRole('heading', { name: 'Alice 的夜间歌单', exact: true }).waitFor(); const saved = service.localPlaylists.find(item => item.name === 'Alice 的夜间歌单');
  assert.equal(saved.openedBy, 'Alice'); assert.deepEqual(service.store.localPlaylist(saved.id).songs.map(song => song.id), ['1','0']); assert.equal(queue.length, 1);
  await alice.reload(); await alice.getByRole('button', { name: 'ID：Alice', exact: true }).waitFor(); assert.equal(await alice.getByRole('textbox', { name: '点播 ID', exact: true }).count(), 0);
  assert.equal(await alice.evaluate(() => localStorage.getItem('tsmd_guest_name_v1')), 'Alice');
  await chooseCommunity(alice, '用户歌单');
  await alice.getByRole('textbox', { name: '查找网易云用户', exact: true }).fill('13812345678'); await alice.getByRole('button', { name: '查找用户', exact: true }).click(); await alice.getByRole('alert').filter({hasText:'手机号'}).waitFor();
  await alice.getByRole('textbox', { name: '查找网易云用户', exact: true }).fill('Public'); await alice.getByRole('button', { name: '查找用户', exact: true }).click();
  await alice.locator('.public-user-list button').first().click(); await alice.getByRole('heading', { name: 'Public 42 的公开歌单', exact: true }).waitFor(); assert.equal(await alice.locator('.public-playlist-list article').count(), 1);
  await alice.setViewportSize({ width: 390, height: 844 }); assert.equal(await alice.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await alice.screenshot({ path: resolve(output, 'public-user-phone.png'), fullPage: true, animations: 'disabled' });
  await alice.getByRole('button', { name: '加入开放歌单', exact: true }).click(); await alice.getByText('已加入开放歌单', { exact: false }).waitFor(); assert.equal(service.publications.find(item => item.id === '7').openedBy, 'Alice');
  const getPublicPlaylist = provider.getPublicPlaylist.bind(provider);
  provider.getPublicPlaylist = async id => { const item = await getPublicPlaylist(id); return String(id) === '7' ? { ...item, songs: [...item.songs, item.songs[0]] } : item; };
  await alice.locator('.public-playlist-preview').first().click(); await alice.locator('.playlist-heading').waitFor();
  await alice.getByRole('button', { name: '用此歌单建单', exact: true }).click(); assert.equal(await alice.locator('.draft-song-row').count(), 3); assert.equal(await alice.locator('.guest-playlist-add.active').count(), 1);
  await alice.locator('.notice').filter({ hasText: '已复制 3 首歌曲，跳过 1 首重复歌曲' }).waitFor(); provider.getPublicPlaylist = getPublicPlaylist;
  assert.equal(await alice.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await alice.screenshot({ path: resolve(output, 'builder-phone.png'), fullPage: true });
  await alice.locator('.draft-song-cover img').first().evaluate(img => img.dispatchEvent(new Event('error')));
  await alice.waitForFunction(() => !document.querySelector('.draft-song-cover img'));
  assert.equal(await alice.locator('.draft-song-cover>span').count(), 3, 'failed artwork shows music placeholders');
  const bobContext = await context(); const bob = await pageIn(bobContext); await identify(bob, 'Bob'); await openSearch(bob);
  await bob.getByPlaceholder('搜索歌曲、歌手或歌单').fill('Artist'); await bob.getByRole('button', { name: '搜索', exact: true }).click(); await bob.locator('.song-actions button[title="加入队列"]').nth(1).click();
  await bob.locator('.queue-items').getByText(/Bob 点播/).waitFor(); assert.equal(queue[0].requestedBy, 'Alice'); assert.equal(queue[1].requestedBy, 'Bob');
  assert.equal(await alice.getByRole('button', { name: 'ID：Alice', exact: true }).count(), 1);
  await bob.getByRole('button', { name: '开放歌单', exact: true }).click(); await bob.waitForFunction(() => document.querySelectorAll('.playlist-card').length === 2);
  assert.equal(await bob.locator('.playlist-card>small').filter({ hasText: 'Alice 开放' }).count(), 2); await bob.screenshot({ path: resolve(output, 'opened-by-desktop.png'), fullPage: true });
  await bob.locator('.playlist-grid .playlist-card').filter({hasText:'Alice 的夜间歌单'}).click(); await bob.getByRole('button', { name: '▶ 播放歌单', exact: true }).click(); await bob.locator('.queue-items').getByText(/Bob 点播/).nth(1).waitFor(); assert.ok(queue.every(song => song.requestedBy === 'Bob'));
  otherServer = await createShareServer(service, { persistentInvites: true }); const otherOrigin = await pageIn(aliceContext, `http://127.0.0.1:${otherServer.port}`); await otherOrigin.getByRole('textbox', { name: '点播 ID', exact: true }).waitFor();
  assert.equal(new URL(otherOrigin.url()).hash, '#invite=' + grant.raw, 'fixed server invitation stays bookmarkable');
  assert.equal(new URL(alice.url()).hash, '', 'existing desktop invitation URL handling remains unchanged');
  assert.equal(await otherOrigin.evaluate(() => localStorage.getItem('tsmd_guest_name_v1')), null);
  await otherOrigin.getByRole('button', { name: '使用曾用昵称 Alice', exact: true }).waitFor();
  assert.equal(await otherOrigin.getByRole('button', { name: '使用曾用昵称 Bob', exact: true }).count(), 1);
  await otherOrigin.getByRole('button',{name:'使用曾用昵称 Alice',exact:true}).hover();
  await otherOrigin.waitForFunction(()=>{
    const button=document.querySelector('[aria-label="使用曾用昵称 Alice"]');
    return getComputedStyle(button.parentElement).backgroundColor==='rgb(53, 71, 44)' && getComputedStyle(button).backgroundColor==='rgba(0, 0, 0, 0)';
  });
  await otherOrigin.locator('.modal').screenshot({path:resolve(output,'nickname-history-hover.png'),animations:'disabled'});
  await otherOrigin.locator('.modal').screenshot({ path: resolve(output, 'nickname-history-desktop.png'), animations: 'disabled' });
  await otherOrigin.setViewportSize({ width: 390, height: 844 });
  assert.equal(await otherOrigin.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await otherOrigin.screenshot({ path: resolve(output, 'nickname-history-phone.png'), fullPage: true, animations: 'disabled' });
  await otherOrigin.getByRole('button', { name: '使用曾用昵称 Alice', exact: true }).click(); await otherOrigin.getByRole('button', { name: 'ID：Alice', exact: true }).waitFor();
  assert.equal(await otherOrigin.evaluate(() => localStorage.getItem('tsmd_guest_name_v1')), 'Alice');
  await openSearch(otherOrigin); await otherOrigin.getByPlaceholder('搜索歌曲、歌手或歌单').fill('Artist'); await otherOrigin.getByRole('button', { name: '搜索', exact: true }).click();
  await otherOrigin.locator('.song-actions button[title="加入队列"]').first().click(); await otherOrigin.waitForFunction(() => [...document.querySelectorAll('.queue-items small')].some(el => el.textContent.includes('Alice 点播')));
  assert.equal(queue.at(-1).requestedBy, 'Alice'); assert.equal(await bob.getByRole('button', { name: 'ID：Bob', exact: true }).count(), 1);
  // A longer history remains searchable and usable on narrow screens, including text that must never be interpreted as markup.
  for (const name of ['朋友一','朋友二','朋友三','朋友四','朋友五','朋友六','朋友七','😀'.repeat(32),'<img src=x onerror=alert(1)>']) service.store.rememberVisitorName(name);
  await otherOrigin.getByRole('button', { name: 'ID：Alice', exact: true }).click();
  const history = otherOrigin.getByRole('region', { name: '选择曾用昵称', exact: true });
  await history.getByRole('searchbox', { name: '筛选曾用昵称', exact: true }).waitFor();
  await history.getByRole('searchbox', { name: '筛选曾用昵称', exact: true }).fill('ALICE');
  assert.equal(await history.locator('.guest-history-use').count(), 1);
  await history.getByRole('searchbox', { name: '筛选曾用昵称', exact: true }).fill('没有这个人'); await history.getByRole('status').filter({ hasText: '没有匹配' }).waitFor();
  await history.getByRole('searchbox', { name: '筛选曾用昵称', exact: true }).fill('');
  assert.equal(await history.locator('img').count(), 0); assert.equal(await otherOrigin.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await otherOrigin.screenshot({ path: resolve(output, 'nickname-history-long-phone.png'), fullPage: true, animations: 'disabled' });
  await history.getByRole('button', { name: '删除曾用昵称 朋友一', exact: true }).click();
  await otherOrigin.waitForFunction(() => ![...document.querySelectorAll('.guest-history-use')].some(button => button.textContent === '朋友一'));
  assert.equal(service.store.visitorNames().includes('朋友一'), false); assert.equal(await otherOrigin.getByRole('button', { name: 'ID：Alice', exact: true }).count(), 1);
  await history.getByRole('button', { name: '删除曾用昵称 Alice', exact: true }).click();
  await otherOrigin.waitForFunction(() => ![...document.querySelectorAll('.guest-history-use')].some(button => button.textContent === 'Alice'));
  assert.equal(await otherOrigin.evaluate(() => localStorage.getItem('tsmd_guest_name_v1')), null);
  assert.equal(await otherOrigin.getByRole('button', { name: 'ID：Alice', exact: true }).count(), 1); assert.equal(service.store.visitorNames().includes('Alice'), false);
  await otherOrigin.reload(); await otherOrigin.getByRole('textbox', { name: '点播 ID', exact: true }).waitFor();
  assert.equal(await otherOrigin.getByRole('button', { name: '使用曾用昵称 Alice', exact: true }).count(), 0);
  // Simulate another browser retaining the removed name: automatic identity restoration must not repopulate history.
  await otherOrigin.evaluate(() => localStorage.setItem('tsmd_guest_name_v1', 'Alice')); await otherOrigin.reload();
  await otherOrigin.getByRole('button', { name: 'ID：Alice', exact: true }).waitFor(); assert.equal(service.store.visitorNames().includes('Alice'), false);
  await otherOrigin.getByRole('button', { name: 'ID：Alice', exact: true }).click(); await identify(otherOrigin, 'Alice'); assert.equal(service.store.visitorNames().includes('Alice'), true);
  await alice.setViewportSize({width:1360,height:1000}); await alice.getByRole('button',{name:'播放队列',exact:true}).click(); await alice.locator('.queue-expanded .cover-art').waitFor();
  assert.equal(await alice.locator('.queue-expanded .now-card').isVisible(),true); await alice.screenshot({path:resolve(output,'queue-home-desktop.png'),fullPage:true,animations:'disabled'});
  await alice.setViewportSize({width:390,height:844}); assert.equal(await alice.locator('.queue-expanded .now-card').isVisible(),true); assert.equal(await alice.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false); await alice.screenshot({path:resolve(output,'queue-home-phone.png'),fullPage:true,animations:'disabled'});
  await alice.getByRole('button',{name:'权限 13',exact:true}).click(); assert.equal(await alice.locator('.permission-feature-list li').count(),13); await alice.screenshot({path:resolve(output,'permission-list-phone.png'),fullPage:true}); await alice.locator('.modal-close').click();
  assert.equal(await alice.locator('.guest-playlists>button').last().getAttribute('aria-label'),'添加歌单');
  const ownerContext = await context(); const owner = await ownerContext.newPage(); owner.on('pageerror',error=>errors.push(error.message));
  await owner.exposeFunction('desktopRpc',(method,args)=>service.rpc(method,args));
  await owner.addInitScript(()=>{window.musicDesk={rpc:(...args)=>window.desktopRpc(...args),subscribe:()=>()=>{},resources:async()=>({paused:true}),copy:async()=>true,quit(){}};});
  await owner.goto(origin); await owner.getByRole('button',{name:'开放歌单',exact:true}).click();
  await owner.locator('.playlist-grid .playlist-card').filter({hasText:'Alice 的夜间歌单'}).click(); await owner.getByRole('button',{name:'编辑歌单',exact:true}).click();
  await owner.getByRole('textbox',{name:'自建歌单名称',exact:true}).fill('Alice 的夜间歌单（已编辑）'); await owner.locator('.draft-song-row').nth(0).dragTo(owner.locator('.draft-song-row').nth(1));
  await owner.getByRole('button',{name:'保存歌单修改',exact:true}).click(); await owner.getByRole('heading',{name:'Alice 的夜间歌单（已编辑）',exact:true}).waitFor();
  assert.equal(service.store.localPlaylist(saved.id).openedBy,'Alice'); assert.deepEqual(service.store.localPlaylist(saved.id).songs.map(song=>song.id),['0','1']); assert.equal(service.localPlaylists.length,1);
  await owner.getByRole('button',{name:'编辑歌单',exact:true}).click(); await owner.locator('.community-library').screenshot({path:resolve(output,'owner-edit-desktop.png'),animations:'disabled'});
  await owner.getByRole('button',{name:'打开搜索',exact:true}).click(); await owner.getByPlaceholder('搜索歌曲、歌手或歌单').fill('Artist'); await owner.locator('.search-box').getByRole('button',{name:'搜索',exact:true}).click();
  await addToDraft(owner,2); await owner.getByRole('button',{name:'自建歌单',exact:true}).click(); assert.equal(await owner.locator('.draft-song-row').count(),3);
  await owner.reload(); await owner.getByRole('button',{name:'自建歌单',exact:true}).click(); assert.equal(await owner.locator('.draft-song-row').count(),3); await owner.getByRole('button',{name:'保存歌单修改',exact:true}).click(); await owner.getByRole('heading',{name:'Alice 的夜间歌单（已编辑）',exact:true}).waitFor();
  assert.deepEqual(service.store.localPlaylist(saved.id).songs.map(song=>song.id),['0','1','2']); assert.equal(service.localPlaylists.length,1); assert.equal(service.store.localPlaylist(saved.id).openedBy,'Alice');
  await bob.getByRole('button',{name:'开放歌单',exact:true}).click(); await bob.locator('.playlist-grid .playlist-card').filter({hasText:'Alice 的夜间歌单'}).click(); await bob.getByRole('button',{name:'编辑歌单',exact:true}).waitFor();
  await bob.getByRole('button',{name:'用此歌单建单',exact:true}).click(); await bob.getByRole('textbox',{name:'自建歌单名称',exact:true}).fill('Bob 的副本'); await bob.getByRole('button',{name:'保存自建歌单并开放',exact:true}).click(); await bob.getByRole('heading',{name:'Bob 的副本',exact:true}).waitFor();
  assert.equal(service.localPlaylists.length,2); assert.equal(service.localPlaylists.find(p=>p.name==='Bob 的副本').openedBy,'Bob'); assert.equal(service.store.localPlaylist(saved.id).name,'Alice 的夜间歌单（已编辑）');
  service.authority.update(grant.id, ['view','search','playlist']); server.broadcast();
  await bob.getByRole('button',{name:'权限 3',exact:true}).waitFor(); await bob.getByRole('button',{name:'权限 3',exact:true}).click(); assert.deepEqual(await bob.locator('.permission-feature-list li').allTextContents(),['✓查看播放','✓搜索歌曲','✓切换开放歌单']); await bob.locator('.modal-close').click();
  await chooseCommunity(bob, '用户歌单'); await bob.getByRole('textbox', { name: '查找网易云用户', exact: true }).fill('Public'); await bob.getByRole('button', { name: '查找用户', exact: true }).click(); await bob.locator('.public-user-list button').first().click();
  assert.equal(await bob.getByRole('button', { name: '加入开放歌单', exact: true }).count(), 0); assert.equal(await bob.locator('.sidebar nav').getByRole('button', { name: '自建歌单', exact: true }).count(), 1);await bob.locator('.sidebar nav').getByRole('button',{name:'自建歌单',exact:true}).click();assert.equal(await bob.getByRole('tab',{name:'编辑歌单',exact:true}).count(),0);assert.equal(await bob.getByRole('tab',{name:'用户搜索',exact:true}).getAttribute('aria-selected'),'true');
  assert.deepEqual(errors, []); assert.equal(provider.getCookie(), 'owner-fixture-cookie');
  const report = { queueLandingDefault: true, queueLandingMobileCoverVisible: true, sidebarNavigationAndPlaylistPlus: true, exactPermissionListAndLiveUpdates: true, nativeDraftDragSorting: true, ownerCanEditSavedPlaylist: true, editingDraftSurvivesNavigationAndReload: true, visitorMayEditOrSaveCopy: true, nicknameRemembered: true, identitiesIndependentOnSameLink: true, queueAttribution: true, publicUserSearch: true, phoneRejected: true, privateListsFiltered: true, publicPlaylistOpened: true, songBuilderAndOrder: true, duplicateDraftAddPrevented: true, legacyDraftDuplicatesCleaned: true, copiedPlaylistDuplicatesSkipped: true, draftArtworkLoaded: true, failedArtworkHasPlaceholder: true, openedByAttribution: true, sharedSavedPlaylistPlayback: true, mobileNoOverflow: true, permissionsApplied: true, differentOriginCanChooseSavedName: true, chosenNameRememberedAndAttributed: true, nicknameHistorySearchAndEscaping: true, nicknameHistoryCanDelete: true, deletingHistoryPreservesCurrentIdentity: true, removedNameNotRestoredByReload: true, removedNameCanBeExplicitlySavedAgain: true, ownerCookieNotUsedByPublicLookup: true, realAccountUsed: false, realTSConnected: false, publicNetworkUsed: false, electronLaunched: false };
  writeFileSync(resolve(output,'result.json'), JSON.stringify(report,null,2)+'\n'); console.log(JSON.stringify(report,null,2));
} finally { await browser?.close(); otherServer?.close(); server?.close(); await service?.close(); }

