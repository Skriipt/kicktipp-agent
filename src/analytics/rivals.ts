import type { MatchdayBets, ScheduleMatch } from '../core.js';
import {
  parseScore,
  multiplierFor,
  type ScoringRules,
} from '../rules/scoring.js';

import { isUnknownBet, pointRange, resultRepresentatives } from '../rules/outcomes.js';

export type Outcome = 'home' | 'draw' | 'away';

export interface MatchSwing {
  home: string;
  away: string;
  myBet: string | null;
  rivalBet: string | null;
  /** Best and worst points difference this match can still produce. */
  bestForMe: number;
  worstForMe: number;
  /** Points difference per outcome class, when both bets are known. */
  byOutcome?: Record<Outcome, { best: number; worst: number }>;
  /** Already-decided matches contribute a fixed difference. */
  settled?: number;
}

export type RivalMode = 'exact' | 'bounds';

export interface RivalAnalysis {
  rival: string;
  player: string;
  matchday?: number;
  mode: RivalMode;
  /** Points behind (negative) or ahead (positive) before the open matches. */
  gap: number | null;
  perMatch: MatchSwing[];
  /** Total swing still available across all undecided matches. */
  swingRange: { best: number; worst: number };
  /** Plain-language statements of what has to happen. */
  conditions: string[];
  note?: string;
}

/**
 * How much this match can move the gap, per outcome class and overall.
 *
 * With the rival's bet unknown, the calculation switches to the widest
 * plausible range: the rival is assumed to score their maximum in the worst
 * case and nothing in the best case.
 */
export function matchSwing(
  match: ScheduleMatch,
  myBet: string | null,
  rivalBet: string | null,
  rules: ScoringRules,
  rivalKnown: boolean,
): MatchSwing {
  // Legacy callers use null with rivalKnown=true for a confirmed missing tip.
  // The grid caller below supplies '-:-' for unknown player rows instead.
  const mine = myBet ?? (rivalKnown ? '' : '-:-');
  const theirs = rivalBet ?? (rivalKnown ? '' : '-:-');
  const known = !isUnknownBet(mine) && !isUnknownBet(theirs);
  const settledResult = parseScore(match.result);

  if (settledResult) {
    const myPoints = pointRange(mine, settledResult, rules);
    const rivalPoints = pointRange(theirs, settledResult, rules);
    const best = myPoints.best - rivalPoints.worst;
    const worst = myPoints.worst - rivalPoints.best;
    return {
      home: match.home, away: match.away, myBet, rivalBet,
      bestForMe: best, worstForMe: worst,
      ...(best === worst ? { settled: best } : {}),
    };
  }

  const byOutcome: Record<Outcome, { best: number; worst: number }> = {
    home: { best: -Infinity, worst: Infinity },
    draw: { best: -Infinity, worst: Infinity },
    away: { best: -Infinity, worst: Infinity },
  };
  for (const sample of resultRepresentatives([mine, theirs])) {
    const myPoints = pointRange(mine, sample, rules);
    const rivalPoints = pointRange(theirs, sample, rules);
    const outcome = sample.home > sample.away ? 'home' : sample.home < sample.away ? 'away' : 'draw';
    byOutcome[outcome].best = Math.max(byOutcome[outcome].best, myPoints.best - rivalPoints.worst);
    byOutcome[outcome].worst = Math.min(byOutcome[outcome].worst, myPoints.worst - rivalPoints.best);
  }

  const all = Object.values(byOutcome);
  return {
    home: match.home, away: match.away, myBet, rivalBet,
    bestForMe: Math.max(...all.map((o) => o.best)),
    worstForMe: Math.min(...all.map((o) => o.worst)),
    byOutcome: known ? byOutcome : undefined,
  };
}

function describeFinished(rival: string, startingGap: number | null): string {
  if (startingGap === null) {
    return 'This matchday is finished. Standings for the gap are not cached.';
  }
  if (startingGap > 0) {
    return `This matchday is finished. You finished ${startingGap} ahead of ${rival}.`;
  }
  if (startingGap < 0) {
    return `This matchday is finished. You finished ${-startingGap} behind ${rival}.`;
  }
  return `This matchday is finished. You finished level with ${rival}.`;
}

function describeWithoutTips(rival: string, startingGap: number | null): string {
  if (startingGap === null) {
    return 'Bets are not in yet, so there is no swing to compute.';
  }
  if (startingGap > 0) {
    return `You are ${startingGap} ahead going into this matchday. Bets are not in yet, so nothing can swing.`;
  }
  if (startingGap < 0) {
    return `You trail ${rival} by ${-startingGap} going into this matchday. Bets are not in yet, so nothing can swing.`;
  }
  return `You and ${rival} are level going into this matchday. Bets are not in yet, so nothing can swing.`;
}

function describe(swing: MatchSwing): string | null {
  if (!swing.byOutcome) return null;
  const gains = (['home', 'draw', 'away'] as Outcome[])
    .filter((o) => swing.byOutcome![o].best > 0)
    .map((o) => (o === 'home' ? `${swing.home} win` : o === 'away' ? `${swing.away} win` : 'a draw'));
  if (!gains.length) return null;
  return `${swing.home} vs ${swing.away}: you gain on ${gains.join(' or ')}`;
}

/**
 * Compare two players over one matchday: where the gap stands, how much each
 * remaining match can move it, and what would have to happen to close it.
 */
export function analyseRival(
  grid: MatchdayBets,
  player: string,
  rival: string,
  rules: ScoringRules,
  gapBefore: number | null,
): RivalAnalysis {
  const mine = grid.players.find((p) => p.player === player);
  const theirs = grid.players.find((p) => p.player === rival);
  const rivalKnown = Boolean(mine && theirs) && grid.matches.every((_, i) =>
    !isUnknownBet(mine?.bets[i]) && !isUnknownBet(theirs?.bets[i]));
  const mode: RivalMode = rivalKnown ? 'exact' : 'bounds';
  const multiplier = multiplierFor(grid.matchday, rules);

  const perMatch = grid.matches.map((match, i) => {
    const swing = matchSwing(match, mine?.bets[i] ?? '-:-', theirs?.bets[i] ?? '-:-', rules, rivalKnown);
    return {
      ...swing,
      bestForMe: swing.bestForMe * multiplier,
      worstForMe: swing.worstForMe * multiplier,
      settled: swing.settled === undefined ? undefined : swing.settled * multiplier,
      byOutcome: swing.byOutcome ? {
        home: { best: swing.byOutcome.home.best * multiplier, worst: swing.byOutcome.home.worst * multiplier },
        draw: { best: swing.byOutcome.draw.best * multiplier, worst: swing.byOutcome.draw.worst * multiplier },
        away: { best: swing.byOutcome.away.best * multiplier, worst: swing.byOutcome.away.worst * multiplier },
      } : undefined,
    };
  });

  const open = perMatch.filter((_, i) => !parseScore(grid.matches[i].result));
  const finished = perMatch.filter((_, i) => parseScore(grid.matches[i].result));
  const uncertainFinished = finished.some((m) => m.settled === undefined);
  const settledDelta = finished.reduce((sum, m) => sum + (m.settled ?? 0), 0);
  const swingRange = {
    best: open.reduce((sum, m) => sum + m.bestForMe, 0),
    worst: open.reduce((sum, m) => sum + m.worstForMe, 0),
  };
  const startingGap = gapBefore === null || uncertainFinished ? null : gapBefore + settledDelta;
  const anyTip = Boolean(mine || theirs) && perMatch.some((m) => m.myBet || m.rivalBet);
  const conditions: string[] = [];

  if (uncertainFinished) {
    conditions.push('Some already-played predictions are hidden, so the current points gap is unknown.');
  } else if (!anyTip) {
    conditions.push(describeWithoutTips(rival, startingGap));
  } else if (open.length === 0) {
    conditions.push(describeFinished(rival, startingGap));
  } else if (startingGap === null) {
    conditions.push('Standings for this matchday are not cached, so only the swing range is known.');
  } else if (startingGap > 0) {
    conditions.push(
      swingRange.worst + startingGap > 0
        ? `You stay ahead whatever happens (worst case still +${startingGap + swingRange.worst}).`
        : `You are ${startingGap} ahead, but can still be caught (worst case ${startingGap + swingRange.worst}).`,
    );
  } else if (startingGap === 0) {
    conditions.push(
      swingRange.best > 0
        ? `You are level; out-scoring ${rival} by 1 would take the lead, and up to ${swingRange.best} is available.`
        : swingRange.worst < 0
          ? `You are level; a lead is out of reach, but you can still fall behind ${rival}.`
          : `You are level, and the remaining matches cannot change that.`,
    );
  } else {
    const needed = -startingGap;
    conditions.push(
      swingRange.best > needed
        ? `You need to out-score ${rival} by ${needed + 1} across the open matches; up to ${swingRange.best} is available.`
        : `Catching ${rival} is out of reach this matchday: you trail by ${needed} and at most ${swingRange.best} is available.`,
    );
  }

  for (const swing of open) {
    const line = describe(swing);
    if (line) conditions.push(line);
  }

  return {
    rival,
    player,
    matchday: grid.matchday,
    mode,
    gap: startingGap,
    perMatch,
    swingRange,
    conditions,
    note:
      grid.note ??
      (rivalKnown
        ? undefined
        : `${rival}'s bets are not visible yet, so these are best/worst bounds rather than exact swings.`),
  };
}
