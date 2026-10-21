import { performance } from 'node:perf_hooks';

const WINDOW_MS = 60000; const FRAME_BYTES = 3840; const PCM_BYTES_PER_MS = 192;

// Observe counters only: no PCM, song IDs, URLs or networking changes.
export function createAudioHealth({ now = () => performance.now(), wallNow = () => Date.now() } = {}) {
  const buckets = []; const events = []; const attachments = new Map();
  let activePlayer; let session; let lastTick; let lastFrame; let hasFrames = false; let starving = false;
  let currentBufferMs = null; let currentState = 'idle';
  function trim(at) {
    while (buckets.length && at - buckets[0].at >= WINDOW_MS) buckets.shift();
    while (events.length && at - events[0].at >= WINDOW_MS) events.shift();
  }
  function bucket(at) {
    trim(at); let item = buckets.at(-1);
    if (!item || at - item.at >= 1000) {
      item = { at, frames: 0, underruns: 0, lateTicks: 0, maxFrameGapMs: 0, maxTickGapMs: 0, minBufferMs: null,
        maxFrameWorkMs: 0, maxEncodeMs: 0, maxVoiceSubmitMs: 0, slowFrameCalls: 0 };
      buckets.push(item);
    }
    return item;
  }
  function event(type, at, gapMs, bufferMs) {
    trim(at);
    events.push({ at, time: wallNow(), type, gapMs: Math.round(gapMs || 0), bufferMs: Math.round(bufferMs || 0) });
    if (events.length > 16) events.shift();
  }
  function resetTiming() { lastTick = lastFrame = undefined; hasFrames = false; starving = false; }
  function cost(kind, started) { const at = now(); const value = Math.max(0, at - started); const item = bucket(at); item[kind] = Math.max(item[kind], value); if (kind === 'maxFrameWorkMs' && value >= 20) item.slowFrameCalls++; }
  function observe(player) {
    if (!player) { currentState = 'idle'; currentBufferMs = null; resetTiming(); activePlayer = undefined; return; }
    if (activePlayer !== player || session !== player.sessionId) {
      activePlayer = player; session = player.sessionId; resetTiming();
    }
    currentState = player.getState();
    const bytes = player.pcmBuffer?.length;
    currentBufferMs = Number.isFinite(bytes) ? bytes / PCM_BYTES_PER_MS : null;
    if (currentState !== 'playing') resetTiming();
  }
  function tick(player) {
    observe(player); if (currentState !== 'playing') return;
    const at = now(); const item = bucket(at);
    if (hasFrames && currentBufferMs !== null) item.minBufferMs = item.minBufferMs === null ? currentBufferMs : Math.min(item.minBufferMs, currentBufferMs);
    if (hasFrames && lastTick !== undefined && at - lastTick >= 45) {
      const gap = at - lastTick; item.lateTicks++; item.maxTickGapMs = Math.max(item.maxTickGapMs, gap);
      event('scheduler-gap', at, gap, currentBufferMs);
    }
    lastTick = at;
    const nearEnd = player.currentSongDuration > 0 && player.currentSongDuration - player.getElapsed?.() <= 0.3;
    if (hasFrames && !nearEnd && player.ffmpeg && player.pcmBuffer?.length < FRAME_BYTES) {
      if (!starving) { item.underruns++; event('buffer-empty', at, 0, currentBufferMs); }
      starving = true;
    } else if (player.pcmBuffer?.length >= FRAME_BYTES || nearEnd) starving = false;
  }
  function frame(player) {
    observe(player); if (currentState !== 'playing') return;
    const at = now(); const item = bucket(at); item.frames++;
    if (lastFrame !== undefined) item.maxFrameGapMs = Math.max(item.maxFrameGapMs, at - lastFrame);
    hasFrames = true; lastFrame = at;
  }
  return {
    setPlayer(player, voiceClient) {
      for (const [other, { original, wrapped, onFrame, probes }] of attachments) {
        if (other === player) continue;
        if (other.sendNextFrame === wrapped) other.sendNextFrame = original;
        other.off('frame', onFrame); for (const probe of probes) if (probe.object[probe.name] === probe.wrapped) probe.object[probe.name] = probe.original; attachments.delete(other);
      }
      if (player) this.attach(player, voiceClient);
      observe(player);
    },
    attach(player, voiceClient) {
      if (attachments.has(player)) return;
      const original = player.sendNextFrame;
      if (typeof original !== 'function') return;
      const wrapped = function (...args) { const observed = activePlayer === this; if (observed) tick(this); const started = now(); try { return Reflect.apply(original, this, args); } finally { if (observed) cost('maxFrameWorkMs', started); } };
      const onFrame = () => { if (activePlayer === player) frame(player); };
      player.sendNextFrame = wrapped; player.on('frame', onFrame);
      const probes = [];
      for (const [object, name, kind] of [[player.encoder, 'encode', 'maxEncodeMs'], [voiceClient, 'sendVoiceData', 'maxVoiceSubmitMs']]) {
        if (typeof object?.[name] !== 'function') continue;
        const original = object[name]; const wrapped = function (...args) { const started = now(); try { return Reflect.apply(original, this, args); } finally { if (activePlayer === player) cost(kind, started); } };
        object[name] = wrapped; probes.push({ object, name, original, wrapped });
      }
      attachments.set(player, { original, wrapped, onFrame, probes });
    },
    snapshot(player) {
      this.setPlayer(player); const at = now(); trim(at);
      const total = buckets.reduce((sum, item) => ({ frames: sum.frames + item.frames, underruns: sum.underruns + item.underruns,
        lateTicks: sum.lateTicks + item.lateTicks, maxFrameGapMs: Math.max(sum.maxFrameGapMs, item.maxFrameGapMs),
        maxTickGapMs: Math.max(sum.maxTickGapMs, item.maxTickGapMs), minBufferMs: item.minBufferMs === null ? sum.minBufferMs : sum.minBufferMs === null ? item.minBufferMs : Math.min(sum.minBufferMs, item.minBufferMs) }),
      { frames: 0, underruns: 0, lateTicks: 0, maxFrameGapMs: 0, maxTickGapMs: 0, minBufferMs: null });
      const round = value => value === null ? null : Math.round(value);
      let encoding = null;
      try { encoding = player?.encoder?.getSettings?.() || null; } catch { /* diagnostics must not interrupt playback */ }
      return { supported: Boolean(player && attachments.has(player)), state: currentState, windowSeconds: 60,
        bufferMs: round(currentBufferMs), minBufferMs: round(total.minBufferMs), frames: total.frames, underruns: total.underruns,
        lateTicks: total.lateTicks, maxFrameGapMs: total.frames ? round(Math.max(total.maxFrameGapMs, hasFrames && lastFrame !== undefined && currentState === 'playing' ? at - lastFrame : 0)) : null,
        maxTickGapMs: round(total.maxTickGapMs), starving, encoding,
        audioWork: { maxFrameWorkMs: Math.round(Math.max(0, ...buckets.map(item => item.maxFrameWorkMs)) * 100) / 100,
          maxEncodeMs: Math.round(Math.max(0, ...buckets.map(item => item.maxEncodeMs)) * 100) / 100,
          maxVoiceSubmitMs: Math.round(Math.max(0, ...buckets.map(item => item.maxVoiceSubmitMs)) * 100) / 100,
          slowFrameCalls: buckets.reduce((sum, item) => sum + item.slowFrameCalls, 0) },
        tsConnectionStatistics: 'unsupported', deliveryVerified: false,
        recent: events.slice(-8).map(({ at: _at, ...item }) => item) };
    },
    clear() { buckets.length = 0; events.length = 0; resetTiming(); },
    close() {
      for (const [player, { original, wrapped, onFrame, probes }] of attachments) {
        if (player.sendNextFrame === wrapped) player.sendNextFrame = original;
        player.off('frame', onFrame);
        for (const probe of probes) if (probe.object[probe.name] === probe.wrapped) probe.object[probe.name] = probe.original;
      }
      attachments.clear(); activePlayer = undefined; this.clear();
    }
  };
}
