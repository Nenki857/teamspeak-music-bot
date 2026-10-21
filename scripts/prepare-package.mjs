import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { copyWindowsKoffiRuntime } from './windows-native-runtime.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = resolve(root, 'work/local/package-stage');
if (dirname(stage) !== resolve(root, 'work/local') || basename(stage) !== 'package-stage') throw new Error('Unsafe staging directory');
rmSync(stage, { recursive: true, force: true }); mkdirSync(stage, { recursive: true });
const copy = (source, target = source, filter) => cpSync(resolve(root, source), resolve(stage, target), { recursive: true, filter });
const notes = [];
function copyPackage(source, target) {
  cpSync(source, target, { recursive: true, filter: path => !relative(source, path).split(sep).includes('node_modules') });
  const pkg = JSON.parse(readFileSync(resolve(source, 'package.json'), 'utf8'));
  const licenses = readdirSync(source).filter(name => /^(licen[cs]e|copying|notice)(\.|$|-)/i.test(name) && statSync(resolve(source, name)).isFile());
  notes.push(`\n## ${pkg.name} ${pkg.version}\nLicense: ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license || 'See package source')}\nSource: ${typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || pkg.homepage || ''}\n` + licenses.map(name => readFileSync(resolve(source, name), 'utf8')).join('\n'));
}
copy('LICENSE'); copy('THIRD-PARTY-NOTICES.txt');
copy('src'); copy('dist/ui'); copy('resources'); copy('docs/使用说明.txt', '使用说明.txt');
copy('vendor/teamspeak-music-bot-1.13.2/package.json'); copy('vendor/teamspeak-music-bot-1.13.2/LICENSE');
copy('vendor/teamspeak-music-bot-1.13.2/dist', undefined, path => !/\.test\.|\.map$|\.d\.ts$/.test(path));
copy('vendor/teamspeak-music-bot-1.13.2/src');
const desktopNative = copyWindowsKoffiRuntime(root, stage, copyPackage);
const core = resolve(root, 'vendor/teamspeak-music-bot-1.13.2');
const npmCli = process.env.npm_execpath || resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const result = spawnSync(process.execPath, [npmCli, 'ls', '--omit=dev', '--all', '--parseable'], { cwd: core, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
if (result.status !== 0) throw new Error('Cannot enumerate runtime dependencies: ' + result.stderr);
const packages = [...new Set(result.stdout.trim().split(/\r?\n/).filter(path => path !== core && existsSync(resolve(path, 'package.json'))))];
for (const source of packages) {
  const part = relative(root, source);
  if (part.startsWith('..') || !part.includes('node_modules')) throw new Error('Dependency outside project');
  copyPackage(source, resolve(stage, part));
}
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
writeFileSync(resolve(stage, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, description: pkg.description, author: 'TS Music Bot', license: pkg.license, type: 'module', main: pkg.main, dependencies: { koffi: pkg.dependencies.koffi, [desktopNative.nativePackage]: desktopNative.version } }, null, 2));
writeFileSync(resolve(stage, 'THIRD-PARTY-DEPENDENCIES.txt'), 'Third-party components retain their original licenses.\nUpstream bot: ZHANGTIANYAO1/teamspeak-music-bot v1.13.2 (MIT).\nElectron licenses are located beside the application executable.\nNode.js and Cloudflared licenses are under resources/licenses.\nFFmpeg version and source locations are under resources/licenses.\n' + notes.join('\n'));
for (const required of ['resources/node/node.exe', 'resources/app.ico', 'resources/cloudflared.exe', 'resources/licenses/Node-v22.14.0-LICENSE.txt', 'resources/licenses/Cloudflared-2026.10.0-LICENSE.txt', 'resources/licenses/FFmpeg-6.1.1-LICENSE.txt', 'dist/ui/index.html', 'vendor/teamspeak-music-bot-1.13.2/node_modules/ffmpeg-static/ffmpeg.exe']) if (!existsSync(resolve(stage, required))) throw new Error('Missing runtime file: ' + required);
for (const forbidden of ['data', 'work', 'release', '.env', '.npmrc', 'package-lock.json', '启动音乐机器人.cmd']) if (existsSync(resolve(stage, forbidden))) throw new Error('Private/development file in staging: ' + forbidden);
writeFileSync(resolve(stage, 'package-manifest.json'), JSON.stringify({ desktopNative: { koffi: desktopNative.version, package: desktopNative.nativePackage }, version: pkg.version, platform: 'win32', arch: 'x64', node: '22.14.0', core: '1.13.2', runtimeDependencies: packages.length + 2, privateDataIncluded: false }, null, 2));
console.log(`已准备干净发行目录：${packages.length + 2} 个运行依赖，不包含用户数据`);
