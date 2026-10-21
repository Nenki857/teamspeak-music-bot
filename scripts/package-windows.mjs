import { spawnSync } from 'node:child_process';
import { resolve, dirname, delimiter } from 'node:path';
import { mkdirSync } from 'node:fs';
process.env.Path = dirname(process.execPath) + delimiter + (process.env.Path || process.env.PATH || '');
const taskTemp = resolve('work/local/package-temp'); mkdirSync(taskTemp, { recursive: true });
process.env.TEMP = taskTemp; process.env.TMP = taskTemp;
const result = spawnSync(process.execPath, [resolve('node_modules/electron-builder/cli.js'), '--config', 'electron-builder.json', '--win', '--x64', '--publish', 'never'], {
  stdio: 'inherit', windowsHide: true,
  env: { ...process.env, ELECTRON_BUILDER_CACHE: resolve('work/local/electron-builder-cache'), CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
});
process.exit(result.status ?? 1);
