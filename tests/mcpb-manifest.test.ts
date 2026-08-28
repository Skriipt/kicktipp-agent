import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { VERSION } from '../src/version.js';

const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcpb', 'manifest.json');

describe('the MCPB manifest', () => {
  it('declares a Desktop settings form and a node server', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
    ) as { version: string };
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      manifest_version: string;
      version: string;
      server: { mcp_config: { command: string; args: string[]; env: Record<string, string> } };
      user_config: Record<string, { type: string; sensitive?: boolean; required?: boolean }>;
    };
    expect(manifest.version).toBe(pkg.version);
    expect(VERSION).toBe(pkg.version);
    expect(manifest.manifest_version).toBe('0.4');
    expect(manifest.server.mcp_config.command).toBe('node');
    expect(manifest.server.mcp_config.args[0]).toContain('${__dirname}');
    expect(manifest.server.mcp_config.env.KICKTIPP_PASSWORD).toBe('${user_config.password}');
    expect(manifest.user_config.password.sensitive).toBe(true);
    expect(manifest.user_config.password.required).toBe(true);
    expect(manifest.user_config.email.required).toBe(true);
    expect(manifest.user_config.read_only.type).toBe('boolean');
  });
});
