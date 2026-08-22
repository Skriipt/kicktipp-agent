import { describe, it, expect } from 'vitest';
import { CookieJar, splitSetCookie, isAllowedHost } from '../src/http/cookie-jar.js';

const COM = 'https://www.kicktipp.com/';
const DE = 'https://www.kicktipp.de/';

function headers(...setCookies: string[]): Headers {
  const h = new Headers();
  for (const value of setCookies) h.append('set-cookie', value);
  return h;
}

describe('splitSetCookie', () => {
  it('keeps a comma inside an Expires date intact', () => {
    expect(
      splitSetCookie('sid=abc; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/'),
    ).toEqual(['sid=abc; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/']);
  });

  it('splits genuinely separate cookies', () => {
    expect(splitSetCookie('a=1; Path=/, b=2; Path=/')).toEqual([
      'a=1; Path=/',
      'b=2; Path=/',
    ]);
  });

  it('returns nothing for an empty header', () => {
    expect(splitSetCookie('')).toEqual([]);
  });
});

describe('isAllowedHost', () => {
  it('accepts Kicktipp hosts and rejects everything else', () => {
    expect(isAllowedHost('www.kicktipp.de')).toBe(true);
    expect(isAllowedHost('kicktipp.com')).toBe(true);
    expect(isAllowedHost('WWW.KICKTIPP.COM')).toBe(true);
    expect(isAllowedHost('evil.com')).toBe(false);
    expect(isAllowedHost('kicktipp.com.evil.com')).toBe(false);
    expect(isAllowedHost('notkicktipp.de')).toBe(false);
  });
});

describe('CookieJar storing and sending', () => {
  it('sends a cookie back to the host that set it', () => {
    const jar = new CookieJar();
    jar.store(COM, headers('sid=abc; Path=/; HttpOnly'));
    expect(jar.header(COM)).toBe('sid=abc');
  });

  it('never records cookies from a foreign host', () => {
    const jar = new CookieJar();
    jar.store('https://evil.com/', headers('sid=stolen'));
    expect(jar.size).toBe(0);
  });

  it('never sends cookies to a foreign host', () => {
    const jar = new CookieJar();
    jar.store(COM, headers('sid=abc'));
    expect(jar.header('https://evil.com/')).toBe('');
  });

  it('does not send a www.kicktipp.com cookie to www.kicktipp.de', () => {
    const jar = new CookieJar();
    jar.store(COM, headers('sid=abc'));
    expect(jar.header(DE)).toBe('');
  });

  it('honors a Domain attribute the responding host belongs to', () => {
    const jar = new CookieJar();
    jar.store(COM, headers('sid=abc; Domain=.kicktipp.com'));
    expect(jar.header(COM)).toBe('sid=abc');
    expect(jar.header('https://other.kicktipp.com/')).toBe('sid=abc');
  });

  it('ignores a Domain the responding host does not belong to', () => {
    const jar = new CookieJar();
    jar.store(COM, headers('sid=abc; Domain=kicktipp.de'));
    // Falls back to a host-only cookie rather than trusting the attribute.
    expect(jar.header(DE)).toBe('');
    expect(jar.header(COM)).toBe('sid=abc');
  });

  it('ignores a Domain outside Kicktipp entirely', () => {
    const jar = new CookieJar();
    jar.store(COM, headers('sid=abc; Domain=evil.com'));
    expect(jar.header('https://evil.com/')).toBe('');
    expect(jar.header(COM)).toBe('sid=abc');
  });

  it('lets a host-only cookie win over the parent-domain one', () => {
    const jar = new CookieJar();
    jar.store(COM, headers('sid=parent; Domain=.kicktipp.com'));
    jar.store(COM, headers('sid=host'));
    expect(jar.header(COM)).toBe('sid=host');
  });

  it('joins multiple cookies', () => {
    const jar = new CookieJar();
    jar.store(COM, headers('a=1', 'b=2'));
    expect(jar.header(COM)).toBe('a=1; b=2');
  });

  it('overwrites a cookie of the same name', () => {
    const jar = new CookieJar();
    jar.store(COM, headers('sid=old'));
    jar.store(COM, headers('sid=new'));
    expect(jar.header(COM)).toBe('sid=new');
    expect(jar.size).toBe(1);
  });

  it('ignores a malformed pair', () => {
    const jar = new CookieJar();
    jar.store(COM, headers('=novalue', 'noequals'));
    expect(jar.size).toBe(0);
  });
});

describe('CookieJar expiry', () => {
  it('deletes on Max-Age=0', () => {
    const jar = new CookieJar();
    jar.store(COM, headers('sid=abc'));
    jar.store(COM, headers('sid=; Max-Age=0'));
    expect(jar.header(COM)).toBe('');
  });

  it('deletes on an Expires date in the past', () => {
    const jar = new CookieJar();
    jar.store(COM, headers('sid=abc'));
    jar.store(COM, headers('sid=; Expires=Thu, 01 Jan 1970 00:00:00 GMT'));
    expect(jar.header(COM)).toBe('');
  });

  it('keeps a cookie whose Expires is in the future', () => {
    const jar = new CookieJar();
    const future = new Date(Date.now() + 86_400_000).toUTCString();
    jar.store(COM, headers(`sid=abc; Expires=${future}`));
    expect(jar.header(COM)).toBe('sid=abc');
  });
});

describe('CookieJar persistence', () => {
  it('round-trips through JSON', () => {
    const jar = new CookieJar();
    jar.store(COM, headers('sid=abc', 'lang=de'));
    const restored = CookieJar.fromJSON(JSON.parse(JSON.stringify(jar.toJSON())));
    expect(restored.header(COM)).toBe('sid=abc; lang=de');
  });

  it('reads a Playwright storageState file', () => {
    const restored = CookieJar.fromJSON({
      cookies: [
        { name: 'sid', value: 'abc', domain: '.kicktipp.com', path: '/' },
        { name: 'lang', value: 'de', domain: 'www.kicktipp.com', path: '/' },
      ],
      origins: [],
    });
    expect(restored.header(COM)).toBe('sid=abc; lang=de');
  });

  it('drops stored cookies for foreign domains', () => {
    const restored = CookieJar.fromJSON({
      cookies: [{ name: 'sid', value: 'abc', domain: 'evil.com' }],
    });
    expect(restored.size).toBe(0);
  });

  it('survives a file with no usable content', () => {
    expect(CookieJar.fromJSON(null).size).toBe(0);
    expect(CookieJar.fromJSON({}).size).toBe(0);
    expect(CookieJar.fromJSON({ cookies: 'nope' }).size).toBe(0);
  });
});
