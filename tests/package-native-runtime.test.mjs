import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { copyWindowsKoffiRuntime, inspectWindowsKoffiRuntime, windowsKoffiPackage } from '../scripts/windows-native-runtime.mjs';
const fixture = () => { mkdirSync(resolve('work'), { recursive: true }); return mkdtempSync(resolve('work/native-runtime-')); };
function fakeSource(version = '3.3.3') {
  const root = fixture();
  for (const name of ['koffi', windowsKoffiPackage]) mkdirSync(resolve(root, 'node_modules', name), { recursive: true });
  writeFileSync(resolve(root, 'node_modules/koffi/package.json'), JSON.stringify({ name: 'koffi', version: '3.3.3', main: 'index.cjs' }));
  writeFileSync(resolve(root, 'node_modules/koffi/index.cjs'), 'module.exports = {};');
  writeFileSync(resolve(root, 'node_modules', windowsKoffiPackage, 'package.json'), JSON.stringify({ name: windowsKoffiPackage, version, main: 'index.js' }));
  writeFileSync(resolve(root, 'node_modules', windowsKoffiPackage, 'index.js'), 'module.exports = {};');
  mkdirSync(resolve(root, 'node_modules', windowsKoffiPackage, 'win32_x64'));
  writeFileSync(resolve(root, 'node_modules', windowsKoffiPackage, 'win32_x64/koffi.node'), 'fixture only');
  return root;
}
test('desktop packaging copies the matching Windows Koffi platform package as well as the JS wrapper', () => {
  const source = fakeSource(); const target = fixture();
  const result = copyWindowsKoffiRuntime(source, target);
  assert.equal(result.version, '3.3.3');
  assert.equal(result.nativePackage, windowsKoffiPackage);
  assert.ok(existsSync(resolve(target, 'node_modules', windowsKoffiPackage, 'win32_x64/koffi.node')));
  assert.ok(result.nativeEntry.startsWith(target));
});
test('package validation rejects a missing platform package even when a developer ancestor can resolve Koffi', () => {
  const source = fakeSource(); const target = fixture();
  cpSync(resolve(source, 'node_modules/koffi'), resolve(target, 'node_modules/koffi'), { recursive: true });
  assert.throws(() => inspectWindowsKoffiRuntime(target), /Missing Windows x64 Koffi runtime/);
});
test('missing binaries and mismatched platform versions stop packaging before incomplete files are copied', () => {
  const source = fakeSource('0.0.0'); const target = fixture();
  assert.throws(() => copyWindowsKoffiRuntime(source, target), /version does not match/);
  assert.equal(existsSync(resolve(target, 'node_modules/koffi')), false);
  const nativeJson = resolve(source, 'node_modules', windowsKoffiPackage, 'package.json');
  const pkg = JSON.parse(readFileSync(nativeJson, 'utf8')); pkg.version = '3.3.3'; writeFileSync(nativeJson, JSON.stringify(pkg));
  const wrapperOnly = fixture(); cpSync(resolve(source, 'node_modules/koffi'), resolve(wrapperOnly, 'node_modules/koffi'), { recursive: true });
  mkdirSync(resolve(wrapperOnly, 'node_modules', windowsKoffiPackage), { recursive: true });
  writeFileSync(resolve(wrapperOnly, 'node_modules', windowsKoffiPackage, 'package.json'), JSON.stringify(pkg));
  assert.throws(() => copyWindowsKoffiRuntime(wrapperOnly, target), /Missing Windows Koffi native binary/);
});
test('an unavailable resource-monitor dependency does not throw during desktop module import or sampling', async () => {
  const root = fixture();
  mkdirSync(resolve(root, 'node_modules/koffi'), { recursive: true });
  writeFileSync(resolve(root, 'node_modules/koffi/package.json'), JSON.stringify({ name: 'koffi', main: 'missing-native-wrapper.cjs' }));
  for (const name of ['resource-monitor.mjs', 'windows-resources.mjs']) cpSync(resolve('src/desktop', name), resolve(root, name));
  const { createResourceMonitor } = await import(pathToFileURL(resolve(root, 'resource-monitor.mjs')).href);
  const value = createResourceMonitor({ platform: 'win32' }).sample();
  assert.equal(value.cpu.status, 'unavailable');
  assert.equal(value.memory.bytes, null);
});
