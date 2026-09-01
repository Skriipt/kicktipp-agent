/**
 * The production DataSource: a thin adapter over the same functions the CLI
 * calls. It opens one authenticated session lazily (on the first request
 * that needs the network) and reuses it, so moving between screens does not
 * re-login.
 */
import { launchBrowser, type Page } from '../../browser.js';
import {
  fetchTodayMatches,
  fetchBets,
  fetchSchedule,
  fetchLeaderboard,
  fetchOverview,
  fetchTable,
  fetchRules,
  fetchCommunities,
  fetchPlayers,
  fetchMatchdayBets,
  fetchBonusQuestions,
  fetchBonusBets,
  fetchMembers,
  fetchBetsForMember,
  placeBets,
  placeBetsForMember,
  placeBonusBets,
  type Member,
} from '../../core.js';
import {
  loadCommunity,
  loadPlayer,
  getActiveProfile,
  saveCommunity,
  savePlayer,
  hasUsableAuth,
  listProfiles,
} from '../../config.js';
import { isReadOnly } from '../../read-only.js';
import { CacheStore } from '../../cache/store.js';
import { loadSeason } from '../../analytics/season.js';
import { computeSeasonStats } from '../../analytics/season-stats.js';
import { replaySeason } from '../../analytics/replay.js';
import { analyseRival } from '../../analytics/rivals.js';
import { projectStandings, type HypotheticalResult } from '../../analytics/scenarios.js';
import { gapBeforeMatchday } from '../../analytics/gap.js';
import { toOddsMatches } from '../../analytics/odds.js';
import { suggestBets, type StrategyName } from '../../analytics/strategies.js';
import { buildDeadlineReport } from '../../analytics/deadline.js';
import { resolveRules, resolveRulesFromCache } from '../../rules/resolve.js';
import { readAudit } from '../../audit/log.js';
import { notifierSnapshot, applyNotifierSettings } from '../../notify/backends.js';
import { saveNotifySection } from '../../config.js';
import { syncSeason, type SyncOptions } from '../../cache/sync.js';
import { getGuideText } from '../../commands/guide.js';
import type { AppContext, CacheInfo, DataSource, SuggestOutcome } from './source.js';

export class LiveDataSource implements DataSource {
  readonly demo = false;
  private page: Page | null = null;

  private async ensurePage(): Promise<Page> {
    if (!this.page) {
      const { page } = await launchBrowser();
      this.page = page;
    }
    return this.page;
  }

  private requireCommunity(): string {
    const community = loadCommunity();
    if (!community) {
      throw new Error('No community selected. Open “Set community” first (or run `kicktipp set-community`).');
    }
    return community;
  }

  private store(): CacheStore {
    return new CacheStore(this.requireCommunity());
  }

  getContext(): AppContext {
    return {
      community: loadCommunity(),
      player: loadPlayer(),
      profile: getActiveProfile(),
      readOnly: isReadOnly(),
      loggedIn: hasUsableAuth(),
      demo: false,
    };
  }

  async today() {
    const page = await this.ensurePage();
    return fetchTodayMatches(page, this.requireCommunity());
  }

  async bets(matchday?: number) {
    const page = await this.ensurePage();
    return fetchBets(page, this.requireCommunity(), matchday);
  }

  async schedule(matchday?: number) {
    const page = await this.ensurePage();
    return fetchSchedule(page, this.requireCommunity(), matchday);
  }

  async leaderboard(matchday?: number, bonus = false) {
    const page = await this.ensurePage();
    return fetchLeaderboard(page, this.requireCommunity(), matchday, bonus);
  }

  async overview(view = 'matchday-points') {
    const page = await this.ensurePage();
    return fetchOverview(page, this.requireCommunity(), view);
  }

  async table(option?: 'home' | 'away') {
    const page = await this.ensurePage();
    return fetchTable(page, this.requireCommunity(), option);
  }

  async rules() {
    const page = await this.ensurePage();
    return fetchRules(page, this.requireCommunity());
  }

  async communities() {
    const page = await this.ensurePage();
    return fetchCommunities(page);
  }

  async players() {
    const page = await this.ensurePage();
    return fetchPlayers(page, this.requireCommunity());
  }

  async matchdayBets(matchday?: number) {
    const page = await this.ensurePage();
    return fetchMatchdayBets(page, this.requireCommunity(), matchday);
  }

  async bonusQuestions() {
    const page = await this.ensurePage();
    return fetchBonusQuestions(page, this.requireCommunity());
  }

  async bonusBets() {
    const page = await this.ensurePage();
    return fetchBonusBets(page, this.requireCommunity());
  }

  async members() {
    const page = await this.ensurePage();
    return fetchMembers(page, this.requireCommunity());
  }

  async betsForMember(member: Member, matchday?: number) {
    const page = await this.ensurePage();
    return fetchBetsForMember(page, this.requireCommunity(), member, matchday);
  }

  async deadline(matchday?: number) {
    const page = await this.ensurePage();
    const community = this.requireCommunity();
    const { matches } = await fetchBets(page, community, matchday);
    return buildDeadlineReport(community, matchday ?? null, matches);
  }

  async suggest(strategy: StrategyName, matchday?: number): Promise<SuggestOutcome> {
    const page = await this.ensurePage();
    const community = this.requireCommunity();
    const cache = { store: new CacheStore(community) };
    const { matches } = await fetchBets(page, community, matchday);
    const rules = await resolveRules(page, community, cache);
    const suggestions = suggestBets(toOddsMatches(matches), rules.values, strategy);
    return { strategy, matchday: matchday ?? null, rules, suggestions };
  }

  async stats(player?: string) {
    const store = this.store();
    const season = loadSeason(store);
    const who = player ?? loadPlayer();
    if (!who) throw new Error('No player set. Open “Set player” first (or run `kicktipp set-player`).');
    const rules = resolveRulesFromCache(store);
    return computeSeasonStats(season, who, rules.values, loadPlayer());
  }

  async replay(strategy: string, player?: string) {
    const store = this.store();
    const season = loadSeason(store);
    const who = player ?? loadPlayer();
    if (!who) throw new Error('No player set. Open “Set player” first (or run `kicktipp set-player`).');
    const rules = resolveRulesFromCache(store);
    return replaySeason(season, who, rules.values, strategy, loadPlayer());
  }

  async rival(name: string, matchday?: number) {
    const page = await this.ensurePage();
    const community = this.requireCommunity();
    const player = loadPlayer();
    if (!player) throw new Error('No player set. Open “Set player” first (or run `kicktipp set-player`).');
    const cache = { store: new CacheStore(community) };
    const grid = await fetchMatchdayBets(page, community, matchday);
    const leaderboard = await fetchLeaderboard(page, community, matchday, false, cache);
    const rules = await resolveRules(page, community, cache);
    const gap = gapBeforeMatchday(leaderboard, player, name);
    return analyseRival(grid, player, name, rules.values, gap);
  }

  async scenario(matchday?: number, results: string[] = []) {
    const page = await this.ensurePage();
    const community = this.requireCommunity();
    const cache = { store: new CacheStore(community) };
    const grid = await fetchMatchdayBets(page, community, matchday);
    const leaderboard = await fetchLeaderboard(page, community, matchday, false, cache);
    const rules = await resolveRules(page, community, cache);
    const supplied = results.map(parseResultArg);
    return projectStandings(grid, leaderboard, rules.values, supplied);
  }

  async cacheInfo(): Promise<CacheInfo | null> {
    const community = loadCommunity();
    if (!community) return null;
    const store = new CacheStore(community);
    const meta = store.readMeta();
    return {
      community,
      dir: store.dir,
      sizeBytes: store.sizeBytes(),
      lastSync: meta?.lastSync ?? null,
      knownMatchdays: meta?.knownMatchdays ?? null,
      matchdays: store.cachedMatchdays(),
    };
  }

  clearCache(): void {
    this.store().clear();
  }

  auditLog(matchday?: number) {
    const community = loadCommunity();
    if (!community) return [];
    const records = readAudit(community);
    return matchday === undefined ? records : records.filter((r) => r.matchday === matchday);
  }

  profiles() {
    return { active: getActiveProfile(), profiles: listProfiles() };
  }

  notifyConfig() {
    const snap = notifierSnapshot();
    return { kind: snap.kind, target: snap.target, fromEnv: snap.from_env };
  }

  guide(): string {
    return getGuideText();
  }

  async placeBets(args: string[], matchday?: number) {
    const page = await this.ensurePage();
    return placeBets(page, this.requireCommunity(), args, matchday, true, 'cli:tui');
  }

  async placeBetsForMember(member: Member, args: string[], matchday?: number) {
    const page = await this.ensurePage();
    return placeBetsForMember(page, this.requireCommunity(), member, args, matchday, true, 'cli:admin');
  }

  async placeBonusBets(args: string[]) {
    const page = await this.ensurePage();
    return placeBonusBets(page, this.requireCommunity(), args, true, 'cli:tui');
  }

  setCommunity(name: string): void {
    saveCommunity(name);
  }

  setPlayer(name: string): void {
    savePlayer(name);
  }

  setNotify(kind: string, target?: string): void {
    if (kind === 'clear') {
      saveNotifySection({ kind: 'desktop' });
      return;
    }
    applyNotifierSettings(kind, target);
  }

  async sync(opts: SyncOptions) {
    const page = await this.ensurePage();
    return syncSeason(page, this.requireCommunity(), opts);
  }
}

/** '"Home vs Away=H:G"' → a hypothetical result. */
function parseResultArg(arg: string): HypotheticalResult {
  const eq = arg.lastIndexOf('=');
  if (eq === -1) throw new Error(`Invalid result '${arg}'. Use "Home vs Away=H:G".`);
  const fixture = arg.slice(0, eq).trim();
  const result = arg.slice(eq + 1).trim();
  const parts = fixture.split(/\s+vs\.?\s+/i);
  if (parts.length !== 2) throw new Error(`Invalid fixture in '${arg}'. Use "Home vs Away=H:G".`);
  return { home: parts[0].trim(), away: parts[1].trim(), result };
}
