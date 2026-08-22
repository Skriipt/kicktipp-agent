import { describe, it, expect } from 'vitest';
import { normalizeSlug } from '../src/helpers/normalize-slug.js';

describe('normalizeSlug', () => {
  it('matches a name containing underscores against its kicktipp slug', () => {
    // kicktipp strips underscores when building the URL slug
    expect(normalizeSlug('my_community')).toBe(normalizeSlug('mycommunity'));
  });

  it('matches a name containing spaces against its hyphenated slug', () => {
    // kicktipp turns spaces into hyphens when building the URL slug
    expect(normalizeSlug('Langtipp WC 26')).toBe(normalizeSlug('langtipp-wc-26'));
  });

  it('is case-insensitive', () => {
    expect(normalizeSlug('MyPool')).toBe(normalizeSlug('mypool'));
  });

  it('does not match different names', () => {
    expect(normalizeSlug('my_community')).not.toBe(normalizeSlug('other-community'));
  });
});
