import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import koffi from 'koffi';

// Actual app HTTP/auth/SQLite and browser UI, fake metadata/playback, no real account or TS.
process.env.TSMD_DATA_DIR = resolve('work/playlist-browser-data-' + randomUUID());
const [{ Service }, { createShareServer }, { createVault }] = await Promise.all([import('../src/worker/service.mjs'), import('../src/worker/share-server.mjs'), import('../src/shared/security.mjs')]);
if (process.platform === 'win32') koffi.load('kernel32.dll').func('uint32 __stdcall SetErrorMode(uint32)')(0x8003);
const output = resolve('work/playlist-features-browser'); mkdirSync(output, { recursive: true });
const key = randomBytes(32); const errors = [];
const track = (id, popularity = 50) => ({ id: String(id), entryId: 'entry-' + id, name: '歌曲 ' + id, artist: '测试歌手', artists: [{ id: '99', name: '测试歌手' }], album: '一起听', duration: 180, coverUrl: 'http://p5.music.126.net/cover.svg', popularity, url: 'https://private.invalid/?token=media-secret' });
let queue = [track(1, 20), track(2, 90), track(3, 50)];
const core = { init: async () => {}, close() {}, health: () => ({}), status: () => ({ connected: true, playing: true, currentSong: queue[0], queue, revision: 4, volume: 35, playMode: 'seq', elapsed: 40 }), exportQueue: async () => queue, auth: { loggedIn: false },
  provider: { search: async () => ({ songs: queue, playlists: [] }), getUserPlaylists: async () => [], getRecommendPlaylists: async () => [], getPlaylistDetail: async id => ({ id, name: '记住的网易云歌单', songCount: 30, coverUrl: 'https://p7.music.126.net/list.svg' }),
    getArtistPage: async (id, order, offset) => ({ artist: { id, name: '测试歌手', coverUrl: 'https://p10.music.126.net/artist.svg', description: '热门与最新歌曲，可加入当前播放队列。' }, order, more: offset === 0, songs: [track((order === 'time' ? 200 : 100) + offset)] }) } };
let service; let server; let browser;
async function start() { service = new Service(createVault(key), () => server?.broadcast(), { createCore: () => core }); await service.init(); service.phase = 'running'; service.authority.beginRun(); server = await createShareServer(service); return `http://127.0.0.1:${server.port}`; }
async function stop() { const closing = server; server = undefined; closing?.close(); await service?.close(); }
try {
  let origin = await start();
  await service.rpc('playlist.publish', { id: '123' });
  const executablePath = [process.env.TSMD_BROWSER_PATH, chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path => path && existsSync(path));
  browser = await chromium.launch({ executablePath, headless: true }); const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1360, height: 1000 } });
  await context.route('**/*', route => {
    const url = new URL(route.request().url()); if (url.hostname === '127.0.0.1') return route.continue();
    if (url.hostname.endsWith('.music.126.net')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" rx="14" fill="#304a39"/><circle cx="50" cy="50" r="35" fill="#b7f576"/><circle cx="50" cy="50" r="12" fill="#151a25"/></svg>' });
    return route.abort();
  });
  async function owner(legacy = false) {
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('desktopRpc', async (method, args) => { const value = await service.rpc(method, args); if (legacy && method === 'status') return { ...value, capabilities: undefined, localPlaylists: undefined }; return value; });
    await page.addInitScript(() => { window.musicBot = { rpc: (...args) => window.desktopRpc(...args), subscribe: () => () => {}, resources: async () => ({ paused: true }), copy: async () => true, quit() {} }; });
    await page.goto(origin); await page.getByRole('button', { name: '保存', exact: true }).waitFor(); return page;
  }
  const old = await owner(true); await old.getByRole('button', { name: '保存', exact: true }).click();
  assert.equal(await old.getByRole('button', { name: '保存并开放', exact: true }).isDisabled(), true);
  const downloaded = old.waitForEvent('download'); await old.getByRole('button', { name: '导出当前队列', exact: true }).click(); const download = await downloaded;
  const backup = resolve(output, 'current-queue-backup.json'); await download.saveAs(backup);
  const file = JSON.parse(readFileSync(backup, 'utf8')); assert.equal(file.songs.length, 3); assert.equal(file.openPlaylists.length, 1); assert.equal(JSON.stringify(file).includes('media-secret'), false);
  await old.screenshot({ path: resolve(output, 'legacy-backup.png'), fullPage: true }); await old.close();

  const page = await owner(); await page.getByRole('button', { name: /音乐与歌单/ }).click();
  await page.getByPlaceholder('搜索歌曲、歌手或歌单').fill('歌手'); await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByRole('button', { name: '人气优先', exact: true }).click(); assert.equal(await page.locator('.song-title strong').first().innerText(), '歌曲 2');
  await page.locator('.artist-link').first().click(); await page.locator('.artist-heading').waitFor(); await page.getByRole('button', { name: '最新歌曲', exact: true }).click();
  await page.getByRole('button', { name: '加载更多歌手歌曲', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('.song-list .song-title').length === 2);
  await page.screenshot({ path: resolve(output, 'artist-desktop.png'), fullPage: true }); await page.getByRole('button', { name: '← 返回上一页', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click(); const name = page.getByRole('textbox', { name: '歌单名称', exact: true }); assert.match(await name.inputValue(), /^\d{4}-\d{2}-\d{2}/);
  await name.fill('今晚一起听');await page.getByRole('textbox',{name:'歌单简介',exact:true}).fill('本机保存的简介\n第二行'); await page.screenshot({ path: resolve(output, 'save-queue.png'), fullPage: true }); await page.getByRole('button', { name: '保存并开放', exact: true }).click();
  await page.getByRole('heading', { name: '今晚一起听', exact: true }).waitFor(); assert.equal(queue.length, 3); assert.equal(service.localPlaylists.length, 1);
  const savedId = service.localPlaylists[0].id;assert.equal(service.store.localPlaylist(savedId).description,'本机保存的简介\n第二行'); queue = [...queue, track(4, 80)]; await page.reload(); await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByLabel('保存方式', { exact: true }).selectOption(savedId);assert.equal(await page.getByRole('textbox',{name:'歌单简介',exact:true}).inputValue(),'本机保存的简介\n第二行'); assert.equal(await page.getByLabel('歌单名称', { exact: true }).inputValue(), '今晚一起听');
  await page.getByRole('button', { name: '更新并开放', exact: true }).click(); await page.getByRole('heading', { name: '今晚一起听', exact: true }).waitFor(); assert.equal(service.store.localPlaylist(savedId).songCount, 4);
  await page.locator('input[type=file]').setInputFiles(backup); await page.waitForFunction(() => document.querySelector('.playlist-heading h2')?.textContent !== '今晚一起听'); assert.equal(service.localPlaylists.length, 2);
  await page.getByRole('button', { name: '开放歌单', exact: true }).click(); await page.screenshot({ path: resolve(output, 'saved-library.png'), fullPage: true });
  await service.rpc('playlist.publish', { id: '123' }); const oldGrant = service.authority.create('Old friend', ['view', 'search', 'playlist']);
  const oldToken = oldGrant.raw; await page.close(); await stop(); origin = await start(); assert.equal(service.publications.length, 3); assert.throws(() => service.authority.exchange(oldToken));
  const newGrant = service.authority.create('New friend', ['view', 'search', 'playlist']);
  const friend = await context.newPage(); friend.on('pageerror', error => errors.push(error.message)); await friend.goto(`${origin}/#invite=${newGrant.raw}`);
  await friend.getByRole('textbox', { name: '点播 ID', exact: true }).fill('测试访客'); await friend.getByRole('button', { name: '记住并使用此 ID', exact: true }).click();
  await friend.getByRole('button', { name: '开放歌单', exact: true }).click(); await friend.waitForFunction(() => document.querySelectorAll('.playlist-card').length === 3);
  assert.equal(await friend.locator('.playlist-remove').count(), 0, 'shared visitors do not gain playlist removal controls');
  assert.equal(await friend.getByRole('button', { name: '保存', exact: true }).count(), 0); await friend.locator('.playlist-grid .playlist-card').filter({hasText:'今晚一起听'}).click(); await friend.locator('.playlist-heading').waitFor();
  assert.equal(await friend.locator('.song-list .song-title').count(), 4); await friend.setViewportSize({ width: 390, height: 844 });
  assert.equal(await friend.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await friend.screenshot({ path: resolve(output, 'shared-library-phone.png'), fullPage: true });
  const host = await owner(); await host.getByRole('button', { name: /分享控制/ }).click();
  assert.equal(await host.locator('.grant-form').getByRole('checkbox', { name: '保存 / 编辑开放歌单', exact: true }).isChecked(), true);
  const savePermission = host.locator('.grant-card').getByRole('checkbox', { name: '保存 / 编辑开放歌单', exact: true });
  assert.equal(await savePermission.isChecked(), false, 'existing grants do not gain the new permission');
  await savePermission.check(); await friend.getByRole('button', { name: '保存', exact: true }).waitFor();
  await friend.getByRole('button', { name: '保存', exact: true }).click();
  const friendName = friend.getByRole('textbox', { name: '歌单名称', exact: true });
  assert.match(await friendName.inputValue(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(await friend.getByLabel('保存方式', { exact: true }).count(), 0);
  assert.equal(await friend.getByRole('button', { name: '导出当前队列', exact: true }).count(), 0);
  await savePermission.uncheck();
  await friend.waitForFunction(() => document.querySelector('.save-playlist-form .primary')?.disabled);
  const rejected = await friend.evaluate(async () => (await fetch('/api/share/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TSMD-CSRF': sessionStorage.getItem('tsmd_csrf') }, body: JSON.stringify({ method: 'playlist.saveQueue', args: {}, id: crypto.randomUUID() }) })).json());
  assert.equal(rejected.ok, false); assert.match(rejected.error, /权限/); assert.equal(service.localPlaylists.length, 2);
  await savePermission.check(); await friend.waitForFunction(() => document.querySelector('.save-playlist-form .primary')?.disabled === false);
  await friendName.fill('朋友保存的一起听');await friend.getByRole('textbox',{name:'歌单简介',exact:true}).fill('网页保存的队列简介'); await friend.screenshot({ path: resolve(output, 'friend-save-phone.png'), fullPage: true });
  await friend.getByRole('button', { name: '保存并开放', exact: true }).click(); await friend.getByRole('heading', { name: '朋友保存的一起听', exact: true }).waitFor();
  assert.equal(service.localPlaylists.length, 3); assert.equal(queue.length, 4); assert.equal(service.store.localPlaylist(savedId).songCount, 4);
  await friend.getByRole('button', { name: '开放歌单', exact: true }).click(); await friend.waitForFunction(() => document.querySelectorAll('.playlist-card').length === 4);
  assert.equal(await friend.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await friend.screenshot({ path: resolve(output, 'friend-saved-library-phone.png'), fullPage: true });
  await host.close(); await friend.close(); await stop(); origin = await start();
  assert.ok(service.publications.some(item => item.name === '朋友保存的一起听'));
  const admin = await owner(); await admin.getByRole('button', { name: /音乐与歌单/ }).click(); await admin.getByRole('button', { name: '开放歌单', exact: true }).click();
  assert.equal(await admin.locator('.playlist-remove').count(), 4);
  await admin.screenshot({ path: resolve(output, 'open-playlist-delete.png'), fullPage: true, animations: 'disabled' });
  await admin.getByRole('button', { name: '从开放歌单移除 记住的网易云歌单', exact: true }).click();
  await admin.waitForFunction(() => document.querySelectorAll('.playlist-card').length === 3);
  assert.ok(!service.publications.some(item => item.id === '123')); assert.equal(service.localPlaylists.length, 3); assert.equal(queue.length, 4);
  assert.equal(await admin.locator('.playlist-heading').count(), 0, 'removing a card does not open its detail page');
  await admin.getByRole('button', { name: '删除歌单 今晚一起听', exact: true }).click();await admin.locator('.modal').getByRole('button',{name:'删除歌单',exact:true}).click();await admin.waitForFunction(() => document.querySelectorAll('.playlist-card').length === 2);
  assert.throws(()=>service.store.localPlaylist(savedId),/不存在/); assert.equal(queue.length, 4);
  await admin.getByRole('button', { name: '本地歌单', exact: true }).click(); assert.equal(await admin.getByRole('button', { name: /今晚一起听/ }).count(), 0);
  assert.equal(await admin.locator('.playlist-remove').count(), 0, 'the shortcut is restricted to the open-playlist page');
  await admin.close(); await stop(); origin = await start(); assert.ok(!service.publications.some(item => item.id === '123' || item.id === savedId)); assert.throws(()=>service.store.localPlaylist(savedId),/不存在/);
  assert.deepEqual(errors, []);
  const report = { desktopQueueIntroductionSaved: true, introductionRestoredWhenUpdatingQueueSnapshot: true, webQueueIntroductionSupported: true, legacyQueueExportedWithoutRestart: true, exportedSongs: 3, importedAndShared: true, saveAndUpdate: true, searchPopularity: true, artistHotLatestAndPaging: true, persistentAfterServiceRestart: true, newLinkKeepsPublishedPlaylists: true, oldLinkInvalid: true, newGrantsDefaultSave: true, existingGrantsUnchanged: true, friendSaveWithPermission: true, revokeDuringSaveDialog: true, queueSaveCreatesNewSnapshot: true, friendSavedPlaylistPersists: true, ownerCanRemoveOpenCardsDirectly: true, removeDoesNotOpenDetail: true, localSnapshotDeletionConfirmed: true, playbackQueueRetained: true, removalPersistsAfterRestart: true, viewOnlyVisitorsCannotRemoveOpenCards: true, mobileNoOverflow: true, realAccountUsed: false, realTSConnected: false, publicNetworkUsed: false, electronLaunched: false };
  writeFileSync(resolve(output, 'result.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); await stop(); }

