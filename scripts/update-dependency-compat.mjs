import { createHash } from 'node:crypto';
import { LEGACY_PACKAGE_NAME } from '../src/shared/legacy-brand.mjs';
export function legacyProjectLockHashes(text) {
  const current=JSON.parse(text);
  if(current.name!=='teamspeak-music-bot'||current.packages?.['']?.name!=='teamspeak-music-bot')return[];
  const expected=structuredClone(current);expected.name=LEGACY_PACKAGE_NAME;expected.packages[''].name=LEGACY_PACKAGE_NAME;
  const legacy=text.replace(/("name"\s*:\s*")teamspeak-music-bot(")/g,(_match,start,end)=>start+LEGACY_PACKAGE_NAME+end);
  if(JSON.stringify(JSON.parse(legacy))!==JSON.stringify(expected))throw Error('Unexpected package names in dependency lock');
  const variants=[legacy,legacy.replace(/\r?\n/g,'\n'),legacy.replace(/\r?\n/g,'\r\n')];
  return [...new Set(variants.map(value=>createHash('sha256').update(value).digest('hex')))];
}
