import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { resolveDataDirectory } from '../src/desktop/storage-path.mjs';
import { LEGACY_DATA_DIRECTORY } from '../src/shared/legacy-brand.mjs';
const projectRoot=resolve('work/read-only-install'),appData=resolve('work/user-profile');
test('fresh builds use Music Bot per-user data; development and overrides retain their paths',()=>{
  assert.equal(resolveDataDirectory({packaged:true,projectRoot,appData,exists:()=>false}),resolve(appData,'TS Music Bot'));
  assert.equal(resolveDataDirectory({packaged:false,projectRoot,appData}),resolve(projectRoot,'data'));
  const override=resolve('work/isolated-data');
  assert.equal(resolveDataDirectory({packaged:true,projectRoot,appData,override}),override);
});
test('renamed builds reuse an existing legacy vault and database without moving it',()=>{
  const legacy=resolve(appData,LEGACY_DATA_DIRECTORY);
  assert.equal(resolveDataDirectory({packaged:true,projectRoot,appData,exists:file=>file===legacy}),legacy);
});
test('an existing current data directory takes precedence when both versions have data',()=>{
  assert.equal(resolveDataDirectory({packaged:true,projectRoot,appData,exists:()=>true}),resolve(appData,'TS Music Bot'));
});
