import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sourceFingerprint, needsPreparation } from '../scripts/prepare-project.mjs';
const shell='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const manager=resolve('scripts/manage.ps1');
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const run=code=>spawnSync(shell,['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-Command',code],{encoding:'utf8',windowsHide:true,cwd:resolve('.'),timeout:15000});
const fixture=name=>'. '+quote(manager)+' -Library\n'+readFileSync('tests/fixtures/deployment/'+name+'.ps1','utf8');
test('only two end-user launchers remain and use CRLF without BOM',()=>{
  assert.deepEqual(readdirSync('.').filter(name=>name.endsWith('.cmd')),[]);
  for(const[folder,name,edition]of [['本地版','一键启动.cmd','local'],['服务器版','一键部署.cmd','server']]){
    assert.deepEqual(readdirSync(folder).filter(name=>name.endsWith('.cmd')),[name]);
    const text=readFileSync(join(folder,name),'utf8');assert.ok(!text.startsWith('\uFEFF'));assert.doesNotMatch(text,/(?<!\r)\n/);assert.ok([...Buffer.from(text)].every(byte=>byte<=127),'CMD commands must stay ASCII so Git archive LF conversion cannot corrupt non-ASCII lines');
    assert.match(text,new RegExp('-Edition '+edition));assert.match(text,/manage\.ps1/);assert.match(text,/pause/);
  }
});
test('preparation reuses installed dependencies and detects changed locks or source',()=>{
  assert.equal(needsPreparation({previous:'same',expected:'same',required:['a'],exists:()=>true}),false);
  assert.equal(needsPreparation({previous:null,expected:'new',required:['a'],exists:()=>true}),false);
  assert.equal(needsPreparation({previous:'old',expected:'new',required:['a'],exists:()=>true}),true);
  assert.equal(needsPreparation({previous:'same',expected:'same',required:['a'],exists:()=>false}),true);
  mkdirSync('work',{recursive:true});const dir=mkdtempSync(resolve('work/build-fingerprint-'));mkdirSync(join(dir,'source'));writeFileSync(join(dir,'source/a.txt'),'before');
  const first=sourceFingerprint(['source'],dir);assert.equal(sourceFingerprint(['source'],dir),first);writeFileSync(join(dir,'source/a.txt'),'after');assert.notEqual(sourceFingerprint(['source'],dir),first);
});
test('PowerShell 5.1 parses the manager and check mode never installs or connects',{skip:process.platform!=='win32'},()=>{
  const parsed=run('$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile('+quote(manager)+',[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors|ForEach-Object{$_.ToString()};exit 1}');
  assert.equal(parsed.status,0,parsed.stdout+parsed.stderr);
  for(const edition of ['local','server']){
    const checked=spawnSync(shell,['-NoProfile','-ExecutionPolicy','Bypass','-File',manager,'-Edition',edition,'-CheckOnly'],{encoding:'utf8',windowsHide:true,timeout:10000});
    assert.equal(checked.status,0,checked.stdout+checked.stderr);const plan=JSON.parse(checked.stdout);assert.equal(plan.edition,edition);assert.equal(plan.networkAttempted,false);
  }
});
test('native arguments preserve spaces, quotes, Unicode and shell expressions',{skip:process.platform!=='win32'},()=>{
  mkdirSync('work',{recursive:true});const dir=mkdtempSync(resolve('work/native-argv-'));
  const helper=join(dir,'argv.mjs');writeFileSync(helper,'console.log(JSON.stringify(process.argv.slice(2)))');
  const values=['two words','a"quote','C:\\path with space\\','中文参数','printf "hello\\n"; app="$HOME/test"'];
  const result=run('. '+quote(manager)+' -Library; $result=@(Get-Native '+quote(process.execPath)+' @('+[helper,...values].map(quote).join(',')+'));Write-Output ($result -join "")');
  assert.equal(result.status,0,result.stdout+result.stderr);assert.deepEqual(JSON.parse(result.stdout),values);
});
test('deployment reuses installed service and browser and stops on failed probes',{skip:process.platform!=='win32'},()=>{
  const result=run(fixture('plans'));assert.equal(result.status,0,result.stdout+result.stderr);const plan=JSON.parse(result.stdout);
  assert.deepEqual(plan.existing,['prepare','update','console']);assert.deepEqual(plan.missingBrowser,['prepare','browser','console']);assert.deepEqual(plan.fresh,['prepare','upload','install','browser','console']);assert.deepEqual(plan.afterFailure,[]);
});
test('connection settings reject shell syntax before SSH',{skip:process.platform!=='win32'},()=>{
  const result=run(fixture('settings'));assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(JSON.parse(result.stdout).rejected,true);
});

test('launchers work with LF and CRLF from another directory and preserve the edition',{skip:process.platform!=='win32'},()=>{
  mkdirSync('work',{recursive:true});const base=mkdtempSync(resolve('work/launcher-encoding-'));
  for(const lineEnding of ['lf','crlf']){
    const root=join(base,lineEnding+' space & 中文 !');mkdirSync(join(root,'scripts'),{recursive:true});
    writeFileSync(join(root,'scripts/manage.ps1'),String.fromCharCode(0xFEFF)+["param([string]$Edition,[string]$Action,[switch]$CheckOnly)","[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)","Write-Output ('CHECK-OK '+(@{edition=$Edition;action=$Action;check=[bool]$CheckOnly}|ConvertTo-Json -Compress))"].join(String.fromCharCode(10)));
    for(const[folder,name,edition]of [['本地版','一键启动.cmd','local'],['服务器版','一键部署.cmd','server']]){
      mkdirSync(join(root,folder),{recursive:true});const file=join(root,folder,name);const source=readFileSync(join(folder,name),'utf8');writeFileSync(file,lineEnding==='lf'?source.replaceAll(String.fromCharCode(13,10),String.fromCharCode(10)):source);
      for(const flag of edition==='local'?['--check','--start','--menu']:['--check']){
        const command='call '+String.fromCharCode(34)+file+String.fromCharCode(34)+' '+flag;
        const result=spawnSync(shell,['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-Command','& '+quote(resolve(process.env.SystemRoot||'C:/Windows','System32/cmd.exe'))+' /d /c '+quote(command)+';exit $LASTEXITCODE'],{cwd:resolve(shell).slice(0,3),encoding:'utf8',windowsHide:true,timeout:15000});
        assert.equal(result.status,0,result.stdout+result.stderr);const line=result.stdout.split(String.fromCharCode(10)).map(value=>value.trim()).find(value=>value.startsWith('CHECK-OK '));assert.ok(line,result.stdout+result.stderr);const actual=JSON.parse(line.slice(9));assert.equal(actual.edition,edition);assert.equal(actual.action,flag==='--menu'?'menu':'default');assert.equal(actual.check,flag==='--check');
      }
    }
  }
});
