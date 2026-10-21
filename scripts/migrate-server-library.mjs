import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { exportLibrary, importLibrary } from '../src/server/library-migration.mjs';
const [mode, file, output] = process.argv.slice(2);
if (mode === 'export' && file && output) {
  const value = exportLibrary(resolve(file));
  writeFileSync(resolve(output), JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  console.log(`已导出 ${value.localPlaylists.length} 个自建歌单、${value.openPlaylists.length} 个网易云歌单引用；不含登录凭据。`);
} else if (mode === 'import' && file) {
  const [{ dataDir }, { serverVaultKey }, { createVault }, { Store }] = await Promise.all([import('../src/worker/paths.mjs'), import('../src/server/vault-key.mjs'), import('../src/shared/security.mjs'), import('../src/worker/store.mjs')]);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const store = new Store(createVault(serverVaultKey(dataDir)));
  try { const result = importLibrary(store, JSON.parse(readFileSync(resolve(file), 'utf8'))); console.log(`已新增 ${result.added} 个歌单，跳过 ${result.skipped} 个已有歌单；未覆盖原有内容。`); }
  finally { store.close(); }
} else throw new Error('用法：node scripts/migrate-server-library.mjs export 数据库路径 输出JSON路径；或设置 TSMD_DATA_DIR 后执行 import JSON路径（请先停止音乐后台）');
