import { fork, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { inspectWindowsKoffiRuntime } from './windows-native-runtime.mjs';
const appRoot = resolve(process.argv[2] || 'release/local/win-unpacked/resources/app');
const testData = resolve('work/package-check-' + randomUUID()); mkdirSync(testData, { recursive: true });
for (const path of ['data', '.env', 'work', '.npmrc']) if (existsSync(resolve(appRoot, path))) throw new Error('Private/development directory in release: ' + path);
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(resolve(dir, entry.name)) : [resolve(dir, entry.name)]);
const files = walk(appRoot);
if (files.some(path => /[\\/](app\.db|core\.db|vault\.key|window-state\.json|desktop-profile|bot-connection\.log)([\\/]|$)/.test(path))) throw new Error('Private data file in release');
const hashFile = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const currentVersion = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version;
if (JSON.parse(readFileSync(resolve(appRoot, 'package.json'), 'utf8')).version !== currentVersion) throw new Error('Packaged version does not match the project');
for (const file of [
  ...walk(resolve('src')).map(path => path.slice(resolve('.').length + 1)),
  ...walk(resolve('dist/ui')).map(path => path.slice(resolve('.').length + 1))
]) {
  if (hashFile(resolve(appRoot, file)) !== hashFile(resolve(file))) throw new Error('Stale packaged file: ' + file);
}
const requireCore = createRequire(resolve(appRoot, 'vendor/teamspeak-music-bot-1.13.2/package.json'));
for (const name of ['better-sqlite3', '@discordjs/opus', '@honeybbq/teamspeak-client', 'NeteaseCloudMusicApi', 'ffmpeg-static', 'ws']) {
  if (!requireCore.resolve(name).startsWith(appRoot + sep)) throw new Error('Runtime dependency resolves outside the package: ' + name);
}
const node = resolve(appRoot, 'resources/node/node.exe');
const desktopNative = inspectWindowsKoffiRuntime(appRoot);
const desktopProbe = spawnSync(node, ['--input-type=module', '-e', "import { createRequire } from 'node:module';\nimport { pathToFileURL } from 'node:url';\nimport { resolve } from 'node:path';\nconst root = process.argv[1];\nconst require = createRequire(resolve(root, 'package.json'));\nconst cjs = require('koffi');\nconst { default: esm } = await import(pathToFileURL(resolve(root, 'node_modules/koffi/index.js')).href);\nfor (const ffi of [cjs, esm]) {\n  const pid = ffi.load('kernel32.dll').func('uint32 __stdcall GetCurrentProcessId()')();\n  if (pid !== process.pid) throw new Error('Koffi Windows call failed');\n}\nconst { createResourceMonitor } = await import(pathToFileURL(resolve(root, 'src/desktop/resource-monitor.mjs')).href);\nconst sample = createResourceMonitor().sample();\nif (!(sample.memory.bytes > 0)) throw new Error('Packaged Windows resource counters unavailable');\nawait import(pathToFileURL(resolve(root, 'src/worker/windows-job.mjs')).href);\nconsole.log(JSON.stringify({ koffi: esm.version, windowsCall: true, resourceCounters: true, electron: process.versions.electron || null }));", appRoot], { encoding: 'utf8', windowsHide: true, cwd: testData });
if (desktopProbe.status !== 0) throw new Error('Packaged desktop native module cannot load: ' + desktopProbe.stderr);

const opusProbe = spawnSync(node, ['--input-type=module', '-e', `import { createRequire } from 'node:module'; const require = createRequire(process.argv[1]); const { OpusEncoder } = require('@discordjs/opus'); const encoder = new OpusEncoder(48000, 2); const frame = encoder.encode(Buffer.alloc(3840)); if (encoder.decode(frame).length !== 3840) throw new Error('Opus roundtrip failed');`, resolve(appRoot, 'vendor/teamspeak-music-bot-1.13.2/package.json')], { encoding: 'utf8', windowsHide: true, cwd: testData });
if (opusProbe.status !== 0) throw new Error('Packaged Opus cannot encode/decode: ' + opusProbe.stderr);
const ffmpeg = requireCore('ffmpeg-static');
const probe = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8', windowsHide: true });
if (probe.status !== 0) throw new Error('Bundled FFmpeg cannot start');
const child = fork(resolve(appRoot, 'src/worker/entry.mjs'), [], { execPath: node, cwd: testData, env: { ...process.env, TSMD_DATA_DIR: testData }, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
try {
  const ready = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Packaged worker startup timeout')), 20000);
    child.on('message', message => { if (message.type === 'ready') { clearTimeout(timer); accept(message); } if (message.type === 'fatal') { clearTimeout(timer); reject(new Error(message.error)); } });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Packaged worker exited: ' + code)); });
    child.send({ type: 'init', key: randomBytes(32).toString('base64') });
  });
  if (!ready.state.ready || ready.state.presets.length || ready.state.auth.loggedIn || ready.state.grants.length) throw new Error('Packaged app did not start with fresh data');
  for (const path of ['/', '/logo.png', '/favicon.ico']) {
    const response = await fetch(`http://127.0.0.1:${ready.port}${path}`); if (!response.ok) throw new Error('Packaged UI missing: ' + path);
    if (path === '/logo.png') {
      const served = Buffer.from(await response.arrayBuffer());
      if (createHash('sha256').update(served).digest('hex') !== createHash('sha256').update(readFileSync(resolve('resources/logo-source.png'))).digest('hex')) throw new Error('Packaged logo differs from the supplied image');
    }
  }
  const exited = new Promise((accept, reject) => { const timer = setTimeout(() => reject(new Error('Packaged worker shutdown timeout')), 8000); child.once('exit', code => { clearTimeout(timer); accept(code); }); });
  child.send({ type: 'shutdown' }); if (await exited !== 0) throw new Error('Packaged worker did not exit cleanly');
  const report = { version: currentVersion, packagedRoot: appRoot, checkedAt: new Date().toISOString(), privateDataIncluded: false, freshUser: true, nativeCore: true, desktopNativeKoffi: desktopNative.version, windowsResourceCounters: true, desktopNativeResolutionInsidePackage: true, opusRoundtrip: true, bundledFFmpeg: true, packagedUIAndLogo: true, currentSourceAndUI: true, cleanShutdown: true, desktopLaunchVerified: false };
  writeFileSync(resolve('release/local/package-verification.json'), JSON.stringify(report, null, 2));
  console.log('发行目录验证通过：无个人数据，Koffi 原生模块/资源监控/内核/转码器/网页/Logo 正常，新用户数据初始化并正常退出');
} finally { if (!child.killed && child.exitCode === null) child.kill(); }
