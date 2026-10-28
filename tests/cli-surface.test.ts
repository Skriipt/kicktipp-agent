import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-cli-'));
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

function runCli(args: string[], entry = 'dist/index.js', extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      KICKTIPP_CONFIG_DIR: path.join(home, 'config'),
      KICKTIPP_DATA_DIR: path.join(home, 'data'),
      KICKTIPP_SERVICE_CONFIG: path.join(home, 'service.json'),
      KICKTIPP_LANG: 'en',
      KICKTIPP_PROFILE: '',
      KICKTIPP_EMAIL: '',
      KICKTIPP_PASSWORD: '',
      KICKTIPP_COMMUNITY: '',
      ...extraEnv,
    },
  });
}

function cli(...args: string[]) { return runCli(args); }

describe('the service-oriented CLI', () => {
  it('keeps Kicktipp commands and admin while removing desktop and specialist commands', () => {
    const result = cli('--help');
    expect(result.status, result.stderr).toBe(0);
    for (const name of ['setup', 'today', 'bets', 'bet', 'schedule', 'leaderboard', 'overview', 'table', 'rules', 'tip-status', 'sync', 'stats', 'suggest', 'deadline', 'notify', 'log', 'admin']) {
      expect(result.stdout).toMatch(new RegExp(`^  ${name}(?:\\s|\\[|\\<)`, 'm'));
    }
    for (const name of ['tui', 'rival', 'scenario', 'whatif', 'remind', 'set-notify']) {
      expect(result.stdout).not.toMatch(new RegExp(`^  ${name}(?:\\s|\\[|\\<)`, 'm'));
    }
  });

  it('rejects missing explicit match or bonus tips before trying to connect', () => {
    for (const args of [['bet'], ['bet', '--bonus']]) {
      const result = cli(...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/missing required argument 'bets'/);
      expect(result.stdout).toBe('');
    }
  });

  it('offers notification-only setup and channel tests without the localhost setup flags', () => {
    expect(cli('setup', '--help').stdout).toContain('--notifications');
    expect(cli('notify', '--help').stdout).toContain('--test');
    expect(cli('login', '--help').stdout).not.toContain('--web');
    expect(cli('bet', '--help').stdout).not.toContain('--tui');
  });

  it('lists service profiles and selects isolated local history through either CLI entry point', () => {
    const configFile = path.join(home, 'service.json');
    const guard = path.join(home, 'network-forbidden.mjs');
    const networkAttempt = path.join(home, 'network-attempt');
    fs.writeFileSync(guard, `import fs from 'node:fs'; globalThis.fetch = () => {
      fs.writeFileSync(${JSON.stringify(networkAttempt)}, 'attempted'); throw new Error('Network forbidden in CLI profile test');
    };`);
    const env = { HOME: home, USERPROFILE: home, KICKTIPP_SERVICE_CONFIG: configFile,
      KICKTIPP_DATA_DIR: path.join(home, 'data'), KICKTIPP_PROFILE: '', KICKTIPP_BASE_URL: 'http://127.0.0.1:1',
      NODE_OPTIONS: `--import=${guard}` };
    fs.writeFileSync(configFile, JSON.stringify({
      version: 2, server: { token: 'cli-fixture-token-at-least-thirty-two-characters', host: '127.0.0.1', port: 8787, allowedOrigins: [] },
      profiles: ['alice', 'bob'].map(id => ({
        id, name: id, account: { email: `${id}@example.invalid`, password: 'cli-fixture-password', community: 'shared-pool', site: 'de' },
        readOnly: true, timeZone: 'Europe/Berlin', notifications: { channels: [], warnHours: [], everyMinutes: 15 },
      })),
    }));
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', `
        import {readServiceConfig, applyServiceConfig, profileServiceConfig} from './dist/service/settings.js';
        import {appendAudit} from './dist/audit/log.js';
        const config = readServiceConfig();
        for (const profile of config.profiles) {
          applyServiceConfig(profileServiceConfig(config, profile), profile.id);
          appendAudit({ at: new Date().toISOString(), source:'mcp:place_bets', community:profile.account.community,
            matchday:1, kind:'match', dryRun:false, outcome:'submitted', bets:[{fixture:profile.id, bet:'2:1', previous:null}] });
        }
      `], { env: { ...process.env, ...env }, encoding: 'utf8' });
      for (const entry of ['dist/index.js', 'dist/service/main.js']) {
        const listed = runCli(['profiles', '--json'], entry, env);
        expect(listed.status, listed.stderr).toBe(0);
        expect(JSON.parse(listed.stdout).profiles).toMatchObject([{ id: 'alice' }, { id: 'bob' }]);
        for (const id of ['alice', 'bob']) {
          const result = runCli(['--profile', id, 'log', '--json'], entry, env);
          expect(result.status, result.stderr).toBe(0);
          const data = JSON.parse(result.stdout);
          expect(data.community).toBe('shared-pool');
          expect(data.records).toHaveLength(1);
          expect(data.records[0].bets[0].fixture).toBe(id);
        }
        const fromEnvironment = runCli(['log', '--json'], entry, { ...env, KICKTIPP_PROFILE: 'bob' });
        expect(fromEnvironment.status, fromEnvironment.stderr).toBe(0);
        expect(JSON.parse(fromEnvironment.stdout).records[0].bets[0].fixture).toBe('bob');
        for (const args of [['log', '--json'], ['--profile', 'missing', 'log', '--json']]) {
          const rejected = runCli(args, entry, env);
          expect(rejected.status).toBe(1);
          expect(rejected.stderr + rejected.stdout).toMatch(/profile/i);
        }
      }
      expect(fs.existsSync(networkAttempt)).toBe(false);
    } finally { fs.rmSync(configFile, { force: true }); }
  }, 20_000);

});
