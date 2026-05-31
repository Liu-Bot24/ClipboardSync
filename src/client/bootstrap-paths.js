import { dirname, join } from 'node:path';

export const BOOTSTRAP_CONFIG_FILE = 'clipboard-sync.config.json';

export function bootstrapConfigPaths({ resourcesPath = process.resourcesPath, execPath = process.execPath, appRoot }) {
  return [
    join(resourcesPath, BOOTSTRAP_CONFIG_FILE),
    join(dirname(execPath), BOOTSTRAP_CONFIG_FILE),
    join(appRoot, BOOTSTRAP_CONFIG_FILE),
    join(appRoot, '.client-bootstrap.json')
  ];
}
