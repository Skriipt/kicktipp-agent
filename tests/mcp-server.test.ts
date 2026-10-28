import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createServer } from 'node:http';

/**
 * Drives the built server over stdio, the same way a client would. This is
 * the regression test for tool registration: a schema mistake shows up here
 * and nowhere else.
 */
function callServer(requests: object[], env: Record<string, string> = {}, entry = 'dist/server.js'): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ...env };
    if (env.HOME && env.USERPROFILE === undefined) childEnv.USERPROFILE = env.HOME;
    const child = spawn('node', [entry], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const pending = new Set(requests.flatMap((request) => 'id' in request ? [request.id] : []));
    const messages: any[] = [];
    let buffer = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`MCP server timed out waiting for response IDs: ${[...pending].join(', ')}`));
    }, 4_000);
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          clearTimeout(timeout);
          child.kill('SIGKILL');
          reject(new Error('MCP server wrote non-JSON output to stdout.'));
          return;
        }
        messages.push(message);
        if ('id' in message) pending.delete(message.id);
      }
      // EOF closes the SDK transport. Keep it open until asynchronous network
      // tools have responded, just as an MCP client would.
      if (!pending.size) child.stdin.end();
    });
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', () => {
      clearTimeout(timeout);
      if (pending.size) reject(new Error(`MCP server exited before response IDs: ${[...pending].join(', ')}`));
      else resolve(messages);
    });
    child.stdin.write(requests.map((r) => JSON.stringify(r)).join('\n') + '\n');
    if (!pending.size) child.stdin.end();
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
  it('starts through an npm-style symlink and lists configured tools without contacting Kicktipp', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-mcp-linked-'));
    let requests = 0;
    const fixture = createServer((_request, response) => { requests++; response.writeHead(500).end(); });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    try {
      const link = path.join(directory, 'kicktipp-mcp');
      fs.symlinkSync(path.resolve('dist/server.js'), link);
      const config = path.join(directory, 'service.json');
      fs.writeFileSync(config, JSON.stringify({
        version: 1,
        account: { email: 'fixture@example.invalid', password: 'fixture-password', community: 'linked-community', site: 'de' },
        server: { token: 'x'.repeat(32), host: '127.0.0.1', port: 8787, readOnly: false, allowedOrigins: [] },
        notifications: { channels: [], warnHours: [6], everyMinutes: 15 },
        timeZone: 'Europe/Berlin',
      }));
      const address = fixture.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture address.');
      const messages = await callServer([
        INIT,
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_status', arguments: {} } },
      ], {
        HOME: directory, KICKTIPP_SERVICE_CONFIG: config, KICKTIPP_DATA_DIR: directory,
        KICKTIPP_BASE_URL: `http://127.0.0.1:${address.port}`,
      }, link);
      expect(messages.find((message) => message.id === 1)?.result.serverInfo.name).toBe('kicktipp');
      const names = messages.find((message) => message.id === 2)?.result.tools.map((tool: { name: string }) => tool.name);
      expect(names).toContain('place_bets_for_member');
      expect(names).not.toContain('set_community');
      expect(names).not.toContain('set_player');
      expect(messages.find((message) => message.id === 3)?.result.structuredContent.data.community).toBe('linked-community');
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('shares one login and keeps concurrent tool reads in separate operations', async () => {
    let sessionChecks = 0;
    const upstream = createServer((req, res) => {
      const url = new URL(req.url!, 'http://fixture');
      const day = url.searchParams.get('spieltagIndex');
      if (url.pathname.includes('meinetipprunden')) sessionChecks++;
      setTimeout(() => {
        res.setHeader('Content-Type', 'text/html');
        res.end(`<div id="kicktipp-content"><div class="pagetitle">Day ${day}</div><table id="tippabgabeSpiele"><tbody>
          <tr><td>21.08.26 20:30</td><td>Home ${day}</td><td>Away</td><td><input id="x_heimTipp" value="2"><input id="x_gastTipp" value="1"></td></tr>
          </tbody></table></div>`);
      }, 20);
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const port = (upstream.address() as { port: number }).port;
    const env = { HOME: home, USERPROFILE: home, KICKTIPP_BASE_URL: `http://127.0.0.1:${port}` };
    const session = execFileSync(process.execPath, ['--input-type=module', '-e',
      "import {sessionFile} from './dist/config.js'; process.stdout.write(sessionFile());"],
    { env: { ...process.env, ...env }, encoding: 'utf8' });
    fs.writeFileSync(session, '{"cookies":[]}');
    try {
      const messages = await callServer([INIT, ...[2, 3].map((day) => ({
        jsonrpc: '2.0', id: day, method: 'tools/call', params: { name: 'get_bets', arguments: { matchday: day } },
      }))], env);
      for (const day of [2, 3]) {
        const result = messages.find((m) => m.id === day)?.result;
        expect(result?.isError).toBeFalsy();
        expect(result?.structuredContent.data.title, JSON.stringify(messages)).toBe(`Day ${day}`);
      }
      expect(sessionChecks).toBe(1);
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      fs.rmSync(session, { force: true });
    }
  }, 15_000);

  it('lists every tool with an input and output schema', async () => {
    const messages = await callServer([INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }], {
      HOME: home,
    });
    const tools = messages.find((m) => m.id === 2)?.result?.tools ?? [];
    expect(tools.length).toBeGreaterThan(20);
    const names = tools.map((tool: { name: string }) => tool.name);
    for (const removed of ['connect_account', 'set_notify', 'whatif', 'get_standings_scenarios', 'get_rival_analysis']) expect(names).not.toContain(removed);
    for (const retained of ['list_members', 'get_bets_for_member', 'place_bets_for_member', 'suggest_bets', 'get_stats', 'place_bonus_bets']) expect(names).toContain(retained);
    for (const tool of tools) {
      expect(tool, `${tool.name} input`).toHaveProperty('inputSchema');
      expect(tool, `${tool.name} output`).toHaveProperty('outputSchema');
      expect(tool.description?.length ?? 0).toBeGreaterThan(20);
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
    expect(result.structuredContent.data.service).toBeNull();
    expect(result.structuredContent.data.setup_instructions).toBeNull();
    expect(result.structuredContent.data).not.toHaveProperty('setup_url');
    expect(result.structuredContent.data).not.toHaveProperty('password');
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

  it('rejects resources for a different community instead of relabelling the active pool', async () => {
    const uris = ['kicktipp://another-pool/rules', 'kicktipp://another-pool/leaderboard/7', 'kicktipp://another-pool/schedule/7'];
    const messages = await callServer([
      INIT,
      ...uris.map((uri, index) => ({ jsonrpc: '2.0', id: index + 2, method: 'resources/read', params: { uri } })),
    ], { HOME: home, KICKTIPP_DATA_DIR: path.join(home, 'resource-scope') });
    for (let index = 0; index < uris.length; index++) {
      const contents = messages.find((m) => m.id === index + 2).result.contents;
      expect(contents[0].uri).toBe(uris[index]);
      expect(JSON.parse(contents[0].text)).toMatchObject({ error: 'community_mismatch' });
    }
  });

  it('returns local setup instructions without a web listener when unconfigured', async () => {
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
      expect(data).not.toHaveProperty('setup_url');
      expect(data.setup_instructions).toContain('docker compose run --rm kicktipp setup');
      expect(data.setup_needed).toBe(true);
      expect(JSON.stringify(data)).not.toMatch(/"password"/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));
