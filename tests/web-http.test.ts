import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHttpService, type HttpService } from '../src/service/http.js';
import { AdminError } from '../src/service/admin.js';
import { ensureWebToken } from '../src/service/web-token.js';

const MCP_TOKEN = 'mcp-fixture-token-with-more-than-32-characters';
const ADMIN_TOKEN = 'admin-fixture-token-with-more-than-32-characters';
let service: HttpService | undefined;
let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-web-http-'));
  for (const key of ['KICKTIPP_CONFIG_DIR', 'KICKTIPP_DATA_DIR']) vi.stubEnv(key, directory);
  vi.stubEnv('KICKTIPP_EMAIL', 'http@example.invalid');
  vi.stubEnv('KICKTIPP_PASSWORD', 'http-private-password');
  vi.stubEnv('KICKTIPP_COMMUNITY', 'fixture');
  vi.stubEnv('KICKTIPP_PROFILE', '');
  vi.stubEnv('KICKTIPP_READ_ONLY', '1');
});

afterEach(async () => {
  await service?.close();
  service = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

function adminHeaders(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json', ...extra };
}

async function start(handle?: (route: string, method: string, body?: unknown) => Promise<unknown>, token: string | (() => string | null) = MCP_TOKEN) {
  service = await startHttpService({
    host: '127.0.0.1', port: 0, token,
    status: () => ({ configured: true }),
    web: { token: ADMIN_TOKEN, handle: handle ?? (async route => {
      if (route === '/api/admin/config') return { configured: true };
      if (route === '/api/admin/failure') throw new Error('password-never-returned');
      throw new AdminError('not_found', 404);
    }) },
  });
  return `http://127.0.0.1:${service.port}`;
}

function chunkedPost(base: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/api/admin/config`, { method: 'POST', headers: adminHeaders() }, response => {
      let result = '';
      response.on('data', chunk => { result += String(chunk); });
      response.on('end', () => resolve({ status: response.statusCode!, body: result }));
    });
    request.on('error', reject);
    // Two writes deliberately avoid a Content-Length header.
    request.write(body.slice(0, 100));
    request.end(body.slice(100));
  });
}

describe('local web HTTP boundary', () => {
  it('serves packaged static files without exposing either bearer token', async () => {
    const base = await start();
    for (const [asset, type] of [['/', 'text/html'], ['/app.css', 'text/css'], ['/app.js', 'text/javascript']]) {
      const response = await fetch(`${base}${asset}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(type);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      const text = await response.text();
      expect(text).not.toContain(MCP_TOKEN);
      expect(text).not.toContain(ADMIN_TOKEN);
      expect(text).not.toContain('http-private-password');
    }
    const head = await fetch(`${base}/`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('separates admin and MCP privileges and allows the local same-origin frontend', async () => {
    const base = await start();
    expect((await fetch(`${base}/api/admin/config`)).status).toBe(401);
    expect((await fetch(`${base}/api/admin/config`, { headers: { Authorization: `Bearer ${MCP_TOKEN}` } })).status).toBe(401);
    expect((await fetch(`${base}/api/admin/config`, { headers: adminHeaders({ Origin: base }) })).status).toBe(200);
    expect((await fetch(`${base}/status`, { headers: adminHeaders() })).status).toBe(401);
    expect((await fetch(`${base}/status`, { headers: { Authorization: `Bearer ${MCP_TOKEN}` } })).status).toBe(200);
    const request = await fetch(`${base}/api/admin/config`, { method: 'POST', headers: adminHeaders({ Origin: base }), body: '{}' });
    expect(request.status).toBe(200);
    expect(request.headers.has('access-control-allow-origin')).toBe(false);
  });

  it('rejects cross-site origins and untrusted Host headers even with the admin credential', async () => {
    const handler = vi.fn(async () => ({}));
    const base = await start(handler);
    for (const extra of [
      { Origin: 'https://attacker.example' },
      { Origin: 'null' },
      { Origin: base, 'Sec-Fetch-Site': 'cross-site' },
      { Host: 'attacker.example', Origin: 'http://attacker.example' },
      { Origin: `http://localhost:${service!.port}` },
    ]) {
      expect((await fetch(`${base}/api/admin/config`, { headers: adminHeaders(extra) })).status).toBe(403);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects wrong methods, media types, malformed JSON and both oversized body encodings', async () => {
    const handler = vi.fn(async () => ({}));
    const base = await start(handler);
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/api/admin/config`, { method: 'DELETE', headers: adminHeaders() })).status).toBe(405);
    expect((await fetch(`${base}/api/admin/config`, { method: 'POST', headers: adminHeaders({ 'Content-Type': 'text/plain' }), body: '{}' })).status).toBe(415);
    const malformed = await fetch(`${base}/api/admin/config`, { method: 'POST', headers: adminHeaders(), body: 'secret-invalid-json' });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'invalid_json' });
    const oversized = JSON.stringify({ value: 'x'.repeat(64 * 1024) });
    expect((await fetch(`${base}/api/admin/config`, { method: 'POST', headers: adminHeaders(), body: oversized })).status).toBe(413);
    expect(await chunkedPost(base, oversized)).toEqual({ status: 413, body: JSON.stringify({ error: 'body_too_large' }) });
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns stable safe controller errors and starts before an MCP configuration exists', async () => {
    const base = await start(undefined, () => null);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/mcp`, { method: 'POST' })).status).toBe(503);
    const missing = await fetch(`${base}/api/admin/missing`, { headers: adminHeaders() });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });
    const failure = await fetch(`${base}/api/admin/failure`, { headers: adminHeaders() });
    expect(failure.status).toBe(500);
    expect(await failure.json()).toEqual({ error: 'request_failed' });
  });

  it('gates MCP server creation behind an accepted configuration change', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const base = await start(async () => {
      entered(); await blocked; process.env.KICKTIPP_READ_ONLY = '0'; return { saved: true };
    });
    const save = fetch(`${base}/api/admin/config`, { method: 'POST', headers: adminHeaders(), body: '{}' });
    await started;
    const list = fetch(`${base}/mcp`, { method: 'POST',
      headers: { Authorization: `Bearer ${MCP_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect((await fetch(`${base}/health`)).status).toBe(200);
    release();
    expect((await save).status).toBe(200);
    const response = await list;
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const value = response.headers.get('content-type')?.includes('text/event-stream')
      ? JSON.parse(text.split('\n').find(line => line.startsWith('data: '))!.slice(6)) : JSON.parse(text);
    expect(value.result.tools.map((tool: { name: string }) => tool.name)).toContain('place_bets');
  });
});

describe('web administrator token storage', () => {
  it('creates a separate durable owner-only credential and refuses invalid files', () => {
    const file = path.join(directory, 'web-admin-token');
    const first = ensureWebToken(file);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ensureWebToken(file)).toBe(first);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.writeFileSync(file, 'invalid-private-content');
    expect(() => ensureWebToken(file)).toThrow(/Invalid web access token/);
    expect(() => ensureWebToken(file)).not.toThrow(/invalid-private-content/);
  });
});
