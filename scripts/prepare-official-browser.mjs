import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
const version = '155.0.8059.84';
const expected = 'cf0f049892dea22e6a6db26d47ed0d7776b7158edcbec4634086633df8bafcbc';
const directory = resolve('release/server/tools'); mkdirSync(directory, { recursive: true });
const target = resolve(directory, `chrome-linux64-${version}.zip`);
async function hash(file) { const digest = createHash('sha256'); for await (const block of createReadStream(file)) digest.update(block); return digest.digest('hex'); }
if (!existsSync(target)) {
  console.log('Downloading the official Linux Chrome component once (about 190 MiB).');
  const temporary = target + '.part-' + randomUUID();
  try {
    const response = await fetch(`https://storage.googleapis.com/chrome-for-testing-public/${version}/linux64/chrome-linux64.zip`, { signal: AbortSignal.timeout(180000), redirect: 'error' });
    if (!response.ok) throw Error('Official browser download failed');
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }));
    if (await hash(temporary) !== expected) throw Error('Browser component checksum mismatch');
    renameSync(temporary, target);
  } finally { rmSync(temporary, { force: true }); }
}
if (await hash(target) !== expected) throw Error('Existing browser component checksum mismatch; nothing was replaced');
writeFileSync(target + '.sha256', expected + '\n');
console.log(`Official browser component verified: Chrome ${version}.`);
