import { describe, it, expect } from 'vitest';
import { classify, parseScore, scoreBet, tendencyOf, DEFAULT_RULES } from '../src/rules/scoring.js';
import { parseScoringRules } from '../src/rules/parse-rules.js';
import type { RulesSection } from '../src/core.js';

const RULES = { exact: 4, goalDiff: 3, tendency: 2 };

describe('parseScore', () => {
  it('reads the usual forms', () => {
    expect(parseScore('2:1')).toEqual({ home: 2, away: 1 });
    expect(parseScore(' 10 : 0 ')).toEqual({ home: 10, away: 0 });
    expect(parseScore('2-1')).toEqual({ home: 2, away: 1 });
  });

  it('rejects anything else', () => {
    expect(parseScore('')).toBeNull();
    expect(parseScore('-:-')).toBeNull();
    expect(parseScore('abc')).toBeNull();
    expect(parseScore(null)).toBeNull();
  });
});

describe('classify', () => {
  const c = (bet: string, result: string) => classify(parseScore(bet)!, parseScore(result)!);

  it('spots an exact hit', () => {
    expect(c('2:1', '2:1')).toBe('exact');
    expect(c('0:0', '0:0')).toBe('exact');
  });

  it('spots the right goal difference', () => {
    expect(c('2:1', '3:2')).toBe('goalDiff');
    expect(c('1:2', '2:3')).toBe('goalDiff');
  });

  it('spots the right tendency only', () => {
    expect(c('2:1', '3:0')).toBe('tendency');
    expect(c('1:0', '4:1')).toBe('tendency');
  });

  it('treats an inexact draw as tendency, never goal difference', () => {
    // Every draw shares a goal difference of zero, so a predicted 1:1 that
    // finishes 2:2 must not be paid as if the difference was predicted.
    expect(c('1:1', '2:2')).toBe('tendency');
    expect(c('0:0', '3:3')).toBe('tendency');
  });

  it('spots a miss', () => {
    expect(c('2:1', '0:1')).toBe('miss');
    expect(c('1:1', '2:0')).toBe('miss');
    expect(c('2:0', '1:1')).toBe('miss');
  });
});

describe('scoreBet', () => {
  it('pays each tier', () => {
    expect(scoreBet('2:1', '2:1', RULES)).toBe(4);
    expect(scoreBet('2:1', '3:2', RULES)).toBe(3);
    expect(scoreBet('2:1', '3:0', RULES)).toBe(2);
    expect(scoreBet('2:1', '0:2', RULES)).toBe(0);
  });

  it('pays nothing for a missing bet or result', () => {
    expect(scoreBet('', '2:1', RULES)).toBe(0);
    expect(scoreBet('2:1', '-:-', RULES)).toBe(0);
    expect(scoreBet(null, null, RULES)).toBe(0);
  });

  it('accepts already-parsed scores', () => {
    expect(scoreBet({ home: 2, away: 1 }, { home: 2, away: 1 }, RULES)).toBe(4);
  });

  it('honours other point values', () => {
    expect(scoreBet('2:1', '2:1', { exact: 10, goalDiff: 5, tendency: 1 })).toBe(10);
  });
});

describe('tendencyOf', () => {
  it('classifies outcomes', () => {
    expect(tendencyOf({ home: 2, away: 1 })).toBe('home');
    expect(tendencyOf({ home: 1, away: 2 })).toBe('away');
    expect(tendencyOf({ home: 1, away: 1 })).toBe('draw');
  });
});

function table(rows: string[][]): RulesSection[] {
  return [{ type: 'table', headers: ['Regel', 'Punkte'], rows }];
}

describe('parseScoringRules', () => {
  it('reads Kicktipp\'s result matrix and scores draws separately', () => {
    const parsed = parseScoringRules([{
      type: 'table',
      headers: ['', 'Tendenz', 'Tordifferenz', 'Ergebnis'],
      rows: [
        ['Sieg', '1', '3', '5'],
        ['Unentschieden', '2', '-', '5'],
      ],
    }]);

    expect(parsed?.values).toEqual({
      exact: 5,
      goalDiff: 3,
      tendency: 1,
      drawExact: 5,
      drawTendency: 2,
    });
    expect(scoreBet('2:0', '1:0', parsed!.values)).toBe(1);
    expect(scoreBet('1:1', '2:2', parsed!.values)).toBe(2);
    expect(scoreBet('1:1', '1:1', parsed!.values)).toBe(5);
    expect(scoreBet('1:1', '1:1', { ...parsed!.values, drawExact: 6 })).toBe(6);

    const withoutCornerHeader = parseScoringRules([{
      type: 'table',
      headers: ['Tendenz', 'Tordifferenz', 'Ergebnis'],
      rows: [['Sieg', '1', '3', '5'], ['Unentschieden', '2', '-', '5']],
    }]);
    expect(withoutCornerHeader?.values).toEqual(parsed?.values);
  });

  it('reads a German rules table', () => {
    const parsed = parseScoringRules(table([
      ['Richtiges Ergebnis', '4'],
      ['Richtige Tordifferenz', '3'],
      ['Richtige Tendenz', '2'],
    ]));
    expect(parsed?.values).toEqual(RULES);
    expect(parsed?.source).toBe('parsed');
    expect(parsed?.warning).toBeUndefined();
  });

  it('reads an English rules table', () => {
    const parsed = parseScoringRules(table([
      ['Exact result', '5'],
      ['Goal difference', '3'],
      ['Correct winner', '1'],
    ]));
    expect(parsed?.values).toEqual({ exact: 5, goalDiff: 3, tendency: 1 });
  });

  it('fills gaps from the defaults and says so', () => {
    const parsed = parseScoringRules(table([['Richtiges Ergebnis', '6']]));
    expect(parsed?.values.exact).toBe(6);
    expect(parsed?.values.tendency).toBe(DEFAULT_RULES.tendency);
    expect(parsed?.confidence).toBe('assumed');
    expect(parsed?.warning).toMatch(/Assumed defaults/);
  });

  it('flags a scheme it cannot express', () => {
    const parsed = parseScoringRules(table([
      ['Richtiges Ergebnis', '4'],
      ['Richtige Tordifferenz', '3'],
      ['Richtige Tendenz', '2'],
      ['Quotenbonus', 'je nach Quote'],
    ]));
    expect(parsed?.unsupported).toBe(true);
    expect(parsed?.warning).toMatch(/does not cover/);
  });

  it('returns null when there is no scoring table at all', () => {
    expect(parseScoringRules([{ type: 'paragraph', text: 'Viel Spaß!' }])).toBeNull();
    expect(parseScoringRules(table([['Teilnehmer', '12']]))).toBeNull();
  });
});
