import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const core = resolve('vendor/teamspeak-music-bot-1.13.2');
const load = path => import(pathToFileURL(resolve(core, path)).href);
const { VoiceTransportMonitor } = await load('dist/ts-protocol/voice-transport-monitor.js');
const { TS3Client } = await load('dist/ts-protocol/client.js');
const { Client: SDKClient } = await load('node_modules/@honeybbq/teamspeak-client/dist/index.mjs');
const { PacketHandler } = await load('node_modules/@honeybbq/teamspeak-client/dist/transport/index.mjs');
const { Crypt, generateIdentity } = await load('node_modules/@honeybbq/teamspeak-client/dist/crypto/index.mjs');
const { createOpusEncoder, PCM_FRAME_BYTES } = await load('dist/audio/encoder.js');
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const packet = (type = 0, id = 1) => { const data = Buffer.alloc(22); data[12] = type; data.writeUInt16BE(id, 8); data[15] = 5; return data; };
class FakeSocket extends EventEmitter {
  constructor() { super(); this.sent = []; this.deferred = []; this.automatic = true; }
  send(...args) { this.sent.push(args[0]); const callback = args.at(-1); if (typeof callback === 'function') { if (this.automatic) callback(null); else this.deferred.push(callback); } return 'sent'; }
  getSendQueueSize() { return this.queueBytes ?? 0; }
  getSendQueueCount() { return this.queueCount ?? 0; }
  close() { this.emit('close'); }
}

test('transport monitoring preserves socket arguments and callbacks while measuring local submission', () => {
  let at = 0; const monitor = new VoiceTransportMonitor(() => at); const socket = new FakeSocket(); socket.automatic = false;
  const original = socket.send; monitor.attach(socket);
  const bytes = packet(); let callbackThis; let callbackError;
  assert.equal(socket.send(bytes, function (error) { callbackThis = this; callbackError = error; }), 'sent');
  assert.equal(socket.sent[0], bytes, 'do not copy or change the packet');
  assert.equal(monitor.snapshot().pendingVoiceSends, 1);
  socket.queueBytes = 17; socket.queueCount = 1; at = 24.5;
  socket.deferred.shift().call(socket, null);
  const health = monitor.snapshot(); assert.equal(health.voicePackets, 1); assert.equal(health.voiceBytes, bytes.length);
  assert.equal(health.sendCallbacks, 1); assert.equal(health.pendingVoiceSends, 0); assert.equal(health.maxSendCallbackMs, 24.5);
  assert.equal(health.minVoicePacketBytes, bytes.length); assert.equal(health.maxVoicePacketBytes, bytes.length);
  assert.equal(health.sendQueueBytes, 17); assert.equal(health.sendQueuePackets, 1); assert.equal(health.deliveryVerified, false);
  assert.equal(callbackThis, socket); assert.equal(callbackError, null);
  monitor.detach(); assert.equal(socket.send, original); assert.equal(monitor.snapshot().supported, false);
});

test('existing ping and matching pong measure RTT without adding packets or claiming a loss rate', () => {
  let at = 100; const monitor = new VoiceTransportMonitor(() => at); const socket = new FakeSocket(); monitor.attach(socket);
  socket.send(packet(4, 123), () => {}); at = 137;
  monitor.observePacket({ typeFlagged: 5, data: Buffer.from([0, 122]) }); assert.equal(monitor.snapshot().rttMs, null);
  monitor.observePacket({ typeFlagged: 5, data: Buffer.from([0, 123]) });
  monitor.observePacket({ typeFlagged: 5, data: Buffer.from([0, 123]) });
  const health = monitor.snapshot(); assert.equal(health.rttMs, 37); assert.equal(health.maxRttMs, 37); assert.equal(health.pingReplies, 1);
  assert.equal(health.voicePackets, 0); assert.equal(socket.sent.length, 1); assert.equal(health.packetLoss, undefined);
  at = 60200; assert.equal(monitor.snapshot().rttMs, null); assert.equal(monitor.snapshot().pingReplies, 0); monitor.detach();
});

test('submission errors remain observable, sanitized and preserve the original throwing behavior', () => {
  const socket = new FakeSocket(); socket.automatic = false; const monitor = new VoiceTransportMonitor(); monitor.attach(socket);
  const error = Object.assign(new Error('private server address and secret'), { code: 'ENOBUFS' }); let delivered;
  socket.send(packet(), value => { delivered = value; }); socket.deferred.shift()(error);
  assert.equal(delivered, error); assert.equal(monitor.snapshot().sendErrors, 1); assert.equal(monitor.snapshot().lastErrorCode, 'ENOBUFS');
  socket.send(packet(), () => {}); socket.deferred.shift()({ code: 'credential-secret', message: 'https://private.invalid' });
  assert.equal(monitor.snapshot().lastErrorCode, 'OTHER');
  socket.getSendQueueSize = () => { throw error; }; assert.equal(monitor.snapshot().sendQueueBytes, null);
  assert.ok(!/private|credential|secret/.test(JSON.stringify(monitor.snapshot())));
  monitor.detach(); socket.send = () => { throw error; }; monitor.attach(socket);
  assert.throws(() => socket.send(packet()), value => value === error);
  assert.equal(monitor.snapshot().sendErrors, 1); assert.equal(monitor.snapshot().sendCallbacks, 0); assert.equal(monitor.snapshot().pendingVoiceSends, 0); monitor.detach();
});

test('old socket completions cannot pollute a new connection and stale windows expire', () => {
  let at = 0; const monitor = new VoiceTransportMonitor(() => at); const old = new FakeSocket(); old.automatic = false;
  monitor.attach(old); old.send(packet(), () => {}); const completion = old.deferred.shift();
  const current = new FakeSocket(); monitor.attach(current); current.send(packet(), () => {}); completion({ code: 'ENOBUFS' });
  assert.equal(monitor.snapshot().voicePackets, 1); assert.equal(monitor.snapshot().sendErrors, 0); assert.equal(monitor.snapshot().pendingVoiceSends, 0);
  at = 61000; assert.equal(monitor.snapshot().voicePackets, 0); assert.equal(monitor.snapshot().sendCallbacks, 0);
  assert.equal(monitor.snapshot().minVoicePacketBytes, null); assert.equal(monitor.snapshot().maxVoicePacketBytes, null);
  const laterWrapper = () => {}; current.send = laterWrapper; monitor.detach(); assert.equal(current.send, laterWrapper);
});

test('real SDK voice packets preserve continuous 20ms Opus payloads through the monitor', () => {
  const socket = new FakeSocket(); const monitor = new VoiceTransportMonitor(); monitor.attach(socket);
  const handler = new PacketHandler(new Crypt(generateIdentity(8)), silent); handler.setClientID(23); handler.start(socket);
  const encoder = createOpusEncoder(); const decoder = createOpusEncoder(); const frames = 80;
  try {
    for (let frame = 0; frame < frames; frame++) {
      const pcm = Buffer.alloc(PCM_FRAME_BYTES);
      for (let i = 0; i < 960; i++) { const sample = Math.round(Math.sin((frame * 960 + i) * 2 * Math.PI * 440 / 48000) * 10000); pcm.writeInt16LE(sample, i * 4); pcm.writeInt16LE(sample, i * 4 + 2); }
      handler.sendVoicePacket(encoder.encode(pcm), 5);
    }
    const voices = socket.sent.filter(data => data.length >= 16 && (data[12] & 15) === 0);
    assert.equal(voices.length, frames);
    const amplitudes = [];
    for (const [index, data] of voices.entries()) {
      assert.equal(data.readUInt16BE(8), index); assert.equal(data.readUInt16BE(10), 23); assert.equal(data.readUInt16BE(13), index); assert.equal(data[15], 5);
      const pcm = decoder.decode(data.subarray(16)); assert.equal(pcm.length, PCM_FRAME_BYTES);
      let squared = 0; for (let i = 0; i < pcm.length; i += 2) squared += pcm.readInt16LE(i) ** 2;
      amplitudes.push(Math.sqrt(squared / (pcm.length / 2)));
    }
    assert.ok(amplitudes.slice(2).every(value => value > 5000 && value < 8500), 'decoded test tone must not develop silent or clipped frames');
    const stats = monitor.snapshot(); assert.equal(stats.voicePackets, frames); assert.equal(stats.sendCallbacks, frames); assert.equal(stats.sendErrors, 0);
    assert.equal(stats.minVoicePacketBytes, 214); assert.equal(stats.maxVoicePacketBytes, 214);
  } finally { handler.close(); monitor.detach(); }
});

test('TS wrapper attaches to the recreated SDK socket and tears down monitoring on disconnect', async t => {
  const socket = new FakeSocket();
  t.mock.method(SDKClient.prototype, 'connect', async function () { await Promise.resolve(); this.handler.start(socket); });
  t.mock.method(SDKClient.prototype, 'waitConnected', async () => {});
  t.mock.method(SDKClient.prototype, 'clientID', () => 23);
  t.mock.method(SDKClient.prototype, 'channelID', () => 1n);
  t.mock.method(SDKClient.prototype, 'disconnect', async function () { this.handler.close(); });
  const ts = new TS3Client({ host: 'fixture.invalid', port: 9987, queryPort: 10011, nickname: 'Synthetic', serverProtocol: 'ts3' }, silent);
  try {
    assert.equal(ts.getVoiceTransportStatistics().supported, false); await ts.connect();
    assert.equal(ts.getVoiceTransportStatistics().supported, true);
    ts.sendVoiceData(Buffer.from([0xf8, 0xff, 0xfe])); assert.equal(ts.getVoiceTransportStatistics().voicePackets, 1);
    assert.equal(ts.getVoiceTransportStatistics().sendErrors, 0);
    ts.endVoiceStream(); ts.endVoiceStream();
    let voices = socket.sent.filter(data => data.length >= 16 && (data[12] & 15) === 0);
    assert.equal(voices.length, 2); assert.equal(voices[1].length, 16); assert.equal(voices[1][15], 5);
    assert.equal(voices[1].readUInt16BE(8), 1); assert.equal(voices[1].readUInt16BE(13), 1);
    assert.equal(ts.getVoiceTransportStatistics().voiceEndPackets, 1);
    ts.sendVoiceData(Buffer.from([0xf8, 0xff, 0xfe])); ts.endVoiceStream();
    voices = socket.sent.filter(data => data.length >= 16 && (data[12] & 15) === 0);
    assert.equal(voices.length, 4); assert.equal(voices[3].length, 16); assert.equal(voices[3].readUInt16BE(13), 3);
    assert.equal(ts.getVoiceTransportStatistics().voiceEndPackets, 2);
  } finally { ts.disconnect(); }
  assert.equal(ts.getVoiceTransportStatistics().supported, false);
});
