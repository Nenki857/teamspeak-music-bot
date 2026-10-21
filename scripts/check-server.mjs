import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setAdminPassword } from '../src/server/admin-auth.mjs';
import { serverVaultKey } from '../src/server/vault-key.mjs';
import { chromium } from 'playwright';
import { createVault } from '../src/shared/security.mjs';
const official=process.argv.includes('--official'),shot=official?'server-official':'server';
if (process.platform === 'win32') {
  const { default: koffi } = await import('koffi');
  koffi.load('kernel32.dll').func('uint32 __stdcall SetErrorMode(uint32)')(0x8003);
}
mkdirSync(resolve('work/server-smoke'), { recursive: true }); const data = mkdtempSync(resolve('work/server-smoke/run-'));
const key=serverVaultKey(data); await setAdminPassword(resolve(data, 'server-admin.json'), 'synthetic-browser-test-password');
if(official)writeFileSync(resolve(data,'official-transport.json'),JSON.stringify({url:'http://127.0.0.1:1',username:'admin',password:createVault(key).encrypt('synthetic-private-bridge-password'),instanceId:'synthetic-instance'}),{mode:0o600});
const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening'); const port = reservation.address().port; await new Promise(accept => reservation.close(accept));
const friendReservation=createServer();friendReservation.listen(0,'127.0.0.1');await once(friendReservation,'listening');const friendPort=friendReservation.address().port;await new Promise(accept=>friendReservation.close(accept));
const child = spawn(process.execPath, ['src/server/entry.mjs'], { windowsHide: true, env: { ...process.env, TSMD_DATA_DIR: data, TSMD_PORT: String(port), TSMD_AUTOSTART: '0', TSMD_PUBLIC_URL:`http://127.0.0.1:${friendPort}`,TSMD_FRIEND_PORT:String(friendPort),TSMD_PERSISTENT_SHARES:'1',TSMD_AUDIO_BACKEND:official?'official':'custom' }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; let browser; const errors = [];
child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', () => {});
try {
  await new Promise((accept, reject) => {
    const deadline = setTimeout(() => { clearInterval(check); reject(new Error('Headless startup timed out')); }, 30000);
    const check = setInterval(() => { if (output.includes('后台已启动')) { clearTimeout(deadline); clearInterval(check); accept(); } else if (child.exitCode !== null) { clearTimeout(deadline); clearInterval(check); reject(new Error('Headless startup failed')); } }, 50);
  });
  const executablePath = process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined;
  browser = await chromium.launch({ headless: true, executablePath }); const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  const base = `http://127.0.0.1:${port}`;
  await page.goto(base + '/admin'); await page.getByLabel('主人密码', { exact: true }).waitFor();
  await page.getByLabel('主人密码', { exact: true }).fill('synthetic-browser-test-password');
  assert.equal(await page.getByLabel('主人密码',{exact:true}).getAttribute('type'),'password');
  await page.getByRole('button',{name:'显示密码',exact:true}).click();assert.equal(await page.getByLabel('主人密码',{exact:true}).getAttribute('type'),'text');
  assert.equal(await page.getByLabel('主人密码',{exact:true}).inputValue(),'synthetic-browser-test-password');
  await page.getByRole('button',{name:'隐藏密码',exact:true}).click();assert.equal(await page.getByLabel('主人密码',{exact:true}).getAttribute('type'),'password');
  await page.getByLabel('记住密码',{exact:true}).check();
  await page.screenshot({ path: resolve(`work/${shot}-login.png`), fullPage: true });
  await page.getByLabel('主人密码', { exact: true }).fill('synthetic-browser-test-password');
  await page.getByRole('button', { name: '登录控制台', exact: true }).click();
  await page.locator('.queue-expanded').waitFor();
  const ownerCookie=(await page.context().cookies()).find(cookie=>cookie.name==='tsmd_owner');assert.ok(ownerCookie.httpOnly);assert.ok(ownerCookie.expires>Date.now()/1000+29*86400);
  const browserStorage=await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}));assert.ok(!browserStorage.includes('synthetic-browser-test-password'));
  await page.getByRole('button', { name: '控制台', exact: true }).click();
  await page.getByRole('heading', { name: '把音乐带进你的频道', exact: true }).waitFor();
  const status = await page.evaluate(() => window.musicDesk.rpc('status'));
  assert.equal(status.runtime.deployment, 'server'); assert.equal(status.audioHealth.isolatedCore, true); assert.equal(status.phase, 'stopped');
  assert.equal(status.runtime.audioBackend,official?'official':'custom');if(official)assert.equal(status.audioHealth.officialClient,true);
  assert.equal(status.runtime.persistentShares,true);assert.equal(status.runtime.friendOnlyEndpoint,true);
  const friends=`http://127.0.0.1:${friendPort}`;
  assert.match(await(await fetch(friends)).text(),/data-persistent-invitations/);
  assert.equal((await fetch(friends+'/api/admin/session')).status,404);
  const denied=await fetch(friends+'/api/admin/login',{method:'POST',headers:{Origin:friends,'Content-Type':'application/json'},body:JSON.stringify({password:'synthetic-browser-test-password'})});assert.equal(denied.status,404);
  await page.getByRole('button', { name: '+ 添加第一个服务器', exact: true }).click();
  await page.getByLabel('预设名称', { exact: true }).fill('服务器版检查');
  await page.getByLabel('服务器地址', { exact: true }).fill('127.0.0.1');
  await page.getByLabel('目标频道 ID', { exact: true }).fill('42');
  await page.getByRole('button', { name: '保存预设', exact: true }).click();
  await page.getByText('服务器版检查', { exact: true }).first().waitFor();
  // Intercept only synthetic collection responses. No music account or catalogue request is made.
  await page.route('**/api/admin/rpc',async route=>{
    const input=route.request().postDataJSON();
    if(input.method!=='playlists.list')return route.continue();
    await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,result:Array.from({length:12},(_,index)=>({id:String(index+1),name:(input.args.type==='mine'?'我的歌单 ':'发现歌单 ')+(index+1),coverUrl:'/logo.png',songCount:20}))})});
  });
  await page.getByText('我的音乐库',{exact:true}).click();
  for(const collection of ['我的歌单','发现歌单']){
    await page.getByRole('button',{name:collection,exact:true}).click();await page.locator('.playlist-card strong').filter({hasText:collection+' 1'}).first().waitFor();
    const size=await page.locator('.playlist-card img').first().boundingBox();assert.ok(size.width<=190.1 && size.height<=190.1,collection+' covers must remain compact');
    assert.ok(Math.abs(size.width-size.height)<1,'covers stay square');
  }
  await page.screenshot({path:resolve(`work/${shot}-compact-playlists.png`),fullPage:true});
  await page.unroute('**/api/admin/rpc');
  await page.getByRole('button',{name:'控制台',exact:true}).click();
  await page.reload(); await page.locator('.queue-expanded').waitFor(); await page.getByRole('button', { name: '控制台', exact: true }).click(); await page.getByText('服务器版检查', { exact: true }).first().waitFor();
  await page.waitForFunction(() => document.querySelector('.sidebar-admin-nav button.active')?.getAttribute('aria-label') === '控制台' && getComputedStyle(document.querySelector('.sidebar-admin-nav button.active')).backgroundColor === 'rgb(32, 45, 35)');
  assert.equal(await page.locator('.sidebar nav button.active').count(), 1);
  await page.screenshot({ path: resolve(`work/${shot}-owner.png`), fullPage: true });
  await page.locator('.owner-console-panel').screenshot({path:resolve(`work/${shot}-console-addresses.png`)});
  assert.equal(await page.getByLabel('当前主人控制台地址', { exact: true }).inputValue(), base + '/admin');
  await page.getByRole('button', { name: '修改主人密码', exact: true }).click();
  await page.getByLabel('当前主人密码', { exact: true }).fill('synthetic-browser-test-password');
  await page.getByLabel('新主人密码', { exact: true }).fill('synthetic-changed-owner-password');
  await page.getByLabel('确认新密码', { exact: true }).fill('synthetic-changed-owner-password');
  await page.locator('.owner-password-form').screenshot({ path: resolve(`work/${shot}-password-form.png`) });
  await page.getByRole('button', { name: '保存新密码', exact: true }).click(); await page.getByText(/主人密码已修改/).waitFor();
  await page.getByRole('button', { name: /设置与状态/ }).click(); await page.getByRole('heading', { name: '服务器运行', exact: true }).waitFor();
  if(official){await page.getByText('当前使用官方 TS3 客户端传输；原内核的帧计数与缓冲诊断不适用。',{exact:true}).waitFor();await page.locator('.audio-health-panel').screenshot({path:resolve('work/server-official-diagnostics.png')});}
  await page.getByRole('button',{name:'管理操作',exact:true}).click();
  await page.getByRole('button',{name:/退出管理端登录/}).waitFor();
  assert.equal(await page.getByRole('button',{name:/退出网易云登录/}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:/关闭机器人/}).isDisabled(),true);
  await page.locator('.modal').screenshot({path:resolve(`work/${shot}-admin-actions.png`)});
  const restartCalls=[];
  await page.route('**/api/admin/rpc',async route=>{
    const input=route.request().postDataJSON();
    if(input.method!=='bot.start')return route.continue();
    restartCalls.push(input.args);await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,result:{}})});
  });
  await page.getByRole('button',{name:/重启机器人/}).click();await page.getByRole('button',{name:'确认重启机器人',exact:true}).waitFor();
  assert.equal(restartCalls.length,0,'choosing restart must not submit until confirmed');
  await page.getByRole('button',{name:'确认重启机器人',exact:true}).click();await page.locator('.modal').waitFor({state:'detached'});
  const savedState=await page.evaluate(()=>window.musicDesk.rpc('status'));assert.deepEqual(restartCalls,[{id:savedState.presets[0].id}]);
  await page.unroute('**/api/admin/rpc');await page.getByRole('button',{name:'管理操作',exact:true}).click();
  await page.getByRole('button',{name:/退出管理端登录/}).click(); await page.getByLabel('主人密码', { exact: true }).waitFor();
  await page.getByLabel('主人密码', { exact: true }).fill('synthetic-changed-owner-password'); await page.getByRole('button', { name: '登录控制台', exact: true }).click(); await page.locator('.queue-expanded').waitFor();
  assert.equal(child.exitCode, null, 'logging out must keep the backend running');
  assert.deepEqual(errors, []); console.log('Headless browser check passed: isolated core, owner login, preset save/reload, logout keeps backend running. No real TS connection or music account used.');
} finally {
  await browser?.close(); if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
}
