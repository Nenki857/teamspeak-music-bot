import { resolve, sep } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const app = resolve(process.argv[2]), adapter = resolve(process.argv[3]);
const parent = resolve(app, 'runtime');
const profile = mkdtempSync(resolve(parent, 'browser-preflight-'));
let browser;
try {
  const { NeteaseOfficialBrowser } = await import(pathToFileURL(adapter).href);
  browser = new NeteaseOfficialBrowser({ executable: resolve(parent, 'official-browser/chrome-linux64/chrome'), profileDirectory: profile });
  const frame = await browser.start();
  console.log(JSON.stringify({ kind: 'TS Music Bot official browser check', capturedAt: new Date().toISOString(), browserStarted: true, officialPageOpened: frame.address.startsWith('https://music.163.com/'), screenshotReady: frame.image.startsWith('data:image/jpeg;base64,'), loginVerified: false, accountDataRead: false, accountSecretsIncluded: false }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ kind: 'TS Music Bot official browser check', browserStarted: false, error: ['服务器浏览器启动失败，请检查浏览器组件与系统依赖', '服务器浏览器未能就绪，请检查浏览器组件；不会自动关闭浏览器沙箱'].includes(error.message) ? error.message : '服务器浏览器检查失败，现有机器人代码未更改', accountSecretsIncluded: false }, null, 2));
  process.exitCode = 21;
} finally {
  await browser?.close();
  if (profile.startsWith(parent + sep) && resolve(profile, '..') === parent) { try { rmSync(profile, { recursive: true, force: true }); } catch {} }
}
