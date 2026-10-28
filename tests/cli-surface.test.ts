import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-cli-'));
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

function cli(...args: string[]) {
  return spawnSync(process.execPath, ['dist/index.js', ...args], {
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
    },
  });
}

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
});
