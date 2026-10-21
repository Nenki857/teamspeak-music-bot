import { createCipheriv, createDecipheriv, randomBytes, createHash, randomUUID } from 'node:crypto';
import { visitorName } from './visitor.mjs';
export const ALL_PERMISSIONS = ['view', 'search', 'add', 'transport', 'skip', 'playNow', 'playlist', 'volume', 'seek', 'queue', 'reorder', 'mode', 'savePlaylist'];
export const BASIC_PERMISSIONS = ['view', 'search', 'add', 'transport', 'skip'];
export const hash = value => createHash('sha256').update(value).digest('hex');
export const token = () => randomBytes(32).toString('base64url');
export function createVault(key) {
  if (key.length !== 32) throw new Error('Invalid encryption key');
  return {
    encrypt(value) {
      if (!value) return '';
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
      return `v1:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`;
    },
    decrypt(value) {
      if (!value) return '';
      if (!value.startsWith('v1:')) throw new Error('未加密的凭据被拒绝');
      const data = Buffer.from(value.slice(3), 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    }
  };
}
export class ShareAuthority {
  constructor() { this.grants = new Map(); this.sessions = new Map(); this.runId = null; }
  beginRun() { this.endRun(); this.runId = randomUUID(); return this.runId; }
  endRun() { this.runId = null; this.grants.clear(); this.sessions.clear(); }
  create(name, permissions = BASIC_PERMISSIONS) {
    if (!this.runId) throw new Error('请先启动机器人');
    if (!Array.isArray(permissions) || permissions.some(p => !ALL_PERMISSIONS.includes(p))) throw new Error('权限无效');
    const raw = token(); const grant = { id: randomUUID(), name: String(name || '朋友').slice(0, 40), runId: this.runId, permissions: [...new Set(['view', ...permissions])], hash: hash(raw), raw, createdAt: Date.now() };
    this.grants.set(grant.id, grant); return grant;
  }
  exchange(raw) {
    if (typeof raw !== 'string' || raw.length !== 43) throw new Error('分享链接无效或已失效');
    const grant = [...this.grants.values()].find(g => g.hash === hash(raw) && g.runId === this.runId);
    if (!grant || !this.runId) throw new Error('分享链接无效或已失效');
    const session = token(); const csrf = token();
    this.sessions.set(hash(session), { grantId: grant.id, runId: this.runId, csrf, createdAt: Date.now() });
    return { session, csrf, grant: this.public(grant) };
  }
  authenticate(raw, permission, csrf) {
    if (typeof raw !== 'string' || raw.length !== 43) throw new Error('请重新打开分享链接');
    const session = this.sessions.get(hash(raw)); const grant = session && this.grants.get(session.grantId);
    if (!grant || !this.runId || session.runId !== this.runId) throw new Error('授权已失效，请联系机器人主人');
    if (csrf !== undefined && csrf !== session.csrf) throw new Error('请求校验失败');
    if (permission && !grant.permissions.includes(permission)) throw new Error('此链接没有该操作权限');
    return { ...session, grant: this.public(grant) };
  }
  revoke(id) {
    this.grants.delete(id);
    for (const [key, session] of this.sessions) if (session.grantId === id) this.sessions.delete(key);
  }
  setIdentity(raw, name, csrf) {
    this.authenticate(raw, 'view', csrf);
    const session = this.sessions.get(hash(raw)); session.displayName = visitorName(name);
    return { name: session.displayName };
  }
  update(id, permissions) {
    const grant = this.grants.get(id); if (!grant) throw new Error('链接已失效');
    if (!Array.isArray(permissions) || permissions.some(p => !ALL_PERMISSIONS.includes(p))) throw new Error('权限无效');
    grant.permissions = [...new Set(['view', ...permissions])];
  }
  public(g) { return { id: g.id, name: g.name, permissions: g.permissions, createdAt: g.createdAt }; }
}
export class CommandGate {
  constructor() { this.tail = Promise.resolve(); this.results = new Map(); }
  run(scope, id, fn) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw new Error('请求标识无效');
    const key = `${scope}:${id}`;
    if (this.results.has(key)) return this.results.get(key);
    const result = this.tail.then(fn); this.tail = result.catch(() => {});
    this.results.set(key, result);
    if (this.results.size > 1000) this.results.delete(this.results.keys().next().value);
    return result;
  }
}
