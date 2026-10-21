import { mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const dir = resolve('resources/licenses'); mkdirSync(dir, { recursive: true });
for (const [name, url] of [
  ['Node-v22.14.0-LICENSE.txt', 'https://api.github.com/repos/nodejs/node/contents/LICENSE?ref=v22.14.0'],
  ['Cloudflared-2026.10.0-LICENSE.txt', 'https://api.github.com/repos/cloudflare/cloudflared/contents/LICENSE?ref=2026.10.0']
]) {
  const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const metadata = await response.json();
  if (metadata.encoding !== 'base64' || !metadata.content) throw new Error('License contents unavailable: ' + name);
  writeFileSync(resolve(dir, name), Buffer.from(metadata.content, 'base64')); console.log('已保存许可证：' + name);
}
cpSync('vendor/teamspeak-music-bot-1.13.2/node_modules/ffmpeg-static/LICENSE', resolve(dir, 'FFmpeg-6.1.1-LICENSE.txt'));
const ffmpeg = spawnSync(resolve('vendor/teamspeak-music-bot-1.13.2/node_modules/ffmpeg-static/ffmpeg.exe'), ['-version'], { encoding: 'utf8', windowsHide: true });
writeFileSync(resolve(dir, 'FFmpeg-version-and-source.txt'), `Bundled FFmpeg binary (unmodified):\n${ffmpeg.stdout}\nBinary distributor: https://www.gyan.dev/ffmpeg/builds/\nBinary release: https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1\nFFmpeg source tag: https://github.com/FFmpeg/FFmpeg/tree/n6.1.1\nFFmpeg redistribution checklist: https://ffmpeg.org/legal.html\n\nSource-location information only. A complete corresponding source bundle (including the enabled external libraries and build scripts) is not supplied here. Resolve that redistribution requirement before public distribution.\n`);
