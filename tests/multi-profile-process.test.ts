import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServiceConfig } from '../src/service/settings.js';

const TOKEN = 'multi-profile-fixture-token-at-least-32-characters';
const PASSWORD = 'multi-profile-password-local-fixture-only';
// Both accounts deliberately belong to the same pool: community-only scoping
// would leak one account's predictions, cached history and audit to the other.
const COMMUNITY = 'shared-pool';
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

async function launch(configFile: string, fixtureOrigin: string) {
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
      KICKTIPP_SERVICE_CONFIG: configFile, KICKTIPP_BASE_URL: fixtureOrigin, KICKTIPP_LANG: 'en',
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

async function rpc(base: string, method: string, params: object = {}) {
  const response = await fetch(`${base}/mcp`, { method: 'POST', signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text(); expect(response.status, text).toBe(200);
  return response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(text.split('\n').find(line => line.startsWith('data: '))!.slice(6)) : JSON.parse(text);
}

function toolData(reply: any): any {
  expect(reply.error, JSON.stringify(reply)).toBeUndefined();
  expect(reply.result?.isError, JSON.stringify(reply)).toBeFalsy();
  return reply.result.structuredContent.data;
}

function toolError(reply: any): string {
  expect(reply.result?.isError, JSON.stringify(reply)).toBe(true);
  return reply.result.content.map((content: { text?: string }) => content.text ?? '').join('\n');
}

describe('multiple profiles in one compiled service', () => {
  it('routes MCP, writes, cached resources and reminders independently and persists UI profile changes', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-multi-profile-'));
    const configFile = path.join(directory, 'service.json');
    const kickoff = printedKickoff();
    const received: { target: string; payload: any }[] = [];
    const requests: { method: string; pathname: string; account: string | null }[] = [];
    const unexpected: string[] = [];
    const stored = new Map<string, [string, string]>();
    const posts: { account: string; goals: [string, string] }[] = [];
    const form = (account: string, community = COMMUNITY) => {
      const goals = stored.get(account) ?? ['', ''];
      return `<div id="kicktipp-content"><div class="pagetitle">Spieltag 1</div>
        <form method="post" action="/${community}/tippabgabe"><input type="hidden" name="spieltagIndex" value="1">
        <table id="tippabgabeSpiele"><tbody><tr><td>${kickoff}</td><td>${account} Home</td><td>Away FC</td><td>
        <input id="spieltipp_1_heimTipp" name="spieltipp[1].heimTipp" value="${goals[0]}">
        <input id="spieltipp_1_gastTipp" name="spieltipp[1].gastTipp" value="${goals[1]}">
        </td></tr></tbody></table><button type="submit" name="submitbutton">Save</button></form></div>`;
    };
    fixture = createServer(async (request, response) => {
      const url = new URL(request.url!, 'http://localhost');
      const pathname = url.pathname;
      const account = request.headers.cookie?.match(/(?:^|;\s*)sid=(alice|bob)(?:;|$)/)?.[1] ?? null;
      requests.push({ method: request.method!, pathname, account });
      const html = (body: string) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(body); };
      if (pathname.startsWith('/webhook/') && request.method === 'POST') {
        let body = ''; for await (const chunk of request) body += String(chunk);
        received.push({ target: pathname.slice('/webhook/'.length), payload: JSON.parse(body) });
        response.writeHead(204); response.end(); return;
      }
      if (pathname === '/info/profil/login') {
        if (request.method === 'GET') {
          html('<form method="post" action="/info/profil/login"><input name="kennung"><input type="password" name="passwort"><button name="submitbutton" value="login">Login</button></form>'); return;
        }
        if (request.method === 'POST') {
          let body = ''; for await (const chunk of request) body += String(chunk);
          const login = new URLSearchParams(body); const name = login.get('kennung')?.split('@')[0];
          if ((name === 'alice' || name === 'bob') && login.get('passwort') === PASSWORD) {
            response.writeHead(302, { Location: '/', 'Set-Cookie': `sid=${name}; Path=/; HttpOnly` }); response.end(); return;
          }
        }
      }
      if (!account) { response.writeHead(302, { Location: '/info/profil/login' }); response.end(); return; }
      if (pathname === `/${COMMUNITY}/tippabgabe` && request.method === 'POST') {
        let body = ''; for await (const chunk of request) body += String(chunk);
        const fields = new URLSearchParams(body);
        const goals: [string, string] = [fields.get('spieltipp[1].heimTipp')!, fields.get('spieltipp[1].gastTipp')!];
        stored.set(account, goals); posts.push({ account, goals });
        html('Saved'); return;
      }
      if (request.method === 'GET') {
        if (pathname === '/' || pathname === '/info/profil/meinetipprunden') {
          html(`<div id="kicktipp-content"><a href="/${COMMUNITY}/">${COMMUNITY}</a><a href="/${account}-extra/">${account}-extra</a></div>`); return;
        }
        const community = pathname.split('/')[1];
        if ([COMMUNITY, `${account}-extra`].includes(community)) {
          const question = `${account} ${community} champion?`;
          if (pathname.endsWith('/tippabgabe') && url.searchParams.get('bonus') === 'true') {
            html(`<div id="kicktipp-content"><table id="tippabgabeFragen"><tbody><tr><td>1</td><td>${question}</td><td>
              <select name="tippabgabeFragenForms[101].tipp"><option value="-1" selected>---</option><option value="1">Home FC</option></select>
              </td></tr></tbody></table></div>`); return;
          }
          if (pathname.endsWith('/tippspielplan') && url.searchParams.get('bonus') === 'true') {
            html(`<div id="kicktipp-content"><table id="fragen"><thead><tr>
              <th name="wettbewerb">Wettbewerb</th><th name="termin">Termin</th><th name="tipptermin">Tipptermin</th><th name="frage">Frage</th>
              </tr></thead><tbody><tr><td>Fixture League</td><td>01.06.27 15:30</td><td>${kickoff}</td><td>${question}</td></tr></tbody></table></div>`); return;
          }
          if (pathname.endsWith('/tippabgabe')) { html(form(account, community)); return; }
        }
        if ([`/${COMMUNITY}/tippspielplan`, `/${account}-extra/tippspielplan`].includes(pathname)) {
          html(`<div id="kicktipp-content"><table id="spiele"><tbody><tr><td>${kickoff}</td><td></td><td>${account} Home</td><td>Away FC</td><td></td></tr></tbody></table></div>`); return;
        }
        if (pathname === `/${COMMUNITY}/tippuebersicht`) {
          html('<div id="kicktipp-content"><div class="pagetitle">Spieltag 1</div></div>'); return;
        }
        if (pathname === `/${COMMUNITY}/spielregeln`) {
          html(`<div id="kicktipp-content"><div class="pagecontent"><h2>Rules for ${account}</h2><p>Fixture scoring.</p></div></div>`); return;
        }
      }
      unexpected.push(`${request.method} ${pathname}`); response.writeHead(500); response.end('Unexpected fixture request');
    });
    fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
    const origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
    const config: ServiceConfig = {
      version: 2,
      server: { host: '127.0.0.1', port: await freePort(), token: TOKEN, allowedOrigins: [] },
      profiles: [
        { id: 'alice', name: 'Alice', account: { email: 'alice@example.invalid', password: PASSWORD, community: COMMUNITY, communities: [COMMUNITY, 'alice-extra'], site: 'de' },
          timeZone: 'Europe/Berlin', readOnly: false,
          notifications: { channels: [{ id: 'same-channel', kind: 'webhook', url: `${origin}/webhook/alice` }], warnHours: [1], everyMinutes: 15 } },
        { id: 'bob', name: 'Bob', account: { email: 'bob@example.invalid', password: PASSWORD, community: COMMUNITY, communities: [COMMUNITY, 'bob-extra'], site: 'de' },
          timeZone: 'UTC', readOnly: true,
          notifications: { channels: [{ id: 'same-channel', kind: 'webhook', url: `${origin}/webhook/bob` }], warnHours: [1], everyMinutes: 15 } },
      ],
    };
    fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
    const first = await launch(configFile, origin);
    let base = first.base;
    const adminToken = fs.readFileSync(path.join(directory, 'web-admin-token'), 'utf8').trim();
    const admin = async (route: string, body?: unknown) => {
      const response = await fetch(`${base}/api/admin/${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', Origin: base },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
      });
      const data = await response.json();
      return { status: response.status, data };
    };
    const overview = async (profile: string) => {
      const response = await admin(`overview?profile=${profile}`);
      expect(response.status, JSON.stringify(response.data)).toBe(200); return response.data;
    };
    const settled = async (profile: string) => {
      let latest: any;
      await vi.waitFor(async () => {
        latest = await overview(profile);
        expect(latest.status.scheduler.lastSuccess).not.toBeNull();
        expect(latest.status.scheduler.nextCheck > latest.status.scheduler.lastCheck).toBe(true);
        expect(latest.status.scheduler.lastError).toBeNull();
      }, { timeout: 5000, interval: 25 });
      return latest;
    };
    const initial = await Promise.all(['alice', 'bob'].map(settled));
    expect(initial.map(value => value.report.matches[0].home)).toEqual(['alice Home', 'bob Home']);
    expect(initial.map(value => value.report.timeZone)).toEqual(['Europe/Berlin', 'UTC']);
    expect(initial.map(value => value.reports.map((report: any) => report.community))).toEqual([
      [COMMUNITY, 'alice-extra'], [COMMUNITY, 'bob-extra'],
    ]);
    expect(received).toHaveLength(8);
    for (const account of ['alice', 'bob']) {
      const name = account === 'alice' ? 'Alice' : 'Bob';
      const own = received.filter(item => item.target === account);
      expect(own).toHaveLength(4);
      for (const item of own) {
        expect(item.payload.profile).toEqual({ id: account, name });
        expect(item.payload.summary.startsWith(`[${name}] `)).toBe(true);
      }
      for (const community of [COMMUNITY, `${account}-extra`]) {
        expect(own.find(item => item.payload.community === community && item.payload.event === 'missing_tips')?.payload)
          .toMatchObject({ matches: [{ home: `${account} Home` }] });
        expect(own.find(item => item.payload.community === community && item.payload.event === 'missing_bonus')?.payload)
          .toMatchObject({ bonusQuestions: [{ question: `${account} ${community} champion?`, missingAnswers: 1, editable: true }] });
      }
    }

    const initialized = await rpc(base, 'initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'multi-profile-fixture', version: '1' },
    });
    expect(initialized.result.instructions).toMatch(/get_profiles/);
    expect(initialized.result.instructions).toMatch(/profile/);
    const listing = toolData(await rpc(base, 'tools/call', { name: 'get_profiles', arguments: {} }));
    expect(listing.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'alice', name: 'Alice', community: COMMUNITY, read_only: false }),
      expect.objectContaining({ id: 'bob', name: 'Bob', community: COMMUNITY, read_only: true }),
    ]));
    expect(JSON.stringify(listing)).not.toContain(PASSWORD);
    expect(JSON.stringify(listing)).not.toContain(TOKEN);
    const allStatus = toolData(await rpc(base, 'tools/call', { name: 'get_status', arguments: {} }));
    expect(allStatus.profiles).toHaveLength(2);
    const tools = (await rpc(base, 'tools/list')).result.tools;
    expect(tools.find((tool: any) => tool.name === 'place_bets')).toBeDefined();
    for (const name of ['get_bets', 'get_deadline', 'sync_history', 'get_bet_log', 'place_bets', 'get_status']) {
      expect(tools.find((tool: any) => tool.name === name).inputSchema.properties.profile).toBeDefined();
    }

    const rejectedAt = requests.length;
    expect(toolError(await rpc(base, 'tools/call', { name: 'get_bets', arguments: {} }))).toMatch(/profile/i);
    expect(toolError(await rpc(base, 'tools/call', { name: 'get_bets', arguments: { profile: 'missing' } }))).toMatch(/profile/i);
    expect(toolError(await rpc(base, 'tools/call', { name: 'place_bets', arguments: { bets: ['alice Home vs Away FC=2:1'] } }))).toMatch(/profile/i);
    expect(requests).toHaveLength(rejectedAt);
    expect(toolError(await rpc(base, 'tools/call', { name: 'place_bets', arguments: { profile: 'bob', bets: ['bob Home vs Away FC=2:1'] } }))).toMatch(/read.only/i);
    expect(posts).toEqual([]);

    // These calls arrive at once. Even when the runtime serializes network work,
    // each call must finish under its requested profile rather than a sticky one.
    const batches = ['bob', 'alice', 'bob', 'alice'].map(profile => rpc(base, 'tools/call', { name: 'get_bets', arguments: { profile } }));
    const read = (await Promise.all(batches)).map(toolData);
    expect(read.map(data => data.matches[0].home)).toEqual(['bob Home', 'alice Home', 'bob Home', 'alice Home']);
    const placed = toolData(await rpc(base, 'tools/call', {
      name: 'place_bets', arguments: { profile: 'alice', bets: ['alice Home vs Away FC=2:1'], matchday: 1 },
    }));
    expect(placed.success).toBe(true);
    expect(posts).toEqual([{ account: 'alice', goals: ['2', '1'] }]);
    expect(stored.has('bob')).toBe(false);
    const audit = await Promise.all(['alice', 'bob'].map(profile => rpc(base, 'tools/call', { name: 'get_bet_log', arguments: { profile } })));
    expect(toolData(audit[0]).records).toHaveLength(1);
    expect(toolData(audit[1]).records).toEqual([]);

    for (const profile of ['alice', 'bob']) {
      expect(toolData(await rpc(base, 'tools/call', { name: 'sync_history', arguments: { profile, from: 1, to: 1 } })).fetched).toBe(1);
      const resource = await rpc(base, 'resources/read', { uri: `kicktipp://profiles/${profile}/${COMMUNITY}/rules` });
      expect(JSON.parse(resource.result.contents[0].text).data).toContainEqual({ type: 'heading', text: `Rules for ${profile}` });
    }
    const legacyResource = await rpc(base, 'resources/read', { uri: `kicktipp://${COMMUNITY}/rules` });
    expect(JSON.stringify(legacyResource)).toMatch(/profile/i);
    expect(legacyResource.error ?? legacyResource.result?.isError).toBeTruthy();

    // The selected UI profile owns blank-secret reuse and permission changes.
    let envelope = (await admin('config?profile=bob')).data;
    expect(envelope.profile).toBe('bob');
    expect(envelope.config.account.email).toBe('bob@example.invalid');
    const updated = await admin('config', { revision: envelope.revision, profile: 'bob', name: 'Bob private', readOnly: false });
    expect(updated.status, JSON.stringify(updated.data)).toBe(200);
    expect(updated.data.profile).toBe('bob');
    expect((await admin('config?profile=alice')).data.config.readOnly).toBe(false);
    const bobWrite = toolData(await rpc(base, 'tools/call', {
      name: 'place_bets', arguments: { profile: 'bob', bets: ['bob Home vs Away FC=1:0'], matchday: 1 },
    }));
    expect(bobWrite.success).toBe(true);
    expect(posts).toEqual([{ account: 'alice', goals: ['2', '1'] }, { account: 'bob', goals: ['1', '0'] }]);
    expect(toolData(await rpc(base, 'tools/call', { name: 'get_bet_log', arguments: { profile: 'alice' } })).records).toHaveLength(1);
    expect(toolData(await rpc(base, 'tools/call', { name: 'get_bet_log', arguments: { profile: 'bob' } })).records).toHaveLength(1);

    envelope = (await admin('config?profile=alice')).data;
    const added = await admin('profiles', { revision: envelope.revision, name: 'Alice second profile',
      account: { email: 'alice@example.invalid', password: PASSWORD, site: 'de', community: COMMUNITY } });
    expect(added.status, JSON.stringify(added.data)).toBe(200);
    const third = added.data.profile;
    expect(third).not.toBe('alice');
    expect(added.data.profiles).toHaveLength(3);
    expect(added.data.config.readOnly).toBe(true);
    expect(added.data.config.notifications.channels).toEqual([]);
    expect(toolData(await rpc(base, 'tools/call', { name: 'get_bet_log', arguments: { profile: third } })).records).toEqual([]);
    await settled(third);
    expect(received).toHaveLength(8);
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8')).profiles).toHaveLength(3);
    for (const secret of [PASSWORD, TOKEN, adminToken]) expect(first.logs()).not.toContain(secret);
    await first.stop();

    const restarted = await launch(configFile, origin); base = restarted.base;
    await Promise.all(['alice', 'bob', third].map(settled));
    expect(received).toHaveLength(8);
    const afterRestart = (await admin('config?profile=bob')).data;
    expect(afterRestart.profiles).toHaveLength(3);
    expect(afterRestart.config.account.email).toBe('bob@example.invalid');
    expect(afterRestart.config.readOnly).toBe(false);
    expect(afterRestart.config.account.communities).toEqual([COMMUNITY, 'bob-extra']);
    expect((await admin('config?profile=alice')).data.config.account.communities).toEqual([COMMUNITY, 'alice-extra']);
    expect(afterRestart.profiles.find((profile: any) => profile.id === 'bob').name).toBe('Bob private');
    expect((await admin('connection')).data.token).toBe(TOKEN);
    expect(toolData(await rpc(base, 'tools/call', { name: 'get_bet_log', arguments: { profile: 'alice' } })).records).toHaveLength(1);
    expect(toolData(await rpc(base, 'tools/call', { name: 'get_bet_log', arguments: { profile: third } })).records).toEqual([]);
    const removal = await admin('profiles/remove', { revision: afterRestart.revision, profile: third });
    expect(removal.status, JSON.stringify(removal.data)).toBe(200);
    expect(removal.data.profiles).toHaveLength(2);
    expect(toolError(await rpc(base, 'tools/call', { name: 'get_bets', arguments: { profile: third } }))).toMatch(/profile/i);
    expect(unexpected).toEqual([]);
    await restarted.stop();
  }, 45_000);
});
