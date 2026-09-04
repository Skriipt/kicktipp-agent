import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import fs from 'fs';
import { urlLogin, getCommunitiesUrl, getLeaderboardUrl } from './url.js';
import {
  getActiveProfile,
  sessionFile,
  loadCredentials,
  loadProfileCredentials,
  isSessionOnly,
  isProfileSessionOnly,
  SessionOnlyExpiredError,
} from './config.js';
import { status, statusClear } from './helpers/spinner.js';
import { t } from './i18n/index.js';
import { normalizeSlug } from './helpers/normalize-slug.js';
import { CookieJar } from './http/cookie-jar.js';
import { Page } from './http/page.js';
import type { FetchLike } from './http/page.js';
import { withAuthProfileMutation } from './auth-profile-lock.js';

export { Page } from './http/page.js';
export type { FetchLike } from './http/page.js';

export interface LaunchOptions {
  /** Explicit Auth Profile. Omit to preserve interactive active-profile behavior. */
  profileId?: string;
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
  const profileId = opts.profileId === undefined ? getActiveProfile() : opts.profileId;
  const file = opts.sessionFile === undefined ? sessionFile(profileId) : opts.sessionFile;

  const restoreSession = async (): Promise<Page | null> => {
    if (!file || !fs.existsSync(file)) return null;
    status(t('status.restoringSession'));
    let page: Page;
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf-8'));
      page = new Page(CookieJar.fromJSON(stored), opts.fetchImpl);
    } catch {
      return null;
    }
    try {
      await page.goto(getCommunitiesUrl());
    } catch (error) {
      await page.close();
      statusClear();
      throw error;
    }
    if (!page.isAuthRedirect() && !page.isNotFound()) {
      statusClear();
      return page;
    }
    await page.close();
    status(t('status.sessionExpired'));
    return null;
  };

  const restored = await restoreSession();
  if (restored) return restored;

  return withAuthProfileMutation(profileId, async () => {
    // Another process may have refreshed this profile while we waited.
    const refreshed = await restoreSession();
    if (refreshed) return refreshed;

    const sessionOnly = opts.profileId === undefined
      ? isSessionOnly()
      : isProfileSessionOnly(opts.profileId);
    if (sessionOnly) {
      statusClear();
      throw new SessionOnlyExpiredError();
    }

    statusClear();
    const { email, password } = opts.profileId === undefined
      ? await loadCredentials()
      : await loadProfileCredentials(opts.profileId);
    const page = new Page(new CookieJar(), opts.fetchImpl);
    await login(page, email, password);
    if (file) page.saveSession(file);
    return page;
  });
}

/** Persist a newly authenticated interactive session through its profile lock. */
export async function saveProfileSession(page: Page, profileId = getActiveProfile()): Promise<void> {
  await withAuthProfileMutation(profileId, () => page.saveSession(sessionFile(profileId)));
}

export async function login(page: Page, username: string, password: string): Promise<void> {
  status(t('status.loggingIn'));
  await page.goto(urlLogin());

  if (!page.has('input[name="kennung"]')) {
    statusClear();
    throw new Error(t('login.formMissing', { url: page.url() }));
  }

  page.setInputValue('input[name="kennung"]', username);
  page.setInputValue('input[name="passwort"]', password);
  await page.submitForm('input[name="kennung"]');

  // A failed login lands back on the login page.
  if (page.isAuthRedirect()) {
    statusClear();
    throw new Error(t('login.failed'));
  }
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
  status(t('status.fetchingCommunities'));
  await page.goto(getCommunitiesUrl());
  if (page.isAuthRedirect()) {
    statusClear();
    throw new Error(
      t('login.notAuthenticated', { url: page.url() }),
    );
  }

  const communities = parseCommunitiesHtml(await page.content());
  statusClear();
  return communities;
}

export function parseOdds($: cheerio.CheerioAPI, td: AnyNode): [string, string, string] {
  const el = $(td);
  const home = el.find('span.quote-heim span.quote-text').text().trim();
  const draw = el.find('span.quote-remis span.quote-text').text().trim();
  const road = el.find('span.quote-gast span.quote-text').text().trim();
  return [home, draw, road];
}

export async function getPlayers(page: Page, community: string): Promise<string[]> {
  status(t('status.fetchingPlayers'));
  await page.goto(getLeaderboardUrl(community));
  statusClear();

  const $ = cheerio.load(await page.content());
  const players: string[] = [];
  $('table#ranking tbody tr').each((_, tr) => {
    const name = $(tr).find('div.mg_name').text().trim();
    if (name) players.push(name);
  });
  return players;
}
