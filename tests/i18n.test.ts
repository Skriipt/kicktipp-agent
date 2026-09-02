import { describe, it, expect, afterEach } from 'vitest';
import {
  de,
  en,
  flattenKeys,
  langFromArgv,
  parseLanguage,
  resolveLanguage,
  setLanguage,
  t,
} from '../src/i18n/index.js';
import { loginPage } from '../src/setup/html.js';

afterEach(() => setLanguage('en'));

describe('parseLanguage', () => {
  it('accepts en and de, ignoring case and padding', () => {
    expect(parseLanguage('DE')).toBe('de');
    expect(parseLanguage(' en ')).toBe('en');
    expect(parseLanguage('')).toBeUndefined();
    expect(parseLanguage(undefined)).toBeUndefined();
  });

  it('rejects unknown values', () => {
    expect(() => parseLanguage('fr')).toThrow(/Unknown language 'fr'/);
  });
});

describe('langFromArgv', () => {
  it('reads --lang before or after the subcommand', () => {
    expect(langFromArgv(['node', 'kicktipp', '--lang', 'de', 'today'])).toBe('de');
    expect(langFromArgv(['node', 'kicktipp', 'today', '--lang=de'])).toBe('de');
  });
});

describe('resolveLanguage', () => {
  it('prefers the flag, then env, then config, then en', () => {
    expect(
      resolveLanguage({
        argv: ['kicktipp', '--lang', 'de'],
        env: { KICKTIPP_LANG: 'en' },
        configLanguage: 'en',
      }),
    ).toBe('de');
    expect(
      resolveLanguage({
        argv: ['kicktipp', 'today'],
        env: { KICKTIPP_LANG: 'de' },
        configLanguage: 'en',
      }),
    ).toBe('de');
    expect(
      resolveLanguage({
        argv: ['kicktipp'],
        env: {},
        configLanguage: 'de',
      }),
    ).toBe('de');
    expect(resolveLanguage({ argv: ['kicktipp'], env: {}, configLanguage: null })).toBe('en');
  });

  it('rejects an unknown env or config value', () => {
    expect(() => resolveLanguage({ argv: ['kicktipp'], env: { KICKTIPP_LANG: 'fr' } })).toThrow(
      /Unknown language 'fr'/,
    );
    expect(() => resolveLanguage({ argv: ['kicktipp'], env: {}, configLanguage: 'es' })).toThrow(
      /Unknown language 'es'/,
    );
  });
});

describe('catalogs', () => {
  it('keeps the same keys in de as in en', () => {
    expect(flattenKeys(de).sort()).toEqual(flattenKeys(en).sort());
  });
});

describe('setup HTML', () => {
  it('uses German labels when the language is de', () => {
    setLanguage('de');
    const html = loginPage('tok');
    expect(html).toContain('lang="de"');
    expect(html).toContain('Kicktipp verbinden');
    expect(html).toContain('Anmelden');
    expect(html).not.toContain('Connect Kicktipp');
  });

  it('stays English by default', () => {
    const html = loginPage('tok');
    expect(html).toContain('lang="en"');
    expect(html).toContain('Connect Kicktipp');
    expect(html).toContain('kicktipp.de');
    expect(html).toContain('name="site"');
    expect(html).toContain('name="language"');
  });
});

describe('t()', () => {
  it('interpolates placeholders', () => {
    expect(t('common.savedCommunity', { name: 'cape' })).toBe("Saved 'cape' as default community.");
  });
});
