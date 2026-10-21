import { randomUUID } from 'node:crypto';

export const ANNOUNCEMENT_COOLDOWN_MS = 3000;
export class ShareAnnouncement {
  constructor({ current, send, changed, gate, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
    Object.assign(this, { current, send, changed, gate, now, schedule, cancel });
    this.links = new Map();
    this.reset();
  }
  reset() { this.clearPending(); this.grantId = ''; this.lastSentAt = 0; this.lastAttemptAt = null; this.error = ''; }
  clearPending() { if (this.timer !== undefined) this.cancel(this.timer); this.timer = undefined; this.epoch = (this.epoch || 0) + 1; }
  configure(grantId) { this.reset(); this.grantId = grantId; const link = this.links.get(grantId); const context = this.current(grantId); if (link && link.url === context?.url && link.runId === context.runId) { this.lastSentAt = link.lastSentAt; this.error = link.error; } }
  state() { return { enabled: !!this.grantId, grantId: this.grantId, lastSentAt: this.lastSentAt, error: this.error, cooldownSeconds: ANNOUNCEMENT_COOLDOWN_MS / 1000 }; }
  linkState(grantId) {
    const context = this.current(grantId); const link = this.links.get(grantId);
    if (!context) return { status: 'waiting', lastSentAt: link?.lastSentAt || 0, error: '' };
    if (link?.url === context.url && link.runId === context.runId) { const { status, lastSentAt, error } = link; return { status, lastSentAt, error }; }
    return { status: 'pending', lastSentAt: 0, error: '' };
  }
  linkFailed(grantId, expected) {
    const context = this.current(grantId);
    if (!expected || context?.runId !== expected.runId || context.url !== expected.url) return;
    const error = '发送未完成，请检查机器人连接与频道文字消息权限';
    this.links.set(grantId, { ...expected, status: 'error', lastSentAt: 0, error });
    if (this.grantId === grantId) this.error = error;
    this.changed();
  }
  async publishLink(grantId, event, expected = this.current(grantId)) {
    const current = () => { const context = this.current(grantId); return expected && context?.runId === expected.runId && context.url === expected.url; };
    if (!current()) return false;
    const previous = this.links.get(grantId);
    if (previous?.runId === expected.runId && previous.url === expected.url && previous.status === 'sent') return true;
    const link = { ...expected, status: 'pending', lastSentAt: 0, error: '' }; this.links.set(grantId, link);
    // Link creation/address changes must not be dropped by the arrival cooldown.
    this.lastAttemptAt = this.now();
    try {
      const sent = await this.send({ ...event, url: expected.url });
      if (!current() || this.links.get(grantId) !== link) return false;
      link.status = sent ? 'sent' : 'error'; link.lastSentAt = sent ? this.now() : 0;
      if (!sent) link.error = '发送未完成，请检查机器人连接与频道文字消息权限';
      return !!sent;
    } catch {
      if (current() && this.links.get(grantId) === link) { link.status = 'error'; link.error = '发送失败，请检查机器人发送频道文字消息的权限'; }
      return false;
    } finally {
      if (current() && this.links.get(grantId) === link) {
        if (this.grantId === grantId) { this.lastSentAt = link.lastSentAt; this.error = link.error; }
        this.changed();
      }
    }
  }
  async sendNow(event, epoch = this.epoch, runId = this.current(this.grantId)?.runId) {
    const latest = this.current(this.grantId);
    if (epoch !== this.epoch || !latest || latest.runId !== runId) return false;
    if (this.lastAttemptAt !== null && this.now() - this.lastAttemptAt < ANNOUNCEMENT_COOLDOWN_MS) return false;
    this.lastAttemptAt = this.now();
    try {
      const sent = await this.send({ ...event, url: latest.url });
      if (epoch !== this.epoch) return false;
      if (sent) { this.lastSentAt = this.now(); this.error = ''; this.links.set(this.grantId, { ...latest, status: 'sent', lastSentAt: this.lastSentAt, error: '' }); }
      return !!sent;
    } catch {
      if (epoch === this.epoch) this.error = '发送失败，请检查机器人发送频道文字消息的权限';
      return false;
    } finally { if (epoch === this.epoch) this.changed(); }
  }
  joined(event) {
    if (!this.grantId || this.timer !== undefined || !this.current(this.grantId)) return;
    const epoch = this.epoch; const context = this.current(this.grantId);
    // People joining during cooldown cannot see the earlier channel message.
    // Keep one trailing send so they receive a link once the cooldown ends.
    const delay = Math.max(800, this.lastAttemptAt === null ? 0 : ANNOUNCEMENT_COOLDOWN_MS - (this.now() - this.lastAttemptAt));
    this.timer = this.schedule(() => {
      this.timer = undefined;
      this.gate.run('channel-announcement', randomUUID(), () => this.sendNow(event, epoch, context.runId)).catch(() => {});
    }, delay);
    this.timer?.unref?.();
  }
}
