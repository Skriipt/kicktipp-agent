const DEFAULT_BASE_URL = 'https://www.kicktipp.de';

type RouteKey =
  | 'login'
  | 'communities'
  | 'predict'
  | 'leaderboard'
  | 'overview'
  | 'schedule'
  | 'table'
  | 'rules';

const ROUTES: Record<RouteKey, { de: string; en: string }> = {
  login: { de: '/info/profil/login', en: '/info/profile/login' },
  communities: {
    de: '/info/profil/meinetipprunden',
    en: '/info/profile/prediction-games',
  },
  predict: { de: '/:community/tippabgabe', en: '/:community/predict' },
  leaderboard: {
    de: '/:community/tippuebersicht',
    en: '/:community/leaderboard',
  },
  overview: {
    de: '/:community/gesamtuebersicht',
    en: '/:community/overview',
  },
  schedule: {
    de: '/:community/tippspielplan',
    en: '/:community/schedule',
  },
  table: { de: '/:community/tabellen', en: '/:community/tables' },
  rules: { de: '/:community/spielregeln', en: '/:community/rules' },
};

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function languageForBase(base: string): 'de' | 'en' {
  return new URL(base).hostname.endsWith('kicktipp.com') ? 'en' : 'de';
}

function routePath(
  route: RouteKey,
  community?: string,
  base = URL_BASE,
): string {
  const template = ROUTES[route][languageForBase(base)];
  if (!template.includes(':community')) return template;
  if (!community) throw new Error(`Community is required for route '${route}'.`);
  return template.replace(':community', encodeURIComponent(community));
}

function buildUrl(
  route: RouteKey,
  community?: string,
  params?: URLSearchParams,
): string {
  const url = new URL(routePath(route, community), URL_BASE);
  if (params) {
    for (const [key, value] of params) {
      url.searchParams.append(key, value);
    }
  }
  return url.toString();
}

function assertMatchday(matchday: number): void {
  if (!Number.isInteger(matchday) || matchday < 1 || matchday > 34) {
    throw new RangeError(
      `The matchday '${matchday}' is not valid, use only 1 to 34!`,
    );
  }
}

export const URL_BASE = normalizeBaseUrl(
  process.env.KICKTIPP_BASE_URL || DEFAULT_BASE_URL,
);
export const URL_LOGIN = buildUrl('login');

export function getCommunitiesUrl(): string {
  return buildUrl('communities');
}

export function getPredictUrl(
  community: string,
  matchday?: number,
): string {
  const params = new URLSearchParams();
  if (matchday !== undefined) {
    assertMatchday(matchday);
    params.set('spieltagIndex', String(matchday));
  }
  return buildUrl('predict', community, params);
}

export function getBonusPredictUrl(community: string): string {
  return buildUrl(
    'predict',
    community,
    new URLSearchParams({ bonus: 'true' }),
  );
}

export function getLeaderboardUrl(
  community: string,
  matchday?: number,
  bonus = false,
): string {
  const params = new URLSearchParams();
  if (bonus) params.set('bonus', 'true');
  if (matchday !== undefined) {
    assertMatchday(matchday);
    params.set('spieltagIndex', String(matchday));
  }
  return buildUrl('leaderboard', community, params);
}

export function getScheduleUrl(
  community: string,
  matchday?: number,
): string {
  const params = new URLSearchParams();
  if (matchday !== undefined) {
    assertMatchday(matchday);
    params.set('spieltagIndex', String(matchday));
  }
  return buildUrl('schedule', community, params);
}

export function getOverviewUrl(
  community: string,
  view: string,
): string {
  return buildUrl(
    'overview',
    community,
    new URLSearchParams({ ansicht: view }),
  );
}

export function getTableUrl(
  community: string,
  option?: 'home' | 'away',
): string {
  const params = new URLSearchParams();
  if (option === 'home') params.set('option', 'heim');
  if (option === 'away') params.set('option', 'gast');
  return buildUrl('table', community, params);
}

export function getRulesUrl(community: string): string {
  return buildUrl('rules', community);
}

const ROUTE_ALIASES: Record<string, { de: string; en: string }> = {
  predict: { de: 'tippabgabe', en: 'predict' },
  tippabgabe: { de: 'tippabgabe', en: 'predict' },
  leaderboard: { de: 'tippuebersicht', en: 'leaderboard' },
  tippuebersicht: { de: 'tippuebersicht', en: 'leaderboard' },
  overview: { de: 'gesamtuebersicht', en: 'overview' },
  gesamtuebersicht: { de: 'gesamtuebersicht', en: 'overview' },
  schedule: { de: 'tippspielplan', en: 'schedule' },
  tippspielplan: { de: 'tippspielplan', en: 'schedule' },
  tables: { de: 'tabellen', en: 'tables' },
  tabellen: { de: 'tabellen', en: 'tables' },
  rules: { de: 'spielregeln', en: 'rules' },
  spielregeln: { de: 'spielregeln', en: 'rules' },
};

/**
 * Keeps older direct URL constructions working after changing the default host.
 * New code should prefer the URL builders above.
 */
export function normalizeKicktippUrl(rawUrl: string): string {
  const url = new URL(rawUrl, URL_BASE);
  if (
    !url.hostname.endsWith('kicktipp.de') &&
    !url.hostname.endsWith('kicktipp.com')
  ) {
    return rawUrl;
  }

  const language = languageForBase(url.origin);
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] === 'info' && parts.length >= 3) {
    const route = parts.slice(0, 3).join('/');
    if (route === 'info/profil/login' || route === 'info/profile/login') {
      url.pathname = ROUTES.login[language];
    } else if (
      route === 'info/profil/meinetipprunden' ||
      route === 'info/profile/prediction-games'
    ) {
      url.pathname = ROUTES.communities[language];
    }
    return url.toString();
  }

  if (parts.length >= 2) {
    const alias = ROUTE_ALIASES[parts[1]];
    if (alias) {
      parts[1] = alias[language];
      url.pathname = `/${parts.join('/')}`;
    }
  }

  return url.toString();
}
