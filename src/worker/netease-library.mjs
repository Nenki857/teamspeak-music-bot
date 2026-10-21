import { isIP } from 'node:net';

export const MAINTAINED_NETEASE_MODULE = 'runtime/netease-api-4.41.1/node_modules/@neteasecloudmusicapienhanced/api/main.js';

export function validateNeteaseSourceIP(value = '') {
  if (!value) return '';
  // The deployment's actual public address; never generate or rotate addresses.
  if (typeof value !== 'string' || isIP(value) !== 4 || /^(?:0|10|127)\./.test(value)
      || /^(?:169\.254|192\.168)\./.test(value) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(value)
      || Number(value.split('.')[0]) >= 224) throw Error('Invalid music request source address');
  return value;
}

// The maintained library defaults song_url_v1 to xeapi, whose keys are not part
// of this application's startup. Retain the supported eapi song URL protocol,
// existing account cookie and requested quality; no unlock option is enabled.
export function neteaseMaintainedRequest(method, args, enabled = true, sourceIP = '') {
  if (!enabled) return args;
  let result = method === 'song_url_v1' && !args.crypto ? { ...args, crypto: 'eapi' } : args;
  if (sourceIP) result = { ...result, realIP: validateNeteaseSourceIP(sourceIP), randomCNIP: false };
  return result;
}
