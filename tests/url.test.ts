import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  delete process.env.KICKTIPP_BASE_URL;
  vi.resetModules();
});

async function loadUrls(baseUrl?: string) {
  if (baseUrl) process.env.KICKTIPP_BASE_URL = baseUrl;
  else delete process.env.KICKTIPP_BASE_URL;
  vi.resetModules();
  return import('../src/url.js');
}

describe('Kicktipp URL builders', () => {
  it('uses kicktipp.de and German routes by default', async () => {
    const {
      URL_BASE,
      URL_LOGIN,
      getCommunitiesUrl,
      getPredictUrl,
      getBonusPredictUrl,
      getLeaderboardUrl,
      getScheduleUrl,
      getOverviewUrl,
      getTableUrl,
      getRulesUrl,
    } = await loadUrls();

    expect(URL_BASE).toBe('https://www.kicktipp.de');
    expect(URL_LOGIN).toBe('https://www.kicktipp.de/info/profil/login');
    expect(getCommunitiesUrl()).toBe(
      'https://www.kicktipp.de/info/profil/meinetipprunden',
    );
    expect(getPredictUrl('my comm')).toBe(
      'https://www.kicktipp.de/my%20comm/tippabgabe',
    );
    expect(getBonusPredictUrl('mycomm')).toBe(
      'https://www.kicktipp.de/mycomm/tippabgabe?bonus=true',
    );
    expect(getLeaderboardUrl('mycomm', 5, true)).toBe(
      'https://www.kicktipp.de/mycomm/tippuebersicht?bonus=true&spieltagIndex=5',
    );
    expect(getScheduleUrl('mycomm', 5)).toBe(
      'https://www.kicktipp.de/mycomm/tippspielplan?spieltagIndex=5',
    );
    expect(getOverviewUrl('mycomm', 'spieltagspunkte')).toBe(
      'https://www.kicktipp.de/mycomm/gesamtuebersicht?ansicht=spieltagspunkte',
    );
    expect(getTableUrl('mycomm', 'home')).toBe(
      'https://www.kicktipp.de/mycomm/tabellen?option=heim',
    );
    expect(getRulesUrl('mycomm')).toBe(
      'https://www.kicktipp.de/mycomm/spielregeln',
    );
  });

  it('uses kicktipp.com and English routes when configured', async () => {
    const {
      URL_BASE,
      URL_LOGIN,
      getCommunitiesUrl,
      getPredictUrl,
      getLeaderboardUrl,
      getScheduleUrl,
      getOverviewUrl,
      getTableUrl,
      getRulesUrl,
    } = await loadUrls('https://www.kicktipp.com/');

    expect(URL_BASE).toBe('https://www.kicktipp.com');
    expect(URL_LOGIN).toBe('https://www.kicktipp.com/info/profile/login');
    expect(getCommunitiesUrl()).toBe(
      'https://www.kicktipp.com/info/profile/prediction-games',
    );
    expect(getPredictUrl('mycomm')).toBe(
      'https://www.kicktipp.com/mycomm/predict',
    );
    expect(getLeaderboardUrl('mycomm')).toBe(
      'https://www.kicktipp.com/mycomm/leaderboard',
    );
    expect(getScheduleUrl('mycomm')).toBe(
      'https://www.kicktipp.com/mycomm/schedule',
    );
    expect(getOverviewUrl('mycomm', 'platzierungen')).toBe(
      'https://www.kicktipp.com/mycomm/overview?ansicht=platzierungen',
    );
    expect(getTableUrl('mycomm', 'away')).toBe(
      'https://www.kicktipp.com/mycomm/tables?option=gast',
    );
    expect(getRulesUrl('mycomm')).toBe(
      'https://www.kicktipp.com/mycomm/rules',
    );
  });

  it('rejects invalid matchdays for every matchday URL', async () => {
    const { getPredictUrl, getLeaderboardUrl, getScheduleUrl } = await loadUrls();

    expect(() => getPredictUrl('mycomm', 0)).toThrow();
    expect(() => getLeaderboardUrl('mycomm', 35)).toThrow();
    expect(() => getScheduleUrl('mycomm', 42)).toThrow();
  });
});
