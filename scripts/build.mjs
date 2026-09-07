import { rmSync, cpSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const [major, minor, patch] = process.versions.node.split('.').map(Number);
if (!(major >= 26 || (major === 24 && minor >= 15)
  || (major === 22 && (minor > 22 || (minor === 22 && patch >= 2))))) {
  console.error(`Unsupported Node.js ${process.versions.node}. Use Node 24.15.0 (nvm install && nvm use), or a version allowed by package.json engines.`);
  process.exit(1);
}
rmSync('dist', { recursive: true, force: true });
const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
cpSync('src/dashboard/public', 'dist/dashboard/public', { recursive: true });
chmodSync('dist/index.js', 0o755);
