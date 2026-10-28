/** Build an offline browser fixture with executable UI checks. No real API calls. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const output = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'kicktipp-web-fixture.html'));
// An inline preview grows with content, so it must not use viewport-height sizing.
const css = read('src/web/app.css').replaceAll('min-height:100dvh', 'min-height:0');
const scripts = ['tests/fixtures/web-ui-fixture.js', 'src/web/app.js', 'tests/fixtures/web-ui-checks.js']
  .map(file => `<script>${read(file).replaceAll('</script', '<\\/script')}</script>`).join('\n');
const html = read('src/web/index.html')
  .replace('<link rel="stylesheet" href="/app.css">', `<style>${css}</style>`)
  .replace('<script src="/app.js" defer></script>', '')
  .replace('</body>', () => `${scripts}</body>`);
fs.writeFileSync(output, html);
console.log(output);
