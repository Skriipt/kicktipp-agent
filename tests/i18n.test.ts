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

describe('t()', () => {
  it('interpolates placeholders', () => {
    expect(t('common.savedCommunity', { name: 'cape' })).toBe("Saved 'cape' as default community.");
  });
});
