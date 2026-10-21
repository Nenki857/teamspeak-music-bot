import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const core = resolve(root, 'vendor/teamspeak-music-bot-1.13.2');
const state = resolve(root, 'work/setup');
const digest = text => createHash('sha256').update(text).digest('hex');
const fileHash = name => digest(readFileSync(name));
export function sourceFingerprint(paths, base = root) {
  const hash = createHash('sha256');
  function visit(name) {
    if (!existsSync(name)) { hash.update('missing:' + relative(base, name)); return; }
    for (const item of readdirSync(name, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.isSymbolicLink()) throw Error('构建源文件不能是符号链接');
      const file = resolve(name, item.name);
      if (item.isDirectory()) visit(file);
      else { hash.update(relative(base, file).replaceAll('\\', '/')); hash.update(readFileSync(file)); }
    }
  }
  for (const name of paths) visit(resolve(base, name));
  return hash.digest('hex');
}
function run(args, cwd = root, environment = {}) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit', windowsHide: true, env: { ...process.env, ...environment } });
  if (result.error || result.status !== 0) throw Error('准备失败：' + args.slice(0, 2).join(' ') + '；请查看上方错误，修复后使用同一入口重试');
}
function npm(args, cwd, environment) {
  const cli = process.env.TSMD_NPM_CLI;
  if (!cli || !existsSync(cli)) throw Error('未找到 npm，请重新运行统一入口准备 Node.js 工具链');
  run([cli, ...args], cwd, environment);
}
export function needsPreparation({ previous, expected, required, exists = existsSync }) {
  return (previous !== null && previous !== expected) || required.some(name => !exists(name));
}
function dependencies(directory, name, required, options = {}) {
  const expected = digest(readFileSync(resolve(directory, 'package-lock.json')) + '\n' + process.version + '\n' + process.arch);
  const marker = resolve(state, name + '-dependencies');
  const previous = existsSync(marker) ? readFileSync(marker, 'utf8') : null;
  if (needsPreparation({ previous, expected, required: required.map(file => resolve(directory, file)) })) {
    console.log('[Setup] Installing ' + name + ' dependencies (npm)');
    npm(['ci', ...(options.ignoreScripts ? ['--ignore-scripts'] : []), '--no-audit', '--no-fund', '--foreground-scripts', '--loglevel=http', '--no-progress'], directory, options.environment);
  }
  writeFileSync(marker, expected);
}
export async function prepare(edition) {
  if (edition !== 'server') throw Error('Windows local edition: download the complete ZIP from https://github.com/Nenki857/teamspeak-music-bot/releases. Automatic local installation has been removed.');
  if (process.versions.node.split('.')[0] !== '22') throw Error('请使用统一入口准备 Node.js 22');
  mkdirSync(state, { recursive: true });
  dependencies(root, 'server-build', ['node_modules/vue/package.json', 'node_modules/vite/bin/vite.js'], { environment: { ELECTRON_SKIP_BINARY_DOWNLOAD: '1' } });
  dependencies(core, 'core', ['node_modules/typescript/bin/tsc', 'node_modules/NeteaseCloudMusicApi/package.json'], { ignoreScripts: true });
  const coreStamp = resolve(state, 'core-build'), coreHash = sourceFingerprint(['vendor/teamspeak-music-bot-1.13.2/src']) + fileHash(resolve(core, 'tsconfig.json'));
  if (!existsSync(resolve(core, 'dist/audio/player.js')) || !existsSync(coreStamp) || readFileSync(coreStamp, 'utf8') !== coreHash) { console.log('[Setup] Building the audio engine'); run(['scripts/build-core.mjs']); writeFileSync(coreStamp, coreHash); }
  const marker = resolve(state, 'server-build');
  const fingerprint = sourceFingerprint(['src/renderer', 'public']) + fileHash(resolve(root, 'vite.config.mjs')) + fileHash(resolve(root, 'package-lock.json'));
  const output = resolve(root, 'dist/server-ui/index.html');
  if (!existsSync(output) || !existsSync(marker) || readFileSync(marker, 'utf8') !== fingerprint) {
    console.log('[Setup] Building the server interface');
    run(['node_modules/vite/bin/vite.js', 'build', '--mode', 'server']); writeFileSync(marker, fingerprint);
  }
  console.log('Server edition is ready.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, edition = 'local'] = process.argv.slice(2);
  try {
    if (!['prepare', 'package'].includes(action)) throw Error('准备操作无效');
    await prepare(edition);
    if (action === 'package') for (const file of ['package-server.mjs', 'check-server-package.mjs', 'package-server-update.mjs', 'check-server-update.mjs']) run(['scripts/' + file]);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
