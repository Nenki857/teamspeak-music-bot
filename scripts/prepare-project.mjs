import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { preparePublicTunnel } from './prepare-public-tunnel.mjs';
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
export async function prepare(edition, { requireTunnel = false } = {}) {
  if (!['local', 'server'].includes(edition)) throw Error('版本类型无效');
  if (process.versions.node.split('.')[0] !== '22') throw Error('请使用统一入口准备 Node.js 22');
  mkdirSync(state, { recursive: true });
  dependencies(root, 'desktop', ['node_modules/vue/package.json', 'node_modules/vite/bin/vite.js', ...(edition === 'local' ? ['node_modules/electron/dist/electron.exe'] : [])], { environment: { ELECTRON_SKIP_BINARY_DOWNLOAD: edition === 'server' ? '1' : '' } });
  dependencies(core, 'core', ['node_modules/typescript/bin/tsc', 'node_modules/NeteaseCloudMusicApi/package.json', ...(edition === 'local' ? ['node_modules/ffmpeg-static/ffmpeg.exe'] : [])], { ignoreScripts: edition === 'server' });
  if (edition === 'local') {
  const native = spawnSync(process.execPath, ['--input-type=module', '-e', "import{createRequire}from'node:module';const r=createRequire(process.argv[1]);const DB=r('better-sqlite3');new DB(':memory:').close();new(r('@discordjs/opus').OpusEncoder)(48000,2).encode(Buffer.alloc(3840));", resolve(core, 'package.json')], { cwd: root, windowsHide: true, stdio: 'ignore' });
  if (native.status !== 0) { console.log('[Setup] Preparing native audio dependencies'); npm(['rebuild', 'better-sqlite3', '@discordjs/opus', '--foreground-scripts'], core); }
  }
  const coreStamp = resolve(state, 'core-build'), coreHash = sourceFingerprint(['vendor/teamspeak-music-bot-1.13.2/src']) + fileHash(resolve(core, 'tsconfig.json'));
  if (!existsSync(resolve(core, 'dist/audio/player.js')) || !existsSync(coreStamp) || readFileSync(coreStamp, 'utf8') !== coreHash) { console.log('[Setup] Building the audio engine'); run(['scripts/build-core.mjs']); writeFileSync(coreStamp, coreHash); }
  const marker = resolve(state, edition + '-build');
  const fingerprint = sourceFingerprint(['src/renderer', 'public']) + fileHash(resolve(root, 'vite.config.mjs')) + fileHash(resolve(root, 'package-lock.json'));
  const output = resolve(root, edition === 'server' ? 'dist/server-ui/index.html' : 'dist/ui/index.html');
  if (!existsSync(output) || !existsSync(marker) || readFileSync(marker, 'utf8') !== fingerprint) {
    console.log('[Setup] Building the ' + edition + ' interface');
    run(['node_modules/vite/bin/vite.js', 'build', ...(edition === 'server' ? ['--mode', 'server'] : [])]); writeFileSync(marker, fingerprint);
  }
  if (edition === 'local') {
    mkdirSync(resolve(root, 'resources/node'), { recursive: true });
    const bundled = resolve(root, 'resources/node/node.exe');
    if (!existsSync(bundled)) copyFileSync(process.execPath, bundled);
    await preparePublicTunnel({ root, required: requireTunnel });
  }
  console.log(edition === 'server' ? 'Server edition is ready.' : 'Local edition is ready to start.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, edition = 'local'] = process.argv.slice(2);
  try {
    await prepare(edition, { requireTunnel: action === 'package' });
    if (action === 'package' && edition === 'server') for (const file of ['package-server.mjs', 'check-server-package.mjs', 'package-server-update.mjs', 'check-server-update.mjs']) run(['scripts/' + file]);
    else if (action === 'package' && edition === 'local') {
      run(['scripts/create-icon.mjs']);
      if (!existsSync(resolve(root, 'resources/licenses/Node-v22.14.0-LICENSE.txt'))) run(['scripts/collect-runtime-licenses.mjs']);
      for (const file of ['prepare-package.mjs', 'package-windows.mjs', 'check-package.mjs']) run(['scripts/' + file]);
    } else if (action !== 'prepare') throw Error('准备操作无效');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
