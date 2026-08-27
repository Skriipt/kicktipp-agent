import { describe, expect, it } from 'vitest';
import { normalizeSlug } from '../src/helpers/normalize-slug.js';

describe('normalizeSlug', () => {
  it('matches a displayed community name to its URL slug', () => {
    expect(normalizeSlug('Toms Zockerrunde 26/27')).toBe(
      normalizeSlug('toms-zockerrunde-2627'),
    );
  });

  it('ignores common separators and punctuation', () => {
    expect(normalizeSlug('Foo_Bar – 2026')).toBe(normalizeSlug('foo-bar-2026'));
  });
});
