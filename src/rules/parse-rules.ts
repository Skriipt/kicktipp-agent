import type { RulesSection } from '../core.js';
import { DEFAULT_RULES, type ResolvedRules, type ScoringRules } from './scoring.js';

/**
 * Row labels Kicktipp uses for the three scoring tiers, in German and
 * English. Matching is done on a normalized (lowercased, punctuation-free)
 * form so spacing and articles do not matter.
 */
/** Numeric scoring fields; multipliers are parsed separately. */
type PointKey = 'exact' | 'goalDiff' | 'tendency' | 'drawExact' | 'drawTendency';

const LABELS: { key: 'exact' | 'goalDiff' | 'tendency'; patterns: RegExp[] }[] = [
  {
    key: 'exact',
    patterns: [/richtiges?ergebnis/, /ergebnis$/, /exactresult/, /correctresult/, /result$/],
  },
  {
    key: 'goalDiff',
    patterns: [/richtigetordifferenz/, /tordifferenz/, /goaldifference/],
  },
  {
    key: 'tendency',
    patterns: [/richtigetendenz/, /tendenz/, /tendency/, /correctwinner/, /outcome/],
  },
];

/** Signals a scheme this model cannot express. */
const UNSUPPORTED = [/quote/i, /odds/i, /multiplikator/i, /multiplier/i, /joker/i];

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
}

function firstNumber(cells: string[]): number | null {
  for (const cell of cells) {
    const match = cell.match(/-?\d+/);
    if (match) return Number(match[0]);
  }
  return null;
}

/**
 * Read the point values out of a community's rules page.
 *
 * Returns null when the page holds no recognizable scoring table, so the
 * caller can reject it or apply an explicit fallback.
 */
export function parseScoringRules(sections: RulesSection[]): ResolvedRules | null {
  const found: Partial<Record<PointKey, number>> = {};
  let unsupported: string | undefined;
  let matrix = false;

  for (const section of sections) {
    if (section.type !== 'table' || !section.rows) continue;

    const win = section.rows.find((row) => /^(sieg|win)$/.test(normalize(row[0] ?? '')));
    const draw = section.rows.find((row) => /^(unentschieden|draw)$/.test(normalize(row[0] ?? '')));
    if (win && draw) {
      const headers = section.headers ?? [];
      const rowOffset = win.length === headers.length + 1 ? 1 : 0;
      for (const { key, patterns } of LABELS) {
        const column = headers.findIndex((header) =>
          patterns.some((pattern) => pattern.test(normalize(header))),
        );
        if (column < 0) continue;
        matrix = true;
        const winValue = firstNumber([win[column + rowOffset] ?? '']);
        if (winValue !== null && found[key] === undefined) found[key] = winValue;
        const drawValue = firstNumber([draw[column + rowOffset] ?? '']);
        if (drawValue !== null && key === 'exact' && found.drawExact === undefined) {
          found.drawExact = drawValue;
        }
        if (drawValue !== null && key === 'tendency' && found.drawTendency === undefined) {
          found.drawTendency = drawValue;
        }
      }
    }

    for (const row of section.rows) {
      if (!row.length) continue;
      const label = normalize(row[0]);
      if (!label) continue;

      const rest = row.slice(1);
      for (const { key, patterns } of LABELS) {
        if (found[key] !== undefined) continue;
        if (!patterns.some((p) => p.test(label))) continue;
        const value = firstNumber(rest);
        if (value !== null) found[key] = value;
      }

      const rowText = row.join(' ');
      if (!unsupported && UNSUPPORTED.some((p) => p.test(rowText))) {
        unsupported = `The rules mention "${row[0].trim()}", which this scoring model does not cover.`;
      }
    }
  }

  if (found.exact === undefined && found.goalDiff === undefined && found.tendency === undefined) {
    return null;
  }

  // A partially recognized table is filled in from the defaults, and says so.
  const expected: PointKey[] = ['exact', 'goalDiff', 'tendency'];
  if (matrix) expected.push('drawExact', 'drawTendency');
  const missing = expected.filter((key) => found[key] === undefined);
  const values: ScoringRules = {
    exact: found.exact ?? DEFAULT_RULES.exact,
    goalDiff: found.goalDiff ?? DEFAULT_RULES.goalDiff,
    tendency: found.tendency ?? DEFAULT_RULES.tendency,
  };
  if (found.drawExact !== undefined) values.drawExact = found.drawExact;
  if (found.drawTendency !== undefined) values.drawTendency = found.drawTendency;

  const warnings = [
    missing.length ? `Assumed defaults for: ${missing.join(', ')}.` : '',
    unsupported ?? '',
  ].filter(Boolean);

  const multipliers = parseMultipliers(sections);
  if (Object.keys(multipliers).length) values.multipliers = multipliers;

  return {
    values,
    source: 'parsed',
    confidence: missing.length ? 'assumed' : 'parsed',
    warning: warnings.length ? warnings.join(' ') : undefined,
    unsupported: !!unsupported,
  };
}

/**
 * Communities sometimes double a matchday ("Spieltag 34 zählt doppelt").
 * Only explicit numeric factors tied to a matchday number are taken; a
 * vaguer statement is left alone rather than guessed at.
 */
export function parseMultipliers(sections: RulesSection[]): Record<number, number> {
  const multipliers: Record<number, number> = {};
  const patterns = [
    /spieltag\s*(\d{1,2})[^.]{0,40}?(doppelt|zweifach|dreifach|x\s*([\d.]+)|(\d+)\s*[-–]?\s*fach)/gi,
    /matchday\s*(\d{1,2})[^.]{0,40}?(double|triple|x\s*([\d.]+)|counts?\s+(\d+)\s*times)/gi,
  ];

  const text = sections
    .map((s) => (s.type === 'table' ? (s.rows ?? []).map((r) => r.join(' ')).join(' ') : s.text ?? ''))
    .join(' ');

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const matchday = Number(match[1]);
      if (!Number.isInteger(matchday) || matchday < 1 || matchday > 34) continue;
      const word = match[2].toLowerCase();
      let factor: number | null = null;
      if (/doppelt|zweifach|double/.test(word)) factor = 2;
      else if (/dreifach|triple/.test(word)) factor = 3;
      else if (match[3]) factor = Number(match[3]);
      else if (match[4]) factor = Number(match[4]);
      if (factor && Number.isFinite(factor) && factor > 0) multipliers[matchday] = factor;
    }
  }
  return multipliers;
}
