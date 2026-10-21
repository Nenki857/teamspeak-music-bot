import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { resolveDataDirectory } from '../src/desktop/storage-path.mjs';

test('installed builds write per-user data outside the installation; development retains its existing data', () => {
  const projectRoot = resolve('work/read-only-install'); const appData = resolve('work/user-profile');
  assert.equal(resolveDataDirectory({ packaged: true, projectRoot, appData }), resolve(appData, 'TS Music Desk'));
  assert.equal(resolveDataDirectory({ packaged: false, projectRoot, appData }), resolve(projectRoot, 'data'));
  const override = resolve('work/isolated-data');
  assert.equal(resolveDataDirectory({ packaged: true, projectRoot, appData, override }), override);
});
