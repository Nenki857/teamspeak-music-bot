import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { stageServerCode } from '../scripts/export-server-code.mjs';
import { inspectSnapshot } from '../scripts/inspect-server-snapshot.mjs';

function fixture() {
  mkdirSync('work', { recursive: true });
  const root = mkdtempSync(resolve('work/source-pull-test-')), app = resolve(root, 'app'), stage = resolve(root, 'source');
  const put = (name, content) => { mkdirSync(dirname(resolve(app, name)), { recursive: true }); writeFileSync(resolve(app, name), content); };
  put('package.json', JSON.stringify({ version: '1.2.0' }));put('src/server/entry.mjs', 'server-code');put('dist/ui/index.html', '<html>server</html>');
  put('server.env', 'TSMD_AUDIO_BACKEND=official\nPRIVATE_PASSWORD=DO_NOT_EXPORT\n');put('server-data/server-admin.json', 'PRIVATE_ADMIN_DATA');put('runtime/sinusbot/config.ini', 'PRIVATE_BRIDGE_DATA');
  mkdirSync(stage);return { root, app, stage, put };
}
test('server source export excludes private files, records selected backend and compares actual copied hashes', () => {
  const { app, stage } = fixture();const m = stageServerCode(app, stage);
  assert.equal(m.backend, 'official');assert.equal(m.version, '1.2.0');assert.equal(m.privateDataIncluded, false);
  assert.equal(existsSync(resolve(stage, 'server.env')), false);assert.equal(existsSync(resolve(stage, 'server-data')), false);assert.equal(existsSync(resolve(stage, 'runtime')), false);
  const report = inspectSnapshot(stage, app);assert.equal(report.changed.length, 0);assert.equal(report.identicalCount, 3);
  writeFileSync(resolve(app, 'src/server/entry.mjs'), 'local-code');assert.deepEqual(inspectSnapshot(stage, app).changed, ['src/server/entry.mjs']);
  assert.equal(readFileSync(resolve(app, 'src/server/entry.mjs'), 'utf8'), 'local-code');
  writeFileSync(resolve(stage, 'src/server/entry.mjs'), 'tampered');assert.throws(() => inspectSnapshot(stage, app), /checksum mismatch/);
});
test('private files hidden in a code tree cause the export to stop', () => {
  const { app, stage, put } = fixture();put('src/server/session.key', 'PRIVATE');assert.throws(() => stageServerCode(app, stage), /Private or runtime file/);
});
test('receiver verifies archive digest before extraction and validates a complete source download', () => {
  const { root, app, stage } = fixture();stageServerCode(app, stage);
  const dir=resolve(root,'download');mkdirSync(dir);const archive=resolve(dir,'code.tar.gz');
  const packed=spawnSync('tar',['-czf',archive,'-C',stage,'.'],{encoding:'utf8',windowsHide:true});assert.equal(packed.status,0,packed.stderr);
  writeFileSync(archive+'.sha256','0'.repeat(64));
  const receiver=resolve('scripts/receive-server-snapshot.mjs');
  const rejected=spawnSync(process.execPath,[receiver,dir],{encoding:'utf8',windowsHide:true});assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/checksum mismatch/);assert.equal(existsSync(resolve(dir,'source')),false);
  writeFileSync(archive+'.sha256',createHash('sha256').update(readFileSync(archive)).digest('hex'));
  const accepted=spawnSync(process.execPath,[receiver,dir],{encoding:'utf8',windowsHide:true});assert.equal(accepted.status,0,accepted.stderr);assert.match(accepted.stdout,/Snapshot verified/);
  assert.equal(readFileSync(resolve(dir,'source/src/server/entry.mjs'),'utf8'),'server-code');
});
