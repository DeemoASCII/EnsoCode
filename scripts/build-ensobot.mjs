import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = spawnSync(
  process.execPath,
  ['node_modules/electron-vite/bin/electron-vite.js', 'build'],
  {
    cwd: root,
    env: { ...process.env, ENSO_PRODUCT: 'ensobot' },
    stdio: 'inherit',
  }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
