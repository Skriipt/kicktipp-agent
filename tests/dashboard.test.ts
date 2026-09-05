import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { startDashboard } from '../dist/dashboard/server.js';
import { commandArguments, commandCatalog, commandLeaves, dedicatedCommands } from '../src/dashboard/catalog.js';
import { program } from '../src/index.js';
import { dashboardSite } from './helpers/dashboard-site.mjs';
import { serviceConfiguration } from './helpers/service-fixtures.js';

let dashboard: Awaited<ReturnType<typeof startDashboard>>;
let site: Awaited<ReturnType<typeof dashboardSite>>;
let home: string, origin: string, token: string;
beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-dashboard-'));
  site = await dashboardSite();
  dashboard = await startDashboard({ port: 0, env: { ...process.env, HOME: home, USERPROFILE: home,
    KICKTIPP_CONFIG_DIR: path.join(home, 'config'), KICKTIPP_DATA_DIR: path.join(home, 'data'),
    KICKTIPP_BASE_URL: site.origin, KICKTIPP_LANG: 'de',
  } });
  const url = new URL(dashboard.url); origin = url.origin; token = url.hash.slice(1);
});
afterEach(async () => {
  await dashboard?.close(); await site?.close();
  fs.rmSync(home, { recursive: true, force: true });
});
async function request(operation: string, payload = {}, profile: string | null = null, confirmed = false) {
  const response = await fetch(origin + '/api/run', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, Origin: origin },
    body: JSON.stringify({ operation, payload, profile, confirmed }),
  });
  expect(response.status).toBe(202);
  let job = await response.json();
  while (job.status === 'running') {
    await new Promise(resolve => setTimeout(resolve, 30));
    job = await (await fetch(origin + '/api/jobs/' + job.id, { headers: { Authorization: 'Bearer ' + token } })).json();
  }
  return job;
}
async function signIn(profile: string | null = 'alpha') {
  const job = await request('login', { email: (profile || 'default') + '@example.com', password: ' secret password ', store: 'session', site: site.origin }, profile, true);
  expect(job.status, JSON.stringify(job)).toBe('done');
  expect(job.result.communities).toEqual(['family', 'office']);
  const selection = await request('selection', { community: 'family', player: 'Anna' }, profile, true);
  expect(selection.status, JSON.stringify(selection)).toBe('done');
}

describe('dashboard security and full CLI coverage', () => {
  it('serves packaged assets and requires a bearer token and matching origin/host', async () => {
    const html = await fetch(origin);
    expect(await html.text()).toContain('Projekt-Dashboard'.toUpperCase());
    expect(html.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const script = await fetch(origin + '/app.js');
    expect(script.status).toBe(200);
    expect(spawnSync(process.execPath, ['--check', 'dist/dashboard/public/app.js'], { encoding: 'utf8' }).status).toBe(0);
    for (const headers of [
      {}, { Authorization: 'Bearer wrong' },
      { Authorization: 'Bearer ' + token, Origin: 'https://evil.example' },
    ]) {
      expect((await fetch(origin + '/api/runtime', { headers })).status).toBeGreaterThanOrEqual(401);
    }
    const wrongHost = await new Promise(resolve => {
      http.get(origin + '/api/runtime', { headers: { Host: 'evil.example', Authorization: 'Bearer ' + token } }, response => {
        response.resume(); resolve(response.statusCode);
      });
    });
    expect(wrongHost).toBe(403);
    expect((await fetch(origin + '/api/runtime', { headers: { Authorization: 'Bearer ' + token } })).status).toBe(200);
    expect((await request('unknown')).status).toBe('failed');
  });

  it('represents every CLI command and validates flags without shell/argument injection', () => {
    const catalog = commandCatalog(program);
    expect(new Set([...catalog.map(c => c.id), ...dedicatedCommands])).toEqual(new Set(commandLeaves(program).map(c => c.id)));
    for (const item of catalog) {
      const cli = commandLeaves(program).find(c => c.id === item.id)!.command;
      expect(item.options.map(o => o.name)).toEqual(cli.options.filter(o => o.long !== '--yes').map(o => o.long!.slice(2)));
    }
    expect(() => commandArguments(program, { command: 'serve' }, true)).toThrow();
    expect(() => commandArguments(program, { command: 'suggest', options: { place: true } }, false)).toThrow(/Bestätigung/);
    expect(() => commandArguments(program, { command: 'notify', options: { json: 'true' } }, true)).toThrow();
    expect(() => commandArguments(program, { command: 'bets', options: { profile: 'other' } }, true)).toThrow();
    expect(() => commandArguments(program, { command: 'bets', options: { matchday: '1oops' } }, true)).toThrow();
    expect(() => commandArguments(program, { command: 'remind', options: { ics: '../../config.ini' } }, true)).toThrow();
    expect(commandArguments(program, { command: 'rival', args: ['--profile=other'] }, false)).toEqual(['rival', '--', '--profile=other']);
    expect(commandArguments(program, { command: 'suggest', options: { pin: ['Bayern vs Dortmund=2:1', 'A vs B=0:0'] } }, false))
      .toEqual(['suggest', '--pin', 'Bayern vs Dortmund=2:1', 'A vs B=0:0', '--']);
  });

  it.skipIf(process.platform === 'win32')('runs the CLI through an installed-style symlink', () => {
    const link = path.join(home, 'kicktipp');
    fs.symlinkSync(path.resolve('dist/index.js'), link);
    const result = spawnSync(process.execPath, [link, '--version'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('1.3.0');
  });
});

describe('dashboard end-to-end operations', () => {
  it('requires a preview identity before placing tips for another member', async () => {
    await signIn();
    const payload = { command: 'admin bet', args: ['Anna', 'Bayern vs Dortmund=1:0'] };
    const preview = await request('command', { ...payload, options: { 'dry-run': true } }, 'alpha');
    expect(preview.result.member).toMatchObject({ name: 'Anna', tipperId: '101' });
    expect((await request('command', payload, 'alpha', true)).status).toBe('failed');
    expect(site.posts).toHaveLength(0);
    const placed = await request('command', { ...payload, confirmMember: 'Anna', confirmMemberId: '101' }, 'alpha', true);
    expect(placed.status, JSON.stringify(placed)).toBe('done');
    expect(site.posts[0].body).toMatchObject({ tipperId: '101', home: '1', away: '0' });
  }, 20_000);
  it('logs in, selects players, isolates profiles, submits and previews match/bonus tips with auditing', async () => {
    await signIn();
    const players = await request('players', {}, 'alpha');
    expect(players.result.players).toEqual(['Anna', 'Ben']);
    const bets = await request('bets', { matchday: 1 }, 'alpha');
    expect(bets.result.matches.map((m: { editable: boolean }) => m.editable)).toEqual([true, false]);
    const payload = { bets: ['Bayern vs Dortmund=2:1'], matchday: 1 };
    expect((await request('place', payload, 'alpha')).status).toBe('failed');
    expect((await request('place', { ...payload, dryRun: true }, 'alpha')).status).toBe('done');
    expect(site.posts).toHaveLength(0);
    expect((await request('place', payload, 'alpha', true)).status).toBe('done');
    expect(site.posts[0].body).toMatchObject({ csrf: 'keep-me', home: '2', away: '1' });
    await signIn('beta');
    const [alpha, beta] = await Promise.all([request('bets', {}, 'alpha'), request('bets', {}, 'beta')]);
    expect(alpha.result.matches[0].bet).toBe('2:1');
    expect(beta.result.matches[0].bet).toBe('-');
    const bonus = await request('bonus', {}, 'alpha');
    expect(bonus.result.questions[0].question).toBe('Wer wird Meister?');
    expect((await request('place', { bets: ['Wer wird Meister?=Bayern'], bonus: true }, 'alpha', true)).status).toBe('done');
    expect(site.posts[1].body).toMatchObject({ bonus: 'true', bonusAnswer: 'bayern' });
    const calendar = await request('calendar', { matchday: 1 }, 'alpha');
    expect(calendar.result.download.content).toContain('BEGIN:VCALENDAR');
    const log = await request('command', { command: 'log', options: { json: true, all: true } }, 'alpha');
    expect(log.status, JSON.stringify(log)).toBe('done');
    expect(log.result.records.some((record: { source: string }) => record.source === 'dashboard:bet')).toBe(true);
    const snapshot = await request('snapshot', {}, 'alpha');
    expect(JSON.stringify(snapshot)).not.toContain('secret password');
    expect(snapshot.result.auth.store).toBe('session');
    const logout = await request('logout', {}, 'alpha', true);
    expect(logout.status).toBe('done');
    expect((await request('snapshot', {}, 'beta')).result.auth.configured).toBe(true);
    expect((await request('bets', {}, 'alpha')).status).toBe('failed');
  }, 30_000);

  it('saves shared settings with revision protection and enforces read-only at submission', async () => {
    await signIn();
    const snapshot = (await request('snapshot', {}, 'alpha')).result;
    const { environmentOverrides: _, ...settings } = snapshot.settings;
    expect((await request('settings', { ...settings, readOnly: true, warnHours: 12, timezone: 'UTC',
      scoring: { exact: 4, goalDiff: 3, tendency: 2 } }, 'alpha', true)).status).toBe('done');
    expect((await request('settings', settings, 'alpha', true)).status).toBe('failed');
    expect((await request('place', { bets: ['Bayern vs Dortmund=3:1'] }, 'alpha', true)).error).toContain('read-only');
    expect(site.posts).toHaveLength(0);
    expect((await request('notifier', { kind: 'webhook', target: 'https://example.test/private-key' }, 'alpha', true)).status).toBe('done');
    const next = (await request('snapshot', {}, 'alpha')).result;
    expect(next.settings).toMatchObject({ readOnly: true, warnHours: 12, timezone: 'UTC' });
    expect(JSON.stringify(next.notifier)).not.toContain('private-key');
    const preview = await request('command', { command: 'bets', options: { json: true } }, 'alpha');
    expect(preview.status, JSON.stringify(preview)).toBe('done');
    expect(preview.result.community).toBe('family');
  }, 20_000);

  it('persists service configuration and secret references, detects conflicts and manages its own service', async () => {
    const configuration = serviceConfiguration();
    const setup = await request('service-config', { revision: null, configuration }, null, true);
    expect(setup.status, JSON.stringify(setup)).toBe('done');
    const snapshot = (await request('snapshot')).result;
    const secret = await request('secret', { value: 'https://example.test/keep-secret' }, null, true);
    expect(secret.result.reference).toMatch(/^local:/);
    expect(JSON.stringify(secret)).not.toContain('keep-secret');
    configuration.targets.push({ id: 'web', provider: 'webhook', enabled: true, urlRef: secret.result.reference });
    configuration.job.targetIds.push('web');
    expect((await request('service-config', { revision: snapshot.serviceRevision, configuration }, null, true)).status).toBe('done');
    expect((await request('service-config', { revision: snapshot.serviceRevision, configuration }, null, true)).status).toBe('failed');
    const stored = fs.readFileSync(path.join(home, 'config', 'service.json'), 'utf8');
    expect(stored).not.toContain('keep-secret');
    expect(stored).toContain(secret.result.reference);
    const start = await fetch(origin + '/api/run', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'service-start', confirmed: true, payload: { logFormat: 'json' } }) });
    const startJob = await start.json();
    expect(start.status).toBe(202);
    await new Promise(resolve => setTimeout(resolve, 500));
    const runtime = await (await fetch(origin + '/api/runtime', { headers: { Authorization: 'Bearer ' + token } })).json();
    expect(runtime.running).toBe(true);
    const stop = await fetch(origin + '/api/run', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'service-stop', confirmed: true }) });
    expect(stop.status).toBe(200);
    let result;
    for (let i = 0; i < 80; i++) {
      result = await (await fetch(origin + '/api/jobs/' + startJob.id, { headers: { Authorization: 'Bearer ' + token } })).json();
      if (result.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(result.status, JSON.stringify(result)).toBe('done');
    expect(result.output).toContain('service_stopped');
  }, 20_000);
});
