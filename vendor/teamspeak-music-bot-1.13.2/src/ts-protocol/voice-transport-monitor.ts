import { performance } from "node:perf_hooks";
import type { Socket } from "node:dgram";

const WINDOW_MS = 60_000;
const SAFE_CODES = new Set(["ENOBUFS", "EMSGSIZE", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH", "EACCES", "EBADF", "ERR_SOCKET_DGRAM_NOT_RUNNING"]);

// Observe the pinned SDK's socket without changing packet bytes, destination,
// ordering or timing. A successful callback is local submission, not delivery.
export class VoiceTransportMonitor {
  private socket: Socket | null = null;
  private restore: (() => void) | null = null;
  private generation = 0;
  private pending = 0;
  private buckets: { at: number; packets: number; endPackets: number; bytes: number; minPacketBytes: number | null; maxPacketBytes: number; callbacks: number; errors: number; maxCallbackMs: number; maxRttMs: number; replies: number }[] = [];
  private pings = new Map<number, number>();
  private lastRtt: { at: number; ms: number } | null = null;
  private lastError: { at: number; code: string } | null = null;

  constructor(private now: () => number = () => performance.now()) {}

  private trim(at: number): void {
    while (this.buckets.length && at - this.buckets[0].at >= WINDOW_MS) this.buckets.shift();
    for (const [id, started] of this.pings) if (at - started >= WINDOW_MS) this.pings.delete(id);
  }

  private bucket(at: number) {
    this.trim(at);
    let item = this.buckets.at(-1);
    if (!item || at - item.at >= 1000) {
      item = { at, packets: 0, endPackets: 0, bytes: 0, minPacketBytes: null, maxPacketBytes: 0, callbacks: 0, errors: 0, maxCallbackMs: 0, maxRttMs: 0, replies: 0 };
      this.buckets.push(item);
    }
    return item;
  }

  attach(socket: Socket): void {
    this.detach(); this.socket = socket;
    this.buckets = []; this.pings.clear(); this.lastRtt = null; this.lastError = null;
    const generation = this.generation;
    const monitor = this;
    const original = socket.send;
    const wrapped = function (this: Socket, ...args: unknown[]) {
      const raw = args[0];
      if (monitor.generation !== generation || !(raw instanceof Uint8Array) || raw.length < 13) return Reflect.apply(original, this, args);
      const type = raw[12] & 0x0f;
      const at = monitor.now();
      if (type === 4) {
        monitor.trim(at); monitor.pings.set((raw[8] << 8) | raw[9], at);
        if (monitor.pings.size > 16) monitor.pings.delete(monitor.pings.keys().next().value!);
      }
      // Normal C2S voice: 8-byte tag, 5-byte header, 3-byte voice header.
      if (type !== 0 || raw.length < 16 || raw[15] !== 5) return Reflect.apply(original, this, args);
      const item = monitor.bucket(at); item.packets++; item.bytes += raw.length; monitor.pending++;
      if (raw.length === 16) item.endPackets++;
      item.minPacketBytes = item.minPacketBytes === null ? raw.length : Math.min(item.minPacketBytes, raw.length);
      item.maxPacketBytes = Math.max(item.maxPacketBytes, raw.length);
      const callback = typeof args.at(-1) === "function" ? args.pop() as (...values: unknown[]) => unknown : null;
      let completed = false;
      const finish = (error: unknown, fromCallback = true) => {
        if (completed || generation !== monitor.generation) return;
        completed = true; monitor.pending = Math.max(0, monitor.pending - 1);
        const finishedAt = monitor.now(); const bucket = monitor.bucket(finishedAt);
        if (fromCallback) { bucket.callbacks++; bucket.maxCallbackMs = Math.max(bucket.maxCallbackMs, finishedAt - at); }
        if (error) {
          bucket.errors++;
          const code = String((error as { code?: unknown }).code || "OTHER");
          monitor.lastError = { at: finishedAt, code: SAFE_CODES.has(code) ? code : "OTHER" };
        }
      };
      args.push(function (this: unknown, ...values: unknown[]) {
        finish(values[0]);
        if (callback) return Reflect.apply(callback, this, values);
      });
      try { return Reflect.apply(original, this, args); }
      catch (error) { finish(error, false); throw error; }
    } as Socket["send"];
    socket.send = wrapped;
    this.restore = () => { if (socket.send === wrapped) socket.send = original; };
  }

  observePacket(packet: { typeFlagged: number; data: Uint8Array }): void {
    if (!this.socket || (packet.typeFlagged & 0x0f) !== 5 || packet.data.length < 2) return;
    const at = this.now(); this.trim(at);
    const id = (packet.data[0] << 8) | packet.data[1]; const started = this.pings.get(id);
    if (started === undefined) return;
    this.pings.delete(id);
    const ms = Math.max(0, at - started); this.lastRtt = { at, ms };
    const bucket = this.bucket(at); bucket.replies++; bucket.maxRttMs = Math.max(bucket.maxRttMs, ms);
  }

  snapshot() {
    const at = this.now(); this.trim(at);
    const sum = this.buckets.reduce((total, item) => ({
      voicePackets: total.voicePackets + item.packets, voiceBytes: total.voiceBytes + item.bytes,
      voiceEndPackets: total.voiceEndPackets + item.endPackets,
      sendCallbacks: total.sendCallbacks + item.callbacks, sendErrors: total.sendErrors + item.errors,
      maxSendCallbackMs: Math.max(total.maxSendCallbackMs, item.maxCallbackMs),
      pingReplies: total.pingReplies + item.replies, maxRttMs: Math.max(total.maxRttMs, item.maxRttMs)
    }), { voicePackets: 0, voiceEndPackets: 0, voiceBytes: 0, sendCallbacks: 0, sendErrors: 0, maxSendCallbackMs: 0, pingReplies: 0, maxRttMs: 0 });
    let sendQueueBytes: number | null = null; let sendQueuePackets: number | null = null;
    if (this.socket) {
      try { sendQueueBytes = this.socket.getSendQueueSize(); sendQueuePackets = this.socket.getSendQueueCount(); } catch { /* unknown, not zero */ }
    }
    return { supported: Boolean(this.socket), windowSeconds: 60, ...sum,
      minVoicePacketBytes: sum.voicePackets ? Math.min(...this.buckets.filter(item => item.minPacketBytes !== null).map(item => item.minPacketBytes!)) : null,
      maxVoicePacketBytes: sum.voicePackets ? Math.max(...this.buckets.map(item => item.maxPacketBytes)) : null,
      maxSendCallbackMs: Math.round(sum.maxSendCallbackMs * 100) / 100,
      maxRttMs: sum.pingReplies ? Math.round(sum.maxRttMs) : null,
      rttMs: this.lastRtt && at - this.lastRtt.at < WINDOW_MS ? Math.round(this.lastRtt.ms) : null,
      lastErrorCode: this.lastError && at - this.lastError.at < WINDOW_MS ? this.lastError.code : null,
      pendingVoiceSends: this.pending, sendQueueBytes, sendQueuePackets, deliveryVerified: false };
  }

  detach(): void { this.generation++; this.restore?.(); this.restore = null; this.socket = null; this.pending = 0; this.pings.clear(); }
}
