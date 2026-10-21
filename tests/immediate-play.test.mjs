import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PlayQueue, PlayMode } from '../vendor/teamspeak-music-bot-1.13.2/dist/audio/queue.js';
import { BotInstance } from '../vendor/teamspeak-music-bot-1.13.2/dist/bot/instance.js';
import { CoreEngine } from '../src/worker/core-engine.mjs';
const song = (id, entryId = String(id)) => ({ id: String(id), entryId, name: 'Song ' + id, artist: '', album: '', coverUrl: '', platform: 'netease', duration: 180 });
function fixture(fail = false) {
  const queue = new PlayQueue(); queue.addMany([1, 2, 3, 4].map(id => song(id))); queue.playAt(1); let elapsed = 45;
  const player = { getState: () => 'playing', resetFailures() {} };
  const bot = { isConnected: () => true, runExclusive: fn => fn(), getPlayer: () => player, getQueueManager: () => queue, getQueue: () => queue.list(),
    getStatus: () => ({ currentSong: queue.current(), elapsed, playing: true }), getConnectionInfo: () => ({}), emit() {}, autoPaused: false,
    resolveAndPlay: async () => { if (fail) return false; elapsed = 0; return true; } };
  const core = new CoreEngine({}, {}, () => {}, () => {}); core.bot = () => bot; core.lastTrack = queue.current(); core.audioClock = { setActive() {} };
  core.provider = { getSongDetail: async id => song(id) }; return { core, queue };
}
test('search play inserts ahead of the interrupted entry, retains every song and restarts the next song', async () => {
  for (const mode of Object.values(PlayMode)) {
    const f = fixture(); f.queue.setMode(mode); const interrupted = f.queue.current();
    const result = await f.core.command('music.playNow', { id: '9' }, 'Friend');
    assert.deepEqual(f.queue.list().map(item => item.id), ['1', '9', '2', '3', '4']); assert.equal(result.currentSong.id, '9'); assert.equal(result.elapsed, 0);
    assert.equal(f.queue.next(), interrupted, 'interrupted entry must be next even in shuffle mode');
  }
});
test('repeated interruptions are stacked, failures restore the queue, and replaying the current song never duplicates it', async () => {
  const f = fixture(); await f.core.command('music.playNow', { id: '9' }, 'Friend'); await f.core.command('music.playNow', { id: '8' }, 'Friend');
  assert.deepEqual(f.queue.list().map(item => item.id), ['1', '8', '9', '2', '3', '4']);
  await f.core.command('music.playNow', { id: '8' }, 'Owner'); assert.equal(f.queue.size(), 6);
  const bad = fixture(true); const current = bad.queue.current(); await assert.rejects(bad.core.command('music.playNow', { id: '9' }, 'Friend'), /无法播放/);
  assert.deepEqual(bad.queue.list().map(item => item.id), ['1', '2', '3', '4']); assert.equal(bad.queue.current(), current);
  const full = fixture(); while (full.queue.size() < 500) full.queue.add(song(7)); await assert.rejects(full.core.command('music.playNow', { id: '9' }, 'Friend'), /500/); assert.equal(full.queue.size(), 500);
});
test('a queued completion from the interrupted playback session cannot skip the newly requested song', async () => {
  let session = 1; let advances = 0; let unblock; let tail = new Promise(accept => { unblock = accept; });
  const player = Object.assign(new EventEmitter(), { getPlaybackSessionId: () => session });
  const bot = { player, tsClient: { sendVoiceData() {}, endVoiceStream() {} }, logger: { debug() {}, error() {} }, spotifyController: new EventEmitter(),
    runExclusive(fn) { const result = tail.then(fn); tail = result.catch(() => {}); return result; }, playNext: async () => { advances++; } };
  BotInstance.prototype.setupPlayerEvents.call(bot); player.emit('trackEnd'); session++; unblock(); await tail; assert.equal(advances, 0);
  player.emit('trackEnd'); await tail; assert.equal(advances, 1);
});
