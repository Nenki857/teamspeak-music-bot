import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CODE_PATHS } from './export-server-code.mjs';

const dir = resolve(process.argv[2]), archive = resolve(dir, 'code.tar.gz');
const expected = readFileSync(archive + '.sha256', 'utf8').trim();
if (!/^[a-f0-9]{64}$/.test(expected) || createHash('sha256').update(readFileSync(archive)).digest('hex') !== expected) throw Error('Downloaded source checksum mismatch');
const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
if (listing.status !== 0) throw Error('Cannot list source archive');
for (const raw of listing.stdout.trim().split(/\r?\n/)) {
  const name = raw.replace(/^\.\//, '').replace(/\/$/, '');
  if (name === '.' || name === '') continue;
  if (name.includes('\\') || name.split('/').some(part => ['..', '.', ''].includes(part)) || name.includes(':')) throw Error('Unsafe source archive path');
  if (name !== 'source-snapshot.json' && !CODE_PATHS.some(path => name === path || name.startsWith(path + '/') || path.startsWith(name + '/'))) throw Error('Unexpected source archive path');
}
const verbose = spawnSync('tar', ['-tvzf', archive], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
if (verbose.status !== 0 || verbose.stdout.trim().split(/\r?\n/).some(line => !/^[d-]/.test(line))) throw Error('Archive links and special files are forbidden');
const stage = resolve(dir, 'source'); mkdirSync(stage);
const extracted = spawnSync('tar', ['-xzf', archive, '-C', stage], { encoding: 'utf8', windowsHide: true });
if (extracted.status !== 0) throw Error('Source extraction failed');
const inspected = spawnSync(process.execPath, [fileURLToPath(new URL('./inspect-server-snapshot.mjs', import.meta.url)), stage, resolve(dir, 'comparison.json')], { stdio: 'inherit', windowsHide: true });
if (inspected.status !== 0) throw Error('Source snapshot validation failed');
