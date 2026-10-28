import { copyFileSync, mkdirSync } from 'node:fs';
const source = new URL('../src/web/', import.meta.url);
const destination = new URL('../dist/web/', import.meta.url);
mkdirSync(destination, { recursive: true });
for (const file of ['index.html', 'app.css', 'app.js']) {
  copyFileSync(new URL(file, source), new URL(file, destination));
}
