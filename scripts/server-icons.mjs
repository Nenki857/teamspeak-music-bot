import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { imagesToIco } from 'png-to-ico';
import { readPNG, resize } from 'png-to-ico/lib/png.js';

// Build-time only. The local desktop images and original artwork stay unchanged.
export async function writeServerIcons(output, source = resolve('resources/logo-source.png')) {
  const original = await readPNG(source);
  if (original.width !== original.height) throw Error('服务器图标源文件必须为正方形 PNG');
  const logo = PNG.sync.write(resize(original, 192, 192), { deflateLevel: 9, deflateStrategy: 3 });
  const favicon = imagesToIco([16, 32].map(size => resize(original, size, size)));
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, 'logo.png'), logo);
  writeFileSync(resolve(output, 'favicon.ico'), favicon);
  return { logoBytes: logo.length, faviconBytes: favicon.length };
}
