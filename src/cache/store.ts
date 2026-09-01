import fs from 'fs';
import path from 'path';
import { parseMatchDate } from '../helpers/match-date.js';
import { communityDir } from './paths.js';
import type {
  BetMatch,
  LeaderboardData,
  MatchdayBets,
  OverviewData,
  RulesSection,
  ScheduleMatch,
  TableTeam,
} from '../core.js';

/**
 * Bumped when the shape of a cached payload changes. Readers ignore files
 * written by a different version and re-fetch instead of guessing.
 */
export const SCHEMA_VERSION = 1;

/** Payload shapes, keyed by what the cache calls them. */
export interface CacheKinds {
  schedule: { title: string; matches: ScheduleMatch[] };
  bets: { title: string; matches: BetMatch[] };
  leaderboard: LeaderboardData;
  matchdayBets: MatchdayBets;
  overview: OverviewData;
  table: { label: string; teams: TableTeam[] };
  rules: RulesSection[];
}

export type CacheKind = keyof CacheKinds;

/** Kinds stored once per matchday; everything else is stored once. */
const PER_MATCHDAY: ReadonlySet<CacheKind> = new Set<CacheKind>([
  'schedule',
  'bets',
  'leaderboard',
  'matchdayBets',
]);

export interface Envelope<K extends CacheKind> {
  schemaVersion: number;
  community: string;
  kind: K;
  matchday?: number;
  fetchedAt: string;
  data: CacheKinds[K];
}

export interface CacheMeta {
  schemaVersion: number;
  community: string;
  lastSync?: string;
  /** Highest matchday seen during a sync, so readers know the season length. */
  knownMatchdays?: number;
}

function matchdayFolder(matchday: number): string {
  return `matchday-${String(matchday).padStart(2, '0')}`;
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/**
 * A directory of JSON snapshots, one per page the agent has fetched.
 *
 * Deliberately not a database: the whole season is a few hundred kilobytes,
 * the shapes are the ones core.ts already returns, and staying dependency-free
 * keeps installs light.
 */
export class CacheStore {
  constructor(
    readonly community: string,
    private readonly root: string = communityDir(community),
  ) {}

  get dir(): string {
    return this.root;
  }

  private fileFor(kind: CacheKind, matchday?: number): string {
    if (PER_MATCHDAY.has(kind)) {
      if (matchday === undefined) {
        throw new Error(`Cache kind '${kind}' requires a matchday.`);
      }
      return path.join(this.root, matchdayFolder(matchday), `${kind}.json`);
    }
    return path.join(this.root, `${kind}.json`);
  }

  write<K extends CacheKind>(kind: K, data: CacheKinds[K], matchday?: number): void {
    const envelope: Envelope<K> = {
      schemaVersion: SCHEMA_VERSION,
      community: this.community,
      kind,
      matchday,
      fetchedAt: new Date().toISOString(),
      data,
    };
    writeJsonAtomic(this.fileFor(kind, matchday), envelope);
  }

  read<K extends CacheKind>(kind: K, matchday?: number): Envelope<K> | null {
    const envelope = readJson<Envelope<K>>(this.fileFor(kind, matchday));
    if (!envelope || envelope.schemaVersion !== SCHEMA_VERSION) return null;
    return envelope;
  }

  has(kind: CacheKind, matchday?: number): boolean {
    return this.read(kind, matchday) !== null;
  }

  /** Matchday numbers that have at least one cached file, ascending. */
  cachedMatchdays(): number[] {
    if (!fs.existsSync(this.root)) return [];
    return fs
      .readdirSync(this.root)
      .map((name) => name.match(/^matchday-(\d+)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
  }

  readMeta(): CacheMeta | null {
    const meta = readJson<CacheMeta>(path.join(this.root, 'meta.json'));
    if (!meta || meta.schemaVersion !== SCHEMA_VERSION) return null;
    return meta;
  }

  writeMeta(meta: Omit<CacheMeta, 'schemaVersion' | 'community'>): void {
    writeJsonAtomic(path.join(this.root, 'meta.json'), {
      schemaVersion: SCHEMA_VERSION,
      community: this.community,
      ...meta,
    });
  }

  clear(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
  }

  /** Total bytes on disk, for `kicktipp cache status`. */
  sizeBytes(): number {
    if (!fs.existsSync(this.root)) return 0;
    let total = 0;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else total += fs.statSync(full).size;
      }
    };
    walk(this.root);
    return total;
  }
}

/** A matchday counts as finished once every match has a real result. */
export function isMatchdayFinished(matches: ScheduleMatch[]): boolean {
  return matches.length > 0 && matches.every((m) => /^\d+:\d+$/.test(m.result));
}

/** True when every fixture has a kickoff after `now`. Unparseable dates
 *  mean we cannot tell, so this stays false and the matchday is fetched. */
export function isMatchdayUpcoming(matches: ScheduleMatch[], now: Date = new Date()): boolean {
  if (!matches.length) return false;
  const kickoffs: Date[] = [];
  for (const match of matches) {
    const at = parseMatchDate(match.date);
    if (!at) return false;
    kickoffs.push(at);
  }
  return kickoffs.every((at) => at.getTime() > now.getTime());
}
