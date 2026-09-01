/**
 * The single seam between the TUI and the outside world.
 *
 * Every screen reads and writes through a DataSource, so the interface is the
 * whole contract. The live implementation talks to Kicktipp exactly the way
 * the CLI does; the demo implementation serves fixtures, which is what powers
 * `kicktipp tui --demo` and the tests. Nothing in the views knows which one
 * it has.
 */
import type {
  BetMatch,
  BonusAnswer,
  BonusQuestion,
  LeaderboardData,
  MatchdayBets,
  Member,
  OverviewData,
  PlacedBet,
  PlacedBonusBet,
  RulesSection,
  ScheduleMatch,
  TableTeam,
  TodayMatch,
} from '../../core.js';
import type { DeadlineReport } from '../../analytics/deadline.js';
import type { SeasonStats } from '../../analytics/season-stats.js';
import type { ReplayResult } from '../../analytics/replay.js';
import type { RivalAnalysis } from '../../analytics/rivals.js';
import type { ScenarioProjection } from '../../analytics/scenarios.js';
import type { SuggestedBet, StrategyName } from '../../analytics/strategies.js';
import type { ResolvedRules } from '../../rules/scoring.js';
import type { SyncOptions, SyncResult } from '../../cache/sync.js';
import type { AuditRecord } from '../../audit/log.js';

export interface AppContext {
  community: string | null;
  player: string | null;
  profile: string | null;
  readOnly: boolean;
  loggedIn: boolean;
  demo: boolean;
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

export interface DataSource {
  readonly demo: boolean;
  getContext(): AppContext;

  // ── Reads (network, unless demo) ────────────────────────────────
  today(): Promise<{ title: string; matches: TodayMatch[] }>;
  bets(matchday?: number): Promise<{ title: string; matches: BetMatch[] }>;
  schedule(matchday?: number): Promise<{ title: string; matches: ScheduleMatch[] }>;
  leaderboard(matchday?: number, bonus?: boolean): Promise<LeaderboardData>;
  overview(view?: string): Promise<OverviewData>;
  table(option?: 'home' | 'away'): Promise<{ label: string; teams: TableTeam[] }>;
  rules(): Promise<RulesSection[]>;
  communities(): Promise<string[]>;
  players(): Promise<string[]>;
  matchdayBets(matchday?: number): Promise<MatchdayBets>;
  bonusQuestions(): Promise<BonusQuestion[]>;
  bonusBets(): Promise<BonusAnswer[]>;
  members(): Promise<Member[]>;
  betsForMember(member: Member, matchday?: number): Promise<{ member: Member; matches: BetMatch[] }>;
  deadline(matchday?: number): Promise<DeadlineReport>;
  suggest(strategy: StrategyName, matchday?: number): Promise<SuggestOutcome>;

  // ── Analytics (cache only) ──────────────────────────────────────
  stats(player?: string): Promise<SeasonStats>;
  replay(strategy: string, player?: string): Promise<ReplayResult>;
  rival(name: string, matchday?: number): Promise<RivalAnalysis>;
  scenario(matchday?: number, results?: string[]): Promise<ScenarioProjection>;

  // ── Local state ─────────────────────────────────────────────────
  cacheInfo(): Promise<CacheInfo | null>;
  clearCache(): void;
  auditLog(matchday?: number): AuditRecord[];
  profiles(): { active: string | null; profiles: string[] };
  notifyConfig(): { kind: string; target: string | null; fromEnv: boolean };
  guide(): string;

  // ── Writes ──────────────────────────────────────────────────────
  placeBets(args: string[], matchday?: number): Promise<PlacedBet[]>;
  placeBetsForMember(member: Member, args: string[], matchday?: number): Promise<PlacedBet[]>;
  placeBonusBets(args: string[]): Promise<PlacedBonusBet[]>;
  setCommunity(name: string): void;
  setPlayer(name: string): void;
  setNotify(kind: string, target?: string): void;
  sync(opts: SyncOptions): Promise<SyncResult>;
}
