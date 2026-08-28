import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  getPredictUrl,
  getBonusPredictUrl,
  getLeaderboardUrl,
  getScheduleUrl,
  getOverviewUrl,
  getTableUrl,
  getRulesUrl,
  getCommunitiesUrl,
  getAlternateUrls,
  parseSite,
  resolveBaseUrl,
  urlBase,
  urlLogin,
} from '../src/url.js';

// The host is resolved from the environment at import time, so exercising a
// different host means re-importing the module with the env var stubbed.
async function withBase(base: string) {
  vi.resetModules();
  vi.stubEnv('KICKTIPP_BASE_URL', base);
  return import('../src/url.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('default host', () => {
  it('stays on kicktipp.com with English paths', () => {
    expect(urlBase()).toBe('https://www.kicktipp.com');
    expect(urlLogin()).toBe('https://www.kicktipp.com/info/profil/login');
    expect(getCommunitiesUrl()).toBe(
      'https://www.kicktipp.com/info/profil/meinetipprunden',
    );
  });
});

describe('getPredictUrl', () => {
  it('without matchday', () => {
    expect(getPredictUrl('mycomm')).toBe('https://www.kicktipp.com/mycomm/predict');
  });

  it('with matchday', () => {
    expect(getPredictUrl('mycomm', 5)).toBe(
      'https://www.kicktipp.com/mycomm/predict?spieltagIndex=5',
    );
  });

  it('throws on invalid matchday', () => {
    expect(() => getPredictUrl('mycomm', 42)).toThrow(RangeError);
    expect(() => getPredictUrl('mycomm', 0)).toThrow(RangeError);
    expect(() => getPredictUrl('mycomm', 1.5)).toThrow(RangeError);
  });

  it('encodes the community', () => {
    expect(getPredictUrl('my comm')).toBe('https://www.kicktipp.com/my%20comm/predict');
  });

  it('builds the bonus variant', () => {
    expect(getBonusPredictUrl('mycomm')).toBe(
      'https://www.kicktipp.com/mycomm/predict?bonus=true',
    );
  });
});

describe('other page URLs', () => {
  it('leaderboard with bonus and matchday', () => {
    expect(getLeaderboardUrl('c')).toBe('https://www.kicktipp.com/c/leaderboard');
    expect(getLeaderboardUrl('c', 3, true)).toBe(
      'https://www.kicktipp.com/c/leaderboard?bonus=true&spieltagIndex=3',
    );
  });

  it('schedule, overview, table, rules', () => {
    expect(getScheduleUrl('c', 2)).toBe(
      'https://www.kicktipp.com/c/schedule?spieltagIndex=2',
    );
    expect(getOverviewUrl('c', 'spieltagspunkte')).toBe(
      'https://www.kicktipp.com/c/overview?ansicht=spieltagspunkte',
    );
    expect(getTableUrl('c')).toBe('https://www.kicktipp.com/c/tables');
    expect(getTableUrl('c', 'home')).toBe('https://www.kicktipp.com/c/tables?option=heim');
    expect(getTableUrl('c', 'away')).toBe('https://www.kicktipp.com/c/tables?option=gast');
    expect(getRulesUrl('c')).toBe('https://www.kicktipp.com/c/rules');
  });
});

describe('KICKTIPP_BASE_URL override', () => {
  it('switches kicktipp.de to German paths', async () => {
    const url = await withBase('https://www.kicktipp.de');
    expect(url.urlBase()).toBe('https://www.kicktipp.de');
    expect(url.getPredictUrl('c', 4)).toBe(
      'https://www.kicktipp.de/c/tippabgabe?spieltagIndex=4',
    );
    expect(url.getLeaderboardUrl('c')).toBe('https://www.kicktipp.de/c/tippuebersicht');
    expect(url.getScheduleUrl('c')).toBe('https://www.kicktipp.de/c/tippspielplan');
    expect(url.getTableUrl('c')).toBe('https://www.kicktipp.de/c/tabellen');
    expect(url.getRulesUrl('c')).toBe('https://www.kicktipp.de/c/spielregeln');
  });

  it('normalizes a base with a path or trailing slash', async () => {
    const url = await withBase('https://www.kicktipp.de/some/path/');
    expect(url.urlBase()).toBe('https://www.kicktipp.de');
  });
});

describe('parseSite', () => {
  it('accepts de, com, and full URLs', () => {
    expect(parseSite('de')).toBe('https://www.kicktipp.de');
    expect(parseSite('COM')).toBe('https://www.kicktipp.com');
    expect(parseSite('https://www.kicktipp.de/foo')).toBe('https://www.kicktipp.de');
    expect(parseSite('')).toBeUndefined();
  });

  it('rejects unknown values', () => {
    expect(() => parseSite('fr')).toThrow(/Unknown site 'fr'/);
  });
});

describe('resolveBaseUrl', () => {
  it('prefers the flag, then the full URL env, then KICKTIPP_SITE, then config', () => {
    expect(
      resolveBaseUrl({
        argv: ['kicktipp', '--site', 'de'],
        env: { KICKTIPP_BASE_URL: 'https://www.kicktipp.com', KICKTIPP_SITE: 'com' },
        configSite: 'com',
      }),
    ).toBe('https://www.kicktipp.de');
    expect(
      resolveBaseUrl({
        argv: ['kicktipp'],
        env: { KICKTIPP_BASE_URL: 'https://www.kicktipp.de' },
        configSite: 'com',
      }),
    ).toBe('https://www.kicktipp.de');
    expect(
      resolveBaseUrl({
        argv: ['kicktipp'],
        env: { KICKTIPP_SITE: 'de' },
        configSite: 'com',
      }),
    ).toBe('https://www.kicktipp.de');
    expect(resolveBaseUrl({ argv: ['kicktipp'], env: {}, configSite: 'de' })).toBe(
      'https://www.kicktipp.de',
    );
    expect(resolveBaseUrl({ argv: ['kicktipp'], env: {}, configSite: null })).toBe(
      'https://www.kicktipp.com',
    );
  });
});

describe('getAlternateUrls', () => {
  it('offers the German page on the German host', () => {
    const alts = getAlternateUrls('https://www.kicktipp.com/c/predict');
    expect(alts).toContain('https://www.kicktipp.de/c/tippabgabe');
    expect(alts).toContain('https://www.kicktipp.com/c/tippabgabe');
    expect(alts).toContain('https://www.kicktipp.de/c/predict');
  });

  it('never includes the input URL', () => {
    const input = 'https://www.kicktipp.com/c/predict';
    expect(getAlternateUrls(input)).not.toContain(input);
  });

  it('preserves the query string', () => {
    const alts = getAlternateUrls('https://www.kicktipp.com/c/leaderboard?spieltagIndex=7');
    expect(alts).toContain('https://www.kicktipp.de/c/tippuebersicht?spieltagIndex=7');
    expect(alts.every((u) => u.includes('spieltagIndex=7'))).toBe(true);
  });

  it('covers the profile routes', () => {
    const alts = getAlternateUrls('https://www.kicktipp.com/info/profil/meinetipprunden');
    expect(alts).toContain('https://www.kicktipp.com/info/profile/prediction-games');
    expect(alts).toContain('https://www.kicktipp.de/info/profil/meinetipprunden');
  });

  it('keeps an unknown path unchanged apart from the host', () => {
    const alts = getAlternateUrls('https://www.kicktipp.com/c/unknown-page');
    expect(alts).toEqual(['https://www.kicktipp.de/c/unknown-page']);
  });

  it('does not double-encode an encoded community', () => {
    const alts = getAlternateUrls('https://www.kicktipp.com/my%20comm/predict');
    expect(alts).toContain('https://www.kicktipp.de/my%20comm/tippabgabe');
    expect(alts.every((u) => !u.includes('%2520'))).toBe(true);
  });
});
