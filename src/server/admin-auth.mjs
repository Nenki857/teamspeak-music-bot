import { randomBytes, timingSafeEqual, scrypt as derive } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { hash, token } from '../shared/security.mjs';

const scrypt = promisify(derive);
const parameters = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const rememberedLifetimeMs = 30 * 24 * 60 * 60 * 1000;
async function passwordAccount(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw new Error('主人密码需要 12–128 个字符');
  const salt = randomBytes(16).toString('base64');
  const digest = await scrypt(password, salt, 32, parameters);
  return { version: 1, salt, digest: digest.toString('base64') };
}
function saveAccount(file, account) {
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(account) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temporary, file); }
  finally { try { unlinkSync(temporary); } catch {} }
}
export async function setAdminPassword(file, password) {
  saveAccount(file, await passwordAccount(password));
}
export class AdminAuthority {
  constructor(file, { now = Date.now, lifetimeMs = 12 * 60 * 60 * 1000 } = {}) {
    const account = JSON.parse(readFileSync(file, 'utf8'));
    if (account.version !== 1 || !/^[A-Za-z0-9+/]{22}==$/.test(account.salt) || Buffer.from(account.digest, 'base64').length !== 32) throw new Error('主人登录配置无效，请重新设置密码');
    Object.assign(this, { file, account, now, lifetimeMs }); this.sessions = new Map(); this.verifying = false;
    for (const item of account.rememberedSessions || []) {
      if (typeof item.key === 'string' && typeof item.csrf === 'string' && Number.isFinite(item.expiresAt) && item.expiresAt > now() && item.expiresAt <= now() + rememberedLifetimeMs) {
        this.sessions.set(item.key, { csrf: item.csrf, expiresAt: item.expiresAt, remembered: true });
      }
    }
  }
  saveSessions(sessions = this.sessions, account = this.account) {
    const rememberedSessions = [...sessions].filter(([,value]) => value.remembered && value.expiresAt > this.now()).map(([key,value]) => ({ key, csrf: value.csrf, expiresAt: value.expiresAt }));
    const saved = { ...account, rememberedSessions }; saveAccount(this.file, saved); this.account = saved;
  }
  async login(password, { remember = false } = {}) {
    if (typeof password !== 'string' || password.length > 128 || this.verifying) throw new Error('登录失败，请稍后重试');
    this.verifying = true;
    try {
      const digest = await scrypt(password, this.account.salt, 32, parameters);
      if (!timingSafeEqual(digest, Buffer.from(this.account.digest, 'base64'))) throw new Error('密码不正确');
      const next = new Map([...this.sessions].filter(([,value]) => value.expiresAt > this.now()));
      if (next.size >= 20) next.delete(next.keys().next().value);
      const session = token(); const csrf = token();
      const maxAge = remember === true ? rememberedLifetimeMs : this.lifetimeMs;
      next.set(hash(session), { csrf, expiresAt: this.now() + maxAge, remembered: remember === true });
      if (remember === true || this.account.rememberedSessions?.length) this.saveSessions(next);
      this.sessions = next;
      return { session, csrf, ...(remember === true ? { maxAgeSeconds: Math.floor(maxAge / 1000) } : {}) };
    } finally { this.verifying = false; }
  }
  authenticate(raw, csrf) {
    const key = typeof raw === 'string' && raw.length === 43 ? hash(raw) : '';
    const session = this.sessions.get(key);
    if (!session || session.expiresAt <= this.now()) { this.sessions.delete(key); throw new Error('主人登录已过期，请重新登录'); }
    if (csrf !== undefined && csrf !== session.csrf) throw new Error('请求校验失败');
    return session;
  }
  async changePassword(raw, csrf, currentPassword, newPassword) {
    this.authenticate(raw, csrf);
    if (typeof currentPassword !== 'string' || currentPassword.length > 128 || this.verifying) throw new Error('暂时无法修改密码，请稍后重试');
    if (typeof newPassword !== 'string' || newPassword.length < 12 || newPassword.length > 128) throw new Error('新密码需要 12–128 个字符');
    if (newPassword === currentPassword) throw new Error('新密码不能与当前密码相同');
    this.verifying = true;
    try {
      const digest = await scrypt(currentPassword, this.account.salt, 32, parameters);
      if (!timingSafeEqual(digest, Buffer.from(this.account.digest, 'base64'))) throw new Error('当前密码不正确');
      this.authenticate(raw, csrf);
      const account = await passwordAccount(newPassword);
      const session = this.authenticate(raw, csrf);
      // Persist before revoking sessions. A failed disk write must not lock
      // the owner out or leave the in-memory password different from disk.
      const retained = new Map([[hash(raw), session]]);
      this.saveSessions(retained, account); this.sessions = retained;
      return true;
    } finally { this.verifying = false; }
  }
  logout(raw) {
    if (typeof raw !== 'string') return;
    const next = new Map(this.sessions); const removed = next.get(hash(raw)); next.delete(hash(raw));
    if (removed?.remembered) this.saveSessions(next);
    this.sessions = next;
  }
  close() { this.sessions.clear(); }
}
