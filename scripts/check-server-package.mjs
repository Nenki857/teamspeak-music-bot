import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const archive = resolve(`release/server/TS-Music-Desk-Server-${pkg.version}.tar.gz`);
const listed = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
assert.equal(listed.status, 0); const files = listed.stdout.split(/\r?\n/).filter(Boolean).map(name => name.replace(/^\.\//, ''));
for (const required of ['LICENSE', 'THIRD-PARTY-NOTICES.txt', 'src/server/entry.mjs', 'src/server/admin-auth.mjs', 'src/server/vault-key.mjs', 'src/worker/core-worker-entry.mjs', 'src/worker/music-worker-entry.mjs', 'src/shared/security.mjs', 'dist/ui/index.html', 'deploy/install-ubuntu.sh', 'deploy/preflight.sh', 'deploy/wait-server.sh', 'package-lock.json', 'scripts/migrate-server-library.mjs', 'vendor/teamspeak-music-bot-1.13.2/package-lock.json', 'vendor/teamspeak-music-bot-1.13.2/dist/audio/player.js']) assert.ok(files.includes(required), `Missing ${required}`);
assert.ok(files.includes('src/worker/web-delivery.mjs'));
for (const [name,limit] of [['dist/ui/logo.png',64*1024],['dist/ui/favicon.ico',8*1024]]) {
  const image=spawnSync('tar',['-xOzf',archive,'./'+name],{windowsHide:true,maxBuffer:2*1024*1024});
  assert.equal(image.status,0);assert.ok(image.stdout.length<limit,`Oversized server image ${name}`);
}
for (const name of files) {
  assert.equal(/^(data|server-data|work|release|node_modules|resources|src\/desktop)(\/|$)/.test(name), false, `Local data/binary ${name}`);
  assert.equal(/(^|\/)(?:vault\.key|server-vault\.key|server-admin\.json|app\.db|core\.db|\.npmrc|\.env)$|\.(exe|dll|node|log)$/i.test(name), false, `Private/platform file ${name}`);
}
console.log(`Server archive check passed: ${files.length} entries, ${(statSync(archive).size / 1024 / 1024).toFixed(2)} MiB; no local data, keys or Windows runtimes.`);
