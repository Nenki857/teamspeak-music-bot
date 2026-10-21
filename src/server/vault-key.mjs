import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

export function serverVaultKey(directory) {
  const file = resolve(directory, 'server-vault.key');
  // Windows DPAPI keys cannot be decrypted by a different host. Never silently
  // create a replacement key alongside a copied desktop database.
  if (!existsSync(file) && ['app.db', 'core.db', 'vault.key'].some(name => existsSync(resolve(directory, name)))) throw new Error('检测到已有数据但缺少服务器密钥；请使用独立数据目录，或先完成凭据迁移');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32), { mode: 0o600, flag: 'wx' });
  if (process.platform !== 'win32') chmodSync(file, 0o600);
  const key = readFileSync(file); if (key.length !== 32) throw new Error('服务器加密密钥无效');
  return key;
}
