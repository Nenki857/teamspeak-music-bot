import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
export const officialSinusbotUrl = 'https://www.sinusbot.com/dl/sinusbot.current.tar.bz2';
export function validateAudioArchive(file) {
  const size=statSync(file).size;
  if(size<100 || size>250*1024*1024)throw Error('官方音频安装包大小异常');
  const bytes=readFileSync(file);if(bytes.subarray(0,3).toString()!=='BZh')throw Error('文件不是 bzip2 安装包，可能保存了网页或下载未完成');
  const listing=spawnSync('tar',['-tjf',file],{encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024});
  if(listing.status!==0)throw Error('音频安装包无法完整解压，请重新从官网下载');
  const names=listing.stdout.split(/\r?\n/).filter(Boolean).map(name=>name.replace(/^\.\//,''));
  if(names.some(name=>name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')))throw Error('安装包包含无效路径');
  for(const name of ['sinusbot','config.ini.dist','plugin/libsoundbot_plugin.so'])if(!names.includes(name))throw Error('安装包缺少 '+name+'，请下载 Linux 64 位版本');
  return createHash('sha256').update(bytes).digest('hex');
}
export async function prepareOfficialAudio({ directory, downloads=resolve(homedir(),'Downloads'), fetcher=fetch, log=console.log }) {
  mkdirSync(directory,{recursive:true});const target=resolve(directory,'sinusbot.current.tar.bz2');
  const source=[target,resolve(downloads,'sinusbot.current.tar.bz2')].find(file=>existsSync(file));
  if(source){const digest=validateAudioArchive(source);if(source!==target)copyFileSync(source,target);writeFileSync(target+'.sha256',digest+'  sinusbot.current.tar.bz2\n');log('Official audio component is ready locally; it will be uploaded over SSH.');return target;}
  log('Preparing the official Linux audio component before changing the server...');
  const temporary=target+'.part';
  try{
    const response=await fetcher(officialSinusbotUrl,{signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw Error('HTTP '+response.status);
    if(/text\/html/i.test(response.headers.get('content-type')||''))throw Error('官网返回了网页验证页面');
    const chunks=[];let total=0;for await(const chunk of response.body){total+=chunk.length;if(total>250*1024*1024)throw Error('安装包超过大小限制');chunks.push(chunk);}
    writeFileSync(temporary,Buffer.concat(chunks));const digest=validateAudioArchive(temporary);renameSync(temporary,target);
    writeFileSync(target+'.sha256',digest+'  sinusbot.current.tar.bz2\n');log('Official audio component downloaded and archive checked.');return target;
  }catch(failure){try{unlinkSync(temporary);}catch{}
    throw Error('自动准备官方音频组件失败：'+failure.message+'\n请用浏览器访问 https://www.sinusbot.com/ ，点击 Download for Linux 64 bit。\n将文件保存为默认下载目录中的 sinusbot.current.tar.bz2，再重新运行切换工具。\n也可放到 '+directory+'；本次尚未更新或停止服务器机器人。');
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const directory=resolve(dirname(fileURLToPath(import.meta.url)),'../release/server/tools');
  prepareOfficialAudio({directory}).catch(error=>{console.error(error.message);process.exitCode=1;});
}
