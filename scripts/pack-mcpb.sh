#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

cd "$root"
npm run build
cp package.json package-lock.json "$stage/"
cp -R dist "$stage/dist"

# The Desktop pack must carry the same version as package.json / the GitHub release.
node --input-type=module -e "
import fs from 'node:fs';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(fs.readFileSync('mcpb/manifest.json', 'utf8'));
manifest.version = pkg.version;
fs.writeFileSync(process.argv[1], JSON.stringify(manifest, null, 2) + '\n');
" "$stage/manifest.json"

(cd "$stage" && npm ci --omit=dev --ignore-scripts)
if command -v zip >/dev/null; then
  (cd "$stage" && zip -qr "$root/kicktipp.mcpb" manifest.json package.json dist node_modules)
else
  (cd "$stage" && python3 -m zipfile -c "$root/kicktipp.mcpb" manifest.json package.json dist node_modules)
fi
echo "Wrote $root/kicktipp.mcpb ($(node -p "require('./package.json').version"))"
