import { resolve } from 'node:path';

export function resolveDataDirectory({ packaged, projectRoot, appData, override }) {
  return resolve(override || (packaged ? resolve(appData, 'TS Music Desk') : resolve(projectRoot, 'data')));
}
