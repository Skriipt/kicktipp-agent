import type { LeaderboardData, MatchdayBets } from '../core.js';
import { toNumber } from '../analytics/season.js';
import { multiplierFor, scoreBet, type ScoringRules } from './scoring.js';

export interface PlayerCheck {
  player: string;
  computed: number;
  reported: number | null;
  agrees: boolean;
}

export interface VerificationResult {
  matchday: number | null;
  checked: number;
  agreed: number;
  /** True only when every player with a reported score matched. */
  verified: boolean;
  players: PlayerCheck[];
  reason?: string;
}

/**
 * Recompute a finished matchday from the per-player bet grid and compare
 * against the points Kicktipp itself reported.
 *
 * This is the strongest available check on the parsed rules: if the model
 * reproduces every player's score, the point values are right; if it does
 * not, they are wrong in a way no amount of careful parsing would reveal.
 * Bonus points are excluded by comparing against the matchday column only.
 */
export function verifyRules(
  grid: MatchdayBets,
  leaderboard: LeaderboardData,
  rules: ScoringRules,
): VerificationResult {
  const matchday = grid.matchday ?? null;

  if (!grid.players.length) {
    return {
      matchday,
      checked: 0,
      agreed: 0,
      verified: false,
      players: [],
      reason: grid.note ?? 'No per-player bets are available for this matchday.',
    };
  }
  if (!grid.matches.every((m) => /^\d+:\d+$/.test(m.result))) {
    return {
      matchday,
      checked: 0,
      agreed: 0,
      verified: false,
      players: [],
      reason: 'This matchday is not finished, so the reported points are not final.',
    };
  }

  const multiplier = multiplierFor(matchday, rules);
  const players: PlayerCheck[] = grid.players.map((entry) => {
    const computed =
      entry.bets.reduce(
        (sum, bet, i) => sum + scoreBet(bet, grid.matches[i]?.result, rules),
        0,
      ) * multiplier;
    const row = leaderboard.rankings.find((r) => r.name === entry.player);
    const reported = row ? toNumber(row.matchdayPoints) : null;
    return { player: entry.player, computed, reported, agrees: reported === computed };
  });

  const comparable = players.filter((p) => p.reported !== null);
  const agreed = comparable.filter((p) => p.agrees).length;

  return {
    matchday,
    checked: comparable.length,
    agreed,
    verified: comparable.length > 0 && agreed === comparable.length,
    players,
    reason: comparable.length
      ? undefined
      : 'None of the players in the bet grid appear on the leaderboard.',
  };
}
