import { CoreEngine as RealCore } from '../../src/worker/core-engine.mjs';
import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { IsolatedMusicProvider } from '../../src/worker/music-provider.mjs';

// Real AudioPlayer/Opus, isolated databases and fake music metadata; never connects to TS.
export class CoreEngine extends RealCore {
  async init() {
    await super.init(); await this.provider.close();
    this.provider = new IsolatedMusicProvider({ apiModule: new URL('./music-api.mjs', import.meta.url).href }); await this.provider.ready;
    this.musicReplies = 0; this.provider.worker.on('message', message => { if (message.id) this.musicReplies++; });
    this.auth = { loggedIn: false };
  }
  async start({ probeFrames = 180, queueSize = 500 } = {}) {
    const bot = await this.manager.createBot({ name: 'Synthetic playback', serverAddress: '127.0.0.1', serverPort: 9987, nickname: 'Synthetic' });
    this.activeId = bot.id; this.times = []; this.result = null;
    // Control tests need a connected facade; the underlying TS client remains disconnected.
    bot.isConnected = () => true; bot.getConnectionInfo = () => ({ connected: true, channelId: '1' });
    this.sentAnnouncements = []; bot.tsClient.getChannelId = () => 1n; bot.tsClient.getClientId = () => 99;
    bot.tsClient.sendTextMessage = async (text, target) => { if (this.messageError) throw new Error('Permission denied: ' + text); this.sentAnnouncements.push({ text, target }); };
    this.observeChannelJoins();
    const queue = bot.getQueueManager();
    for (let i = 0; i < queueSize; i++) queue.add({ id: String(i + 1), entryId: 'entry-' + i, name: 'Synthetic ' + i, artist: 'Fixture', duration: 180, platform: 'netease' });
    queue.playAt(0); this.observeTrack();
    const player = bot.getPlayer(); this.audioHealth.setPlayer(player, bot.tsClient);
    player.on('frame', () => {
      this.times.push(performance.now());
      if (this.times.length !== probeFrames) return;
      const gaps = this.times.slice(1).map((at, i) => at - this.times[i]).sort((a, b) => a - b);
      this.result = { frames: this.times.length, wallSeconds: (this.times.at(-1) - this.started) / 1000, p50GapMs: gaps[Math.floor(gaps.length * .5)], p95GapMs: gaps[Math.floor(gaps.length * .95)], maxGapMs: gaps.at(-1), gapsOver45Ms: gaps.filter(value => value >= 45).length };
      player.pause(); this.onChange();
    });
    const pcm = Buffer.alloc(3840 * (probeFrames + 50));
    for (let i = 0; i < pcm.length / 4; i++) { const value = Math.round(Math.sin(i * Math.PI * 880 / 48000) * 10000); pcm.writeInt16LE(value, i * 4); pcm.writeInt16LE(value, i * 4 + 2); }
    this.stream = new PassThrough(); this.started = performance.now(); player.playPcmStream(this.stream); this.stream.write(pcm);
    return bot.getConnectionInfo();
  }
  async command(method, args, name) {
    if (method === 'probe.join') { this.bot().tsClient.emit('clientEnter', { id: args.id || 88, type: 0, channelID: BigInt(args.channelId || '1'), nickname: 'Fixture', uid: 'private-fixture-uid' }); return true; }
    if (method === 'probe.announcements') return this.sentAnnouncements;
    if (method === 'probe.messageError') { this.messageError = !!args.enabled; return true; }
    if (method === 'probe.result') return this.result;
    if (method === 'probe.musicReplies') return this.musicReplies;
    if (method === 'probe.qrPending') { this.qrPending = args.enabled; return true; }
    if (method === 'probe.crash') { setImmediate(() => { throw new Error('Synthetic playback worker failure'); }); return true; }
    if (method === 'probe.delay') { await new Promise(accept => setTimeout(accept, args.ms)); return true; }
    if (method === 'probe.error') throw new Error('https://private.invalid/?token=fixture-secret');
    return super.command(method, args, name);
  }
  qr() { return { qrImg: 'data:image/png;base64,fixture', qrUrl: 'https://example.invalid/login' }; }
  qrCheck() { if (this.qrPending) return { status: 'waiting' }; this.provider.setCookie('fixture-cookie'); this.auth = { loggedIn: true, nickname: 'Fixture' }; this.store.set('neteaseCookie', this.vault.encrypt('fixture-cookie')); this.onChange(); return { status: 'confirmed' }; }
  refreshAuth() { return this.auth; }
  logout() { this.provider.setCookie(''); this.auth = { loggedIn: false }; this.store.set('neteaseCookie', ''); this.onChange(); }
  close() { this.stream?.destroy(); return super.close(); }
}
