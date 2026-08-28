import { describe, it, expect } from 'vitest';
import { Page } from '../src/http/page.js';
import { CookieJar } from '../src/http/cookie-jar.js';
import { AuthError, NotFoundError, AdminRequiredError, fetchRules } from '../src/core.js';
import { mockFetch, routes, page as htmlPage, type Handler } from './helpers/mock-fetch.js';

const BASE = 'https://www.kicktipp.com';

function pageWith(handler: Handler): Page {
  return new Page(new CookieJar(), mockFetch(handler).fetchImpl);
}

describe('loadPage error classification', () => {
  it('parses a healthy page', async () => {
    const page = pageWith(routes({
      [`${BASE}/c/rules`]: htmlPage(
        '<div id="kicktipp-content"><div class="pagecontent"><h2>Punkte</h2></div></div>',
      ),
    }));

    await expect(fetchRules(page, 'c')).resolves.toEqual([
      { type: 'heading', text: 'Punkte' },
    ]);
  });

  it('raises AuthError when Kicktipp bounces to the login page', async () => {
    const page = pageWith(routes({
      [`${BASE}/c/rules`]: { status: 302, location: '/info/profil/login' },
      [`${BASE}/info/profil/login`]: htmlPage('<form></form>'),
    }));

    await expect(fetchRules(page, 'c')).rejects.toBeInstanceOf(AuthError);
  });

  it('raises AdminRequiredError for a Spielleiter-only page', async () => {
    const page = pageWith(routes({
      [`${BASE}/c/rules`]: { status: 302, location: '/info/profil/login?spielleiter=1' },
      [`${BASE}/info/profil/login?spielleiter=1`]: htmlPage('<form></form>'),
    }));

    const error = await fetchRules(page, 'c').catch((e) => e);
    expect(error).toBeInstanceOf(AdminRequiredError);
    // An admin-rights problem must not be mistaken for a broken session.
    expect(error).not.toBeInstanceOf(AuthError);
  });

  it('raises NotFoundError — not AuthError — for an unknown community', async () => {
    // Every spelling on every host is missing, i.e. the community is wrong.
    const page = pageWith(() => undefined);

    const error = await fetchRules(page, 'typo').catch((e) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).not.toBeInstanceOf(AuthError);
    expect(String(error)).toMatch(/community name/i);
  });

  it('does not raise when a fallback spelling exists', async () => {
    const page = pageWith(routes({
      [`${BASE}/c/spielregeln`]: htmlPage(
        '<div id="kicktipp-content"><div class="pagecontent"><h2>Regeln</h2></div></div>',
      ),
    }));

    await expect(fetchRules(page, 'c')).resolves.toEqual([
      { type: 'heading', text: 'Regeln' },
    ]);
  });
});
