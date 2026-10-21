import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { legacyProjectLockHashes } from '../scripts/update-dependency-compat.mjs';
import { LEGACY_PACKAGE_NAME } from '../src/shared/legacy-brand.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
test('server code updates accept only the previous package-name metadata for unchanged dependencies',()=>{
  const modern=readFileSync('package-lock.json','utf8'),old=JSON.parse(modern);
  old.name=LEGACY_PACKAGE_NAME;old.packages[''].name=LEGACY_PACKAGE_NAME;
  const legacy=JSON.stringify(old,null,2)+'\n';
  const allowed=legacyProjectLockHashes(modern);assert.ok(allowed.includes(hash(legacy)));
  assert.ok(allowed.includes(hash(legacy.replace(/\n/g,'\r\n'))));
  old.packages[''].dependencies={...old.packages[''].dependencies,koffi:'0.0.0'};
  assert.equal(allowed.includes(hash(JSON.stringify(old,null,2)+'\n')),false);
  assert.equal(allowed.includes(hash(modern)),false);
});
