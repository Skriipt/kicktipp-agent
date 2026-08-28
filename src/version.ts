import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/**
 * Same string as package.json, so the CLI, MCP server, and Desktop pack
 * cannot drift from a GitHub release that was cut from this tree.
 */
export const VERSION: string = readPackageVersion();

function readPackageVersion(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const parsed: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed)) {
    throw new Error(`package.json at ${pkgPath} has no version string.`);
  }
  const version = parsed.version;
  if (typeof version !== 'string') {
    throw new Error(`package.json at ${pkgPath} has no version string.`);
  }
  return version;
}
