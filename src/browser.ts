import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import fs from 'fs';
import { urlLogin, getCommunitiesUrl, getLeaderboardUrl } from './url.js';
import { sessionFile, loadCredentials, isSessionOnly, SessionOnlyExpiredError } from './config.js';
import { status, statusClear } from './helpers/spinner.js';
import { t } from './i18n/index.js';
import { normalizeSlug } from './helpers/normalize-slug.js';
import { CookieJar } from './http/cookie-jar.js';
import { Page } from './http/page.js';
import type { FetchLike } from './http/page.js';
import { assertReadable, AuthError, NotFoundError } from './http/response.js';

export { Page } from './http/page.js';
export type { FetchLike } from './http/page.js';

export interface LaunchOptions {
  /** Where to persist cookies. Pass null to keep the session in memory only. */
  sessionFile?: string | null;
  /** Injection point for tests. */
  fetchImpl?: FetchLike;
}

/**
 * Open an authenticated Kicktipp session: restore the saved cookies when
 * they still work, otherwise log in and save fresh ones.
 */
export async function launchBrowser(opts: LaunchOptions = {}): Promise<Page> {
  const file = opts.sessionFile === undefined ? sessionFile() : opts.sessionFile;

  if (file && fs.existsSync(file)) {
    status(t('status.restoringSession'));
    let restored: Page | null = null;
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf-8'));
      restored = new Page(CookieJar.fromJSON(stored), opts.fetchImpl);
    } catch {
      // An unreadable or outdated session file is not worth reporting —
      // logging in again produces a good one.
    }
    if (restored) {
      try {
        await getCommunities(restored);
        statusClear();
        return restored;
      } catch (error) {
        await restored.close();
        statusClear();
        // A transient server/transport failure is not evidence of an expired
        // login, and must not cause a credential POST or an empty success.
        if (!(error instanceof AuthError) && !(error instanceof NotFoundError)) throw error;
      }
    }
    status(t('status.sessionExpired'));
  }

  if (isSessionOnly()) {
    statusClear();
    throw new SessionOnlyExpiredError();
  }

  statusClear();
  const { email, password } = await loadCredentials();
  const page = new Page(new CookieJar(), opts.fetchImpl);
  await login(page, email, password);
  // Interactive credential entry can change the account storage scope.
  const saveFile = opts.sessionFile === undefined ? sessionFile() : opts.sessionFile;
  if (saveFile) page.saveSession(saveFile);
  return page;
}

export async function login(page: Page, username: string, password: string): Promise<void> {
  return page.runExclusive(() => loginUnlocked(page, username, password));
}

async function loginUnlocked(page: Page, username: string, password: string): Promise<void> {
  status(t('status.loggingIn'));
  await page.goto(urlLogin());

  if (page.status() < 200 || page.status() >= 300) {
    statusClear();
    throw new Error(`Kicktipp HTTP ${page.status()} while loading the login form.`);
  }

  if (!page.has('input[name="kennung"]')) {
    statusClear();
    throw new Error(t('login.formMissing', { url: page.url() }));
  }

  page.setInputValue('input[name="kennung"]', username);
  page.setInputValue('input[name="passwort"]', password);
  await page.submitForm('input[name="kennung"]');

  // A failed login lands back on the login page.
  if (page.isAuthRedirect() || page.has('input[type="password"]')) {
    statusClear();
    throw new AuthError(t('login.failed'));
  }
  assertReadable(page, page.url());
  statusClear();
}

export function parseCommunitiesHtml(html: string): string[] {
  const $ = cheerio.load(html);
  const communities = new Set<string>();
  const reserved = new Set(['info', 'service']);
  $('#kicktipp-content a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const match = href.match(/^\/([^/?#]+)\/?$/);
    if (!match) return;
    let slug: string;
    try {
      slug = decodeURIComponent(match[1]);
    } catch {
      return;
    }
    if (reserved.has(slug.toLowerCase())) return;
    const menuDiv = $(el).find('div.menu-title-mit-tippglocke');
    if (
      normalizeSlug(slug) === normalizeSlug($(el).text().trim()) ||
      (menuDiv.length &&
        normalizeSlug(menuDiv.text().trim()) === normalizeSlug(slug))
    ) {
      communities.add(slug);
    }
  });
  return Array.from(communities);
}

export async function getCommunities(page: Page): Promise<string[]> {
  return page.runExclusive(async () => {
  status(t('status.fetchingCommunities'));
  await page.goto(getCommunitiesUrl());
  assertReadable(page, getCommunitiesUrl());

  const communities = parseCommunitiesHtml(await page.content());
  statusClear();
  return communities;
  });
}

export function parseOdds($: cheerio.CheerioAPI, td: AnyNode): [string, string, string] {
  const el = $(td);
  const home = el.find('span.quote-heim span.quote-text').text().trim();
  const draw = el.find('span.quote-remis span.quote-text').text().trim();
  const road = el.find('span.quote-gast span.quote-text').text().trim();
  return [home, draw, road];
}

export async function getPlayers(page: Page, community: string): Promise<string[]> {
  return page.runExclusive(async () => {
  status(t('status.fetchingPlayers'));
  await page.goto(getLeaderboardUrl(community));
  assertReadable(page, getLeaderboardUrl(community));
  statusClear();

  const $ = cheerio.load(await page.content());
  const players: string[] = [];
  $('table#ranking tbody tr').each((_, tr) => {
    const name = $(tr).find('div.mg_name').text().trim();
    if (name) players.push(name);
  });
  return players;
  });
}
