#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

cd "$root"
npm run build
cp mcpb/manifest.json "$stage/"
cp package.json package-lock.json "$stage/"
cp -R dist "$stage/dist"
(cd "$stage" && npm ci --omit=dev --ignore-scripts)
(cd "$stage" && zip -qr "$root/kicktipp.mcpb" manifest.json package.json dist node_modules)
echo "Wrote $root/kicktipp.mcpb"
