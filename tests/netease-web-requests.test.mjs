import test from 'node:test';
import assert from 'node:assert/strict';
import { neteaseWebRequest } from '../src/worker/netease-web-requests.mjs';
import { probeWebRequests } from '../scripts/check-netease-web-requests.mjs';
import { neteaseMaintainedRequest, MAINTAINED_NETEASE_MODULE, validateNeteaseSourceIP } from '../src/worker/netease-library.mjs';

test('web compatibility is opt-in and preserves the login, quality and explicit API protocol', () => {
  const args = { cookie: 'private', level: 'lossless' };
  assert.equal(neteaseWebRequest('song_url_v1', args), args);
  assert.deepEqual(neteaseWebRequest('song_url_v1', args, true), { ...args, crypto: 'weapi' });
  assert.equal(neteaseWebRequest('login_qr_create', args, true), args);
  const explicit = { crypto: 'eapi', ...args }; assert.equal(neteaseWebRequest('song_url_v1', explicit, true), explicit);
});

test('maintained library adapter retains account and quality and avoids uninitialized xeapi',()=>{
  const args={id:'123',level:'lossless',cookie:'private'};
  assert.equal(neteaseMaintainedRequest('song_url_v1',args,false),args);
  assert.deepEqual(neteaseMaintainedRequest('song_url_v1',args),{...args,crypto:'eapi'});
  assert.equal(neteaseMaintainedRequest('cloudsearch',args),args);
  assert.equal(neteaseMaintainedRequest('song_url_v1',{...args,crypto:'weapi'}).crypto,'weapi');
  assert.match(MAINTAINED_NETEASE_MODULE,/^runtime\/netease-api-4\.41\.1\/node_modules\//);
});

test('source attribution is opt-in, rejects malformed/private addresses and cannot change account or quality', () => {
  const args = { id: '123', level: 'lossless', cookie: 'private' };
  assert.equal(neteaseMaintainedRequest('cloudsearch', args, false, '203.0.113.10'), args);
  assert.deepEqual(neteaseMaintainedRequest('song_url_v1', args, true, '203.0.113.10'), { ...args, crypto: 'eapi', realIP: '203.0.113.10', randomCNIP: false });
  for (const invalid of ['127.0.0.1', '10.0.0.1', '169.254.1.2', '192.168.1.2', '172.16.1.1', '255.255.255.255', '203.0.113.10\r\nX-Test: 1', 'example.com']) assert.throws(() => validateNeteaseSourceIP(invalid));
});

function fake({ failSearch = false, urlCode = 200 } = {}) {
  const calls = [];
  const raw = {};
  for (const method of ['cloudsearch', 'personalized', 'login_qr_key', 'login_qr_create', 'song_url_v1', 'playlist_track_all', 'login_qr_check']) raw[method] = async args => {
    calls.push([method, args]);
    if (method === 'cloudsearch' && failSearch) throw { status: 400, body: { code: -462, msg: 'PRIVATE_COOKIE' } };
    const body = { code: 200 };
    if (method === 'cloudsearch') body.result = { songs: [{ id: '123', fee: 0 }] };
    if (method === 'personalized') body.result = [{ id: '456' }];
    if (method === 'login_qr_key') body.data = { unikey: 'PRIVATE_KEY' };
    if (method === 'login_qr_create') body.data = { qrurl: 'https://music.163.com/login?codekey=PRIVATE_KEY', qrimg: 'data:image/png;base64,PRIVATE_IMAGE' };
    if (method === 'song_url_v1') { body.code = urlCode; body.data = [{ url: 'https://private.example/MUSIC_U=PRIVATE_COOKIE' }]; }
    if (method === 'login_qr_check') body.code = 801;
    return { status: 200, body };
  };
  return { raw, calls };
}

test('compatibility preflight verifies search, QR, song URL and playlist requests without exposing credentials', async () => {
  const { raw, calls } = fake();
  const result = await probeWebRequests(raw, neteaseWebRequest, 'MUSIC_U=PRIVATE_COOKIE');
  assert.equal(result.candidatePassed, true); assert.equal(result.extra[0].playableUrlReturned, true);
  for (const [method, args] of calls) {
    if (!method.startsWith('login_qr_')) assert.equal(args.cookie, 'MUSIC_U=PRIVATE_COOKIE');
    else assert.equal(Object.hasOwn(args, 'cookie'), false);
    assert.equal(args.crypto, method === 'login_qr_create' ? undefined : 'weapi');
  }
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|MUSIC_U|private.example/);
});

test('a search or playback API failure cannot pass preflight or retry the failed request', async () => {
  const failed = fake({ failSearch: true }); const result = await probeWebRequests(failed.raw, neteaseWebRequest);
  assert.equal(result.candidatePassed, false); assert.equal(failed.calls.filter(([name]) => name === 'cloudsearch').length, 3);
  assert.ok(!failed.calls.some(([name]) => name === 'song_url_v1'));
  const denied = fake({ urlCode: 403 }); assert.equal((await probeWebRequests(denied.raw, neteaseWebRequest)).candidatePassed, false);
});

test('source-IP preflight stops after the first rejection without QR or repeated search requests', async () => {
  const { raw, calls } = fake({ failSearch: true });
  const transform = (method, args) => neteaseMaintainedRequest(method, args, true, '203.0.113.10');
  const result = await probeWebRequests(raw, transform, '', { stopOnFailure: true });
  assert.equal(result.candidatePassed, false);
  assert.deepEqual(calls.map(([method]) => method), ['cloudsearch']);
  assert.equal(calls[0][1].realIP, '203.0.113.10');
  assert.equal(result.qrLogin.category, 'not-tested-after-failure');
});

test('source-IP preflight verifies every required operation when requests succeed', async () => {
  const { raw, calls } = fake();
  const result = await probeWebRequests(raw, (method, args) => neteaseMaintainedRequest(method, args, true, '203.0.113.10'), '', { stopOnFailure: true });
  assert.equal(result.candidatePassed, true);
  for (const [, args] of calls) { assert.equal(args.realIP, '203.0.113.10'); assert.equal(args.randomCNIP, false); }
  assert.equal(calls.filter(([name]) => name === 'cloudsearch').length, 3);
});
