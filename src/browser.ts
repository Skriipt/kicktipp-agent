import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import fs from 'fs';
import { URL_LOGIN, getCommunitiesUrl, getLeaderboardUrl } from './url.js';
import { sessionFile, loadCredentials } from './config.js';
import { status, statusClear } from './helpers/spinner.js';
import { normalizeSlug } from './helpers/normalize-slug.js';
import { CookieJar } from './http/cookie-jar.js';
import { Page } from './http/page.js';
import type { FetchLike } from './http/page.js';

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
export async function launchBrowser(opts: LaunchOptions = {}): Promise<{ page: Page }> {
  const file = opts.sessionFile === undefined ? sessionFile() : opts.sessionFile;

  if (file && fs.existsSync(file)) {
    status('Restoring session...');
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const page = new Page(CookieJar.fromJSON(stored), opts.fetchImpl);
      await page.goto(getCommunitiesUrl());
      if (!page.isAuthRedirect() && !page.isNotFound()) {
        statusClear();
        return { page };
      }
    } catch {
      // An unreadable or outdated session file is not worth reporting —
      // logging in again produces a good one.
    }
    status('Session expired, logging in again...');
  }

  statusClear();
  const { email, password } = await loadCredentials();
  const page = new Page(new CookieJar(), opts.fetchImpl);
  await login(page, email, password);
  if (file) page.saveSession(file);
  return { page };
}

async function login(page: Page, username: string, password: string): Promise<void> {
  status('Logging in...');
  await page.goto(URL_LOGIN);

  if (!page.has('input[name="kennung"]')) {
    statusClear();
    throw new Error(`Kicktipp login form not found at ${page.url()}.`);
  }

  page.setInputValue('input[name="kennung"]', username);
  page.setInputValue('input[name="passwort"]', password);
  await page.submitForm('input[name="kennung"]');

  // A failed login lands back on the login page.
  if (page.isAuthRedirect()) {
    statusClear();
    throw new Error('Login failed. Check your credentials (use --logout to re-enter).');
  }
  statusClear();
}

export async function getCommunities(page: Page): Promise<string[]> {
  status('Fetching communities...');
  await page.goto(getCommunitiesUrl());
  if (page.isAuthRedirect()) {
    statusClear();
    throw new Error(
      `Kicktipp session is not authenticated (redirected to ${page.url()}). Verify credentials.`,
    );
  }

  const $ = cheerio.load(await page.content());
  const communities = new Set<string>();
  // A community link is a single path segment ("/<slug>" or "/<slug>/") whose
  // slug matches the link's own label. Kicktipp derives the slug from the
  // community name — dropping underscores and turning spaces into hyphens —
  // so the comparison has to be made on normalized forms.
  const reserved = new Set(['info', 'service']);
  $('#kicktipp-content a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const match = href.match(/^\/([^/?#]+)\/?$/);
    if (!match) return;
    const slug = decodeURIComponent(match[1]);
    if (reserved.has(slug.toLowerCase())) return;
    const menuDiv = $(el).find('div.menu-title-mit-tippglocke');
    if (
      normalizeSlug(slug) === normalizeSlug($(el).text().trim()) ||
      (menuDiv.length && normalizeSlug(menuDiv.text().trim()) === normalizeSlug(slug))
    ) {
      communities.add(slug);
    }
  });
  statusClear();
  return Array.from(communities);
}

export function parseOdds($: cheerio.CheerioAPI, td: AnyNode): [string, string, string] {
  const el = $(td);
  const home = el.find('span.quote-heim span.quote-text').text().trim();
  const draw = el.find('span.quote-remis span.quote-text').text().trim();
  const road = el.find('span.quote-gast span.quote-text').text().trim();
  return [home, draw, road];
}

export async function getPlayers(page: Page, community: string): Promise<string[]> {
  status('Fetching players...');
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
