import { existsSync } from 'node:fs';
import { dirname, resolve, delimiter } from 'node:path';

// Deploy tests require Bash. Override this when Git for Windows is installed
// outside a standard directory; production launchers do not depend on Bash.
export function deploymentBash(env = process.env, platform = process.platform) {
  if (env.TSMD_BASH) return env.TSMD_BASH;
  if (platform !== 'win32') return 'bash';
  const roots = [env.ProgramFiles && resolve(env.ProgramFiles, 'Git'),
    env.LOCALAPPDATA && resolve(env.LOCALAPPDATA, 'Programs/Git')].filter(Boolean);
  for (const item of (env.PATH || env.Path || '').split(delimiter)) {
    if (item && /[\\/]Git[\\/](?:cmd|bin)$/i.test(item)) roots.push(dirname(item));
  }
  const candidates = roots.flatMap(root => [resolve(root, 'bin/bash.exe'), resolve(root, 'usr/bin/bash.exe')]);
  const shell = candidates.find(existsSync);
  if (!shell) throw new Error('Deployment tests require Git Bash. Install Git for Windows or set TSMD_BASH to its bash.exe path.');
  return shell;
}
