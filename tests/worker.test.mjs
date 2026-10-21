import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
test('standalone Node worker initializes native core and exits cleanly', async t => {
  const child = fork(resolve('src/worker/entry.mjs'), [], { execPath: existsSync(resolve('resources/node/node.exe')) ? resolve('resources/node/node.exe') : process.execPath, cwd: resolve('.'), env: { ...process.env, TSMD_DATA_DIR: resolve('work/worker-test-' + randomUUID()) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  t.after(() => { if (!child.killed) child.kill(); }); let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const ready = new Promise((accept, reject) => { const timer = setTimeout(() => reject(new Error('worker startup timeout: ' + stderr.slice(0, 200))), 15000); child.on('message', message => { if (message.type === 'ready') { clearTimeout(timer); accept(message); } if (message.type === 'fatal') { clearTimeout(timer); reject(new Error(message.error)); } }); child.on('exit', code => { clearTimeout(timer); reject(new Error('worker exited ' + code + ': ' + stderr.slice(0, 200))); }); });
  child.send({ type: 'init', key: randomBytes(32).toString('base64') }); const result = await ready;
  assert.equal(result.state.ready, true); assert.equal(result.state.phase, 'stopped'); assert.ok(result.port > 0);
  assert.equal(result.state.audioHealth.isolatedCore, true, 'production must use the isolated playback worker');
  const response = await fetch(`http://127.0.0.1:${result.port}/`); assert.equal(response.status, 200);
  const exited = new Promise((accept, reject) => { const timer = setTimeout(() => reject(new Error('worker shutdown timeout')), 7000); child.once('exit', code => { clearTimeout(timer); accept(code); }); });
  child.send({ type: 'shutdown' }); assert.equal(await exited, 0);
});
