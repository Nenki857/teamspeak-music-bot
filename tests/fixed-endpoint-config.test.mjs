import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixedEndpointConfig, writeFixedEndpointFiles } from '../src/server/fixed-endpoint-config.mjs';
const input={ip:'203.0.113.10',app:'/home/ubuntu/ts-music-bot-server-1.2.0',user:'ubuntu',environment:'# my settings\nTSMD_DATA_DIR=/home/ubuntu/ts-music-bot-server-1.2.0/server-data\nTSMD_HOST=127.0.0.1\nTSMD_PORT=18080\nTSMD_AUTOSTART=0\nTSMD_PUBLIC_URL=https://old.example.test\nTSMD_PERSISTENT_SHARES=0\nTSMD_FRIEND_PORT=18082\n'};
test('IP HTTPS configuration preserves private data and autostart settings and isolates the owner listener',()=>{
  const value=fixedEndpointConfig(input);
  assert.ok(value.environment.includes('TSMD_AUTOSTART=0'));assert.ok(value.environment.includes('TSMD_HOST=127.0.0.1'));assert.ok(value.environment.includes('TSMD_DATA_DIR='+input.app+'/server-data'));
  assert.equal(value.environment.match(/^TSMD_PUBLIC_URL=/gm).length,1);assert.ok(value.environment.includes('TSMD_PUBLIC_URL=https://203.0.113.10'));
  assert.ok(!value.environment.includes('18082'));assert.ok(!value.environment.includes('old.example.test'));
  assert.ok(value.caddy.includes('profile shortlived'));assert.ok(value.caddy.includes('default_sni 203.0.113.10'));
  assert.ok(value.caddy.includes('reverse_proxy 127.0.0.1:18081'));assert.ok(!value.caddy.includes('18080'));assert.ok(!value.caddy.includes('tls internal'));
  assert.ok(value.unit.includes('User=ubuntu'));assert.ok(!value.unit.includes('User=root'));assert.ok(value.unit.includes('CAP_NET_BIND_SERVICE'));assert.ok(value.unit.includes(input.app+'/server-data/https'));
  assert.equal(fixedEndpointConfig({...input,environment:value.environment}).environment,value.environment,'setup is idempotent');
});
test('configuration rejects command/config injection, private IP addresses and a publicly bound owner listener',()=>{
  for(const ip of ['https://203.0.113.10','203.0.113.10\nrespond hacked','127.0.0.1','10.1.1.1','192.168.1.1','0.0.0.0','::1'])assert.throws(()=>fixedEndpointConfig({...input,ip}));
  for(const app of ['/home/ubuntu/app\nExecStart=bad','/home/ubuntu/../outside','/home/ubuntu/app;evil','/home/ubuntu/app with spaces'])assert.throws(()=>fixedEndpointConfig({...input,app}));
  assert.throws(()=>fixedEndpointConfig({...input,user:'ubuntu\nUser=root'}));
  assert.throws(()=>fixedEndpointConfig({...input,environment:'TSMD_HOST=0.0.0.0\nTSMD_PORT=18080'}));
  assert.throws(()=>fixedEndpointConfig({...input,environment:'TSMD_PORT=18081'}));
});
test('generated configuration survives extracting a Caddy binary into the same staging directory',()=>{
  const stage=mkdtempSync(join(tmpdir(),'tsmd-caddy-config-'));
  const expected=writeFixedEndpointFiles(input,stage);
  const binary=Buffer.from([0x7f,0x45,0x4c,0x46,0,0xff,0x3c,0x3c,0x3c]);
  writeFileSync(join(stage,'caddy'),binary);
  assert.deepEqual(readFileSync(join(stage,'caddy')),binary);
  assert.equal(readFileSync(join(stage,'Caddyfile'),'utf8'),expected.caddy);
  assert.equal(readFileSync(join(stage,'environment'),'utf8'),expected.environment);
  assert.equal(readFileSync(join(stage,'unit'),'utf8'),expected.unit);
});
