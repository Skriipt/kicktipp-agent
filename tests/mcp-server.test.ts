import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

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
