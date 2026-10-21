import { ShareAuthority, ALL_PERMISSIONS, hash } from '../shared/security.mjs';

// Opt-in for the fixed server endpoint only. Sessions and run IDs remain
// ephemeral; encrypted invitations survive a backend or bot restart.
export class PersistentShareAuthority extends ShareAuthority {
  constructor(store, vault) {
    super(); this.store = store; this.vault = vault; this.records = []; this.automaticId = '';
    const saved = store.get('serverFixedInvitations');
    if (saved) {
      const data = JSON.parse(vault.decrypt(saved));
      if (data.version !== 1 || !Array.isArray(data.grants)) throw new Error('固定分享配置无效');
      for (const g of data.grants) {
        if (typeof g.id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(g.raw) || typeof g.name !== 'string' || !Array.isArray(g.permissions) || g.permissions.some(p => !ALL_PERMISSIONS.includes(p))) throw new Error('固定分享配置无效');
        this.records.push({ id: g.id, raw: g.raw, name: g.name, permissions: [...new Set(['view', ...g.permissions])], createdAt: g.createdAt });
      }
      this.automaticId = data.automaticId || '';
    }
  }
  persist(records = this.records, automaticId = this.automaticId) {
    this.store.set('serverFixedInvitations', this.vault.encrypt(JSON.stringify({ version: 1, grants: records, automaticId })));
  }
  beginRun() {
    const runId = super.beginRun();
    for (const record of this.records) this.grants.set(record.id, { ...record, permissions: [...record.permissions], hash: hash(record.raw), runId });
    return runId;
  }
  create(name, permissions) {
    return this.createRecord(name, permissions);
  }
  createRecord(name, permissions, automatic = false) {
    const grant = super.create(name, permissions);
    const { id, raw, createdAt } = grant;
    const records = [...this.records, { id, raw, createdAt, name: grant.name, permissions: [...grant.permissions] }];
    const automaticId = automatic ? grant.id : this.automaticId;
    try { this.persist(records, automaticId); } catch (error) { this.grants.delete(id); throw error; }
    this.records = records; this.automaticId = automaticId; return grant;
  }
  createAutomatic(permissions) {
    const existing = this.grants.get(this.automaticId);
    if (existing) return existing;
    return this.createRecord('频道共享（自动）', permissions, true);
  }
  update(id, permissions) {
    const grant = this.grants.get(id); if (!grant) throw new Error('链接已失效');
    if (!Array.isArray(permissions) || permissions.some(p => !ALL_PERMISSIONS.includes(p))) throw new Error('权限无效');
    const next = [...new Set(['view', ...permissions])];
    const records = this.records.map(g => g.id === id ? { ...g, permissions: next } : g);
    this.persist(records); this.records = records; grant.permissions = next;
  }
  revoke(id) {
    const records = this.records.filter(g => g.id !== id); const automaticId = this.automaticId === id ? '' : this.automaticId;
    this.persist(records, automaticId); this.records = records; this.automaticId = automaticId;
    super.revoke(id);
  }
}
