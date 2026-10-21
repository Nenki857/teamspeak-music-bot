import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepare } from '../scripts/prepare-project.mjs';
const shell='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const library='. '+quote(resolve('scripts/manage.ps1'))+' -Library; ';
const run=code=>spawnSync(shell,['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-Command',library+code],{encoding:'utf8',windowsHide:true,timeout:10000});
test('local source preparation stops with a Releases link before installing dependencies',async()=>{
  await assert.rejects(prepare('local'),/https:\/\/github.com\/Nenki857\/teamspeak-music-bot\/releases/);
});
test('the local menu opens only Releases and cannot start a downloader',{skip:process.platform!=='win32'},()=>{
  const result=run("function Ensure-Node { throw 'DOWNLOAD-CALLED' };function Read-Host {throw 'MENU-CALLED'};function Start-Process {param([string]$FilePath);Write-Output ('OPEN '+$FilePath)};Show-Menu;try{Prepare-Project 'local' -Package;throw 'Unexpected success'}catch{if($_.Exception.Message -notlike '*Releases*'){throw};Write-Output 'LOCAL-INSTALL-BLOCKED'}");
  assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/OPEN https:\/\/github.com\/Nenki857\/teamspeak-music-bot\/releases/);assert.match(result.stdout,/LOCAL-INSTALL-BLOCKED/);assert.doesNotMatch(result.stdout,/DOWNLOAD-CALLED|MENU-CALLED/);
});
test('removed local installers are absent and both READMEs explain complete release ZIP usage',()=>{
  for(const file of ['本地版/一键启动.cmd','scripts/prepare-public-tunnel.mjs','scripts/download-file.ps1'])assert.equal(existsSync(file),false,file);
  for(const file of ['README.md','本地版/README.md']){const text=readFileSync(file,'utf8');assert.match(text,/https:\/\/github.com\/Nenki857\/teamspeak-music-bot\/releases/);assert.match(text,/Source code/);assert.match(text,/TS Music Bot\.exe/);assert.doesNotMatch(text,/首次启动需要联网下载|等待 5 秒自动安装/);}
});
