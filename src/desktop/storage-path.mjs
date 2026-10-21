import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { LEGACY_DATA_DIRECTORY } from '../shared/legacy-brand.mjs';

export function resolveDataDirectory({ packaged, projectRoot, appData, override, exists = existsSync }) {
  if (override) return resolve(override);
  if (!packaged) return resolve(projectRoot, 'data');
  const current = resolve(appData, 'TS Music Bot');
  const legacy = resolve(appData, LEGACY_DATA_DIRECTORY);
  // Reuse an existing vault/database in place; do not move files while another version may be running.
  return !exists(current) && exists(legacy) ? legacy : current;
}
