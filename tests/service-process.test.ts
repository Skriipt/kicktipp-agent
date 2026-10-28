import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServiceConfig } from '../src/service/settings.js';

const TOKEN = 'local-process-test-token-with-thirty-two-characters';
const PASSWORD = 'fixture-password-never-used-outside-local-server';
const COMMUNITY = 'process-fixture';
const OTHER_COMMUNITY = 'second-process-fixture';
const processes = new Set<ChildProcess>();
let fixture: Server | undefined;
let directory: string | undefined;

afterEach(async () => {
  for (const child of processes) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  processes.clear();
  fixture?.closeAllConnections();
  if (fixture?.listening) await new Promise<void>((resolve) => fixture!.close(() => resolve()));
  fixture = undefined;
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function printedKickoff(): string {
  const instant = new Date(Date.now() + 30 * 60_000);
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(instant);
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${value('day')}.${value('month')}.${value('year')} ${value('hour')}:${value('minute')}`;
}

async function launch(configFile: string, fixtureOrigin: string) {
  const guard = path.join(path.dirname(configFile), 'local-fetch-only.mjs');
  fs.writeFileSync(guard, `
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const address = input instanceof Request ? input.url : String(input);
  if (new URL(address).origin !== process.env.KICKTIPP_BASE_URL) {
    throw new Error('Integration fixture blocked a non-local HTTP request');
  }
  return nativeFetch(input, init);
};
`);
  const child = spawn(process.execPath, ['--import', guard, 'dist/service/main.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      KICKTIPP_SERVICE_CONFIG: configFile,
      KICKTIPP_BASE_URL: fixtureOrigin,
      KICKTIPP_LANG: 'en',
      HOME: path.dirname(configFile),
      USERPROFILE: path.dirname(configFile),
    },
  });
  processes.add(child);
  let output = '';
  let stderr = '';
  child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Service did not start. ${stderr}`)), 10_000);
    const onExit = (code: number | null, signal: string | null) => {
      clearTimeout(timer);
      reject(new Error(`Service exited before startup (${code}/${signal}). ${stderr}`));
    };
    child.once('exit', onExit);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.stdout!.on('data', (chunk) => {
      output += String(chunk);
      const match = output.match(/listening on port (\d+)/);
      if (!match) return;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(`http://127.0.0.1:${match[1]}`);
    });
  });
  return {
    base,
    logs: () => output + stderr,
    async stop() {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        const [code, signal] = await exited;
        expect(signal, stderr).toBeNull();
        expect(code, stderr).toBe(0);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function rpc(base: string, method: string, params: object = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.text();
  expect(response.status, body).toBe(200);
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    return JSON.parse(body.split('\n').find((line) => line.startsWith('data: '))!.slice(6));
  }
  return JSON.parse(body);
}

async function settledStatus(base: string): Promise<any> {
  let status: any;
  await vi.waitFor(async () => {
    const response = await fetch(`${base}/status`, {
      headers: { Authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(2000),
    });
    expect(response.status).toBe(200);
    status = await response.json();
    expect(status.scheduler.lastSuccess).not.toBeNull();
    expect(status.scheduler.nextCheck > status.scheduler.lastCheck).toBe(true);
  }, { timeout: 5000, interval: 25 });
  return status;
}

describe('the compiled service process', () => {
  it('delivers scheduled reminders, survives restart and isolates a changed account', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-service-process-'));
    const configFile = path.join(directory, 'service.json');
    const kickoff = printedKickoff();
    const received: any[] = [];
    const logins: string[] = [];
    const requests: { method: string; pathname: string; account: string | null }[] = [];
    const unexpected: string[] = [];
    fixture = createServer(async (request, response) => {
      const url = new URL(request.url!, 'http://localhost');
      const pathname = url.pathname;
      const account = request.headers.cookie?.match(/(?:^|;\s*)sid=(first|second)(?:;|$)/)?.[1] ?? null;
      requests.push({ method: request.method!, pathname, account });
      const html = (body: string) => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(body);
      };
      if (pathname === '/webhook' && request.method === 'POST') {
        let body = '';
        for await (const chunk of request) body += String(chunk);
        received.push(JSON.parse(body));
        response.writeHead(204);
        response.end();
        return;
      }
      if (pathname === '/info/profil/login') {
        if (request.method === 'GET') {
          html('<form method="post" action="/info/profil/login"><input name="kennung"><input type="password" name="passwort"><button name="submitbutton" value="login">Login</button></form>');
          return;
        }
        if (request.method === 'POST') {
          let body = '';
          for await (const chunk of request) body += String(chunk);
          const form = new URLSearchParams(body);
          const name = form.get('kennung')?.split('@')[0];
          if ((name === 'first' || name === 'second') && form.get('passwort') === PASSWORD) {
            logins.push(name);
            response.writeHead(302, { Location: '/', 'Set-Cookie': `sid=${name}; Path=/; HttpOnly` });
            response.end();
            return;
          }
        }
      }
      if (request.method === 'GET' && ['/', '/info/profil/meinetipprunden', `/${COMMUNITY}/tippabgabe`, `/${COMMUNITY}/tippspielplan`, `/${COMMUNITY}/tippuebersicht`, `/${COMMUNITY}/spielregeln`, `/${OTHER_COMMUNITY}/tippabgabe`, `/${OTHER_COMMUNITY}/tippspielplan`].includes(pathname)) {
        if (!account) {
          response.writeHead(302, { Location: '/info/profil/login' });
          response.end();
          return;
        }
        if (pathname === '/' || pathname === '/info/profil/meinetipprunden') {
          html(`<div id="kicktipp-content"><a href="/${COMMUNITY}/">${COMMUNITY}</a></div>`);
        } else if (pathname.endsWith('/tippabgabe') && url.searchParams.get('bonus') === 'true') {
          html(`<div id="kicktipp-content"><table id="tippabgabeFragen"><tbody>
            <tr><td>1</td><td>Wer wird Meister?</td><td>
            <select name="tippabgabeFragenForms[101].tipp"><option value="-1" selected>---</option><option value="1">Home FC</option></select>
            </td></tr></tbody></table></div>`);
        } else if (pathname.endsWith('/tippspielplan') && url.searchParams.get('bonus') === 'true') {
          html(`<div id="kicktipp-content"><table id="fragen"><thead><tr>
            <th name="wettbewerb">Wettbewerb</th><th name="termin">Termin</th><th name="tipptermin">Tipptermin</th><th name="frage">Frage</th>
            </tr></thead><tbody><tr><td>Fixture League</td><td>01.06.27 15:30</td><td>${kickoff}</td><td>Wer wird Meister?</td></tr></tbody></table></div>`);
        } else if (pathname.endsWith('/tippabgabe')) {
          html(`<div id="kicktipp-content"><div class="pagetitle">Spieltag 1</div>
            <table id="tippabgabeSpiele"><tbody><tr><td>${kickoff}</td><td>Home FC</td><td>Away FC</td><td>
            <input id="spieltipp_1_heimTipp" name="spieltipp[1].heimTipp" value="">
            <input id="spieltipp_1_gastTipp" name="spieltipp[1].gastTipp" value="">
            </td></tr></tbody></table></div>`);
        } else if (pathname.endsWith('/tippspielplan')) {
          html(`<div id="kicktipp-content"><table id="spiele"><tbody><tr><td>${kickoff}</td><td></td><td>Home FC</td><td>Away FC</td><td></td></tr></tbody></table></div>`);
        } else if (pathname.endsWith('/spielregeln')) {
          html(`<div id="kicktipp-content"><div class="pagecontent"><h2>Rules for ${account}</h2><p>Fixture scoring.</p></div></div>`);
        } else {
          html('<div id="kicktipp-content"><div class="pagetitle">Spieltag 1</div></div>');
        }
        return;
      }
      unexpected.push(`${request.method} ${pathname}`);
      response.writeHead(500);
      response.end('Unexpected fixture request');
    });
    fixture.listen(0, '127.0.0.1');
    await once(fixture, 'listening');
    const fixtureOrigin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
    const config: ServiceConfig = {
      version: 1,
      account: { email: 'first@example.invalid', password: PASSWORD, community: COMMUNITY, communities: [COMMUNITY, OTHER_COMMUNITY], site: 'de' },
      server: { host: '127.0.0.1', port: await freePort(), token: TOKEN, readOnly: true, allowedOrigins: [] },
      notifications: { channels: [{ id: 'local-webhook', kind: 'webhook', url: `${fixtureOrigin}/webhook` }], warnHours: [6, 1], everyMinutes: 1 },
      timeZone: 'Europe/Berlin',
    };
    const saveConfig = () => fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
    saveConfig();

    const first = await launch(configFile, fixtureOrigin);
    expect(await (await fetch(`${first.base}/health`)).json()).toEqual({ status: 'ok' });
    expect((await fetch(`${first.base}/status`)).status).toBe(401);
    expect((await fetch(`${first.base}/mcp`, { method: 'POST' })).status).toBe(401);
    const firstStatus = await settledStatus(first.base);
    expect(firstStatus).toMatchObject({ community: COMMUNITY, readOnly: true, scheduler: { running: true, lastError: null, deliveredCount: 4 } });
    expect(received).toHaveLength(4);
    expect(received[0]).toMatchObject({ event: 'missing_tips', community: COMMUNITY, warnHours: 1, matches: [{ home: 'Home FC', away: 'Away FC', needsBet: true }] });
    expect(received[1]).toMatchObject({ event: 'missing_bonus', community: COMMUNITY, warnHours: 1,
      bonusQuestions: [{ question: 'Wer wird Meister?', missingAnswers: 1, editable: true }] });
    expect(received[2]).toMatchObject({ event: 'missing_tips', community: OTHER_COMMUNITY });
    expect(received[3]).toMatchObject({ event: 'missing_bonus', community: OTHER_COMMUNITY });
    const initialized = await rpc(first.base, 'initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'process-fixture', version: '1' },
    });
    expect(initialized.result.serverInfo.name).toBe('kicktipp');
    const tools = (await rpc(first.base, 'tools/list')).result.tools.map((tool: { name: string }) => tool.name);
    expect(tools).toContain('get_bets');
    expect(tools).toContain('list_members');
    expect(tools).not.toContain('place_bets');
    const sync = await rpc(first.base, 'tools/call', { name: 'sync_history', arguments: { from: 1, to: 1 } });
    expect(sync.result.isError).toBeFalsy();
    expect(sync.result.structuredContent.data.fetched).toBe(1);
    const readRules = (base: string) => rpc(base, 'resources/read', { uri: `kicktipp://${COMMUNITY}/rules` });
    const cached = JSON.parse((await readRules(first.base)).result.contents[0].text);
    expect(cached.data).toContainEqual({ type: 'heading', text: 'Rules for first' });
    expect(logins).toEqual(['first']);
    expect(first.logs()).not.toContain(PASSWORD);
    expect(first.logs()).not.toContain(TOKEN);
    const firstAccount = fs.readdirSync(path.join(directory, 'accounts'));
    expect(firstAccount).toHaveLength(1);
    await first.stop();

    const restarted = await launch(configFile, fixtureOrigin);
    const restartedStatus = await settledStatus(restarted.base);
    expect(restartedStatus.scheduler).toMatchObject({ lastError: null, deliveredCount: 0 });
    expect(received).toHaveLength(4);
    expect(logins).toEqual(['first']);
    expect(JSON.parse((await readRules(restarted.base)).result.contents[0].text).data).toEqual(cached.data);
    await restarted.stop();

    config.account.email = 'second@example.invalid';
    saveConfig();
    const secondStartRequest = requests.length;
    const second = await launch(configFile, fixtureOrigin);
    const secondStatus = await settledStatus(second.base);
    expect(secondStatus.scheduler).toMatchObject({ lastError: null, deliveredCount: 4 });
    expect(logins).toEqual(['first', 'second']);
    expect(received).toHaveLength(8);
    expect(requests.slice(secondStartRequest).filter((request) => request.account === 'first')).toEqual([]);
    expect(JSON.parse((await readRules(second.base)).result.contents[0].text)).toMatchObject({ error: 'not_cached' });
    const secondSync = await rpc(second.base, 'tools/call', { name: 'sync_history', arguments: { from: 1, to: 1 } });
    expect(secondSync.result.isError).toBeFalsy();
    expect(JSON.parse((await readRules(second.base)).result.contents[0].text).data).toContainEqual({ type: 'heading', text: 'Rules for second' });
    expect(fs.readdirSync(path.join(directory, 'accounts'))).toHaveLength(2);
    const firstSessionFiles = fs.readdirSync(path.join(directory, 'accounts', firstAccount[0], 'config'));
    expect(firstSessionFiles.filter((name) => /^session-[a-f0-9]{64}\.json$/.test(name))).toHaveLength(1);
    expect(unexpected).toEqual([]);
    await second.stop();
  }, 30_000);
});
