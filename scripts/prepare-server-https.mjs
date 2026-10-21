import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const version='2.11.7';
const response=await fetch(`https://api.github.com/repos/caddyserver/caddy/releases/tags/v${version}`,{signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('Caddy release lookup failed');
const release=await response.json();
for(const [name,folder] of [[`caddy_${version}_linux_amd64.tar.gz`,'release/server/tools'],...(process.argv.includes('--validation')?[[`caddy_${version}_windows_amd64.zip`,'work/caddy-validation']]:[])]){
  const asset=release.assets.find(a=>a.name===name);if(!asset||!/^sha256:[a-f0-9]{64}$/.test(asset.digest)||!asset.browser_download_url.startsWith(`https://github.com/caddyserver/caddy/releases/download/v${version}/`))throw Error('Invalid release asset');
  mkdirSync(folder,{recursive:true});const file=resolve(folder,name),digest=value=>createHash('sha256').update(value).digest('hex');
  if(!existsSync(file)||digest(readFileSync(file))!==asset.digest.slice(7)){
    console.log(`Downloading ${name} through the official GitHub asset API...`);
    if(!/^https:\/\/api\.github\.com\/repos\/caddyserver\/caddy\/releases\/assets\/\d+$/.test(asset.url))throw Error('Invalid asset API URL');
    const downloaded=await fetch(asset.url,{headers:{Accept:'application/octet-stream'},signal:AbortSignal.timeout(120000)});if(!downloaded.ok)throw Error('Caddy download failed');
    const content=Buffer.from(await downloaded.arrayBuffer());if(digest(content)!==asset.digest.slice(7))throw Error('Caddy checksum mismatch');writeFileSync(file,content);
  }
  writeFileSync(file+'.sha256',asset.digest.slice(7)+'  '+name+'\n');console.log(`Verified ${name} (${(asset.size/1024/1024).toFixed(1)} MiB)`);
}
