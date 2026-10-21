import {readFileSync,writeFileSync} from 'node:fs';
for(const file of ['本地版/下载本地版.cmd','服务器版/一键部署.cmd'])writeFileSync(file,readFileSync(file,'utf8').replace(/^\uFEFF/,'').replace(/\r?\n/g,'\r\n'));
