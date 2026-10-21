import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(resolve('vendor/teamspeak-music-bot-1.13.2/package.json'));
const Database = require('better-sqlite3');
const db = new Database(resolve('data/app.db'), { readonly: true, fileMustExist: true });
const rows = db.prepare('SELECT json FROM presets').all().map(row => JSON.parse(row.json)); db.close();
const preset = rows[0];
if (!preset || preset.serverPassword || preset.channelPassword) throw new Error('此短时诊断只用于不需要密码的已保存服务器');
const { TS3Client } = await import(pathToFileURL(resolve('vendor/teamspeak-music-bot-1.13.2/dist/ts-protocol/client.js')).href);
const began = Date.now(); const trace = message => console.log(JSON.stringify({ ms: Date.now() - began, message }));
const logger = { info: (...args) => trace(args.find(a => typeof a === 'string') || 'info'), warn: (...args) => trace(args.find(a => typeof a === 'string') || 'warn'), error: (...args) => trace(args.find(a => typeof a === 'string') || 'error'), debug() {}, child() { return this; } };
const client = new TS3Client({ host: preset.serverAddress, port: preset.serverPort, queryPort: 10011, nickname: 'MusicBot_Check_' + Date.now().toString().slice(-4), serverProtocol: 'ts3', directVoiceConnection: true, defaultChannel: preset.defaultChannel, channelId: preset.channelId }, logger);
client.on('connected', () => trace('Wrapper connected event'));
client.on('disconnected', () => trace('Wrapper disconnected event'));
const timer = setInterval(() => { const raw = client.client; trace(`Status=${raw?.status}, clientId=${raw?.clientID()}, channelId=${raw?.channelID()}`); }, 2000);
let deadline;
try {
  const opening = client.connect(); const raw = client.client;
  if (process.argv.includes('--native-channel')) {
    Object.assign(raw.getClientInitOptions(), { defaultChannel: preset.defaultChannel, defaultChannelPassword: '' });
    const previous = raw.handler.onPacket; let count = 0;
    raw.handler.onPacket = packet => {
      if ([2, 3].includes(packet.typeFlagged & 15)) {
        for (const line of Buffer.from(packet.data).toString('utf8').split(/[\n\0]/)) {
          const command = line.split(' ', 1)[0];
          if (/channel|initserver|notifycliententerview/.test(command) && ++count < 20) trace('Incoming: ' + command + '; channel fields=' + (/channel_name=/.test(line)));
        }
      }
      previous(packet);
    };
  }
  await Promise.race([opening, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Diagnostic connection deadline')), 18000); })]); trace('Connect resolved');
}
catch (error) { trace('Connect rejected: ' + error.message); }
finally { clearTimeout(deadline); clearInterval(timer); client.disconnect(); setTimeout(() => process.exit(0), 1400); }
