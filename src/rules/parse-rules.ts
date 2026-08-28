import type { RulesSection } from '../core.js';
import { DEFAULT_RULES, type ResolvedRules, type ScoringRules } from './scoring.js';

/**
 * Row labels Kicktipp uses for the three scoring tiers, in German and
 * English. Matching is done on a normalized (lowercased, punctuation-free)
 * form so spacing and articles do not matter.
 */
const LABELS: { key: keyof ScoringRules; patterns: RegExp[] }[] = [
  {
    key: 'exact',
    patterns: [/richtiges?ergebnis/, /exactresult/, /correctresult/],
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
 * caller can fall back to the defaults and say so.
 */
export function parseScoringRules(sections: RulesSection[]): ResolvedRules | null {
  const found: Partial<ScoringRules> = {};
  let unsupported: string | undefined;

  for (const section of sections) {
    if (section.type !== 'table' || !section.rows) continue;

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
  const missing = (['exact', 'goalDiff', 'tendency'] as const).filter((k) => found[k] === undefined);
  const values: ScoringRules = {
    exact: found.exact ?? DEFAULT_RULES.exact,
    goalDiff: found.goalDiff ?? DEFAULT_RULES.goalDiff,
    tendency: found.tendency ?? DEFAULT_RULES.tendency,
  };

  const warnings = [
    missing.length ? `Assumed defaults for: ${missing.join(', ')}.` : '',
    unsupported ?? '',
  ].filter(Boolean);

  return {
    values,
    source: 'parsed',
    warning: warnings.length ? warnings.join(' ') : undefined,
  };
}
