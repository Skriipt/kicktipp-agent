import { en } from './i18n/en.js';

// Kicktipp serves the same pages under a German and an English host, with
// different path spellings per language. We build URLs for the configured
// host, and — because some communities only exist under one of them — can
// enumerate the equivalent URLs on the other host/language as fallbacks.

const DEFAULT_BASE_URL = 'https://www.kicktipp.com';
const SITE_DE = 'https://www.kicktipp.de';
const SITE_COM = 'https://www.kicktipp.com';

type RouteKey =
  | 'login'
  | 'communities'
  | 'predict'
  | 'leaderboard'
  | 'overview'
  | 'schedule'
  | 'table'
  | 'rules'
  | 'adminMembers'
  | 'adminTips';

interface Route {
  de: string;
  en: string;
  // Extra path spellings to try when the primary ones return "not found".
  aliases?: string[];
}

// The profile routes use the German spelling on both hosts; the English
// spelling is only listed as a fallback because kicktipp.com serves
// /info/profil/... today.
const ROUTES: Record<RouteKey, Route> = {
  login: {
    de: '/info/profil/login',
    en: '/info/profil/login',
    aliases: ['/info/profile/login'],
  },
  communities: {
    de: '/info/profil/meinetipprunden',
    en: '/info/profil/meinetipprunden',
    aliases: ['/info/profile/prediction-games'],
  },
  predict: { de: '/:community/tippabgabe', en: '/:community/predict' },
  leaderboard: { de: '/:community/tippuebersicht', en: '/:community/leaderboard' },
  overview: { de: '/:community/gesamtuebersicht', en: '/:community/overview' },
  schedule: { de: '/:community/tippspielplan', en: '/:community/schedule' },
  table: { de: '/:community/tabellen', en: '/:community/tables' },
  rules: { de: '/:community/spielregeln', en: '/:community/rules' },
  // Kicktipp exposes no English aliases for the Spielleiter pages, so the
  // German paths are used on both hosts.
  adminMembers: {
    de: '/:community/spielleiter/mitgliederliste',
    en: '/:community/spielleiter/mitgliederliste',
  },
  adminTips: {
    de: '/:community/spielleiter/tippsnachtragen',
    en: '/:community/spielleiter/tippsnachtragen',
  },
};

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

// Anything that is not kicktipp.com is treated as German — that matches
// kicktipp.de and keeps self-hosted/staging bases on the German spellings.
function languageForBase(base: string): 'de' | 'en' {
  return new URL(base).hostname.endsWith('kicktipp.com') ? 'en' : 'de';
}

function oppositeBase(base: string): string {
  const url = new URL(base);
  if (url.hostname.endsWith('kicktipp.com')) {
    url.hostname = url.hostname.replace(/kicktipp\.com$/, 'kicktipp.de');
  } else if (url.hostname.endsWith('kicktipp.de')) {
    url.hostname = url.hostname.replace(/kicktipp\.de$/, 'kicktipp.com');
  }
  return normalizeBaseUrl(url.toString());
}

export function siteFromArgv(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--site') return argv[i + 1];
    if (arg.startsWith('--site=')) return arg.slice('--site='.length);
  }
  return undefined;
}

/** Map `de` / `com` / a URL to a normalized origin. Empty is not an error. */
export function parseSite(raw: string | undefined | null): string | undefined {
  if (raw == null) return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  const key = value.toLowerCase();
  if (key === 'de' || key === '.de' || key === 'kicktipp.de' || key === 'www.kicktipp.de') {
    return SITE_DE;
  }
  if (
    key === 'com' ||
    key === '.com' ||
    key === 'en' ||
    key === 'kicktipp.com' ||
    key === 'www.kicktipp.com'
  ) {
    return SITE_COM;
  }
  if (key.startsWith('http://') || key.startsWith('https://')) return normalizeBaseUrl(value);
  throw new Error(en.i18n.unknownSite.replace('{value}', value));
}

export function resolveBaseUrl(opts?: {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  configSite?: string | null;
}): string {
  const argv = opts?.argv ?? process.argv;
  const env = opts?.env ?? process.env;
  const fromFlag = parseSite(siteFromArgv(argv));
  if (fromFlag) return fromFlag;
  const fromBaseEnv = env.KICKTIPP_BASE_URL?.trim();
  if (fromBaseEnv) return normalizeBaseUrl(fromBaseEnv);
  const fromSiteEnv = parseSite(env.KICKTIPP_SITE);
  if (fromSiteEnv) return fromSiteEnv;
  const fromConfig = parseSite(opts?.configSite);
  if (fromConfig) return fromConfig;
  return DEFAULT_BASE_URL;
}

/** Short label for config.ini and status lines: `de`, `com`, or the origin. */
export function siteLabel(base: string): string {
  const host = new URL(base).hostname.toLowerCase();
  if (host.endsWith('kicktipp.de')) return 'de';
  if (host.endsWith('kicktipp.com')) return 'com';
  return normalizeBaseUrl(base);
}

let currentBase = resolveBaseUrl();

export function setUrlBase(base: string): void {
  currentBase = normalizeBaseUrl(base);
}

export function urlBase(): string {
  return currentBase;
}

function routePath(route: RouteKey, community?: string, base = urlBase()): string {
  const template = ROUTES[route][languageForBase(base)];
  if (!template.includes(':community')) return template;
  if (!community) throw new Error(`Community is required for route '${route}'.`);
  return template.replace(':community', encodeURIComponent(community));
}

function buildUrl(
  route: RouteKey,
  community?: string,
  params?: URLSearchParams,
  base = urlBase(),
): string {
  const url = new URL(routePath(route, community, base), base);
  if (params) {
    for (const [key, value] of params) url.searchParams.append(key, value);
  }
  return url.toString();
}

function assertMatchday(matchday: number): void {
  if (!Number.isInteger(matchday) || matchday < 1 || matchday > 34) {
    throw new RangeError(`The matchday '${matchday}' is not valid, use only 1 to 34!`);
  }
}

function matchdayParams(matchday?: number, extra?: Record<string, string>): URLSearchParams {
  const params = new URLSearchParams(extra);
  if (matchday !== undefined) {
    assertMatchday(matchday);
    params.set('spieltagIndex', String(matchday));
  }
  return params;
}

export function urlLogin(): string {
  return buildUrl('login');
}

export function getCommunitiesUrl(): string {
  return buildUrl('communities');
}

export function getPredictUrl(community: string, matchday?: number): string {
  return buildUrl('predict', community, matchdayParams(matchday));
}

export function getBonusPredictUrl(community: string): string {
  return buildUrl('predict', community, new URLSearchParams({ bonus: 'true' }));
}

export function getLeaderboardUrl(community: string, matchday?: number, bonus = false): string {
  return buildUrl('leaderboard', community, matchdayParams(matchday, bonus ? { bonus: 'true' } : undefined));
}

export function getScheduleUrl(community: string, matchday?: number): string {
  return buildUrl('schedule', community, matchdayParams(matchday));
}

export function getOverviewUrl(community: string, ansicht: string): string {
  return buildUrl('overview', community, new URLSearchParams({ ansicht }));
}

export function getTableUrl(community: string, option?: 'home' | 'away'): string {
  const params = new URLSearchParams();
  if (option === 'home') params.set('option', 'heim');
  else if (option === 'away') params.set('option', 'gast');
  return buildUrl('table', community, params);
}

export function getRulesUrl(community: string): string {
  return buildUrl('rules', community);
}

export function getAdminMembersUrl(community: string): string {
  return buildUrl('adminMembers', community);
}

export function getAdminTipsUrl(
  community: string,
  tipperId: string,
  tippsaisonId: string,
  matchday?: number,
  bonus = false,
): string {
  const params = new URLSearchParams({ tipperId, tippsaisonId });
  if (bonus) params.set('bonus', 'true');
  if (matchday !== undefined) {
    assertMatchday(matchday);
    params.set('spieltagIndex', String(matchday));
  }
  return buildUrl('adminTips', community, params);
}

function allSpellings(route: Route): string[] {
  return [route.de, route.en, ...(route.aliases || [])];
}

// Given a pathname, return every known spelling of the same page.
function pathVariants(pathname: string): string[] {
  const parts = pathname.split('/').filter(Boolean);
  if (!parts.length) return [pathname];

  for (const route of Object.values(ROUTES)) {
    const spellings = allSpellings(route);

    if (!route.de.includes(':community')) {
      if (spellings.includes(pathname)) return spellings;
      continue;
    }

    // Community routes: the first segment is the community, the rest
    // identifies the page. Keep the segment exactly as given — it is
    // already percent-encoded.
    const community = parts[0];
    const tail = `/${parts.slice(1).join('/')}`;
    const tails = spellings.map((s) => s.replace('/:community', ''));
    if (tails.includes(tail)) {
      return tails.map((t) => `/${community}${t}`);
    }
  }

  return [pathname];
}

/**
 * Equivalent URLs for a page on the other host and in the other language,
 * used as fallbacks when Kicktipp answers "page not found". The input URL
 * is never included in the result.
 */
export function getAlternateUrls(rawUrl: string): string[] {
  const current = new URL(rawUrl);
  const bases = [
    normalizeBaseUrl(current.origin),
    oppositeBase(current.origin),
    urlBase(),
    oppositeBase(urlBase()),
  ];
  const paths = pathVariants(current.pathname);

  const urls: string[] = [];
  for (const base of new Set(bases)) {
    for (const path of paths) {
      const url = new URL(path, base);
      url.search = current.search;
      const next = url.toString();
      if (next !== rawUrl && !urls.includes(next)) urls.push(next);
    }
  }
  return urls;
}
