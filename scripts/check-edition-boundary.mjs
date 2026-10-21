import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';

// Explicit before/after guard for directory organization. Never updates its baseline.
const baseline = JSON.parse(readFileSync(resolve(process.argv[2] || 'work/edition-protected-before.json'), 'utf8'));
const now = {};
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = resolve(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.isFile()) now[relative(process.cwd(), file).replaceAll('\\', '/')] = createHash('sha256').update(readFileSync(file)).digest('hex');
  }
}
for (const dir of ['src', 'vendor/teamspeak-music-bot-1.13.2/src', 'vendor/teamspeak-music-bot-1.13.2/dist', 'archives']) walk(dir);
assert.deepEqual(now, baseline, 'Runtime, playback core or original-chain archive changed during directory organization');
console.log(`Edition separation boundary verified: ${Object.keys(now).length} runtime/core/archive files unchanged.`);
