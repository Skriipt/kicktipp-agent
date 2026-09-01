/**
 * A believable Bundesliga season, generated deterministically.
 *
 * The point of the demo world is to exercise the *real* rendering, analytics
 * and navigation code without a Kicktipp account: `kicktipp tui --demo` and
 * the tests both run on it. Everything downstream (stats, replay, rival,
 * scenarios, suggestions) is computed by the production functions from this
 * data, so the demo stays honest — only the source of the numbers is fake.
 */
import type {
  BetMatch,
  BonusQuestion,
  LeaderboardData,
  MatchdayBets,
  Member,
  OverviewData,
  OverviewPlayer,
  RankingEntry,
  RulesSection,
  ScheduleMatch,
  TableTeam,
  TodayMatch,
} from '../../core.js';
import type { CachedMatchday, CachedSeason } from '../../analytics/season.js';
import type { AuditRecord } from '../../audit/log.js';
import { classify, parseScore, pointsFor, DEFAULT_RULES } from '../../rules/scoring.js';

const TEAMS = [
  'FC Bayern München',
  'Borussia Dortmund',
  'RB Leipzig',
  'Bayer 04 Leverkusen',
  'Union Berlin',
  'SC Freiburg',
  'Eintracht Frankfurt',
  'VfL Wolfsburg',
  'Borussia M.Gladbach',
  '1. FC Köln',
  'TSG Hoffenheim',
  'Werder Bremen',
  'VfB Stuttgart',
  'FC Augsburg',
  '1. FSV Mainz 05',
  'VfL Bochum',
  '1. FC Heidenheim',
  'SV Darmstadt 98',
];

const PLAYERS = [
  'You',
  'Lena Fischer',
  'Max Weber',
  'Jonas Becker',
  'Sophie Wagner',
  'Paul Hoffmann',
  'Mia Schäfer',
  'Leon Krüger',
  'Emma Richter',
  'Finn Neumann',
  'Clara Vogel',
  'Noah Schulz',
];

export const DEMO_COMMUNITY = 'bundesliga-buddies';
export const DEMO_PLAYER = 'You';
export const DEMO_CURRENT_MATCHDAY = 24;

/** A tiny deterministic PRNG so the demo is identical on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rnd: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A low-scoring, home-leaning result — the shape of a real football score. */
function randomResult(rnd: () => number): { home: number; away: number } {
  const goals = () => {
    const r = rnd();
    return r < 0.28 ? 0 : r < 0.62 ? 1 : r < 0.85 ? 2 : r < 0.96 ? 3 : 4;
  };
  const home = goals();
  const away = Math.max(0, goals() - (rnd() < 0.35 ? 1 : 0));
  return { home, away };
}

/** A player's bet: close to the result more often for the stronger tippers. */
function betFor(result: { home: number; away: number }, skill: number, rnd: () => number): string {
  if (rnd() < skill * 0.45) return `${result.home}:${result.away}`; // exact
  const jitter = (v: number) => Math.max(0, v + (rnd() < 0.5 ? -1 : 1) * (rnd() < skill ? 0 : 1));
  if (rnd() < skill * 0.4) {
    // Right tendency, different score.
    return `${jitter(result.home)}:${jitter(result.away)}`;
  }
  return `${Math.floor(rnd() * 4)}:${Math.floor(rnd() * 3)}`;
}

function germanDate(day: number, month: number, hour: number, minute: number): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(day)}.${p(month)}.26 ${p(hour)}:${p(minute)}`;
}

/** Format a real Date in Kicktipp's German wall-clock notation. */
function germanDateFrom(date: Date): string {
  return germanDate(
    date.getDate(),
    date.getMonth() + 1,
    date.getHours(),
    date.getMinutes(),
  );
}

/** Kickoffs for the live matchday: spread over the next few days from now. */
function upcomingDates(now: Date, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + Math.floor(i / 3));
    d.setHours(15 + (i % 3) * 2, 30, 0, 0);
    // Keep the very first match comfortably ahead so a countdown is visible.
    if (i === 0 && d.getTime() < now.getTime() + 90 * 60000) {
      d.setTime(now.getTime() + 150 * 60000);
    }
    out.push(germanDateFrom(d));
  }
  return out;
}

function oddsFor(rnd: () => number): { home: string; draw: string; away: string } {
  const h = (1.2 + rnd() * 3).toFixed(2);
  const d = (3 + rnd() * 2).toFixed(2);
  const a = (1.6 + rnd() * 5).toFixed(2);
  return { home: h, draw: d, away: a };
}

export interface DemoWorld {
  community: string;
  player: string;
  teams: string[];
  players: string[];
  currentMatchday: number;
  season: CachedSeason;
  bonusQuestions: BonusQuestion[];
  members: Member[];
  overview: OverviewData;
  table: { label: string; teams: TableTeam[] };
  rules: RulesSection[];
  audit: AuditRecord[];
}

interface BuiltMatchday {
  matchday: number;
  schedule: ScheduleMatch[];
  bets: BetMatch[];
  leaderboard: LeaderboardData;
  matchdayBets: MatchdayBets;
  /** Points each player earned this matchday, for cumulative leaderboards. */
  scored: { name: string; pts: number }[];
}

function buildMatchday(
  matchday: number,
  isCurrent: boolean,
  rnd: () => number,
  now: Date,
): BuiltMatchday {
  const teams = shuffle(TEAMS, rnd);
  const fixtures: { home: string; away: string }[] = [];
  for (let i = 0; i < teams.length; i += 2) {
    fixtures.push({ home: teams[i], away: teams[i + 1] });
  }

  const baseDay = ((matchday * 7) % 28) + 1;
  const results = fixtures.map(() => (isCurrent ? null : randomResult(rnd)));
  const liveDates = isCurrent ? upcomingDates(now, fixtures.length) : [];

  const schedule: ScheduleMatch[] = fixtures.map((f, i) => ({
    date: isCurrent
      ? liveDates[i]
      : germanDate(baseDay + Math.floor(i / 3), 2 + (matchday % 6), 15 + (i % 3) * 2, 30),
    home: f.home,
    away: f.away,
    result: results[i] ? `${results[i]!.home}:${results[i]!.away}` : '-:-',
  }));

  // Your bets for the current matchday: a few placed, a few still open.
  const bets: BetMatch[] = fixtures.map((f, i) => {
    const placed = isCurrent ? rnd() < 0.55 : true;
    const bet = isCurrent
      ? placed
        ? `${Math.floor(rnd() * 3)}:${Math.floor(rnd() * 2)}`
        : '-'
      : betFor(results[i]!, 0.75, rnd);
    return {
      date: schedule[i].date,
      home: f.home,
      away: f.away,
      bet,
      odds: oddsFor(rnd),
    };
  });

  // Everyone's bets, for the per-player grid.
  const playerBets = PLAYERS.map((name, p) => {
    const skill = name === 'You' ? 0.78 : 0.4 + (p % 6) * 0.08;
    return {
      player: name,
      bets: fixtures.map((_, i) =>
        results[i] ? betFor(results[i]!, skill, rnd) : isCurrent && name === 'You' ? bets[i].bet.replace('-', '') : '',
      ),
    };
  });

  const matchdayBets: MatchdayBets = { matchday, matches: schedule, players: playerBets };

  // Points each player scored this matchday, from their bets vs the results.
  const scored = PLAYERS.map((name, p) => {
    let pts = 0;
    if (!isCurrent) {
      playerBets[p].bets.forEach((b, i) => {
        const bet = parseScore(b);
        const res = results[i];
        if (bet && res) pts += pointsFor(classify(bet, res), DEFAULT_RULES);
      });
    }
    return { name, pts };
  });

  return {
    matchday,
    schedule,
    bets,
    leaderboard: { title: `Spieltag ${matchday}`, matches: schedule, rankings: [] },
    matchdayBets,
    scored,
  };
}

export function buildDemoWorld(): DemoWorld {
  const rnd = mulberry32(20260829);
  const now = new Date();
  const built: BuiltMatchday[] = [];
  for (let md = 1; md <= DEMO_CURRENT_MATCHDAY; md++) {
    built.push(buildMatchday(md, md === DEMO_CURRENT_MATCHDAY, rnd, now));
  }

  // Running totals to build honest cumulative leaderboards per matchday.
  const totals = new Map<string, number>(PLAYERS.map((n) => [n, 0]));
  const bonusPts = new Map<string, number>(PLAYERS.map((n, i) => [n, 6 + ((i * 3) % 11)]));

  for (const md of built) {
    for (const s of md.scored) totals.set(s.name, (totals.get(s.name) ?? 0) + s.pts);
    const rows = PLAYERS.map((name) => ({
      name,
      md: md.scored.find((s) => s.name === name)?.pts ?? 0,
      bonus: bonusPts.get(name) ?? 0,
      total: (totals.get(name) ?? 0) + (bonusPts.get(name) ?? 0),
    }));
    rows.sort((a, b) => b.total - a.total || b.md - a.md);
    // The in-progress matchday has not been scored yet: leave its per-matchday
    // points blank so form/consistency analytics skip it rather than reading a
    // misleading zero.
    const inProgress = md.matchday === DEMO_CURRENT_MATCHDAY;
    md.leaderboard.rankings = rows.map((r, i) => ({
      position: String(i + 1),
      name: r.name,
      matchdayPoints: inProgress ? '' : String(r.md),
      bonus: String(r.bonus),
      total: String(r.total),
      isCurrentPlayer: r.name === DEMO_PLAYER,
    }));
  }

  const season: CachedSeason = {
    community: DEMO_COMMUNITY,
    knownMatchdays: DEMO_CURRENT_MATCHDAY,
    lastSync: new Date().toISOString(),
    matchdays: built.map<CachedMatchday>((md) => ({
      matchday: md.matchday,
      schedule: md.schedule,
      bets: md.bets,
      leaderboard: md.leaderboard,
      matchdayBets: md.matchdayBets,
    })),
  };

  return {
    community: DEMO_COMMUNITY,
    player: DEMO_PLAYER,
    teams: TEAMS,
    players: PLAYERS,
    currentMatchday: DEMO_CURRENT_MATCHDAY,
    season,
    bonusQuestions: demoBonusQuestions(),
    members: demoMembers(),
    overview: demoOverview(built),
    table: demoTable(built),
    rules: demoRules(),
    audit: demoAudit(),
  };
}

function demoOverview(built: BuiltMatchday[]): OverviewData {
  const totals = new Map<string, number>(PLAYERS.map((n) => [n, 0]));
  const perPlayer = new Map<string, Record<number, string>>(PLAYERS.map((n) => [n, {}]));
  for (const md of built) {
    if (md.matchday === DEMO_CURRENT_MATCHDAY) continue; // not scored yet
    for (const s of md.scored) {
      totals.set(s.name, (totals.get(s.name) ?? 0) + s.pts);
      perPlayer.get(s.name)![md.matchday] = String(s.pts);
    }
  }
  const players: OverviewPlayer[] = PLAYERS.map((name, i) => ({
    position: '0',
    name,
    matchdays: perPlayer.get(name)!,
    bonus: String(6 + ((i * 3) % 11)),
    wins: String(3 + ((i * 2) % 9)),
    total: String((totals.get(name) ?? 0) + 6 + ((i * 3) % 11)),
    isCurrentPlayer: name === DEMO_PLAYER,
  }));
  players.sort((a, b) => Number(b.total) - Number(a.total));
  players.forEach((p, i) => (p.position = String(i + 1)));
  return { label: 'Matchday points', maxMatchday: DEMO_CURRENT_MATCHDAY, players };
}

function demoTable(built: BuiltMatchday[]): { label: string; teams: TableTeam[] } {
  const stats = new Map<
    string,
    { p: number; w: number; d: number; l: number; gf: number; ga: number }
  >(TEAMS.map((t) => [t, { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0 }]));

  for (const md of built) {
    for (const m of md.schedule) {
      const res = parseScore(m.result);
      if (!res) continue;
      const home = stats.get(m.home)!;
      const away = stats.get(m.away)!;
      home.p++; away.p++;
      home.gf += res.home; home.ga += res.away;
      away.gf += res.away; away.ga += res.home;
      if (res.home > res.away) { home.w++; away.l++; }
      else if (res.home < res.away) { away.w++; home.l++; }
      else { home.d++; away.d++; }
    }
  }

  const teams: TableTeam[] = TEAMS.map((team) => {
    const s = stats.get(team)!;
    const points = s.w * 3 + s.d;
    return {
      position: '0',
      team,
      played: String(s.p),
      points: String(points),
      goalsFor: String(s.gf),
      goalsAgainst: String(s.ga),
      goalDifference: `${s.gf - s.ga >= 0 ? '+' : ''}${s.gf - s.ga}`,
      wins: String(s.w),
      draws: String(s.d),
      losses: String(s.l),
    };
  });
  teams.sort(
    (a, b) =>
      Number(b.points) - Number(a.points) ||
      Number(b.goalDifference) - Number(a.goalDifference) ||
      Number(b.goalsFor) - Number(a.goalsFor),
  );
  teams.forEach((t, i) => (t.position = String(i + 1)));
  return { label: 'League Table', teams };
}

function demoBonusQuestions(): BonusQuestion[] {
  const champ = TEAMS.slice(0, 6).map((t, i) => ({ value: String(i + 1), text: t }));
  const topScorer = ['Harry Kane', 'Serhou Guirassy', 'Loïs Openda', 'Deniz Undav'].map((t, i) => ({
    value: String(i + 1),
    text: t,
  }));
  return [
    {
      question: 'Who will be champion?',
      selects: [{ name: 'q_champ', options: champ, selected: '1' }],
    },
    {
      question: 'Top scorer of the season?',
      selects: [{ name: 'q_scorer', options: topScorer, selected: '-1' }],
    },
    {
      question: 'Which three teams get relegated?',
      selects: [0, 1, 2].map((n) => ({
        name: `q_releg_${n}`,
        options: TEAMS.slice(12).map((t, i) => ({ value: String(i + 1), text: t })),
        selected: n === 0 ? '6' : '-1',
      })),
    },
  ];
}

function demoMembers(): Member[] {
  return PLAYERS.map((name, i) => ({
    tipperId: String(1000 + i),
    tippsaisonId: '55',
    name,
    dummy: name === 'Noah Schulz',
  }));
}

function demoRules(): RulesSection[] {
  return [
    { type: 'heading', text: 'Scoring' },
    {
      type: 'paragraph',
      text: 'Points are awarded for each prediction depending on how close it is to the final result.',
    },
    {
      type: 'table',
      headers: ['Result', 'Points'],
      rows: [
        ['Exact score', '4'],
        ['Correct goal difference', '3'],
        ['Correct tendency', '2'],
        ['Wrong', '0'],
      ],
    },
    { type: 'heading', text: 'Bonus questions' },
    {
      type: 'paragraph',
      text: 'Bonus questions are answered once before the season and can swing the final standings.',
    },
  ];
}

function demoAudit(): AuditRecord[] {
  const now = Date.now();
  const at = (minsAgo: number) => new Date(now - minsAgo * 60000).toISOString();
  return [
    {
      at: at(180),
      source: 'cli:tui',
      community: DEMO_COMMUNITY,
      matchday: 24,
      kind: 'match',
      dryRun: false,
      outcome: 'submitted',
      bets: [
        { fixture: 'FC Bayern München vs Borussia Dortmund', bet: '2:1', previous: null },
        { fixture: 'RB Leipzig vs SC Freiburg', bet: '1:1', previous: '2:0' },
      ],
    },
    {
      at: at(1440),
      source: 'cli:suggest',
      community: DEMO_COMMUNITY,
      matchday: 23,
      kind: 'match',
      dryRun: false,
      outcome: 'submitted',
      bets: [{ fixture: 'VfB Stuttgart vs Union Berlin', bet: '2:0', previous: null }],
    },
    {
      at: at(4320),
      source: 'cli:tui',
      community: DEMO_COMMUNITY,
      matchday: null,
      kind: 'bonus',
      dryRun: false,
      outcome: 'submitted',
      bets: [{ fixture: 'Who will be champion?', bet: 'Bayer 04 Leverkusen', previous: null }],
    },
  ];
}
