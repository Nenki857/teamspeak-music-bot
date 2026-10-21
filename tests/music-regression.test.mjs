import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { compareProgram, readSavedLogin, probeSession } from '../scripts/diagnose-music-regression.mjs';

test('regression comparison identifies changed and missing source without accepting paths outside the program', () => {
  mkdirSync('work', { recursive: true }); const app = mkdtempSync(resolve('work/regression-test-'));
  mkdirSync(resolve(app, 'src/worker'), { recursive: true }); writeFileSync(resolve(app, 'src/worker/a.mjs'), 'current');
  const digest = createHash('sha256').update('current').digest('hex');
  assert.equal(compareProgram(app, { 'src/worker/a.mjs': digest }).matches, true);
  const report = compareProgram(app, { 'src/worker/a.mjs': 'a'.repeat(64), 'src/worker/b.mjs': digest });
  assert.deepEqual(report.changed, ['src/worker/a.mjs']); assert.deepEqual(report.missing, ['src/worker/b.mjs']);
  assert.throws(() => compareProgram(app, { 'src/worker/../../server-data/app.db': digest }));
  assert.throws(() => compareProgram(app, { 'server-data/server-vault.key': digest }));
});

test('saved login is read through a read-only database and the database closes on invalid data', () => {
  let closed = false;
  const require = name => { assert.equal(name, 'better-sqlite3'); return class {
    constructor(file, options) { assert.equal(file, resolve('data/app.db')); assert.deepEqual(options, { readonly: true, fileMustExist: true }); }
    prepare(sql) { assert.match(sql, /^SELECT/); return { get(key) { assert.equal(key, 'neteaseCookie'); return { value: '"invalid"' }; } }; }
    close() { closed = true; }
  }; };
  assert.throws(() => readSavedLogin('app', resolve('data'), require)); assert.equal(closed, true);
});

test('session comparison uses the saved login without exporting secrets or changing accounts', async () => {
  const calls = [];
  const api = { cloudsearch: async args => { calls.push(args); throw { status: 400, body: { code: -462, msg: 'PRIVATE_LOGIN_COOKIE' } }; }, personalized: async args => { calls.push(args); return { status: 200, body: { code: 200, result: ['PRIVATE_ACCOUNT_DATA'] } }; } };
  const result = await probeSession(api, 'MUSIC_U=PRIVATE_LOGIN_COOKIE');
  assert.ok(calls.every(args => args.cookie === 'MUSIC_U=PRIVATE_LOGIN_COOKIE'));
  assert.equal(result[0].bodyCode, -462); assert.equal(result[1].ok, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|MUSIC_U|cookie/i);
  await probeSession(api); assert.equal(Object.hasOwn(calls[2], 'cookie'), false);
});
