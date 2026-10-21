import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { observeChannelJoins } from '../src/worker/channel-joins.mjs';
const core = resolve('vendor/teamspeak-music-bot-1.13.2');
const { ChannelView } = await import(pathToFileURL(resolve(core, 'dist/ts-protocol/channel-view.js')).href);
const { TS3Client, escapeTS3 } = await import(pathToFileURL(resolve(core, 'dist/ts-protocol/client.js')).href);
const { DirectVoiceEndpointResolver, TrackingVoiceEndpointResolver } = await import(pathToFileURL(resolve(core, 'dist/ts-protocol/voice-endpoint.js')).href);
const { ServerError } = createRequire(resolve(core, 'package.json'))('@honeybbq/teamspeak-client');
const { Client: SDKClient } = await import(pathToFileURL(resolve(core, 'node_modules/@honeybbq/teamspeak-client/dist/index.mjs')).href);
const silent = { info() {}, warn() {}, error() {}, debug() {} };
function stub(respond) {
  const ts = new TS3Client({ host: 'localhost', port: 9987, queryPort: 10011, nickname: 'Test' }, silent);
  const calls = []; ts.clientId = 12;
  ts.client = { clientID: () => 12, channelID: () => 0n, execCommand: async command => { calls.push(command); return respond(command); } };
  ts.channelView.observeText(`channellist cid=39 cpid=0 channel_name=${escapeTS3('🎸 音乐频道')}`);
  return { ts, calls };
}
test('welcome channel view parses Unicode, escaped names, multiple rows and moves', () => {
  const view = new ChannelView();
  view.observeText(`channellist cid=1 cpid=0 channel_name=大厅|cid=39 cpid=1 channel_name=${escapeTS3('🎸 音乐 | 频道')}`);
  assert.equal(view.resolve('大厅/🎸 音乐 | 频道').id, '39');
  view.observeText('clientlist clid=12 cid=39|clid=20 cid=1'); assert.equal(view.clientChannel(12), '39');
  view.observeText('notifyclientmoved clid=12 ctid=1'); assert.equal(view.clientChannel(12), '1');
  view.observeText('notifychanneldeleted cid=39'); assert.equal(view.list().length, 1);
  view.observeText('notifyclientleftview clid=12'); assert.equal(view.clientChannel(12), undefined);
});

test('actual SDK packet parsing preserves ctid arrivals through the TS wrapper and repeated leave/re-enter events', async () => {
  const originalConnect = SDKClient.prototype.connect; const originalWait = SDKClient.prototype.waitConnected;
  const ts = new TS3Client({ host: '127.0.0.1', port: 9987, queryPort: 10011, nickname: 'ReplayBot', serverProtocol: 'ts3' }, silent);
  const packet = text => ({ typeFlagged: 2, data: Buffer.from(text) });
  const settle = () => new Promise(resolve => setImmediate(resolve)); let stop;
  // Replace dialing only. The actual SDK parser, wrapper event handlers and packet view remain in use; no socket is opened.
  SDKClient.prototype.connect = function () {
    queueMicrotask(() => this.handler.onPacket(packet('notifycliententerview clid=99 ctid=1 client_nickname=ReplayBot client_unique_identifier=self client_type=0')));
    return Promise.resolve();
  };
  SDKClient.prototype.waitConnected = async () => {};
  try {
    await ts.connect(); await settle(); assert.equal(ts.getChannelId(), 1n); assert.equal(ts.getClientId(), 99);
    const joins = []; const forwarded = []; ts.on('clientEnter', info => forwarded.push(info)); stop = observeChannelJoins(ts, event => joins.push(event));
    const receive = async text => { ts.client.handler.onPacket(packet(text)); await settle(); };
    await receive('notifycliententerview clid=7 cfid=2 ctid=1 reasonid=0 client_nickname=Fixture client_unique_identifier=fixture client_type=0');
    assert.equal(forwarded.at(-1).channelID, 1n, 'ctid is the destination of enter-view notifications'); assert.deepEqual(joins, [{ channelId: '1' }]);
    await receive('notifyclientleftview clid=7 cfid=1 ctid=2 reasonid=0');
    await receive('notifycliententerview clid=7 cfid=2 ctid=1 reasonid=0 client_nickname=Fixture client_unique_identifier=fixture client_type=0');
    assert.equal(joins.length, 2);
    await receive('notifyclientmoved clid=7 ctid=2 reasonid=0'); await receive('notifyclientmoved clid=7 ctid=1 reasonid=0'); assert.equal(joins.length, 3);
    await receive('notifycliententerview clid=8 ctid=2 client_nickname=Other client_unique_identifier=other client_type=0');
    await receive('notifycliententerview clid=9 ctid=1 client_nickname=Query client_unique_identifier=query client_type=1'); assert.equal(joins.length, 3);
    await receive('notifycliententerview clid=10 cid=1 client_nickname=Legacy client_unique_identifier=legacy client_type=0'); assert.equal(joins.length, 4);
  } finally { stop?.(); ts.client?.handler.close(); SDKClient.prototype.connect = originalConnect; SDKClient.prototype.waitConnected = originalWait; }
});
test('already in target channel connects and lists visible channels without any Query permission', async () => {
  const { ts, calls } = stub(() => { throw new ServerError('2568', 'insufficient client permissions'); });
  ts.channelView.observeText('clientlist clid=12 cid=39');
  await ts.joinChannel('🎸 音乐频道');
  assert.equal(ts.getChannelId(), 39n); assert.equal((await ts.listVisibleChannels())[0].id, '39'); assert.deepEqual(calls, []);
});
test('server already-member acknowledgement confirms channel even when SDK cache omits our entry', async () => {
  const { ts, calls } = stub(() => { throw new ServerError('770', 'already member of channel'); });
  await ts.joinChannel('🎸 音乐频道'); assert.equal(ts.getChannelId(), 39n);
  assert.equal(calls.length, 1); assert.ok(calls[0].startsWith('clientmove ')); assert.ok(!calls.some(command => command.startsWith('channellist')));
});
test('move acknowledgement is tracked; denied permissions and duplicate names still fail', async () => {
  const successful = stub(() => {}); await successful.ts.joinChannel('39'); assert.equal(successful.ts.getChannelId(), 39n);
  const denied = stub(() => { throw new ServerError('2568', 'insufficient client permissions'); });
  await assert.rejects(denied.ts.joinChannel('39'), /insufficient client permissions/); assert.equal(denied.ts.getChannelId(), 0n);
  const duplicate = stub(() => {}); duplicate.ts.channelView.observeText(`channellist cid=40 cpid=0 channel_name=${escapeTS3('🎸 音乐频道')}`);
  await assert.rejects(duplicate.ts.joinChannel('🎸 音乐频道'), /频道重名/); assert.equal(duplicate.calls.length, 0);
});
test('desktop connection honors the explicitly configured port and resolves the host once', async () => {
  const hosts = []; const resolver = new TrackingVoiceEndpointResolver(new DirectVoiceEndpointResolver(), async host => { hosts.push(host); return '127.0.0.1'; });
  const result = await resolver.resolve('example.test:12345'); assert.equal(result[0].addr, '127.0.0.1:12345'); assert.equal(result[0].source, 'Direct'); assert.deepEqual(hosts, ['example.test']);
});

test('confirmed channel messages wait for command acceptance, escape content and surface server errors', async () => {
  let accept; const pending = new Promise(resolve => { accept = resolve; }); const { ts, calls } = stub(() => pending);
  const message = '点歌 hello | 世界\\test\nnext'; let done = false;
  const sent = ts.sendTextMessage(message, 2, true).then(() => { done = true; });
  await Promise.resolve(); assert.equal(done, false); assert.equal(calls.length, 1);
  assert.equal(calls[0], 'sendtextmessage targetmode=2 target=0 msg=' + escapeTS3(message));
  accept(); await sent; assert.equal(done, true);
  const denied = stub(() => { throw new ServerError('2568', 'insufficient client permissions'); });
  await assert.rejects(denied.ts.sendTextMessage('test', 2, true), /insufficient client permissions/);
  denied.ts.client = null; await assert.rejects(denied.ts.sendTextMessage('test', 2, true), /尚未连接/);
});
