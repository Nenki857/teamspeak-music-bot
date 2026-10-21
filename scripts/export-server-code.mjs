import { mkdirSync, mkdtempSync, readFileSync, readdirSync, lstatSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CODE_PATHS = ['src/server', 'src/worker', 'src/shared', 'dist/ui', 'deploy', 'package.json', 'package-lock.json', 'server-manifest.json', 'vendor/teamspeak-music-bot-1.13.2/src', 'vendor/teamspeak-music-bot-1.13.2/dist', 'vendor/teamspeak-music-bot-1.13.2/package.json', 'vendor/teamspeak-music-bot-1.13.2/package-lock.json', 'vendor/teamspeak-music-bot-1.13.2/LICENSE'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => { const rel = relative(root, path); return rel && !rel.startsWith('..' + sep) && rel !== '..' && !resolve(rel).startsWith('\\\\'); };

export function stageServerCode(app, stage) {
  app = resolve(app); stage = resolve(stage);
  if (stage === app || inside(app, stage)) throw Error('Export staging directory must be outside the installed app');
  const files = {};
  function copy(name) {
    const source = resolve(app, name);
    let stat;
    try { stat = lstatSync(source); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw Error('Source snapshot refuses symbolic links');
    if (stat.isDirectory()) { for (const entry of readdirSync(source)) copy(name + '/' + entry); return; }
    if (!stat.isFile()) throw Error('Source snapshot refuses special files');
    if (/(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|server\.env|server-admin\.json|official-transport\.json)|\.(?:db|sqlite|key|pem|log)$/i.test(name)) throw Error('Private or runtime file in source tree');
    mkdirSync(dirname(resolve(stage, name)), { recursive: true });
    // Hash the copied bytes, rather than a second read of a potentially changing file.
    copyFileSync(source, resolve(stage, name));
    files[name] = hash(readFileSync(resolve(stage, name)));
  }
  for (const name of CODE_PATHS) copy(name);
  for (const required of ['package.json', 'src/server/entry.mjs', 'dist/ui/index.html']) if (!files[required]) throw Error('Installed source is incomplete');
  for (const [name, digest] of Object.entries(files)) if (hash(readFileSync(resolve(app, name))) !== digest) throw Error('Server code changed during snapshot; retry after the update finishes');
  const version = JSON.parse(readFileSync(resolve(stage, 'package.json'), 'utf8')).version;
  let backend = 'custom';
  try { backend = readFileSync(resolve(app, 'server.env'), 'utf8').match(/^TSMD_AUDIO_BACKEND=(custom|official)\r?$/m)?.[1] || 'custom'; } catch {}
  const manifest = { kind: 'tsmd-server-source-snapshot', capturedAt: new Date().toISOString(), version, backend, privateDataIncluded: false, rendererSourceIncluded: false, files };
  writeFileSync(resolve(stage, 'source-snapshot.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [app, output] = process.argv.slice(2);
  if (!app || !output || !/^tsmd-source-\d+-\d+\.tar\.gz$/.test(output)) throw Error('Invalid snapshot arguments');
  const home = process.env.HOME;
  if (!home) throw Error('Missing server home directory');
  const stage = mkdtempSync(resolve(home, '.tsmd-source-stage-'));
  const manifest = stageServerCode(app, stage);
  const archive = resolve(home, output);
  const result = spawnSync('tar', ['-czf', archive, '-C', stage, '.'], { stdio: 'inherit', timeout: 120000 });
  if (result.status !== 0) throw Error('Source archive failed');
  writeFileSync(archive + '.sha256', hash(readFileSync(archive)) + '\n', { mode: 0o600 });
  console.log(`Source snapshot ready: version ${manifest.version}, backend ${manifest.backend}, ${Object.keys(manifest.files).length} files.`);
}
