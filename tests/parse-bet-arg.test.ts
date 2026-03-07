import { describe, it, expect } from 'vitest';
import {
  parseBetArg,
  matchFixture,
  EditableMatch,
} from '../src/helpers/parse-bet-arg.js';

describe('parseBetArg', () => {
  it('parses valid bet arg', () => {
    const r = parseBetArg('FC Bayern München vs Borussia Dortmund=2:1');
    expect(r).toEqual({
      home: 'FC Bayern München',
      away: 'Borussia Dortmund',
      h: 2,
      g: 1,
    });
  });

  it('parses 0:0', () => {
    const r = parseBetArg('Leipzig vs Leverkusen=0:0');
    expect(r).toEqual({
      home: 'Leipzig',
      away: 'Leverkusen',
      h: 0,
      g: 0,
    });
  });

  it('exits on missing vs', () => {
    expect(() => parseBetArg('Bayern - Dortmund=2:1')).toThrow();
  });

  it('exits on missing equals', () => {
    expect(() => parseBetArg('Bayern vs Dortmund 2:1')).toThrow();
  });

  it('exits on invalid result', () => {
    expect(() => parseBetArg('Bayern vs Dortmund=abc')).toThrow();
  });
});

describe('matchFixture', () => {
  const editable: EditableMatch[] = [
    {
      home: 'FC Bayern München',
      away: 'Borussia Dortmund',
      heimName: 'heim1',
      gastName: 'gast1',
    },
    {
      home: 'RB Leipzig',
      away: 'Bayer 04 Leverkusen',
      heimName: 'heim2',
      gastName: 'gast2',
    },
  ];

  it('finds exact match', () => {
    const r = matchFixture(
      'FC Bayern München',
      'Borussia Dortmund',
      editable,
    );
    expect(r.heimName).toBe('heim1');
  });

  it('is case-insensitive', () => {
    const r = matchFixture(
      'fc bayern münchen',
      'borussia dortmund',
      editable,
    );
    expect(r.heimName).toBe('heim1');
  });

  it('exits on not found', () => {
    expect(() => matchFixture('Unknown', 'Dortmund', editable)).toThrow();
  });
});
