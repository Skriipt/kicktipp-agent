import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { urlBase, getAlternateUrls } from '../url.js';
import { CookieJar } from './cookie-jar.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const MAX_REDIRECTS = 8;

// Kicktipp bounces unauthenticated requests to its login page.
const LOGIN_URL_PATTERN = /\/(profil|profile)\/login(\?|$|\/)/i;
// Spielleiter-only pages redirect to the login page with this marker.
const ADMIN_REQUIRED_PATTERN = /[?&]spielleiter=1\b/i;
const NOT_FOUND_PATTERN = /Seite\s+wurde\s+nicht\s+gefunden|Page\s+not\s+found/i;

const DEFAULT_HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
  'User-Agent': 'kicktipp-agent (+https://github.com/Skriipt/kicktipp-agent)',
};

function charsetFromContentType(contentType: string | null): string | null {
  const match = contentType?.match(/charset=["']?([\w-]+)/i);
  return match ? match[1] : null;
}

function charsetFromMeta(bytes: Uint8Array): string | null {
  // The declaration is ASCII either way, so a latin1 peek at the head of the
  // document is enough to find it.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const match =
    head.match(/<meta[^>]+charset=["']?([\w-]+)/i) ||
    head.match(/<meta[^>]+content=["'][^"']*charset=([\w-]+)/i);
  return match ? match[1] : null;
}

/**
 * Decode a response body by its declared charset. Response.text() always
 * assumes UTF-8, which would quietly mangle the umlauts in team and player
 * names if Kicktipp ever answered in a legacy encoding.
 */
async function decodeBody(res: Response): Promise<string> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const charset =
    charsetFromContentType(res.headers.get('content-type')) ||
    charsetFromMeta(bytes) ||
    'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * Fetches server-rendered
 * Kicktipp pages, keeps cookies, follows redirects, and can fill in and
 * submit the forms on the page. Only the surface the CLI and MCP server
 * actually used is implemented.
 */
export class Page {
  private currentUrl = urlBase();
  private html = '';
  private $dom: cheerio.CheerioAPI | null = null;
  private lastStatus = 0;
  private closed = false;

  constructor(
    readonly jar: CookieJar = new CookieJar(),
    private readonly fetchImpl: FetchLike = ((input, init) =>
      fetch(input, init)) as FetchLike,
  ) {}

  // ── Navigation ───────────────────────────────────────────────────

  async goto(url: string): Promise<void> {
    this.ensureOpen();
    const target = this.absoluteUrl(url);
    await this.navigate('GET', target);
    if (!this.isNotFound()) return;

    // Some communities only exist on one host, or only under the German
    // route spelling. Try the equivalents before giving up.
    for (const alternate of getAlternateUrls(target)) {
      await this.navigate('GET', alternate);
      if (!this.isNotFound()) return;
    }
  }

  private async navigate(
    method: 'GET' | 'POST',
    url: string,
    body?: URLSearchParams,
    referer?: string,
  ): Promise<void> {
    let currentUrl = url;
    let currentMethod = method;
    let currentBody = body;
    let currentReferer = referer;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const headers = new Headers(DEFAULT_HEADERS);
      const cookie = this.jar.header(currentUrl);
      if (cookie) headers.set('Cookie', cookie);
      if (currentReferer) headers.set('Referer', currentReferer);
      if (currentMethod === 'POST') {
        headers.set('Content-Type', 'application/x-www-form-urlencoded');
      }

      const res = await this.fetchImpl(currentUrl, {
        method: currentMethod,
        headers,
        body: currentMethod === 'POST' ? currentBody : undefined,
        redirect: 'manual',
      });
      this.jar.store(currentUrl, res.headers);

      const location = res.headers.get('location');
      if (location && [301, 302, 303, 307, 308].includes(res.status)) {
        currentReferer = currentUrl;
        currentUrl = this.absoluteUrl(location, currentUrl);
        // 301/302/303 turn the follow-up into a GET; 307/308 keep the method.
        if (![307, 308].includes(res.status)) {
          currentMethod = 'GET';
          currentBody = undefined;
        }
        continue;
      }

      this.currentUrl = currentUrl;
      this.lastStatus = res.status;
      this.html = await decodeBody(res);
      this.$dom = cheerio.load(this.html);
      return;
    }

    throw new Error(`Too many redirects while requesting ${url}`);
  }

  // ── Reading ──────────────────────────────────────────────────────

  async content(): Promise<string> {
    this.ensureOpen();
    return this.$dom ? this.$dom.html() : this.html;
  }

  url(): string {
    return this.currentUrl;
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** True when the last response was Kicktipp's "page not found". */
  isNotFound(): boolean {
    return this.lastStatus === 404 || NOT_FOUND_PATTERN.test(this.html);
  }

  /** True when the last response bounced us to the login page. */
  isAuthRedirect(): boolean {
    return LOGIN_URL_PATTERN.test(this.currentUrl);
  }

  /** True when the login bounce carried the Spielleiter-required marker. */
  isAdminRequired(): boolean {
    return this.isAuthRedirect() && ADMIN_REQUIRED_PATTERN.test(this.currentUrl);
  }

  has(selector: string): boolean {
    return this.find(selector).length > 0;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  // ── Mutating the current page ────────────────────────────────────

  setInputValue(selector: string, value: string): void {
    this.ensureOpen();
    const input = this.find(selector);
    if (!input.length) throw new Error(`Input not found: ${selector}`);
    input.attr('value', value);
  }

  async selectOption(selector: string, value: string): Promise<void> {
    this.ensureOpen();
    const $ = this.dom();
    const select = this.find(selector);
    if (!select.length) throw new Error(`Select not found: ${selector}`);
    const option = select
      .find('option')
      .filter((_, el) => ($(el).attr('value') || '') === value)
      .first();
    if (!option.length) {
      throw new Error(`Option value "${value}" not found for ${selector}`);
    }
    if (select.attr('multiple') === undefined) {
      select.find('option').removeAttr('selected');
    }
    option.attr('selected', 'selected');
  }

  // ── Submitting ───────────────────────────────────────────────────

  /** Submit the form containing `selector`, using it as the submitter. */
  async click(selector: string): Promise<void> {
    this.ensureOpen();
    const submitter = this.find(selector);
    if (!submitter.length) throw new Error(`Element not found: ${selector}`);
    await this.submit(submitter.closest('form'), submitter);
  }

  /**
   * Submit the form that contains `anchorSelector`, picking the form's own
   * submit button as the submitter. Used where the button has no stable
   * selector of its own.
   */
  async submitForm(anchorSelector: string): Promise<void> {
    this.ensureOpen();
    const anchor = this.find(anchorSelector);
    if (!anchor.length) throw new Error(`Element not found: ${anchorSelector}`);
    const form = anchor.closest('form');
    if (!form.length) throw new Error(`${anchorSelector} is not inside a form.`);
    const submitter = form
      .find('button[type="submit"], input[type="submit"], button[name], button')
      .first();
    await this.submit(form, submitter);
  }

  private async submit(
    form: cheerio.Cheerio<AnyNode>,
    submitter: cheerio.Cheerio<AnyNode>,
  ): Promise<void> {
    if (!form.length) throw new Error('Submit target is not inside a form.');
    const method = (form.attr('method') || 'get').toLowerCase();
    const action = this.absoluteUrl(form.attr('action') || this.currentUrl);
    const body = this.serializeForm(form, submitter);

    if (method === 'post') {
      await this.navigate('POST', action, body, this.currentUrl);
      return;
    }
    const target = new URL(action);
    for (const [key, value] of body) target.searchParams.append(key, value);
    await this.navigate('GET', target.toString(), undefined, this.currentUrl);
  }

  /** Serialize a form the way a browser would for urlencoded submission. */
  private serializeForm(
    form: cheerio.Cheerio<AnyNode>,
    submitter: cheerio.Cheerio<AnyNode>,
  ): URLSearchParams {
    const $ = this.dom();
    const body = new URLSearchParams();
    const submitterNode = submitter.get(0);

    form.find('input, select, textarea, button').each((_, node) => {
      const el = $(node);
      const tag = (node as Element).tagName.toLowerCase();
      const name = el.attr('name');
      if (!name || el.attr('disabled') !== undefined) return;

      if (tag === 'button') {
        // Only the button that submitted the form contributes a value.
        if (node === submitterNode) body.append(name, el.attr('value') || '');
        return;
      }

      if (tag === 'textarea') {
        body.append(name, el.text());
        return;
      }

      if (tag === 'select') {
        let selected = el.find('option[selected]');
        if (!selected.length && el.attr('multiple') === undefined) {
          selected = el.find('option').first();
        }
        selected.each((__, option) => {
          const opt = $(option);
          body.append(name, opt.attr('value') ?? opt.text());
        });
        return;
      }

      const type = (el.attr('type') || 'text').toLowerCase();
      if (['button', 'image', 'reset', 'file'].includes(type)) return;
      if (['checkbox', 'radio'].includes(type) && el.attr('checked') === undefined) return;
      if (type === 'submit') {
        if (node === submitterNode) body.append(name, el.attr('value') || '');
        return;
      }
      body.append(name, el.attr('value') || '');
    });

    return body;
  }

  // ── Session persistence ──────────────────────────────────────────

  saveSession(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmpFile = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(this.jar.toJSON(), null, 2), { mode: 0o600 });
      fs.renameSync(tmpFile, file);
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  }

  // ── Internals ────────────────────────────────────────────────────

  private find(selector: string): cheerio.Cheerio<AnyNode> {
    return this.dom()(selector).first();
  }

  private dom(): cheerio.CheerioAPI {
    this.ensureOpen();
    if (!this.$dom) this.$dom = cheerio.load(this.html);
    return this.$dom;
  }

  private absoluteUrl(url: string, base = this.currentUrl || urlBase()): string {
    return new URL(url, base).toString();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('Kicktipp session is closed.');
  }
}
