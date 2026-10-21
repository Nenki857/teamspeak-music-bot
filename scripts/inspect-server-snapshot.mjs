import { readFileSync, readdirSync, lstatSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CODE_PATHS } from './export-server-code.mjs';

const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
export function inspectSnapshot(stage, local) {
  const manifest = JSON.parse(readFileSync(resolve(stage, 'source-snapshot.json'), 'utf8'));
  if (manifest.kind !== 'tsmd-server-source-snapshot' || manifest.privateDataIncluded !== false || !manifest.files) throw Error('Invalid source snapshot');
  const allowed = name => CODE_PATHS.some(path => name === path || name.startsWith(path + '/'));
  const changed = [], added = [], identical = [];
  for (const [name, digest] of Object.entries(manifest.files)) {
    if (!allowed(name) || name.includes('\\') || name.split('/').some(part => ['..', '.', ''].includes(part)) || !/^[a-f0-9]{64}$/.test(digest)) throw Error('Invalid snapshot path or hash');
    const file = resolve(stage, name);
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || hash(file) !== digest) throw Error('Snapshot file checksum mismatch');
    if (!existsSync(resolve(local, name))) added.push(name);
    else if (hash(resolve(local, name)) !== digest) changed.push(name);
    else identical.push(name);
  }
  function walk(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + entry.name, file = resolve(dir, entry.name), stat = lstatSync(file);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw Error('Snapshot contains unsupported entries');
      if (stat.isDirectory()) walk(file, name + '/');
      else if (name !== 'source-snapshot.json' && !manifest.files[name]) throw Error('Snapshot has unlisted files');
    }
  }
  walk(stage);
  return { kind: 'tsmd-server-source-comparison', capturedAt: manifest.capturedAt, version: manifest.version, backend: manifest.backend, changed, added, identicalCount: identical.length, applied: false, rendererSourceIncluded: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stage = resolve(process.argv[2]), local = fileURLToPath(new URL('../', import.meta.url));
  const report = inspectSnapshot(stage, local);
  const output = process.argv[3] ? resolve(process.argv[3]) : resolve(local, 'work/server-source-comparison.json');
  writeFileSync(output, JSON.stringify({ ...report, snapshotDirectory: stage }, null, 2) + '\n');
  console.log(`Downloaded server version: ${report.version}; selected audio backend: ${report.backend}`);
  console.log(`Compared with local project: ${report.changed.length} changed, ${report.added.length} added, ${report.identicalCount} identical files.`);
  console.log('Snapshot verified. Local project files have not been overwritten.');
}
