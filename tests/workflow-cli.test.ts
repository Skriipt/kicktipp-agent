import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scope = { profile: 'test', community: 'test-pool', season: '2026', competition: 'bundesliga', providerSeasonId: '5530388' };
const fixture = { profile: scope.profile, community: scope.community, season: scope.season,
  competition: scope.competition, matchday: '1', fixtureId: '123', home: 'Home', away: 'Away', kickoff: Date.now() + 3_600_000 };
let root: string;
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('workflow CLI site selection', () => {
  it.each([
    { override: '', base: 'https://www.kicktipp.de', route: 'tippabgabe' },
    { override: 'https://www.kicktipp.com', base: 'https://www.kicktipp.com', route: 'predict' },
  ])('uses configured site and preserves environment precedence ($base)', async ({ override, base, route }) => {
    root = mkdtempSync(join(tmpdir(), 'workflow-cli-site-'));
    writeFileSync(join(root, 'config.ini'), '[ui]\nsite = de\n');
    const config = join(root, 'workflow.json');
    writeFileSync(config, JSON.stringify({ scope, store: './state', telegram: { enabled: false } }));
    vi.stubEnv('KICKTIPP_CONFIG_DIR', root);
    vi.stubEnv('KICKTIPP_BASE_URL', override);
    vi.resetModules();
    const { main } = await import('../src/workflow/cli.js');
    const { McpScheduleSource } = await import('../src/workflow/mcp-schedule.js');
    const { KicktippSubmissionAdapter } = await import('../src/workflow/kicktipp.js');
    const { getPredictUrl, setUrlBase, urlBase } = await import('../src/url.js');
    setUrlBase('https://www.kicktipp.com');
    const observed: string[] = [];
    vi.spyOn(McpScheduleSource.prototype, 'fetch').mockImplementation(async () => {
      observed.push(urlBase()); return [fixture];
    });
    vi.spyOn(KicktippSubmissionAdapter.prototype, 'read').mockImplementation(async () => {
      observed.push(getPredictUrl(scope.community)); return { fixture, score: { home: 1, away: 0 } };
    });
    const submit = vi.spyOn(KicktippSubmissionAdapter.prototype, 'submit');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Stop at the existing-tip check, before research, prediction or submission.
    await expect(main(['node', 'workflow', '--config', config, '--test', fixture.fixtureId, '--submit']))
      .rejects.toThrow('Test fixture already has a tip');
    expect(observed).toEqual([base, `${base}/${scope.community}/${route}`]);
    expect(submit).not.toHaveBeenCalled();
  });
});
