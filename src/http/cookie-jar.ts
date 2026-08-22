import { URL_BASE } from '../url.js';

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
}

export interface StoredSession {
  cookies?: StoredCookie[];
}

const KICKTIPP_HOST = /(^|\.)kicktipp\.(de|com)$/i;
const BASE_HOST = new URL(URL_BASE).hostname.toLowerCase();

/**
 * Session cookies are only ever stored for, and sent to, Kicktipp's own
 * hosts (plus whatever KICKTIPP_BASE_URL points at). A redirect that leaves
 * those hosts is still followed, but without carrying the session along.
 */
export function isAllowedHost(host: string): boolean {
  const h = host.toLowerCase();
  return KICKTIPP_HOST.test(h) || h === BASE_HOST;
}

type HeaderBag = Headers & { getSetCookie?: () => string[] };

/**
 * Split a comma-joined Set-Cookie header. Only split where the next segment
 * actually starts a new `name=` pair, so the comma inside an
 * `Expires=Thu, 01 Jan 1970 ...` date does not tear the cookie in half.
 * Node >= 18.14 exposes getSetCookie() and never needs this.
 */
export function splitSetCookie(value: string): string[] {
  if (!value) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value.slice(i, i + 2) !== ', ') continue;
    if (/^[^=;,]+=/.test(value.slice(i + 2))) {
      out.push(value.slice(start, i));
      start = i + 2;
    }
  }
  out.push(value.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

function setCookieValues(headers: Headers): string[] {
  const bag = headers as HeaderBag;
  if (typeof bag.getSetCookie === 'function') return bag.getSetCookie();
  return splitSetCookie(bag.get('set-cookie') || '');
}

function isDeletion(attributes: string[]): boolean {
  for (const attr of attributes) {
    const eq = attr.indexOf('=');
    if (eq === -1) continue;
    const key = attr.slice(0, eq).trim().toLowerCase();
    const value = attr.slice(eq + 1).trim();
    if (key === 'max-age') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds <= 0) return true;
    }
    if (key === 'expires') {
      const when = Date.parse(value);
      if (Number.isFinite(when) && when <= Date.now()) return true;
    }
  }
  return false;
}

// A Domain attribute is only honored when the responding host actually
// belongs to it — otherwise a host could set cookies for unrelated domains.
function domainFor(attributes: string[], host: string): string {
  for (const attr of attributes) {
    const eq = attr.indexOf('=');
    if (eq === -1) continue;
    if (attr.slice(0, eq).trim().toLowerCase() !== 'domain') continue;
    const domain = attr.slice(eq + 1).trim().replace(/^\./, '').toLowerCase();
    if (!domain) continue;
    if (!isAllowedHost(domain)) continue;
    if (host === domain || host.endsWith(`.${domain}`)) return domain;
  }
  return host;
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * A deliberately small cookie store: name/value pairs scoped by domain.
 * Path scoping is not modelled — Kicktipp serves its session cookies for
 * the whole site — but host scoping is, because that is what keeps a
 * session from leaking to another host across a redirect.
 */
export class CookieJar {
  private byDomain = new Map<string, Map<string, string>>();

  static fromJSON(raw: unknown): CookieJar {
    const jar = new CookieJar();
    const cookies = (raw as StoredSession | null)?.cookies;
    if (!Array.isArray(cookies)) return jar;
    for (const cookie of cookies) {
      if (!cookie?.name || cookie.value === undefined) continue;
      // Playwright's storageState files land here too: same shape, with a
      // leading-dot domain. Anything without a usable domain is dropped.
      const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
      if (!domain || !isAllowedHost(domain)) continue;
      jar.set(domain, cookie.name, String(cookie.value));
    }
    return jar;
  }

  private set(domain: string, name: string, value: string): void {
    let bucket = this.byDomain.get(domain);
    if (!bucket) {
      bucket = new Map<string, string>();
      this.byDomain.set(domain, bucket);
    }
    bucket.set(name, value);
  }

  store(requestUrl: string, headers: Headers): void {
    const host = new URL(requestUrl).hostname.toLowerCase();
    if (!isAllowedHost(host)) return;

    for (const raw of setCookieValues(headers)) {
      const segments = raw.split(';');
      const pair = segments[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) continue;

      const attributes = segments.slice(1);
      const domain = domainFor(attributes, host);
      if (isDeletion(attributes)) {
        this.byDomain.get(domain)?.delete(name);
      } else {
        this.set(domain, name, value);
      }
    }
  }

  /** The Cookie header for a request, or '' when nothing may be sent. */
  header(requestUrl: string): string {
    const host = new URL(requestUrl).hostname.toLowerCase();
    if (!isAllowedHost(host)) return '';

    // Apply the least specific domain first so a host-only cookie wins over
    // a same-named cookie set for the parent domain.
    const applicable = Array.from(this.byDomain.entries())
      .filter(([domain]) => hostMatches(host, domain))
      .sort((a, b) => a[0].length - b[0].length);

    const merged = new Map<string, string>();
    for (const [, cookies] of applicable) {
      for (const [name, value] of cookies) merged.set(name, value);
    }
    return Array.from(merged, ([name, value]) => `${name}=${value}`).join('; ');
  }

  toJSON(): StoredSession {
    const cookies: StoredCookie[] = [];
    for (const [domain, bucket] of this.byDomain) {
      for (const [name, value] of bucket) cookies.push({ name, value, domain });
    }
    return { cookies };
  }

  get size(): number {
    let total = 0;
    for (const bucket of this.byDomain.values()) total += bucket.size;
    return total;
  }
}
