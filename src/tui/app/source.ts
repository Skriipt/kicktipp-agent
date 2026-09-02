/**
 * Shared dashboard result types.
 */
import type { SuggestedBet, StrategyName } from '../../analytics/strategies.js';
import type { ResolvedRules } from '../../rules/scoring.js';

export interface AppContext {
  community: string | null;
  player: string | null;
  profile: string | null;
  readOnly: boolean;
  loggedIn: boolean;
}

export interface CacheInfo {
  community: string;
  dir: string;
  sizeBytes: number;
  lastSync: string | null;
  knownMatchdays: number | null;
  matchdays: number[];
}

export interface SuggestOutcome {
  strategy: StrategyName;
  matchday: number | null;
  rules: ResolvedRules;
  suggestions: SuggestedBet[];
}
