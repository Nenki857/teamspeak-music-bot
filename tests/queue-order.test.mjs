import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayQueue, PlayMode } from '../vendor/teamspeak-music-bot-1.13.2/dist/audio/queue.js';
import { CoreEngine } from '../src/worker/core-engine.mjs';
import { Service } from '../src/worker/service.mjs';
import { ShareAuthority, CommandGate } from '../src/shared/security.mjs';

// Duplicate music IDs represent separate queue entries and must remain distinct.
const song = entryId => ({ entryId, id: '42', name: entryId, artist: 'Artist', album: '', platform: 'netease', coverUrl: '', duration: 180 });
const ids = queue => queue.list().map(item => item.entryId);
function queueWithSongs() { const queue = new PlayQueue(); queue.addMany(['A', 'B', 'C', 'D', 'E'].map(song)); return queue; }
function engineFixture(options = {}) {
  const queue = queueWithSongs(); queue.playAt(1);
  let playbackCalls = 0; let events = 0; let state = options.state || 'playing'; let elapsed = 37; let resumes = 0; const playedEntries = [];
  const bot = {
    id: 'test-bot', isConnected: () => true, runExclusive: fn => fn(), getQueueManager: () => queue,
    getPlayer: () => ({ getState: () => state, resetFailures: () => { playbackCalls++; }, stop: () => { playbackCalls++; }, resume: () => { state = 'playing'; resumes++; } }),
    resolveAndPlay: async song => { playbackCalls++; playedEntries.push(song.entryId); if (options.failPlay) return false; state = 'playing'; elapsed = 0; return true; }, getQueue: () => queue.list(),
    getStatus: () => ({ connected: true, playing: state === 'playing', paused: state === 'paused', currentSong: queue.current(), elapsed, playMode: queue.getMode() }),
    getConnectionInfo: () => ({ channelId: '17' }), emit: () => { events++; }
  };
  const engine = new CoreEngine({}, {}, () => {}, () => {});
  engine.audioClock = { setActive() {}, close() {} };
  engine.bot = () => bot; engine.lastTrack = queue.current(); engine.revision = 20;
  return { engine, queue, playedEntries, resumes: () => resumes, playbackCalls: () => playbackCalls, events: () => events };
}

test('queue moves retain song identity, current position, and previous-song history', () => {
  const queue = queueWithSongs(); queue.play(); queue.next(); queue.next();
  const current = queue.current(); assert.equal(current.entryId, 'C');
  assert.equal(queue.move(4, 0), true);
  assert.deepEqual(ids(queue), ['E', 'A', 'B', 'C', 'D']);
  assert.equal(queue.current(), current); assert.equal(queue.getCurrentIndex(), 3);
  assert.equal(queue.prev().entryId, 'B'); assert.equal(queue.prev().entryId, 'A');
});

test('moving entries keeps random-mode pending songs and shuffle membership intact', () => {
  const queue = queueWithSongs(); queue.setMode(PlayMode.Random); queue.play(); queue.addNext(song('F'));
  const unplayed = queue.unplayedCount();
  queue.move(1, 5); assert.equal(queue.unplayedCount(), unplayed);
  assert.equal(queue.next().entryId, 'F', 'an explicitly queued next song follows its entry after a move');
  assert.equal(queue.unplayedCount(), unplayed - 1);
  assert.equal(queue.prev().entryId, 'A');
  queue.move(5, 2); assert.equal(queue.next().entryId, 'F', 'forward history also follows the entry');
});

test('invalid and same-position moves leave the queue unchanged', () => {
  const queue = queueWithSongs(); queue.playAt(2); const original = queue.snapshot();
  for (const [from, to] of [[-1, 2], [1, 8], [0.5, 2], [2, NaN], [2, 2]]) {
    assert.equal(queue.move(from, to), false); assert.deepEqual(queue.snapshot(), original);
  }
});

test('core moves upcoming entries without restarting playback and protects current/past songs', async () => {
  const ui = engineFixture(); const current = ui.queue.current();
  const result = await ui.engine.command('queue.move', { entryId: 'E', targetEntryId: 'C', expectedRevision: 20 }, '朋友');
  assert.deepEqual(ids(ui.queue), ['A', 'B', 'E', 'C', 'D']);
  assert.equal(ui.queue.current(), current); assert.equal(result.elapsed, 37); assert.equal(result.playing, true);
  assert.equal(result.revision, 21); assert.equal(ui.playbackCalls(), 0); assert.equal(ui.events(), 1);
  for (const [entryId, targetEntryId] of [['B', 'D'], ['A', 'D'], ['D', 'B'], ['D', 'A']]) {
    await assert.rejects(ui.engine.command('queue.move', { entryId, targetEntryId }, '主人'), /只能调整/);
  }
  await assert.rejects(ui.engine.command('queue.move', { entryId: 'missing', targetEntryId: 'D' }, '主人'), /已不在队列/);
  await assert.rejects(ui.engine.command('queue.move', { entryId: 'D', targetEntryId: 'E', expectedRevision: 20 }, '主人'), /播放状态已变化/);
  assert.equal(ui.queue.next().entryId, 'E'); assert.equal(ui.playbackCalls(), 0);
});

test('queue edits invalidate an old reorder revision even when the song keeps playing', async () => {
  const ui = engineFixture();
  await ui.engine.command('queue.remove', { entryId: 'D', expectedRevision: 20 }, '主人');
  await assert.rejects(ui.engine.command('queue.move', { entryId: 'E', targetEntryId: 'C', expectedRevision: 20 }, '主人'), /播放状态已变化/);
  ui.engine.provider = { getSongDetail: async () => song('new-song') };
  const revision = ui.engine.revision;
  await ui.engine.command('music.add', { id: '42', expectedRevision: revision }, '朋友');
  assert.equal(ui.engine.revision, revision + 1); assert.equal(ui.playbackCalls(), 0);
  await assert.rejects(ui.engine.command('queue.move', { entryId: 'E', targetEntryId: 'C', expectedRevision: revision }, '主人'), /播放状态已变化/);
});

test('remote reorder requires its own permission, current run and revision; concurrent changes conflict safely', async () => {
  const ui = engineFixture();
  const service = Object.assign(Object.create(Service.prototype), { ready: true, phase: 'running', core: ui.engine, authority: new ShareAuthority(), gate: new CommandGate() });
  const runId = service.authority.beginRun();
  const managed = service.authority.create('队列管理', ['queue']); const manageSession = service.authority.exchange(managed.raw);
  const ordered = service.authority.create('排序', ['reorder']); const orderSession = service.authority.exchange(ordered.raw);
  const access = session => ({ owner: false, session: session.session, csrf: session.csrf });
  const args = { entryId: 'E', targetEntryId: 'C', expectedRevision: 20, runId };
  await assert.rejects(service.rpc('queue.move', args, access(manageSession)), /没有该操作权限/);
  await assert.rejects(service.rpc('queue.clear', args, access(orderSession)), /没有该操作权限/);
  await assert.rejects(service.rpc('queue.move', { ...args, runId: 'old-run' }, access(orderSession)), /重新启动/);
  await assert.rejects(service.rpc('queue.move', { entryId: 'E', targetEntryId: 'C', runId }, access(orderSession)), /刷新播放状态/);
  const first = service.rpc('queue.move', args, access(orderSession), 'move-request-001');
  const retry = service.rpc('queue.move', args, access(orderSession), 'move-request-001');
  const conflict = service.rpc('queue.move', { ...args, entryId: 'D' }, access(orderSession), 'move-request-002');
  assert.equal((await first).revision, 21); assert.equal((await retry).revision, 21);
  await assert.rejects(conflict, /播放状态已变化/);
  assert.deepEqual(ids(ui.queue), ['A', 'B', 'E', 'C', 'D']); assert.equal(ui.playbackCalls(), 0);
  service.authority.revoke(ordered.id);
  await assert.rejects(service.rpc('queue.move', { ...args, expectedRevision: 21 }, access(orderSession)), /授权已失效/);
});

test('selecting a queued entry preserves all songs, ordering and entry identity, including duplicate music IDs', async () => {
  const ui = engineFixture(); const entries = ui.queue.list();
  const result = await ui.engine.command('queue.play', { entryId: 'D', expectedRevision: 20 }, '朋友');
  assert.equal(ui.queue.current(), entries[3]); assert.deepEqual(ui.playedEntries, ['D']);
  assert.equal(result.currentSong.entryId, 'D'); assert.equal(result.elapsed, 0);
  assert.deepEqual(ui.queue.list(), entries); assert.ok(result.revision > 20);
  await ui.engine.command('queue.play', { entryId: 'D', expectedRevision: result.revision }, '朋友');
  assert.deepEqual(ui.playedEntries, ['D'], 'clicking an already playing entry must not restart it');
  assert.equal(ui.queue.next().entryId, 'E', 'sequential playback continues from the selected position');
  await ui.engine.command('queue.play', { entryId: 'A' }, '主人');
  assert.equal(ui.queue.current(), entries[0]); assert.deepEqual(ui.queue.list(), entries);
});

test('selecting the paused current entry resumes without restarting, while missing entries do nothing', async () => {
  const ui = engineFixture({ state: 'paused' }); const entries = ui.queue.list();
  const result = await ui.engine.command('queue.play', { entryId: 'B', expectedRevision: 20 }, '朋友');
  assert.equal(result.playing, true); assert.equal(result.elapsed, 37); assert.equal(ui.resumes(), 1);
  assert.deepEqual(ui.playedEntries, []); assert.deepEqual(ui.queue.list(), entries);
  await assert.rejects(ui.engine.command('queue.play', { entryId: 'missing' }, '朋友'), /已不在队列/);
  assert.equal(ui.queue.current(), entries[1]); assert.deepEqual(ui.queue.list(), entries);
});

test('an unplayable selection restores the current song and random navigation without removing anything', async () => {
  const ui = engineFixture({ failPlay: true });
  ui.queue.setMode(PlayMode.Random); ui.queue.addNext(song('F'));
  const entries = ui.queue.list(); const current = ui.queue.current(); const unplayed = ui.queue.unplayedCount();
  await assert.rejects(ui.engine.command('queue.play', { entryId: 'E', expectedRevision: 20 }, '朋友'), /暂时无法播放/);
  assert.equal(ui.queue.current(), current); assert.deepEqual(ui.queue.list(), entries);
  assert.equal(ui.queue.unplayedCount(), unplayed); assert.equal(ui.queue.next().entryId, 'F');
});

test('remote queued playback enforces playNow permission, run/revision, deduplication and conflicts', async () => {
  const ui = engineFixture();
  const service = Object.assign(Object.create(Service.prototype), { ready: true, phase: 'running', core: ui.engine, authority: new ShareAuthority(), gate: new CommandGate() });
  const runId = service.authority.beginRun();
  const granted = service.authority.create('点播', ['playNow']); const session = service.authority.exchange(granted.raw);
  const limited = service.authority.exchange(service.authority.create('只切歌', ['skip']).raw);
  const access = session => ({ owner: false, session: session.session, csrf: session.csrf });
  const args = { entryId: 'D', expectedRevision: 20, runId };
  await assert.rejects(service.rpc('queue.play', args, access(limited)), /没有该操作权限/);
  await assert.rejects(service.rpc('queue.play', { ...args, runId: 'old' }, access(session)), /重新启动/);
  await assert.rejects(service.rpc('queue.play', { entryId: 'D', runId }, access(session)), /刷新播放状态/);
  const outcomes = await Promise.allSettled([
    service.rpc('queue.play', args, access(session), 'play-entry-001'),
    service.rpc('queue.play', args, access(session), 'play-entry-001'),
    service.rpc('queue.play', { ...args, entryId: 'A' }, access(session), 'play-entry-002')
  ]);
  assert.equal(outcomes[0].status, 'fulfilled'); assert.equal(outcomes[1].status, 'fulfilled');
  assert.equal(outcomes[2].status, 'rejected'); assert.match(outcomes[2].reason.message, /播放状态已变化/);
  assert.deepEqual(ui.playedEntries, ['D']); assert.deepEqual(ids(ui.queue), ['A', 'B', 'C', 'D', 'E']);
  service.authority.revoke(granted.id);
  await assert.rejects(service.rpc('queue.play', { ...args, expectedRevision: ui.engine.revision }, access(session)), /授权已失效/);
});
