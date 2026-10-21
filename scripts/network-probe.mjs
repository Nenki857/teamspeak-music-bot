import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('resources', { recursive: true });
for (const url of ['https://api.github.com/repos/cloudflare/cloudflared/releases/latest', 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe']) {
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'TSMusicBot-Setup' }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    if (url.includes('api.github.com')) { const release = await response.json(); const asset = release.assets.find(a => a.name === 'cloudflared-windows-amd64.exe'); await writeFile('work/cloudflared-release.json', JSON.stringify({ tag: release.tag_name, url: asset?.browser_download_url, digest: asset?.digest }, null, 2)); console.log('Official release metadata:', release.tag_name, asset?.digest || 'no digest'); }
    else { const buffer = Buffer.from(await response.arrayBuffer()); if (buffer.subarray(0, 2).toString() !== 'MZ') throw new Error('Not a Windows executable'); await writeFile('resources/cloudflared.exe', buffer); console.log('Official cloudflared downloaded:', buffer.length); }
  } catch (error) { console.log(new URL(url).host, error.message, error.cause?.code || ''); }
}
