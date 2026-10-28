import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PASSWORD = 'web-process-password-only-for-local-fixture';
const COMMUNITY = 'web-process-fixture';
const OTHER_COMMUNITY = 'other-web-process-fixture';
const processes = new Set<ChildProcess>();
let fixture: Server | undefined;
let directory: string | undefined;

afterEach(async () => {
  for (const child of processes) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  }
  processes.clear();
  fixture?.closeAllConnections();
  if (fixture?.listening) await new Promise<void>(resolve => fixture!.close(() => resolve()));
  fixture = undefined;
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

async function freePort(): Promise<number> {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve())); return port;
}

function printedKickoff(): string {
  const parts = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(Date.now() + 20 * 60_000));
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  return `${get('day')}.${get('month')}.${get('year')} ${get('hour')}:${get('minute')}`;
}

async function launch(configFile: string, fixtureOrigin: string, port: number) {
  const guard = path.join(path.dirname(configFile), 'local-fetch-only.mjs');
  fs.writeFileSync(guard, `
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const address = input instanceof Request ? input.url : String(input);
  if (new URL(address).origin !== process.env.KICKTIPP_BASE_URL) throw new Error('Blocked non-fixture request');
  return nativeFetch(input, init);
};
`);
  const child = spawn(process.execPath, ['--import', guard, 'dist/service/main.js'], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      KICKTIPP_SERVICE_CONFIG: configFile, KICKTIPP_BASE_URL: fixtureOrigin,
      KICKTIPP_LISTEN_HOST: '127.0.0.1', KICKTIPP_LISTEN_PORT: String(port), KICKTIPP_LANG: 'en',
      KICKTIPP_CONFIG_DIR: path.join(path.dirname(configFile), 'config'),
      KICKTIPP_DATA_DIR: path.join(path.dirname(configFile), 'data'),
    },
  });
  processes.add(child);
  let output = ''; let stderr = '';
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Service did not start: ${stderr}`)), 10_000);
    const earlyExit = () => { clearTimeout(timer); reject(new Error(`Service exited: ${stderr}`)); };
    child.once('exit', earlyExit);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdout!.on('data', chunk => {
      output += String(chunk); const match = output.match(/listening on port (\d+)/);
      if (!match) return;
      clearTimeout(timer); child.off('exit', earlyExit); resolve(`http://127.0.0.1:${match[1]}`);
    });
  });
  return { base, logs: () => output + stderr,
    async stop() {
      const exited = once(child, 'exit'); child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { const [code, signal] = await exited; expect(signal, stderr).toBeNull(); expect(code, stderr).toBe(0); }
      finally { clearTimeout(timer); }
    },
  };
}

async function rpc(base: string, token: string, method: string, params: object = {}) {
  const response = await fetch(`${base}/mcp`, { method: 'POST', signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text(); expect(response.status, text).toBe(200);
  return response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(text.split('\n').find(line => line.startsWith('data: '))!.slice(6)) : JSON.parse(text);
}

describe('compiled local web administration', () => {
  it('bootstraps, applies custom reminders and account changes, and persists across restart', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-web-process-'));
    const configFile = path.join(directory, 'service.json');
    const kickoff = printedKickoff();
    const received: any[] = [];
    const requests: { method: string; pathname: string; account: string | null }[] = [];
    const unexpected: string[] = [];
    const logins: string[] = [];
    let rejectReads = false;
    let failedGroup: string | null = null;
    fixture = createServer(async (request, response) => {
      const pathname = new URL(request.url!, 'http://localhost').pathname;
      const account = request.headers.cookie?.match(/(?:^|;\s*)sid=(first|second)(?:;|$)/)?.[1] ?? null;
      requests.push({ method: request.method!, pathname, account });
      const html = (body: string) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(body); };
      const loginForm = '<form method="post" action="/info/profil/login"><input name="kennung"><input type="password" name="passwort"><button name="submitbutton" value="login">Login</button></form>';
      if (pathname === '/webhook/fixture-secret' && request.method === 'POST') {
        let body = ''; for await (const chunk of request) body += String(chunk);
        received.push(JSON.parse(body)); response.writeHead(204); response.end(); return;
      }
      if (pathname === '/info/profil/login') {
        if (request.method === 'GET') { html(loginForm); return; }
        if (request.method === 'POST') {
          let body = ''; for await (const chunk of request) body += String(chunk);
          const form = new URLSearchParams(body); const name = form.get('kennung')?.split('@')[0];
          if ((name === 'first' || name === 'second') && form.get('passwort') === PASSWORD) {
            logins.push(name); response.writeHead(302, { Location: '/', 'Set-Cookie': `sid=${name}; Path=/; HttpOnly` }); response.end(); return;
          }
          html(loginForm); return;
        }
      }
      if (request.method === 'GET' && ['/', '/info/profil/meinetipprunden', `/${COMMUNITY}/tippabgabe`, `/${COMMUNITY}/tippspielplan`, `/${COMMUNITY}/tippuebersicht`, `/${OTHER_COMMUNITY}/tippabgabe`, `/${OTHER_COMMUNITY}/tippspielplan`].includes(pathname)) {
        if (failedGroup && pathname.startsWith(`/${failedGroup}/`)) { response.writeHead(500); response.end('Synthetic group failure'); return; }
        if (!account || (rejectReads && pathname !== '/' && pathname !== '/info/profil/meinetipprunden')) { response.writeHead(302, { Location: '/info/profil/login' }); response.end(); return; }
        if (pathname === '/' || pathname === '/info/profil/meinetipprunden') {
          html(`<div id="kicktipp-content"><a href="/${COMMUNITY}/">${COMMUNITY}</a><a href="/${OTHER_COMMUNITY}/">${OTHER_COMMUNITY}</a></div>`);
        } else if (pathname.endsWith('/tippabgabe')) {
          html(`<div id="kicktipp-content"><div class="pagetitle">Spieltag 1</div><table id="tippabgabeSpiele"><tbody><tr><td>${kickoff}</td><td>${account} Home</td><td>Away FC</td><td><input id="spieltipp_1_heimTipp" name="spieltipp[1].heimTipp" value=""><input id="spieltipp_1_gastTipp" name="spieltipp[1].gastTipp" value=""></td></tr></tbody></table></div>`);
        } else if (pathname.endsWith('/tippspielplan')) {
          html(`<div id="kicktipp-content"><table id="spiele"><tbody><tr><td>${kickoff}</td><td></td><td>${account} Home</td><td>Away FC</td><td></td></tr></tbody></table></div>`);
        } else html('<div id="kicktipp-content"><div class="pagetitle">Spieltag 1</div></div>');
        return;
      }
      unexpected.push(`${request.method} ${pathname}`); response.writeHead(500); response.end('Unexpected fixture request');
    });
    fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
    const fixtureOrigin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
    const port = await freePort();
    const first = await launch(configFile, fixtureOrigin, port);
    const adminTokenFile = path.join(directory, 'web-admin-token');
    const adminToken = fs.readFileSync(adminTokenFile, 'utf8').trim();
    expect(fs.statSync(adminTokenFile).mode & 0o777).toBe(0o600);
    let base = first.base;
    const admin = async (route: string, body?: unknown) => fetch(`${base}/api/admin/${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', Origin: base },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
    const getConfig = async () => { const response = await admin('config'); expect(response.status).toBe(200); return response.json(); };
    const save = async (body: object) => { const response = await admin('config', body); const data = await response.json(); expect(response.status, JSON.stringify(data)).toBe(200); return data; };
    const settled = async () => {
      let latest: any;
      await vi.waitFor(async () => {
        const response = await admin('overview'); expect(response.status).toBe(200); latest = await response.json();
        expect(latest.status.scheduler.lastSuccess).not.toBeNull();
        expect(latest.status.scheduler.nextCheck > latest.status.scheduler.lastCheck).toBe(true);
        expect(latest.report).not.toBeNull();
      }, { timeout: 5000, interval: 25 });
      return latest;
    };

    expect((await fetch(`${base}/`)).status).toBe(200);
    expect((await fetch(`${base}/app.js`)).status).toBe(200);
    expect((await fetch(`${base}/mcp`, { method: 'POST' })).status).toBe(503);
    const empty = await getConfig();
    expect(empty).toMatchObject({ configured: false, config: null });
    expect(fs.existsSync(configFile)).toBe(false);
    const login = await admin('account/check', { account: { email: 'first@example.invalid', password: PASSWORD, site: 'de' } });
    expect(await login.json()).toEqual({ communities: [COMMUNITY, OTHER_COMMUNITY] });
    expect(fs.existsSync(configFile)).toBe(false);
    expect(fs.existsSync(path.join(directory, 'accounts'))).toBe(false);

    rejectReads = true;
    let saved = await save({ revision: empty.revision, account: { email: 'first@example.invalid', password: PASSWORD, site: 'de', community: COMMUNITY } });
    expect(saved.config.notifications).toEqual({ channels: [], warnHours: [], everyMinutes: 15 });
    expect(saved.config.readOnly).toBe(true);
    expect(saved.config.account).toMatchObject({ email: 'first@example.invalid', hasPassword: true });
    expect(JSON.stringify(saved)).not.toContain(PASSWORD);
    const connectionResponse = await admin('connection');
    const connection = await connectionResponse.json();
    const token = connection.token;
    expect(token).not.toBe(adminToken);
    expect(connection).toMatchObject({ url: '/mcp', readOnly: true });
    expect(fs.statSync(configFile).mode & 0o777).toBe(0o600);
    expect((await fetch(`${base}/api/admin/config`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await fetch(`${base}/status`, { headers: { Authorization: `Bearer ${adminToken}` } })).status).toBe(401);
    await vi.waitFor(async () => {
      const failed = await (await admin('overview')).json();
      expect(failed.status.scheduler.lastError).toBe('auth_required');
    });
    rejectReads = false;
    const recovered = await (await admin('check', {})).json();
    expect(recovered.report.matches[0]).toMatchObject({ home: 'first Home', needsBet: true });
    expect(recovered.status.read).toMatchObject({ lastError: null, lastSuccess: expect.any(String) });
    expect(recovered.status.scheduler.lastError).toBe('auth_required');
    rejectReads = true;
    expect((await admin('check', {})).status).toBe(502);
    const manualFailure = await (await admin('overview')).json();
    expect(manualFailure.status.read).toMatchObject({ lastError: 'auth_required', lastSuccess: recovered.status.read.lastSuccess });
    expect(manualFailure.report).toBeNull();
    rejectReads = false;
    expect((await (await admin('check', {})).json()).status.read.lastError).toBeNull();
    expect(received).toHaveLength(0);

    // Terminal edits are pending until restart and must not be overwritten by
    // a browser whose revision still matches the active in-memory settings.
    const originalFile = fs.readFileSync(configFile, 'utf8');
    const externalEdit = JSON.parse(originalFile);
    externalEdit.timeZone = 'UTC';
    fs.writeFileSync(configFile, JSON.stringify(externalEdit));
    const diskConflict = await admin('config', { revision: saved.revision, readOnly: false });
    expect(diskConflict.status).toBe(409);
    expect(await diskConflict.json()).toEqual({ error: 'restart_required' });
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8')).timeZone).toBe('UTC');
    expect((await getConfig()).config.timeZone).toBe('Europe/Berlin');
    fs.writeFileSync(configFile, originalFile);

    const names = async () => (await rpc(base, token, 'tools/list')).result.tools.map((tool: { name: string }) => tool.name);
    expect(await names()).not.toContain('place_bets');
    const outdatedRevision = saved.revision;
    saved = await save({ revision: saved.revision, readOnly: false });
    expect(await names()).toContain('place_bets');
    const conflict = await admin('config', { revision: outdatedRevision, readOnly: true });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: 'config_conflict' });

    saved = await save({ revision: saved.revision, notifications: {
      channels: [{ id: 'local-webhook', kind: 'webhook', url: `${fixtureOrigin}/webhook/fixture-secret` }],
      warnHours: [0.5, 2.5], everyMinutes: 15,
    } });
    expect(saved.config.notifications.warnHours).toEqual([2.5, 0.5]);
    expect(saved.config.notifications.channels).toEqual([{ id: 'local-webhook', kind: 'webhook', hasSecret: true }]);
    expect(JSON.stringify(saved)).not.toContain('fixture-secret');
    expect(JSON.stringify(saved)).not.toContain(token);
    await settled();
    expect(received.filter(item => item.event === 'missing_tips')).toHaveLength(1);
    expect(received[0].warnHours).toBe(0.5);

    const beforeRead = received.length;
    const refreshed = await admin('check', {});
    expect(refreshed.status).toBe(200);
    expect((await refreshed.json()).report.matches[0].home).toBe('first Home');
    expect(received).toHaveLength(beforeRead);
    const test = await admin('notifications/test', { channel: { id: 'local-webhook', kind: 'webhook' }, language: 'en' });
    expect(await test.json()).toEqual({ ok: true });
    expect(received.at(-1)).toMatchObject({ event: 'test', summary: 'Kicktipp: Your notifications are working.' });
    saved = await save({ revision: saved.revision, account: { password: '' }, notifications: {
      channels: [{ id: 'local-webhook', kind: 'webhook', url: '' }], warnHours: [2.5, 0.5], everyMinutes: 15,
    } });
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8')).account.password).toBe(PASSWORD);
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8')).notifications.channels[0].url).toBe(`${fixtureOrigin}/webhook/fixture-secret`);
    await settled();
    expect(received.filter(item => item.event === 'missing_tips')).toHaveLength(1);

    const beforeCandidate = requests.length;
    const candidate = await admin('account/check', { account: { email: 'second@example.invalid', password: PASSWORD, site: 'de' } });
    expect(await candidate.json()).toEqual({ communities: [COMMUNITY, OTHER_COMMUNITY] });
    const stillFirst = await admin('check', {});
    expect((await stillFirst.json()).report.matches[0].home).toBe('first Home');
    expect((await getConfig()).config.account.email).toBe('first@example.invalid');
    expect(requests.slice(beforeCandidate).some(row => row.account === 'second')).toBe(true);

    // Activating another account must be transactional even when constructing
    // its scheduler fails before the new configuration can be committed.
    const secondIdentity = createHash('sha256').update('de:second@example.invalid').digest('hex').slice(0, 24);
    const candidateState = path.join(directory, 'accounts', secondIdentity, 'data', 'notifications.json');
    fs.mkdirSync(path.dirname(candidateState), { recursive: true });
    fs.writeFileSync(candidateState, 'corrupt-state-private-fixture-content', { mode: 0o600 });
    const configBeforeFailure = fs.readFileSync(configFile, 'utf8');
    const failedChange = await admin('config', { revision: saved.revision,
      account: { email: 'second@example.invalid', password: PASSWORD, community: COMMUNITY } });
    expect(failedChange.status).toBe(500);
    expect(await failedChange.json()).toEqual({ error: 'request_failed' });
    expect(fs.readFileSync(configFile, 'utf8')).toBe(configBeforeFailure);
    const afterFailure = await getConfig();
    expect(afterFailure.revision).toBe(saved.revision);
    expect(afterFailure.config.account.email).toBe('first@example.invalid');
    expect((await settled()).report.matches[0].home).toBe('first Home');
    const stillReadable = await admin('check', {});
    expect(stillReadable.status).toBe(200);
    expect((await stillReadable.json()).report.matches[0].home).toBe('first Home');
    expect(received.filter(item => item.event === 'missing_tips')).toHaveLength(1);
    expect(first.logs()).not.toContain('corrupt-state-private-fixture-content');

    // Repair only the synthetic account state, then retry the same revision.
    fs.rmSync(candidateState);
    const changedAt = requests.length;
    saved = await save({ revision: saved.revision, account: { email: 'second@example.invalid', password: PASSWORD, community: COMMUNITY } });
    expect((await settled()).report.matches[0].home).toBe('second Home');
    expect(requests.slice(changedAt).filter(row => row.account === 'first')).toEqual([]);
    expect(fs.readdirSync(path.join(directory, 'accounts'))).toHaveLength(2);
    expect(received.filter(item => item.event === 'missing_tips')).toHaveLength(2);
    expect(first.logs()).not.toContain(PASSWORD);
    expect(first.logs()).not.toContain(token);
    expect(first.logs()).not.toContain(adminToken);
    await first.stop();

    const restarted = await launch(configFile, fixtureOrigin, port);
    base = restarted.base;
    expect(fs.readFileSync(adminTokenFile, 'utf8').trim()).toBe(adminToken);
    const reloaded = await getConfig();
    expect(reloaded.config.notifications.warnHours).toEqual([2.5, 0.5]);
    expect(reloaded.config.account.email).toBe('second@example.invalid');
    expect(reloaded.revision).not.toBe(saved.revision);
    expect((await settled()).status.scheduler.deliveredCount).toBe(0);
    expect(received.filter(item => item.event === 'missing_tips')).toHaveLength(2);
    expect((await (await admin('connection')).json()).token).toBe(token);
    expect(unexpected).toEqual([]);
    expect(requests.filter(row => row.method === 'POST' && !['/info/profil/login', '/webhook/fixture-secret'].includes(row.pathname))).toEqual([]);
    expect(logins.filter(name => name === 'second')).toHaveLength(4); // isolated check, two save validations, and active account login
    // A discovered second group can be added live without replacing the primary.
    let multi = await save({ revision: reloaded.revision, account: {
      community: COMMUNITY, communities: [COMMUNITY, OTHER_COMMUNITY],
    } });
    const added = await settled();
    expect(added.reports.map((group: any) => group.community)).toEqual([COMMUNITY, OTHER_COMMUNITY]);
    expect(added.status.communities).toEqual([COMMUNITY, OTHER_COMMUNITY]);
    expect(added.report.community).toBe(COMMUNITY);
    expect(received.filter(item => item.event === 'missing_tips' && item.community === OTHER_COMMUNITY)).toHaveLength(1);
    // Failure in the second group must not turn the whole overview into an empty success.
    failedGroup = OTHER_COMMUNITY;
    const partial = await admin('check', {});
    expect(partial.status).toBe(200);
    const partialReport = await partial.json();
    expect(partialReport.report.matches[0].home).toBe('second Home');
    expect(partialReport.reports[1].readError).toBe('check_failed');
    expect(partialReport.status.groupErrors).toEqual([{ community: OTHER_COMMUNITY, code: 'check_failed' }]);
    failedGroup = null;
    multi = await save({ revision: multi.revision, account: { communities: [COMMUNITY] } });
    expect(multi.config.account.communities).toEqual([COMMUNITY]);
    expect((await settled()).reports.map((group: any) => group.community)).toEqual([COMMUNITY]);
    expect(received.filter(item => item.event === 'missing_tips')).toHaveLength(3);
    await restarted.stop();
  }, 30_000);
});
