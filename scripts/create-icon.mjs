import { cpSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pngToIco from 'png-to-ico';

const source = resolve(process.argv[2] || 'resources/logo-source.png');
if (!existsSync(source)) throw new Error('请提供用于程序图标的 PNG 图片');
mkdirSync('resources', { recursive: true }); mkdirSync('public', { recursive: true });
if (source !== resolve('resources/logo-source.png')) cpSync(source, 'resources/logo-source.png');
cpSync(source, 'resources/logo.png'); cpSync(source, 'public/logo.png');
const icon = await pngToIco(source);
writeFileSync('resources/app.ico', icon); writeFileSync('public/favicon.ico', icon);
console.log('已生成程序、安装器、托盘和网页图标');
