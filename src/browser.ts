import { chromium, Page, Browser, BrowserContext } from 'playwright';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import fs from 'fs';
import path from 'path';
import { URL_BASE, URL_LOGIN, getLeaderboardUrl } from './url.js';
import { SESSION_FILE, loadCredentials } from './config.js';
import { status, statusClear } from './helpers/spinner.js';

export async function launchBrowser(): Promise<{ browser: Browser; page: Page; context: BrowserContext }> {
  const browser = await chromium.launch({ headless: true });

  // Try restoring session
  if (fs.existsSync(SESSION_FILE)) {
    status('Restoring session...');
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      storageState: SESSION_FILE,
    });
    const page = await context.newPage();
    await page.goto(URL_BASE);
    await page.waitForLoadState('domcontentloaded');
    if (!page.url().includes('/login')) {
      statusClear();
      return { browser, page, context };
    }
    status('Session expired, logging in again...');
    await context.close();
  }

  // Fresh login
  const { email, password } = await loadCredentials();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await login(page, email, password);
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  await context.storageState({ path: SESSION_FILE });
  fs.chmodSync(SESSION_FILE, 0o600);
  return { browser, page, context };
}

export async function dismissConsent(page: Page): Promise<void> {
  try {
    await page.waitForSelector('iframe[src*="privacy-mgmt"]', { timeout: 2000 });
    for (const frame of page.frames()) {
      const btn = await frame.$('button:has-text("Accept and continue")');
      if (btn) {
        await btn.click();
        await page.waitForSelector('iframe[src*="privacy-mgmt"]', { state: 'hidden', timeout: 3000 });
        return;
      }
    }
  } catch {
    /* no consent dialog */
  }
}

async function login(page: Page, username: string, password: string): Promise<void> {
  status('Logging in...');
  await page.goto(URL_LOGIN);
  await page.waitForLoadState('domcontentloaded');
  await dismissConsent(page);
  await page.fill('input[name="kennung"]', username);
  await page.fill('input[name="passwort"]', password);
  await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
  if (page.url().includes('/login')) {
    statusClear();
    console.error('Login failed. Check your credentials (use --logout to re-enter).');
    process.exit(1);
  }
  statusClear();
}

export async function getCommunities(page: Page): Promise<string[]> {
  status('Fetching communities...');
  await page.goto(`${URL_BASE}/info/profil/meinetipprunden`);
  await page.waitForLoadState('domcontentloaded');
  await dismissConsent(page);

  const $ = cheerio.load(await page.content());
  const links = $('#kicktipp-content a');
  const communities: string[] = [];
  links.each((_, el) => {
    const href = ($(el).attr('href') || '').replace(/\//g, '');
    const text = $(el).text().trim();
    const menuDiv = $(el).find('div.menu-title-mit-tippglocke');
    if (
      href.toLowerCase() === text.toLowerCase() ||
      (menuDiv.length && menuDiv.text().trim().toLowerCase() === href.toLowerCase())
    ) {
      communities.push(href);
    }
  });
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
  status('Fetching players...');
  await page.goto(getLeaderboardUrl(community));
  await page.waitForLoadState('domcontentloaded');
  await dismissConsent(page);
  statusClear();

  const $ = cheerio.load(await page.content());
  const players: string[] = [];
  $('table#ranking tbody tr').each((_, tr) => {
    const name = $(tr).find('div.mg_name').text().trim();
    if (name) players.push(name);
  });
  return players;
}
