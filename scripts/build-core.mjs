import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const core = resolve('vendor/teamspeak-music-bot-1.13.2');
const result = spawnSync(process.execPath, [resolve(core, 'node_modules/typescript/bin/tsc'), '-p', core], { stdio: 'inherit', windowsHide: true });
process.exit(result.status ?? 1);
