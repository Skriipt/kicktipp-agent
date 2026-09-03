import { Page } from '../browser.js';
import type { CacheStore } from '../cache/store.js';
import { fetchRules } from '../core.js';
import { readScoringOverride } from '../config.js';
import type { CacheOptions } from '../cache/cached-fetch.js';
import { parseScoringRules } from './parse-rules.js';
import { DEFAULT_RULES, type ResolvedRules } from './scoring.js';

function requireParsedRules(sections: Awaited<ReturnType<typeof fetchRules>>): ResolvedRules {
  const parsed = parseScoringRules(sections);
  if (!parsed || parsed.confidence === 'assumed' || parsed.unsupported) {
    throw new Error(
      parsed?.warning ??
        "This community's scoring table is not supported. Set all point values under [scoring] in config.ini.",
    );
  }
  return parsed;
}

/**
 * Work out how this community scores, in order: an explicit config override,
 * the community's own rules page, then Kicktipp's defaults. The result
 * always records which of the three it was, so output can be honest about
 * how much to trust the numbers.
 */
export async function resolveRules(
  page: Page,
  community: string,
  cache: CacheOptions = {},
): Promise<ResolvedRules> {
  const override = readScoringOverride();
  if (override) return { values: override, source: 'config', confidence: 'parsed' };

  let sections: Awaited<ReturnType<typeof fetchRules>>;
  try {
    sections = await fetchRules(page, community, cache);
  } catch {
    // An unreadable rules page is not worth failing the command over.
    return {
      values: DEFAULT_RULES,
      source: 'default',
      confidence: 'assumed',
      warning: "Could not read this community's scoring table; assuming Kicktipp's defaults (4/3/2).",
    };
  }
  return requireParsedRules(sections);
}

/**
 * The same resolution without a network session, for commands that read the
 * cache only. Falls back to the defaults when the rules page was never
 * synced.
 */
export function resolveRulesFromCache(store: CacheStore | null): ResolvedRules {
  const override = readScoringOverride();
  if (override) return { values: override, source: 'config', confidence: 'parsed' };

  const cached = store?.read('rules');
  if (cached) return requireParsedRules(cached.data);

  return {
    values: DEFAULT_RULES,
    source: 'default',
    confidence: 'assumed',
    warning: "No cached rules page; assuming Kicktipp's default scoring (4/3/2). Run `kicktipp sync` to read the real rules.",
  };
}
