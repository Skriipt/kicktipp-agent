#!/usr/bin/env node
// Run after `docker compose build`. Uses only an isolated Compose project and
// synthetic account data; every outbound fetch is restricted to the fixture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-compose-smoke-'));
const project = `kicktipp-smoke-${randomBytes(6).toString('hex')}`;
let token = randomBytes(32).toString('hex');
const password = 'local-smoke-fixture-password';
const community = 'compose-smoke';
let composeStarted = false;
let composeArgs;
let environment;

async function run(binary, args, input = '', timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: root, env: environment ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${binary} ${args[0]} failed (${code}): ${stderr || stdout}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const compose = (args, input) => run('docker', [...composeArgs, ...args], input);

async function unusedPort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function status(base) {
  const response = await fetch(`${base}/status`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function completedCheck(base) {
  const deadline = Date.now() + 10_000;
  let latest;
  while (Date.now() < deadline) {
    latest = await status(base);
    if (latest.scheduler.lastSuccess && latest.scheduler.nextCheck > latest.scheduler.lastCheck) return latest;
    await delay(50);
  }
  throw new Error(`Scheduler did not complete its startup check: ${JSON.stringify(latest)}`);
}

async function rpc(base, method, params = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(body.split('\n').find((line) => line.startsWith('data: ')).slice(6))
    : JSON.parse(body);
}

try {
  const origin = 'http://fixture:8788';
  const fixturePort = await unusedPort();
  const events = async () => (await fetch(`http://127.0.0.1:${fixturePort}/events`, { signal: AbortSignal.timeout(5000) })).json();
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const guard = path.join(temporary, 'local-fetch-only.mjs');
  fs.writeFileSync(guard, `
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const health = url.origin === 'http://127.0.0.1:8787' && url.pathname === '/health';
  if (!health && url.origin !== process.env.KICKTIPP_BASE_URL) {
    throw new Error('Container smoke blocked non-fixture fetch');
  }
  return nativeFetch(input, init);
};
`, { mode: 0o644 });
  // Mount the file itself: the private host temp directory need not be exposed.
  const override = path.join(temporary, 'compose.smoke.json');
  fs.writeFileSync(override, JSON.stringify({ services: {
    kicktipp: {
      environment: { KICKTIPP_BASE_URL: origin, NODE_OPTIONS: '--import=/opt/smoke/local-fetch-only.mjs' },
      depends_on: { fixture: { condition: 'service_healthy' } },
      volumes: [{ type: 'bind', source: guard, target: '/opt/smoke/local-fetch-only.mjs', read_only: true }],
    },
    fixture: {
      image: 'kicktipp-agent:local',
      entrypoint: ['node', '/opt/smoke/fixture.mjs'],
      command: [],
      init: true,
      read_only: true,
      ports: [`127.0.0.1:${fixturePort}:8788`],
      volumes: [{ type: 'bind', source: path.join(root, 'scripts/fixtures/container-kicktipp.mjs'), target: '/opt/smoke/fixture.mjs', read_only: true }],
      healthcheck: {
        test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:8788/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"],
        interval: '1s', timeout: '2s', retries: 10,
      },
    },
  } }));
  environment = { ...process.env, KICKTIPP_PORT: String(port) };
  composeArgs = ['compose', '--project-name', project, '--file', path.join(root, 'compose.yaml'), '--file', override];
  const config = {
    version: 1,
    account: { email: 'smoke@example.invalid', password, community, site: 'de' },
    server: { token, host: '0.0.0.0', port: 8787, readOnly: true, allowedOrigins: [] },
    notifications: { channels: [{ id: 'smoke', kind: 'webhook', url: `${origin}/webhook` }], warnHours: [6, 1], everyMinutes: 1 },
    timeZone: 'Europe/Berlin',
  };
  console.log(`Running isolated Compose smoke (${project}).`);
  composeStarted = true;
  await compose(['up', '-d', '--no-build', '--wait', '--wait-timeout', '40']);
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: 'ok' });
  for (const [asset, type] of [['/', 'text/html'], ['/app.js', 'javascript'], ['/app.css', 'text/css']]) {
    const response = await fetch(`${base}${asset}`);
    assert.equal(response.status, 200);
    assert(response.headers.get('content-type').includes(type));
    assert(response.headers.get('content-security-policy').includes("script-src 'self'"));
  }
  const adminToken = await compose(['exec', '-T', 'kicktipp', 'node', 'dist/service/main.js', 'web-token']);
  const adminHeaders = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', Origin: base };
  assert.equal((await fetch(`${base}/api/admin/config`)).status, 401);
  const initial = await (await fetch(`${base}/api/admin/config`, { headers: adminHeaders })).json();
  assert.equal(initial.configured, false);
  assert.equal(initial.config, null);
  const setup = await fetch(`${base}/api/admin/config`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ revision: initial.revision, account: config.account,
      notifications: config.notifications, timeZone: config.timeZone, readOnly: true }),
  });
  assert.equal(setup.status, 200);
  const configured = await setup.json();
  assert.equal(configured.configured, true);
  assert(!JSON.stringify(configured).includes(password));
  assert(!JSON.stringify(configured).includes(`${origin}/webhook`));
  const connection = await (await fetch(`${base}/api/admin/connection`, { headers: adminHeaders })).json();
  assert.equal(connection.url, '/mcp');
  token = connection.token;
  assert.equal((await fetch(`${base}/api/admin/config`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  assert.equal((await fetch(`${base}/status`, { headers: { Authorization: `Bearer ${adminToken}` } })).status, 401);
  assert.equal((await fetch(`${base}/status`)).status, 401);
  console.log('PASS: packaged web assets, separate admin authentication and first setup through the web API.');
  const first = await completedCheck(base);
  assert.equal(first.readOnly, true);
  assert.equal(first.scheduler.lastError, null);
  assert.equal(first.scheduler.deliveredCount, 1);
  const firstEvents = await events();
  assert.equal(firstEvents.received.length, 1);
  assert.equal(firstEvents.received[0].event, 'missing_tips');
  assert.equal(firstEvents.received[0].matches[0].home, 'Home FC');
  const result = await rpc(base, 'tools/call', { name: 'get_status', arguments: {} });
  assert.equal(result.result.structuredContent.data.community, community);
  assert.equal(result.result.structuredContent.data.read_only, true);
  const names = (await rpc(base, 'tools/list')).result.tools.map((tool) => tool.name);
  assert(names.includes('list_members'));
  assert(!names.includes('place_bets'));
  console.log('PASS: container health, authenticated MCP, read-only tools and scheduled webhook.');

  const firstId = await compose(['ps', '-q', 'kicktipp']);
  await compose(['stop', '--timeout', '10', 'kicktipp']);
  assert.equal(await run('docker', ['inspect', '--format', '{{.State.ExitCode}}', firstId]), '0');
  await compose(['up', '-d', '--no-build', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '40', 'kicktipp']);
  const nextId = await compose(['ps', '-q', 'kicktipp']);
  assert.notEqual(nextId, firstId);
  const second = await completedCheck(base);
  assert.equal(second.scheduler.lastError, null);
  assert.equal(second.scheduler.deliveredCount, 0);
  const secondEvents = await events();
  assert.equal(secondEvents.received.length, 1);
  assert.equal(secondEvents.logins, 1);
  assert.deepEqual(secondEvents.unexpected, []);
  const logs = await compose(['logs', '--no-color', 'kicktipp']);
  assert(!logs.includes(token));
  assert(!logs.includes(password));
  assert(!logs.includes(adminToken));
  console.log('PASS: graceful shutdown, container recreation, persistent login and reminder deduplication.');
} catch (error) {
  if (composeStarted) {
    const logs = await compose(['logs', '--no-color', 'kicktipp']).catch(() => 'No container logs available.');
    console.error(logs);
  }
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (composeStarted) {
    try {
      await compose(['down', '--volumes', '--remove-orphans', '--timeout', '10']);
      console.log('Removed only the isolated smoke project and its test volume.');
    } catch (error) {
      console.error(`Cleanup failed for ${project}: ${error.message}`);
      process.exitCode = 1;
    }
  }
  fs.rmSync(temporary, { recursive: true, force: true });
}
