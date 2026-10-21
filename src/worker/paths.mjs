import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const coreRoot = resolve(root, 'vendor/teamspeak-music-bot-1.13.2');
export const requireCore = createRequire(resolve(coreRoot, 'package.json'));
export const dataDir = resolve(process.env.TSMD_DATA_DIR || resolve(root, 'data'));
