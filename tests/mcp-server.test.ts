import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'node:http';

/**
 * Drives the built server over stdio, the same way a client would. This is
 * the regression test for tool registration: a schema mistake shows up here
 * and nowhere else.
 */
function callServer(requests: object[], env: Record<string, string> = {}): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ...env };
    if (env.HOME && env.USERPROFILE === undefined) childEnv.USERPROFILE = env.HOME;
    const child = spawn('node', ['dist/server.js'], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.on('error', reject);
    child.on('close', () => {
      const messages = out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      resolve(messages);
    });
    child.stdin.end(requests.map((r) => JSON.stringify(r)).join('\n') + '\n');
  });
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  },
};

let home: string;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-mcp-'));
  fs.mkdirSync(path.join(home, '.config', 'kicktipp-agent'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config', 'kicktipp-agent', 'config.ini'),
    '[auth]\nemail = a@b.c\npassword = x\n[community]\nname = mycomm\n[player]\nname = Me\n',
  );
});

describe('the MCP server as a client sees it', () => {
  it('serializes concurrent operations and renews expired sessions without prompting', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-mcp-concurrent-'));
    fs.writeFileSync(path.join(root, 'config.ini'), '[auth]\nemail = test@example.com\npassword = test\n[community]\nname = family\n');
    fs.writeFileSync(path.join(root, 'session.json'), JSON.stringify({
      cookies: [{ name: 'sid', value: '0', domain: '127.0.0.1' }],
    }));
    let sessionGeneration = 0;
    const loginBodies: URLSearchParams[] = [];
    let active = 0;
    let maxActive = 0;
    const visited: string[] = [];
    const site = http.createServer(async (req, res) => {
      active++;
      maxActive = Math.max(maxActive, active);
      const url = new URL(req.url!, 'http://127.0.0.1');
      visited.push(url.pathname + url.search);
      // Keep navigation in flight long enough for concurrent MCP requests to overlap.
      await new Promise(resolve => setTimeout(resolve, 40));
      let html: string;
      if (url.pathname === '/info/profil/login') {
        if (req.method === 'POST') {
          let body = '';
          for await (const chunk of req) body += chunk.toString();
          loginBodies.push(new URLSearchParams(body));
          res.writeHead(302, { location: '/info/profil/meinetipprunden', 'set-cookie': `sid=${sessionGeneration}; Path=/` });
          html = '';
        } else {
          html = '<form method="post"><input name="kennung"><input name="passwort" type="password"><button type="submit">Login</button></form>';
        }
      } else if (req.headers.cookie !== `sid=${sessionGeneration}`) {
        res.writeHead(302, { location: '/info/profil/login' });
        html = '';
      } else if (url.pathname === '/info/profil/meinetipprunden') {
        html = '<a href="/family/">family</a><a href="/office/">office</a>';
      } else if (url.pathname.endsWith('/tippuebersicht')) {
        html = '<table id="ranking"><tbody><tr><td><div class="mg_name">Alice</div></td></tr></tbody></table>';
      } else if (url.pathname.endsWith('/tippabgabe')) {
        html = '<form><table id="tippabgabeSpiele"><tbody><tr><td>10.09.30 20:30</td><td>Bayern</td><td>Dortmund</td><td>'
          + '<input id="one_heimTipp" name="home"><input id="one_gastTipp" name="away"></td><td></td></tr></tbody></table></form>';
      } else if (url.searchParams.get('spieltagIndex') === '3') {
        res.statusCode = 503;
        html = 'Temporarily unavailable';
      } else {
        html = `<div class="pagetitle">${url.pathname.split('/')[1]}: Spieltag ${url.searchParams.get('spieltagIndex')}</div>`;
      }
      active--;
      res.end(`<div id="kicktipp-content">${html}</div>`);
    });
    await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
    const address = site.address();
    if (!address || typeof address === 'string') throw new Error('Missing test site address');
    const child = spawn(process.execPath, ['dist/server.js'], {
      env: { ...process.env, HOME: root, USERPROFILE: root, KICKTIPP_CONFIG_DIR: root, KICKTIPP_DATA_DIR: root,
        KICKTIPP_BASE_URL: `http://127.0.0.1:${address.port}`, KICKTIPP_EMAIL: '', KICKTIPP_PASSWORD: '',
        KICKTIPP_COMMUNITY: '', KICKTIPP_PROFILE: '', KICKTIPP_READ_ONLY: '0' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let nextId = 10;
    const pending = new Map<number, (message: any) => void>();
    let output = '';
    child.stdout.on('data', chunk => {
      output += String(chunk);
      let newline: number;
      while ((newline = output.indexOf('\n')) >= 0) {
        const message = JSON.parse(output.slice(0, newline));
        output = output.slice(newline + 1);
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    });
    const rpc = (method: string, params: object) => new Promise<any>(resolve => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    const call = (name: string, args: object = {}) => rpc('tools/call', { name, arguments: args });
    try {
      await rpc('initialize', INIT.params);
      expect((await call('get_communities')).result.structuredContent.data).toEqual(['family', 'office']);
      // The persistent Page already exists; all these requests now compete for it.
      const results = await Promise.all([
        call('get_schedule', { matchday: 1 }),
        call('get_schedule', { matchday: 2 }),
        call('place_bets', { bets: ['Bayern vs Dortmund=2:1'], dry_run: true }),
        call('set_community', { name: 'office' }),
        call('get_schedule', { matchday: 3 }),
        call('get_schedule', { matchday: 4 }),
      ]);
      expect(results[0].result.structuredContent.data.title).toBe('family: Spieltag 1');
      expect(results[1].result.structuredContent.data.title).toBe('family: Spieltag 2');
      expect(results[2].result.structuredContent.data).toMatchObject({ success: true, dry_run: true });
      expect(results[3].result.structuredContent.data).toMatchObject({ success: true, community: 'office' });
      expect(results[4].result.isError).toBe(true);
      expect(results[5].result.structuredContent.data.title).toBe('office: Spieltag 4');
      expect(maxActive).toBe(1);
      expect(visited).toContain('/family/tippabgabe');

      // Expire the cached Page twice while keeping the same MCP process alive.
      sessionGeneration++;
      expect((await call('get_communities')).result.structuredContent?.data).toEqual(['family', 'office']);
      expect(loginBodies).toHaveLength(1);
      sessionGeneration++;
      expect((await call('get_players')).result.structuredContent?.data).toEqual(['Alice']);
      expect(loginBodies).toHaveLength(2);
      for (const body of loginBodies) {
        expect(body.get('kennung')).toBe('test@example.com');
        expect(body.get('passwort')).toBe('test');
      }
    } finally {
      child.kill();
      await new Promise<void>(resolve => { site.close(() => resolve()); site.closeAllConnections(); });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('lists every tool with an input and output schema', async () => {
    const messages = await callServer([INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }], {
      HOME: home,
    });
    const tools = messages.find((m) => m.id === 2)?.result?.tools ?? [];
    expect(tools.length).toBeGreaterThan(20);
    for (const tool of tools) {
      expect(tool, `${tool.name} input`).toHaveProperty('inputSchema');
      expect(tool, `${tool.name} output`).toHaveProperty('outputSchema');
      expect(tool.description?.length ?? 0).toBeGreaterThan(20);
    }
    expect(tools.map((tool: { name: string }) => tool.name).filter((name: string) =>
      name.startsWith('get_service_') || name === 'list_notification_targets'))
      .toEqual(['get_service_status', 'get_service_health', 'list_notification_targets']);
  });

  it('exposes exactly three summary-only local Service reads without private content', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-mcp-service-'));
    const configDir = path.join(root, 'config');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    const jobId = '9e90818e-a71f-472c-b4ad-c82f67f5195c';
    const groupId = 'a'.repeat(64);
    const notificationId = 'b'.repeat(64);
    const participant = 'Private Participant MCP Canary';
    const message = 'Private notification MCP canary';
    const secretReference = 'MCP_PRIVATE_WEBHOOK';
    fs.writeFileSync(path.join(configDir, 'service.json'), JSON.stringify({
      schemaVersion: 1,
      job: {
        id: jobId,
        name: 'community-reminder',
        enabled: true,
        profileId: 'service-profile',
        communityId: 'family',
        language: 'en',
        displayTimezone: 'Europe/Berlin',
        policy: {
          excludeParticipantIds: [],
          stages: [{ beforeDeadlineMinutes: 60, severity: 'urgent' }],
        },
        targetIds: ['family-hook'],
      },
      targets: [{ id: 'family-hook', enabled: true, provider: 'webhook', urlRef: `env:${secretReference}` }],
    }), { mode: 0o600 });
    fs.writeFileSync(path.join(dataDir, 'service-state.json'), JSON.stringify({
      schemaVersion: 1,
      jobId,
      initializedAt: new Date().toISOString(),
      stageOutcomes: [],
      notifications: [{
        id: notificationId,
        jobId,
        createdAt: new Date().toISOString(),
        language: 'en',
        displayTimezone: 'Europe/Berlin',
        content: { schemaVersion: 1, type: 'reminder', severity: 'urgent', title: message, message },
        deadlineGroup: { id: groupId, deadlineAt: '2099-09-04T18:00:00.000Z', gameIds: ['game-a'] },
        stage: '60',
        missingParticipants: [{ id: 'private-id', displayName: participant }],
      }],
      deliveries: [],
      attempts: [],
      scheduler: {
        kicktippNetworkFailures: 0,
        lastScheduleFetchAt: new Date().toISOString(),
        lastReliableCheckAt: new Date().toISOString(),
        reminderCapabilityAvailable: true,
        sessionCondition: 'authenticated',
        deadlineGroupId: groupId,
        nextDeadlineAt: '2099-09-04T18:00:00.000Z',
      },
    }), { mode: 0o600 });
    fs.writeFileSync(path.join(dataDir, 'service.lock'), JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      token: 'mcp-test',
    }), { mode: 0o600 });

    try {
      const messages = await callServer([
        INIT,
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_service_status', arguments: {} } },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_service_health', arguments: {} } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_notification_targets', arguments: {} } },
      ], { HOME: home, KICKTIPP_CONFIG_DIR: configDir, KICKTIPP_DATA_DIR: dataDir });
      const results = [2, 3, 4].map((id) => messages.find((item) => item.id === id)?.result?.structuredContent?.data);
      expect(results[0]).toMatchObject({ readable: true, notifications: [{ missingParticipantCount: 1 }] });
      expect(results[1]).toMatchObject({ status: 'healthy' });
      expect(results[2]).toMatchObject({ readable: true, targets: [{ secrets: [{ sourceClass: 'env' }] }] });
      const encoded = JSON.stringify(results);
      expect(encoded).not.toContain(participant);
      expect(encoded).not.toContain(message);
      expect(encoded).not.toContain(secretReference);
      expect(encoded).not.toContain('env:');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('answers a tool call with both text and structured content', async () => {
    const messages = await callServer(
      [INIT, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_status', arguments: {} } }],
      { HOME: home },
    );
    const result = messages.find((m) => m.id === 2)?.result;
    expect(result.isError).toBeFalsy();
    expect(result.content[0].type).toBe('text');
    // Text stays parseable on its own for clients that ignore structure.
    expect(() => JSON.parse(result.content[0].text)).not.toThrow();
    expect(result.structuredContent.data).toMatchObject({ community: 'mycomm', player: 'Me' });
    expect(result.structuredContent.data.notify).toMatchObject({ kind: 'desktop' });
    expect(result.structuredContent.data.setup_url).toBeNull();
    expect(result.structuredContent.data).not.toHaveProperty('password');
  });

  it('connect_account reports already connected when credentials exist', async () => {
    const messages = await callServer(
      [INIT, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'connect_account', arguments: {} } }],
      { HOME: home },
    );
    const data = messages.find((m) => m.id === 2)?.result?.structuredContent?.data;
    expect(data.connected).toBe(true);
    expect(data.setup_url).toBeNull();
    expect(data.community).toBe('mycomm');
  });

  it('offers the cached-data resources', async () => {
    const messages = await callServer(
      [INIT, { jsonrpc: '2.0', id: 2, method: 'resources/templates/list', params: {} }],
      { HOME: home },
    );
    const templates = messages.find((m) => m.id === 2)?.result?.resourceTemplates ?? [];
    expect(templates.map((t: { uriTemplate: string }) => t.uriTemplate)).toEqual([
      'kicktipp://{community}/rules',
      'kicktipp://{community}/leaderboard/{matchday}',
      'kicktipp://{community}/schedule/{matchday}',
    ]);
  });

  it('reports an empty cache from a resource instead of going to the network', async () => {
    const messages = await callServer(
      [
        INIT,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'resources/read',
          params: { uri: 'kicktipp://mycomm/schedule/7' },
        },
      ],
      { HOME: home, KICKTIPP_DATA_DIR: path.join(home, 'empty-cache') },
    );
    const payload = JSON.parse(messages.find((m) => m.id === 2).result.contents[0].text);
    expect(payload.error).toBe('not_cached');
  });

  it('hides the mutating tools in read-only mode', async () => {
    const messages = await callServer([INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }], {
      HOME: home,
      KICKTIPP_READ_ONLY: '1',
    });
    const names = (messages.find((m) => m.id === 2)?.result?.tools ?? []).map(
      (t: { name: string }) => t.name,
    );
    for (const mutating of ['place_bets', 'place_bonus_bets', 'set_community', 'set_player', 'set_notify']) {
      expect(names).not.toContain(mutating);
    }
    expect(names).toContain('get_status');
  });

  it('lets set_notify write the local [notify] section', async () => {
    const messages = await callServer(
      [
        INIT,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'set_notify',
            arguments: { kind: 'webhook', target: 'https://ntfy.sh/kicktipp-tests' },
          },
        },
      ],
      { HOME: home },
    );
    const result = messages.find((m) => m.id === 2)?.result;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.data).toMatchObject({
      success: true,
      kind: 'webhook',
      target: 'https://ntfy.sh/kicktipp-tests',
    });
    const ini = fs.readFileSync(path.join(home, '.config', 'kicktipp-agent', 'config.ini'), 'utf8');
    expect(ini).toMatch(/kind\s*=\s*webhook/);
    expect(ini).toMatch(/kicktipp-tests/);
  });

  it('returns a localhost setup link when nothing is configured', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-mcp-empty-'));
    try {
      const messages = await callServer(
        [INIT, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_status', arguments: {} } }],
        {
          HOME: empty,
          USERPROFILE: empty,
          KICKTIPP_EMAIL: '',
          KICKTIPP_PASSWORD: '',
          KICKTIPP_COMMUNITY: '',
        },
      );
      const result = messages.find((m) => m.id === 2)?.result;
      expect(result.isError).toBeFalsy();
      const data = result.structuredContent.data;
      expect(data.setup_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/setup\?token=[0-9a-f]+$/);
      expect(data.setup_needed).toBe(true);
      expect(JSON.stringify(data)).not.toMatch(/"password"/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('connect_account is the setup tool and stays available in read-only mode', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-mcp-connect-'));
    try {
      const listed = await callServer([INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }], {
        HOME: empty,
        USERPROFILE: empty,
        KICKTIPP_EMAIL: '',
        KICKTIPP_PASSWORD: '',
        KICKTIPP_READ_ONLY: '1',
      });
      const names = (listed.find((m) => m.id === 2)?.result?.tools ?? []).map((t: { name: string }) => t.name);
      expect(names).toContain('connect_account');

      const called = await callServer(
        [INIT, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'connect_account', arguments: {} } }],
        {
          HOME: empty,
          USERPROFILE: empty,
          KICKTIPP_EMAIL: '',
          KICKTIPP_PASSWORD: '',
          KICKTIPP_COMMUNITY: '',
        },
      );
      const data = called.find((m) => m.id === 2)?.result?.structuredContent?.data;
      expect(data.connected).toBe(false);
      expect(data.setup_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/setup\?token=[0-9a-f]+$/);
      expect(data.message).toMatch(/open/i);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
