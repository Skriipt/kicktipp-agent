import { describe, it, expect } from 'vitest';
import { Match } from '../src/helpers/match.js';

describe('Match', () => {
  it('parses US date format', () => {
    const m = new Match(
      'Home',
      'Away',
      '03/15/26 03:30 PM',
      '1.5',
      '4.2',
      '6.1',
    );
    expect(m.matchDate).not.toBeNull();
    expect(m.matchDate!.getFullYear()).toBe(2026);
    expect(m.matchDate!.getMonth()).toBe(2);
    expect(m.matchDate!.getDate()).toBe(15);
    expect(m.matchDate!.getHours()).toBe(15);
  });

  it('parses DE date format', () => {
    const m = new Match(
      'Home',
      'Away',
      '15.03.26 15:30',
      '1.5',
      '4.2',
      '6.1',
    );
    expect(m.matchDate).not.toBeNull();
    expect(m.matchDate!.getFullYear()).toBe(2026);
  });

  it('returns null for invalid date', () => {
    const m = new Match('Home', 'Away', 'garbage', '1.5', '4.2', '6.1');
    expect(m.matchDate).toBeNull();
  });

  it('parses odds as floats', () => {
    const m = new Match(
      'Home',
      'Away',
      '03/15/26 03:30 PM',
      '1.5',
      '4.2',
      '6.1',
    );
    expect(m.odds).toEqual([1.5, 4.2, 6.1]);
  });
});
