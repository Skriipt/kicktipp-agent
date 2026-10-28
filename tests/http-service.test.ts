import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHttpService, type HttpService } from '../src/service/http.js';
import { kicktippQueue, SerialQueue } from '../src/service/queue.js';

const TOKEN = 'test-token-that-is-at-least-thirty-two-characters';
let service: HttpService | undefined;
let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-http-'));
  vi.stubEnv('KICKTIPP_CONFIG_DIR', directory);
  vi.stubEnv('KICKTIPP_DATA_DIR', directory);
  vi.stubEnv('KICKTIPP_EMAIL', 'fixture@example.invalid');
  vi.stubEnv('KICKTIPP_PASSWORD', 'private-test-password');
  vi.stubEnv('KICKTIPP_COMMUNITY', 'test-community');
  vi.stubEnv('KICKTIPP_PLAYER', 'Fixture Player');
  vi.stubEnv('KICKTIPP_PROFILE', '');
  vi.stubEnv('KICKTIPP_READ_ONLY', '0');
});

afterEach(async () => {
  await service?.close();
  service = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function start(allowedOrigins?: string[]) {
  service = await startHttpService({
    host: '127.0.0.1', port: 0, token: TOKEN, allowedOrigins,
    status: () => ({ last_check: '2026-10-28T12:00:00.000Z', next_check: null }),
  });
  return `http://127.0.0.1:${service.port}`;
}

function headers(overrides: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...overrides };
}

async function rpc(base: string, method: string, params: object = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    return JSON.parse(text.split('\n').find((line) => line.startsWith('data: '))!.slice(6));
  }
  return JSON.parse(text);
}

describe('authenticated HTTP MCP service', () => {
  it('offers a minimal public health endpoint and protects status and MCP', async () => {
    const base = await start();
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: 'ok' });
    expect((await fetch(`${base}/status`)).status).toBe(401);
    expect((await fetch(`${base}/mcp`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${base}/status`, { headers: headers({ Authorization: 'Bearer wrong' }) })).status).toBe(401);
    expect((await fetch(`${base}/status`, { headers: headers({ Authorization: `bearer ${TOKEN}` }) })).status).toBe(200);
    const response = await fetch(`${base}/status`, { headers: headers() });
    expect(await response.json()).toEqual({ last_check: '2026-10-28T12:00:00.000Z', next_check: null });
  });

  it('initializes and serves tools with Kicktipp and Spielleiter functions retained', async () => {
    const base = await start();
    const initialized = await rpc(base, 'initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' },
    });
    expect(initialized.result.serverInfo.name).toBe('kicktipp');
    const listed = await rpc(base, 'tools/list');
    const names = listed.result.tools.map((tool: { name: string }) => tool.name);
    for (const name of ['get_bets', 'get_bonus_questions', 'get_rules', 'get_stats', 'suggest_bets', 'place_bets', 'place_bonus_bets', 'list_members', 'get_bets_for_member', 'place_bets_for_member']) expect(names).toContain(name);
    for (const name of ['connect_account', 'set_notify', 'set_community', 'set_player', 'whatif', 'get_rival_analysis', 'get_standings_scenarios']) expect(names).not.toContain(name);
    const status = await rpc(base, 'tools/call', { name: 'get_status', arguments: {} });
    expect(status.result.structuredContent.data).toMatchObject({ community: 'test-community', credentials_saved: true, service: { next_check: null } });
    expect(JSON.stringify(status)).not.toContain('private-test-password');
    expect(JSON.stringify(status)).not.toContain(TOKEN);
  });

  it('hides every submission tool in read-only mode', async () => {
    vi.stubEnv('KICKTIPP_READ_ONLY', '1');
    const base = await start();
    const listed = await rpc(base, 'tools/list');
    const names = listed.result.tools.map((tool: { name: string }) => tool.name);
    for (const name of ['place_bets', 'place_bonus_bets', 'place_bets_for_member']) expect(names).not.toContain(name);
    expect(names).toContain('list_members');
  });

  it('rejects browser origins unless explicitly allowed and handles allowed preflight', async () => {
    const base = await start(['https://agent.example']);
    const rejected = await fetch(`${base}/status`, { headers: headers({ Origin: 'https://evil.example' }) });
    expect(rejected.status).toBe(403);
    const allowed = await fetch(`${base}/status`, { headers: headers({ Origin: 'https://agent.example' }) });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://agent.example');
    const preflight = await fetch(`${base}/mcp`, { method: 'OPTIONS', headers: { Origin: 'https://agent.example' } });
    expect(preflight.status).toBe(204);
  });

  it('rejects invalid methods, media types and oversized requests before dispatch', async () => {
    const base = await start();
    expect((await fetch(`${base}/mcp`, { headers: headers() })).status).toBe(405);
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: headers({ 'Content-Type': 'text/plain' }), body: '{}' })).status).toBe(415);
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: headers(), body: 'x'.repeat(1024 * 1024 + 1) })).status).toBe(413);
  });

  it('queues MCP tool calls behind an ongoing scheduler operation', async () => {
    const base = await start();
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = kicktippQueue.run(() => blocker);
    let enqueued!: () => void;
    const reachedQueue = new Promise<void>((resolve) => { enqueued = resolve; });
    const run = kicktippQueue.run.bind(kicktippQueue);
    vi.spyOn(kicktippQueue, 'run').mockImplementation((operation) => { enqueued(); return run(operation); });
    let responded = false;
    const request = rpc(base, 'tools/call', { name: 'get_status', arguments: {} }).then((value) => { responded = true; return value; });
    await reachedQueue;
    // A successful health call proves the listener is active while queued work
    // stays blocked; we do not rely on sleeps or timing thresholds.
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect(responded).toBe(false);
    release();
    await scheduler;
    expect((await request).result.structuredContent.data.community).toBe('test-community');
  });

  it('finishes already accepted work before closing the HTTP service', async () => {
    const base = await start();
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const active = kicktippQueue.run(() => blocker);
    let enqueued!: () => void;
    const reachedQueue = new Promise<void>((resolve) => { enqueued = resolve; });
    const run = kicktippQueue.run.bind(kicktippQueue);
    vi.spyOn(kicktippQueue, 'run').mockImplementation((operation) => { enqueued(); return run(operation); });
    const request = rpc(base, 'tools/call', { name: 'get_status', arguments: {} });
    await reachedQueue;
    let closed = false;
    const closing = service!.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await active;
    expect((await request).result.structuredContent.data.community).toBe('test-community');
    await closing;
    expect(closed).toBe(true);
  });
});

describe('account work queue', () => {
  it('serializes conflicting work and continues after a failed operation', async () => {
    const queue = new SerialQueue();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.run(async () => { events.push('read-start'); await gate; events.push('read-end'); });
    const rejected = queue.run(() => { events.push('write'); throw new Error('rejected'); });
    const failure = expect(rejected).rejects.toThrow('rejected');
    const third = queue.run(() => { events.push('next'); return 42; });
    await Promise.resolve();
    expect(events).toEqual(['read-start']);
    release();
    await first;
    await failure;
    expect(await third).toBe(42);
    await queue.idle();
    expect(events).toEqual(['read-start', 'read-end', 'write', 'next']);
  });
});
