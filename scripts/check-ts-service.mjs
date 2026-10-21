import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const original = resolve('data/app.db');
process.env.TSMD_DATA_DIR = resolve('work/ts-service-check-' + randomUUID());
const require = createRequire(resolve('vendor/teamspeak-music-bot-1.13.2/package.json'));
const Database = require('better-sqlite3'); const db = new Database(original, { readonly: true, fileMustExist: true });
const preset = JSON.parse(db.prepare('SELECT json FROM presets LIMIT 1').get().json); db.close();
if (preset.serverPassword || preset.channelPassword) throw new Error('此短时检查不读取或解密保存的密码');
const { Service } = await import('../src/worker/service.mjs'); const { createVault } = await import('../src/shared/security.mjs');
const service = new Service(createVault(randomBytes(32)), () => {}); let code = 0;
try {
  await service.init(); const saved = await service.rpc('presets.save', { name: 'Connection check', serverAddress: preset.serverAddress, serverPort: preset.serverPort, defaultChannel: preset.defaultChannel, channelId: preset.channelId, nickname: 'MusicBot_Check_' + Date.now().toString().slice(-4) });
  const began = Date.now(); const result = await service.rpc('bot.start', { id: saved.id });
  assert.equal(result.phase, 'running'); assert.equal(result.player.connected, true); assert.notEqual(result.player.channelId, '0');
  console.log(JSON.stringify({ phase: result.phase, connected: result.player.connected, channelId: result.player.channelId, elapsedMs: Date.now() - began }));
  await service.rpc('bot.stop'); assert.equal(service.snapshot().phase, 'stopped'); assert.equal(service.snapshot().player.connected, false); console.log('Stop completed');
} catch (error) { code = 1; console.log('Connection check failed:', error.message); }
finally { service.close(); setTimeout(() => process.exit(code), 1500); }
