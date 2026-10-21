import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import koffi from 'koffi';
import { ShareAuthority } from '../src/shared/security.mjs';
import { createShareServer } from '../src/worker/share-server.mjs';

// Synthetic metadata and intercepted image bytes only: no real account, TS connection or public tunnel.
if (process.platform === 'win32') koffi.load('kernel32.dll').func('uint32 __stdcall SetErrorMode(uint32)')(0x8003);
const output = resolve('work/shared-artwork-check'); mkdirSync(output, { recursive: true });
const authority = new ShareAuthority(); authority.beginRun();
const permissions = ['view', 'search', 'add', 'playlist'];
const grant = authority.create('Artwork check', permissions);
const covers = ['http://p1.music.126.net/search-1.svg?param=80y80', 'https://p5.music.126.net/search-2.svg', '//p6.music.126.net/search-3.svg', 'https://p10.music.126.net/search-4.svg'];
const songs = covers.map((coverUrl, i) => ({ id: String(i + 1), entryId: 'entry-' + i, name: '歌曲封面 ' + (i + 1), artist: '测试歌手', album: '封面加载检查', duration: 180, coverUrl }));
const playlist = { id: 'test-list', name: '相关歌单封面', coverUrl: 'http://p7.music.126.net/playlist.svg', songCount: songs.length, songs };
const state = { ready: true, phase: 'running', runId: authority.runId, permissions, title: '分享封面检查', player: { connected: true, playing: true, volume: 35, elapsed: 20, playMode: 'seq', currentSong: songs[0], queue: songs, revision: 1 } };
const service = {
  authority, snapshot: () => state,
  async rpc(method, args, access) {
    authority.authenticate(access.session, method === 'music.search' ? 'search' : 'view', access.csrf);
    if (method === 'status') return state;
    if (method === 'music.search') return { songs, playlists: [playlist] };
    if (method === 'playlist.detail' && args.id === playlist.id) return playlist;
    throw new Error('Unexpected synthetic RPC');
  }
};
const server = await createShareServer(service);
const origin = `http://127.0.0.1:${server.port}`;
const oldPolicy = "default-src 'self'; img-src 'self' data: https://p1.music.126.net https://p2.music.126.net https://p3.music.126.net https://p4.music.126.net";
const legacy = createServer((_request, response) => response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': oldPolicy }).end('<!doctype html><img src="https://p5.music.126.net/legacy.svg" alt="legacy">'));
await new Promise(accept => legacy.listen(0, '127.0.0.1', accept));
const legacyOrigin = `http://127.0.0.1:${legacy.address().port}`;
let browser;
try {
  const executablePath = [process.env.TSMD_BROWSER_PATH, chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path => path && existsSync(path));
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  const imageRequests = []; const errors = []; const violations = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin || url.origin === legacyOrigin) return route.continue();
    if (url.protocol === 'https:' && url.hostname.endsWith('.music.126.net')) {
      imageRequests.push(url.href);
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="12" fill="#78a947"/><circle cx="40" cy="40" r="24" fill="#b8f56d"/><circle cx="40" cy="40" r="8" fill="#151b28"/></svg>' });
    }
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(legacyOrigin);
  await page.waitForFunction(() => document.querySelector('img').complete);
  assert.equal(await page.locator('img').evaluate(img => img.naturalWidth), 0, 'the old policy blocks valid p5 artwork');
  assert.equal(imageRequests.length, 0);

  await page.exposeFunction('recordArtworkViolation', value => violations.push(value));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => window.recordArtworkViolation({ directive: event.effectiveDirective, uri: event.blockedURI })));
  await page.goto(`${origin}/#invite=${grant.raw}`);
  await page.getByPlaceholder('搜索歌曲、歌手或歌单').fill('封面');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.song-title img').length === 4 && [...document.querySelectorAll('.song-title img')].every(img => img.complete && img.naturalWidth > 0));
  assert.ok((await page.locator('.song-title img').evaluateAll(images => images.map(img => img.src))).every(url => url.startsWith('https://')));
  assert.ok(await page.locator('.cover-art img').evaluate(img => img.complete && img.naturalWidth > 0));
  await page.screenshot({ path: resolve(output, 'shared-search-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: /相关歌单/ }).click();
  await page.waitForFunction(() => document.querySelector('.playlist-card img')?.naturalWidth > 0);
  await page.locator('.playlist-card').click();
  await page.waitForFunction(() => document.querySelector('.playlist-heading img')?.naturalWidth > 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.song-title img').first().scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('.song-title img')?.naturalWidth > 0);
  await page.screenshot({ path: resolve(output, 'shared-playlist-phone.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(violations, [], 'all legitimate artwork passes the production CSP');
  const hostile = 'https://p1.music.126.net.attacker.invalid/blocked.svg';
  await page.evaluate(url => { const img = new Image(); img.src = url; document.body.append(img); }, hostile);
  await page.waitForFunction(() => [...document.images].some(img => img.src.includes('attacker.invalid') && img.complete && img.naturalWidth === 0));
  assert.ok(violations.some(item => item.directive === 'img-src' && item.uri === hostile), 'lookalike domains remain blocked');
  assert.deepEqual(errors, []);
  const report = { legacyP5Blocked: true, sharedSearchArtworkLoaded: true, httpsUpgraded: true, playlistArtworkLoaded: true, mobileArtworkLoaded: true, lookalikeHostBlocked: true, requestedCdnHosts: [...new Set(imageRequests.map(url => new URL(url).hostname))], publicNetworkUsed: false, realAccountUsed: false, electronLaunched: false };
  writeFileSync(resolve(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); server.close(); await new Promise(accept => legacy.close(accept)); authority.endRun(); }
