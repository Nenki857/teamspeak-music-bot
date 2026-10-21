import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const execute=promisify(execFile);
const shell='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const manager=resolve('scripts/manage.ps1');
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const run=code=>execute(shell,['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-Command','. '+quote(manager)+' -Library; '+code],{encoding:'utf8',windowsHide:true,timeout:20000});
const skip=process.platform!=='win32';
async function fixture(t,handler){
  const dir=await mkdtemp(resolve('work/download-test-'));
  const server=createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  return{dir,url:'http://127.0.0.1:'+server.address().port+'/node.zip'};
}
const receive=(url,file,options='')=>'Receive-File -Uri '+quote(url)+' -Destination '+quote(file)+' -Label NodeProbe '+options;
test('bootstrap download reports received bytes, percent, speed and completion',{skip},async t=>{
  const bytes=Buffer.alloc(256*1024,65);
  const f=await fixture(t,(_req,res)=>{
    res.writeHead(200,{'Content-Length':bytes.length});res.write(bytes.subarray(0,65536));
    setTimeout(()=>res.write(bytes.subarray(65536,196608)),1100).unref();
    setTimeout(()=>res.end(bytes.subarray(196608)),2200).unref();
  });
  const file=join(f.dir,'node.zip.part');
  const result=await run(receive(f.url,file));
  assert.deepEqual(await readFile(file),bytes);
  assert.match(result.stdout,/MiB \(\d+%\).*KiB\/s.*elapsed/);
  assert.match(result.stdout,/\((?:25|75)%\)/);
  assert.match(result.stdout,/\(100%\).*complete/);
});
test('chunked download reports actual bytes without inventing a percentage',{skip},async t=>{
  const f=await fixture(t,(_req,res)=>{res.writeHead(200);res.write('abc');setTimeout(()=>res.end('def'),1100).unref();});
  const file=join(f.dir,'node.zip.part');const result=await run(receive(f.url,file));
  assert.equal(await readFile(file,'utf8'),'abcdef');assert.match(result.stdout,/MiB.*complete/);assert.doesNotMatch(result.stdout,/%/);
});
test('download idle timeout removes partial data and retains a prior archive',{skip},async t=>{
  const f=await fixture(t,(_req,res)=>{res.writeHead(200,{'Content-Length':100});res.write('a');});
  const archive=join(f.dir,'node.zip');await writeFile(archive,'previous archive');
  await assert.rejects(run(receive(f.url,archive+'.part','-IdleTimeoutSeconds 1')),error=>/No download data for 1 seconds/.test(error.stdout+error.stderr));
  await assert.rejects(access(archive+'.part'));assert.equal(await readFile(archive,'utf8'),'previous archive');
});
test('download connection timeout and HTTP failures are explicit',{skip},async t=>{
  const f=await fixture(t,()=>{});const file=join(f.dir,'node.zip.part');
  await assert.rejects(run(receive(f.url,file,'-ConnectTimeoutSeconds 1')),error=>/Download connection failed or timed out/.test(error.stdout+error.stderr));
  await assert.rejects(access(file));
  const missing=await fixture(t,(_req,res)=>{res.writeHead(404);res.end();});
  await assert.rejects(run(receive(missing.url,file)),error=>/Download failed: HTTP 404/.test(error.stdout+error.stderr));
  await assert.rejects(access(file));
});
test('overall download timeout also limits a continuously responding server',{skip},async t=>{
  const f=await fixture(t,(_req,res)=>{
    res.writeHead(200);res.write('a');const timer=setInterval(()=>res.write('a'),100);timer.unref();res.on('close',()=>clearInterval(timer));
  });const file=join(f.dir,'node.zip.part');
  await assert.rejects(run(receive(f.url,file,'-TimeoutSeconds 1 -IdleTimeoutSeconds 10')),error=>/Download exceeded 1 seconds/.test(error.stdout+error.stderr));
  await assert.rejects(access(file));
});
test('setup child output and failure exit code reach the launcher',{skip},async()=>{
  const args=['-e',"console.log('STDOUT-LIVE');console.error('STDERR-LIVE');process.exitCode=7"];
  await assert.rejects(run('Invoke-Native '+quote(process.execPath)+' @('+args.map(quote).join(',')+') -ShowOutput'),error=>{
    assert.match(error.stdout,/STDOUT-LIVE/);assert.match(error.stdout,/STDERR-LIVE/);assert.match(error.stdout+error.stderr,/exit code 7/);return true;
  });
});
test('quiet setup work emits a periodic heartbeat',{skip},async()=>{
  const args=['-e','setTimeout(()=>{},10500)'];
  const result=await run('Invoke-Native '+quote(process.execPath)+' @('+args.map(quote).join(',')+') -ShowOutput');
  assert.match(result.stdout,/is still working \(10s elapsed\)/);
});
