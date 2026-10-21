import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const latest=JSON.parse(readFileSync('archives/original-chain-latest.json','utf8'));
assert.equal(createHash('sha256').update(readFileSync(latest.archive)).digest('hex'),latest.sha256);
const stage=mkdtempSync(resolve('work/audio-archive-check-'));const extracted=spawnSync('tar',['-xzf',latest.archive,'-C',stage],{encoding:'utf8',windowsHide:true});assert.equal(extracted.status,0,extracted.stderr);
const manifest=JSON.parse(readFileSync(resolve(stage,'AUDIO-CHAIN-ARCHIVE.json'),'utf8'));assert.equal(manifest.backend,'original-custom-ts3-protocol');assert.equal(manifest.privateDataIncluded,false);
assert.ok(manifest.files['src/worker/core-engine.mjs']);assert.ok(manifest.files['vendor/teamspeak-music-bot-1.13.2/src/audio/player.ts']);assert.equal(manifest.files['src/server/official-core-engine.mjs'],undefined);
for(const[name,digest]of Object.entries(manifest.files)){assert.doesNotMatch(name,/^(data|server-data|node_modules|resources|work|release)\/|(^|\/)(app\.db|core\.db|server-admin\.json|.*\.key|\.env)$/);assert.equal(createHash('sha256').update(readFileSync(resolve(stage,name))).digest('hex'),digest,name);}
console.log(`Original audio chain archive verified: ${Object.keys(manifest.files).length} files; SHA-256 ${latest.sha256}; no private runtime data.`);
