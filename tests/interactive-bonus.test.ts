import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { Page } from '../src/http/page.js';
import { CookieJar } from '../src/http/cookie-jar.js';
import { registerBetCommand } from '../src/commands/bet.js';
import { readAudit } from '../src/audit/log.js';
const mocked = vi.hoisted(() => ({ launch: vi.fn(), ask: vi.fn() }));
vi.mock('../src/browser.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/browser.js')>(), launchBrowser: mocked.launch,
}));
vi.mock('../src/shared.js', () => ({ ensureCommunity: async () => 'c', ask: mocked.ask }));

let temporary: string;
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-interactive-'));
  vi.stubEnv('KICKTIPP_DATA_DIR', temporary);
  vi.stubEnv('KICKTIPP_READ_ONLY', '0');
  mocked.ask.mockResolvedValue('2');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(temporary, { recursive: true, force: true });
});
function form(selected = '') {
  return `<div id="kicktipp-content"><form method="post" action="/c/predict?bonus=true">
    <table id="tippabgabeFragen"><tbody><tr><td></td><td>Champion?</td><td>
    <select name="q[0].tipp"><option value="" ${selected === '' ? 'selected' : ''}>---</option>
    <option value="A" ${selected === 'A' ? 'selected' : ''}>Team A</option></select>
    </td></tr></tbody></table><button name="submitbutton" type="submit">Save</button></form></div>`;
}
describe('interactive bonus command', () => {
  it.each([403, 307, 200])('verifies persistence after HTTP %s without replaying the POST', async status => {
    let posted = false;
    const methods: string[] = [];
    const page = new Page(new CookieJar(), async (_url, init) => {
      methods.push(init.method!);
      if (init.method === 'POST') {
        posted = true;
        return new Response('Receipt', { status, headers: status === 307 ? { location: '/replay' } : {} });
      }
      return new Response(form(posted && status !== 403 ? 'A' : ''));
    });
    mocked.launch.mockResolvedValue(page);
    const program = new Command();
    registerBetCommand(program);
    const run = program.parseAsync(['node', 'kicktipp', 'bet', '--bonus']);
    if (status === 403) await expect(run).rejects.toMatchObject({ outcome: 'rejected' });
    else await expect(run).resolves.toBeDefined();
    expect(methods.filter(method => method === 'POST')).toHaveLength(1);
    expect(methods.at(-1)).toBe('GET');
    expect(readAudit('c').at(-1)?.outcome).toBe(status === 403 ? 'rejected' : 'submitted');
  });
});
