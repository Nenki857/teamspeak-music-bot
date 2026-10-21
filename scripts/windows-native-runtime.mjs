import { cpSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, sep } from 'node:path';

export const windowsKoffiPackage = '@koromix/koffi-win32-x64';
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
function manifests(root) {
  const koffiRoot = resolve(root, 'node_modules/koffi');
  const nativeRoot = resolve(root, 'node_modules', windowsKoffiPackage);
  if (!existsSync(resolve(nativeRoot, 'package.json'))) throw new Error('Missing Windows x64 Koffi runtime: ' + windowsKoffiPackage);
  const koffi = readJson(resolve(koffiRoot, 'package.json'));
  const native = readJson(resolve(nativeRoot, 'package.json'));
  if (native.name !== windowsKoffiPackage || native.version !== koffi.version) throw new Error('Windows Koffi runtime version does not match koffi');
  const binding = resolve(nativeRoot, 'win32_x64/koffi.node');
  if (!existsSync(binding)) throw new Error('Missing Windows Koffi native binary: ' + binding);
  return { koffiRoot, nativeRoot, binding, version: koffi.version, nativePackage: windowsKoffiPackage };
}
export function copyWindowsKoffiRuntime(sourceRoot, targetRoot, copyPackage = (from, to) => cpSync(from, to, { recursive: true })) {
  const value = manifests(sourceRoot);
  copyPackage(value.koffiRoot, resolve(targetRoot, 'node_modules/koffi'));
  copyPackage(value.nativeRoot, resolve(targetRoot, 'node_modules', windowsKoffiPackage));
  return inspectWindowsKoffiRuntime(targetRoot);
}
export function inspectWindowsKoffiRuntime(appRoot) {
  const value = manifests(appRoot);
  const requireApp = createRequire(resolve(appRoot, 'package.json'));
  const koffiEntry = requireApp.resolve('koffi');
  const requireKoffi = createRequire(resolve(value.koffiRoot, 'package.json'));
  const nativeEntry = requireKoffi.resolve(windowsKoffiPackage);
  const real = file => realpathSync.native(file);
  const prefix = real(appRoot) + sep;
  for (const file of [koffiEntry, nativeEntry, value.binding]) {
    if (!real(file).startsWith(prefix)) throw new Error('Packaged Koffi resolves outside the application: ' + file);
  }
  return { ...value, koffiEntry, nativeEntry, esmEntry: resolve(value.koffiRoot, 'index.js') };
}
