#!/usr/bin/env node

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Page, launchBrowser } from './browser.js';
import { saveCommunity, savePlayer, loadCommunity, loadPlayer, hasCredentials, getActiveProfile, readDefaultStrategy } from './config.js';
import { CacheStore } from './cache/store.js';
import { loadSeason } from './analytics/season.js';
import { computeSeasonStats } from './analytics/season-stats.js';
import { resolveRulesFromCache } from './rules/resolve.js';
import { syncSeason } from './cache/sync.js';
import { isReadOnly } from './read-only.js';
import { buildDeadlineReport } from './analytics/deadline.js';
import { readAudit } from './audit/log.js';
import { findTargetCombinations, projectStandings } from './analytics/scenarios.js';
import { replaySeason, REPLAY_STRATEGIES } from './analytics/replay.js';
import { analyseRival } from './analytics/rivals.js';
import { gapBeforeMatchday } from './analytics/gap.js';
import { resolveRules } from './rules/resolve.js';
import { toOddsMatches } from './analytics/odds.js';
import { STRATEGIES, suggestBets, type StrategyName } from './analytics/strategies.js';
import {
  AuthError,
  resolveCommunity,
  fetchTodayMatches,
  fetchBets,
  fetchSchedule,
  fetchLeaderboard,
  fetchOverview,
  fetchTable,
  fetchRules,
  fetchCommunities,
  fetchPlayers,
  fetchBonusQuestions,
  fetchMatchdayBets,
  placeBets,
  placeBonusBets,
  OVERVIEW_VIEW_OPTIONS,
} from './core.js';

// ── Persistent Kicktipp session ────────────────────────────────────

let pageInstance: Page | null = null;

async function getPage(): Promise<Page> {
  if (pageInstance && !pageInstance.isClosed()) return pageInstance;
  if (!hasCredentials()) {
    throw new Error('No credentials found. Set KICKTIPP_EMAIL and KICKTIPP_PASSWORD env vars in the MCP server config, or run `kicktipp set-community` in a terminal.');
  }
  const { page } = await launchBrowser();
  pageInstance = page;
  return page;
}

async function discardSession(): Promise<void> {
  const stale = pageInstance;
  pageInstance = null;
  if (stale) await stale.close();
}

/**
 * Run a read-only tool body, retrying once with a fresh login if the cached
 * session turned out to be expired. Mutating tools must not use this: their
 * first attempt may already have submitted data.
 */
async function withFreshSession<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof AuthError)) throw err;
    await discardSession();
    return fn();
  }
}

// ── MCP Server ─────────────────────────────────────────────────────

/**
 * Every tool answers twice: human-readable text for clients that render text,
 * and structuredContent for clients that consume typed data. The structured
 * form is uniformly wrapped under `data`, so one output schema describes
 * every tool while the text payload keeps the tool's own shape.
 */
function jsonResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: { data },
  };
}

const OUTPUT_SCHEMA = { data: z.unknown() };


const readOnly = isReadOnly();

const server = new McpServer(
  { name: 'kicktipp', version: '1.0.0' },
  { instructions: (readOnly ? 'READ-ONLY CONNECTION: betting and settings tools are not available, and no tool here can change anything on kicktipp.com. Do not offer to place bets. ' : '') + 'kicktipp.com football prediction game. IMPORTANT: Call get_status first to check if credentials and a community are configured. If credentials are missing, tell the user to either set KICKTIPP_EMAIL and KICKTIPP_PASSWORD env vars in the MCP server config, or run `kicktipp set-community` in a terminal. If only the community is missing, call get_communities then set_community.' },
);

server.registerTool(
  'get_status',
  {
    description: 'Check current configuration. Call this first to see if a community and player are set. Most tools require a community. Use set_community and set_player if not configured.',
    inputSchema: {},
    outputSchema: OUTPUT_SCHEMA,
  },
  async () => {
    const credentials = hasCredentials();
    const community = loadCommunity();
    const player = loadPlayer();
    return jsonResult({
          read_only: readOnly,
          profile: getActiveProfile(),
          credentials_saved: credentials,
          community: community || null,
          player: player || null,
          setup_needed: !credentials || !community,
          setup_instructions: !credentials
            ? 'No credentials found. Set KICKTIPP_EMAIL and KICKTIPP_PASSWORD env vars in the MCP server config, or run `kicktipp set-community` in a terminal.'
            : !community
              ? 'No community set. Call get_communities then set_community.'
              : null,
        });
  },
);

server.registerTool(
  'get_today_matches',
  {
    description: "Get today's matches with bet status. Shows which games are happening today and whether bets have been placed.",
    inputSchema: {},
    outputSchema: OUTPUT_SCHEMA,
  },
  async () => withFreshSession(async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchTodayMatches(page, community);
    return jsonResult(data);
  }),
);

server.registerTool(
  'get_bets',
  {
    description: 'Get all matches and your current bets for a matchday. Shows team names (use these exact names for place_bets), your placed bets, and odds.',
    inputSchema: { matchday: z.number().int().min(1).max(34).optional().describe('Matchday number (1-34). Omit for current matchday.') },
    outputSchema: OUTPUT_SCHEMA,
  },
  async ({ matchday }) => withFreshSession(async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchBets(page, community, matchday);
    return jsonResult(data);
  }),
);

server.registerTool(
  'get_schedule',
  {
    description: 'Get the match schedule with results for a matchday.',
    inputSchema: { matchday: z.number().int().min(1).max(34).optional().describe('Matchday number (1-34). Omit for current matchday.') },
    outputSchema: OUTPUT_SCHEMA,
  },
  async ({ matchday }) => withFreshSession(async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchSchedule(page, community, matchday);
    return jsonResult(data);
  }),
);

server.registerTool(
  'get_leaderboard',
  {
    description: 'Get player rankings for a matchday. Includes matches/results and ranking table with points.',
    inputSchema: {
    matchday: z.number().int().min(1).max(34).optional().describe('Matchday number (1-34). Omit for current matchday.'),
    bonus: z.boolean().optional().describe('Show bonus question rankings instead of match rankings.'),
  },
    outputSchema: OUTPUT_SCHEMA,
  },
  async ({ matchday, bonus }) => withFreshSession(async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchLeaderboard(page, community, matchday, bonus);
    return jsonResult(data);
  }),
);

server.registerTool(
  'get_overview',
  {
    description: 'Get the season overview showing all players and their points across matchdays.',
    inputSchema: { view: z.enum(OVERVIEW_VIEW_OPTIONS as [string, ...string[]]).optional().describe('View type. Default: matchday-points.') },
    outputSchema: OUTPUT_SCHEMA,
  },
  async ({ view }) => withFreshSession(async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchOverview(page, community, view);
    return jsonResult(data);
  }),
);

server.registerTool(
  'get_table',
  {
    description: 'Get the league table (standings of the actual football teams, not the prediction game).',
    inputSchema: { option: z.enum(['home', 'away']).optional().describe('Filter by home or away games only.') },
    outputSchema: OUTPUT_SCHEMA,
  },
  async ({ option }) => withFreshSession(async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchTable(page, community, option);
    return jsonResult(data);
  }),
);

server.registerTool(
  'get_rules',
  {
    description: 'Get the game rules and scoring system.',
    inputSchema: {},
    outputSchema: OUTPUT_SCHEMA,
  },
  async () => withFreshSession(async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchRules(page, community);
    return jsonResult(data);
  }),
);

server.registerTool(
  'get_communities',
  {
    description: 'List all kicktipp communities the user belongs to.',
    inputSchema: {},
    outputSchema: OUTPUT_SCHEMA,
  },
  async () => withFreshSession(async () => {
    const page = await getPage();
    const data = await fetchCommunities(page);
    return jsonResult(data);
  }),
);

server.registerTool(
  'get_players',
  {
    description: 'List all players in the saved community.',
    inputSchema: {},
    outputSchema: OUTPUT_SCHEMA,
  },
  async () => withFreshSession(async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchPlayers(page, community);
    return jsonResult(data);
  }),
);

if (!readOnly) {
  server.registerTool(
  'set_community',
  {
    description: 'Set the active community. Use get_communities first to see available options, then pass the exact name.',
    inputSchema: { name: z.string().describe('Exact community name as returned by get_communities.') },
    outputSchema: OUTPUT_SCHEMA,
  },
  async ({ name }) => {
      const page = await getPage();
      const communities = await fetchCommunities(page);
      if (!communities.includes(name)) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Community "${name}" not found. Available: ${communities.join(', ')}` }, null, 2) }], isError: true };
      }
      saveCommunity(name);
      return jsonResult({ success: true, community: name });
    },
);
}

if (!readOnly) {
  server.registerTool(
  'set_player',
  {
    description: 'Set which player you are (for leaderboard highlighting). Use get_players first to see available names.',
    inputSchema: { name: z.string().describe('Exact player name as returned by get_players.') },
    outputSchema: OUTPUT_SCHEMA,
  },
  async ({ name }) => {
      const page = await getPage();
      const community = await resolveCommunity(page);
      const players = await fetchPlayers(page, community);
      if (!players.includes(name)) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Player "${name}" not found. Available: ${players.join(', ')}` }, null, 2) }], isError: true };
      }
      savePlayer(name);
      return jsonResult({ success: true, player: name });
    },
);
}

server.registerTool(
  'get_bonus_questions',
  {
    description: 'Get available bonus questions with their options and current selections.',
    inputSchema: {},
    outputSchema: OUTPUT_SCHEMA,
  },
  async () => withFreshSession(async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchBonusQuestions(page, community);
    return jsonResult(data);
  }),
);

server.registerTool(
  'whatif',
  {
    description: "Replay the cached season as if the player had followed a different strategy, and compare with what they actually scored. Strategies: a fixed scoreline such as '2:1', one of " + REPLAY_STRATEGIES.join(', ') + ", or suggest:safe|ev|contrarian. Needs a synced cache. Treat final_rank as an estimate — other players are compared on recorded totals that include bonus points the replay does not model.",
    inputSchema: {
    strategy: z.string().describe('A scoreline like "2:1", a named strategy, or "suggest:ev".'),
    player: z.string().optional().describe('Player to replay (default: the configured player).'),
  },
    outputSchema: OUTPUT_SCHEMA,
  },
  async ({ strategy, player }) => {
    const community = loadCommunity();
    if (!community) throw new Error('No community set. Call get_communities then set_community.');
    const ownPlayer = loadPlayer();
    const who = player || ownPlayer;
    if (!who) throw new Error('No player set. Call get_players then set_player, or pass a player.');

    const store = new CacheStore(community);
    const season = loadSeason(store);
    if (!season.matchdays.length) {
      return jsonResult({
            error: 'empty_cache',
            message: 'No season history cached yet. Call sync_history first.',
          });
    }

    const rules = resolveRulesFromCache(store);
    const result = replaySeason(season, who, rules.values, strategy, ownPlayer);
    const baseline =
      strategy === 'actual' ? null : replaySeason(season, who, rules.values, 'actual', ownPlayer);
    return jsonResult({ rules, result, baseline });
  },
);

server.registerTool(
  'get_standings_scenarios',
  {
    description: "Project the whole leaderboard under hypothetical results, or search for what has to happen for a player to reach a target rank. This answers questions like 'what do I need this weekend to take first?' in one call. Matches left unspecified come back as a rank range rather than a number, and the projection is exact only when every open match is given. Check the note field: before the deadline Kicktipp hides everyone's bets and nothing can be projected.",
    inputSchema: {
    results: z
      .array(z.object({
        home: z.string().describe('Home team, exactly as get_bets names it.'),
        away: z.string().describe('Away team.'),
        result: z.string().describe('Hypothetical result as "H:G", e.g. "2:1".'),
      }))
      .optional()
      .describe('Hypothetical results. Omit for the full open-ended range.'),
    matchday: z.number().int().min(1).max(34).optional().describe('Matchday (1-34). Omit for the current one.'),
    target_rank: z.number().int().min(1).optional().describe('Search for combinations reaching this rank instead of projecting.'),
    player: z.string().optional().describe('Player for target_rank (default: the configured player).'),
  },
    outputSchema: OUTPUT_SCHEMA,
  },
  async ({ results, matchday, target_rank, player }) => withFreshSession(async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const cache = { store: new CacheStore(community) };
    const grid = await fetchMatchdayBets(page, community, matchday, cache);
    const leaderboard = await fetchLeaderboard(page, community, matchday, false, cache);
    const rules = await resolveRules(page, community, cache);

    if (target_rank !== undefined) {
      const who = player || loadPlayer();
      if (!who) throw new Error('No player set. Call get_players then set_player, or pass a player.');
      const search = findTargetCombinations(grid, leaderboard, rules.values, who, target_rank);
      return jsonResult({ rules, search });
    }

    const projection = projectStandings(grid, leaderboard, rules.values, results ?? []);
    return jsonResult({ rules, projection });
  }),
);

server.registerTool(
  'get_bet_log',
  {
    description: 'Show what this agent has actually submitted to Kicktipp, with timestamps and which entry point did it. Use this to answer "what have you placed?" from the record rather than from memory. Records marked dry-run or intent never reached Kicktipp.',
    inputSchema: {
    matchday: z.number().int().min(1).max(34).optional().describe('Only this matchday.'),
    include_all: z.boolean().optional().describe('Include dry runs, intents and failures (default: submitted only).'),
  },
    outputSchema: OUTPUT_SCHEMA,
  },
  async ({ matchday, include_all }) => {
    const community = loadCommunity();
    if (!community) throw new Error('No community set. Call get_communities then set_community.');
    let records = readAudit(community);
    if (!include_all) records = records.filter((r) => r.outcome === 'submitted');
    if (matchday !== undefined) records = records.filter((r) => r.matchday === matchday);
    return jsonResult({ community, records });
  },
);

server.registerTool(
  'get_deadline',
  {
    description: "Show how long is left before kickoff and which matches still need a bet. Use this whenever the user asks what is still open, or before suggesting bets, so you can tell them how urgent it is. Times are interpreted in the time_zone field's zone, which is assumed rather than reported by Kicktipp — mention it if a countdown looks surprising.",
    inputSchema: {
    matchday: z.number().int().min(1).max(34).optional().describe('Matchday number (1-34). Omit for the current one.'),
    warn_hours: z.number().positive().optional().describe('Urgency window in hours (default 6).'),
  },
    outputSchema: OUTPUT_SCHEMA,
  },
  async ({ matchday, warn_hours }) => withFreshSession(async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const { matches } = await fetchBets(page, community, matchday);
    const report = buildDeadlineReport(community, matchday ?? null, matches, {
      warnHours: warn_hours,
    });
    return jsonResult(report);
  }),
);

server.registerTool(
  'get_stats',
  {
    description: 'Season analytics for a player: form per matchday against the league average, rank history, hit-type breakdown (exact / goal difference / tendency / miss), prediction bias vs. what actually happened, and consistency. Computed from the local cache, so call sync_history first if it is empty. Always quote the data_completeness figures when summarising, so the user knows how many matchdays the numbers rest on.',
    inputSchema: {
    player: z.string().optional().describe('Player name. Defaults to the configured player.'),
    compare: z.string().optional().describe('Optional second player to compute alongside.'),
  },
    outputSchema: OUTPUT_SCHEMA,
  },
  async ({ player, compare }) => {
    const community = loadCommunity();
    if (!community) throw new Error('No community set. Call get_communities then set_community.');
    const who = player || loadPlayer();
    if (!who) throw new Error('No player set. Call get_players then set_player, or pass a player name.');

    const store = new CacheStore(community);
    const season = loadSeason(store);
    const rules = resolveRulesFromCache(store);

    if (!season.matchdays.length) {
      return jsonResult({
            error: 'empty_cache',
            message: 'No season history cached yet. Call sync_history first; it may take a minute.',
          });
    }

    const own = loadPlayer();
    return jsonResult({
          rules,
          stats: computeSeasonStats(season, who, rules.values, own),
          compare: compare ? computeSeasonStats(season, compare, rules.values, own) : undefined,
        });
  },
);

server.registerTool(
  'sync_history',
  {
    description: 'Download this season into the local cache so get_stats has data to work with. Makes several requests per matchday and paces them politely, so the first run can take a minute. Safe to repeat: matchdays already complete are skipped.',
    inputSchema: {
    from: z.number().int().min(1).max(34).optional().describe('First matchday (default 1).'),
    to: z.number().int().min(1).max(34).optional().describe('Last matchday (default: end of season).'),
  },
    outputSchema: OUTPUT_SCHEMA,
  },
  async ({ from, to }) => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const result = await syncSeason(page, community, { from, to });
    return jsonResult(result);
  },
);

server.registerTool(
  'get_rival_analysis',
  {
    description: "Compare the user with another player for one matchday: the points gap, how much each remaining match can still swing it, and what has to happen to overtake them. Check the 'mode' field before answering - 'exact' means both bet sets are known, 'bounds' means the rival's bets are still hidden and the figures are best/worst limits, not predictions. Also report rules.source, since the point values may be assumed defaults rather than this community's real ones.",
    inputSchema: {
    rival: z.string().describe('Player to compare against, as named by get_players.'),
    matchday: z.number().int().min(1).max(34).optional().describe('Matchday number (1-34). Omit for the current one.'),
  },
    outputSchema: OUTPUT_SCHEMA,
  },
  async ({ rival, matchday }) => withFreshSession(async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const player = loadPlayer();
    if (!player) throw new Error('No player set. Call get_players then set_player first.');

    const store = new CacheStore(community);
    const cache = { store };
    const grid = await fetchMatchdayBets(page, community, matchday, cache);
    const leaderboard = await fetchLeaderboard(page, community, matchday, false, cache);
    const rules = await resolveRules(page, community, cache);

    const analysis = analyseRival(
      grid,
      player,
      rival,
      rules.values,
      gapBeforeMatchday(leaderboard, player, rival),
    );
    return jsonResult({ rules, analysis });
  }),
);

server.registerTool(
  'suggest_bets',
  {
    description: "Build a suggested bet slip for a matchday from the odds Kicktipp publishes. READ-ONLY: it returns suggestions and never submits anything. Show the slip and its reasoning to the user, and only if they explicitly agree, call place_bets yourself. Matches that already carry a bet are flagged so they are not silently overwritten. Strategies: 'safe' backs the likeliest outcome, 'ev' maximises expected points under the community's scoring rules, 'contrarian' fades the favourite in close matches and is high variance by design.",
    inputSchema: {
    strategy: z
      .enum(['safe', 'ev', 'contrarian', 'auto'])
      .optional()
      .describe('Defaults to the configured strategy, or safe.'),
    pin: z
      .array(z.object({
        home: z.string(),
        away: z.string(),
        bet: z.string().describe('Scoreline as "H:G".'),
      }))
      .optional()
      .describe('Picks the user has fixed; the strategy fills in the rest and leaves these alone.'),
    matchday: z.number().int().min(1).max(34).optional().describe('Matchday number (1-34). Omit for the current one.'),
  },
    outputSchema: OUTPUT_SCHEMA,
  },
  async ({ strategy, matchday, pin }) => withFreshSession(async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const store = new CacheStore(community);
    const cache = { store };

    const { matches } = await fetchBets(page, community, matchday, cache);
    const rules = await resolveRules(page, community, cache);
    const chosen = (strategy ?? readDefaultStrategy() ?? 'safe') as StrategyName;
    const suggestions = suggestBets(toOddsMatches(matches), rules.values, chosen, pin ?? []);

    return jsonResult({
          strategy: chosen,
          matchday: matchday ?? null,
          rules,
          suggestions,
          expectedPointsTotal: suggestions.reduce((sum, s) => sum + s.expectedPoints, 0),
          note: 'Suggestions only - nothing has been submitted. Show these to the user and call place_bets only after they confirm.',
        });
  }),
);

if (!readOnly) {
  server.registerTool(
  'place_bets',
  {
    description: 'Place match bets by fixture name. DESTRUCTIVE: submits real bets. Use dry_run=true to preview without submitting. Get exact team names from get_bets first. Format each bet as "Home vs Away=H:G" where H and G are goal counts.',
    inputSchema: {
      bets: z.array(z.string()).min(1).describe('Bets in format "Home vs Away=H:G", e.g. ["FC Bayern München vs Borussia Dortmund=2:1"]'),
      matchday: z.number().int().min(1).max(34).optional().describe('Matchday number (1-34). Omit for current matchday.'),
      dry_run: z.boolean().optional().describe('If true, validate and return what would be placed without submitting.'),
    },
    outputSchema: OUTPUT_SCHEMA,
  },
  async ({ bets, matchday, dry_run }) => {
      const page = await getPage();
      const community = await resolveCommunity(page);
      const placed = await placeBets(page, community, bets, matchday, !dry_run, 'mcp:place_bets');
      return jsonResult({ success: !dry_run, dry_run: !!dry_run, placed });
    },
);
}

if (!readOnly) {
  server.registerTool(
  'place_bonus_bets',
  {
    description: 'Place bonus question answers. DESTRUCTIVE: submits real bets. Use dry_run=true to preview without submitting. Get exact question text and options from get_bonus_questions first. Format each as "Question text=Answer".',
    inputSchema: {
      bets: z.array(z.string()).min(1).describe('Bonus bets in format "Question text=Answer", e.g. ["Who will be champion?=FC Bayern München"]'),
      dry_run: z.boolean().optional().describe('If true, validate and return what would be placed without submitting.'),
    },
    outputSchema: OUTPUT_SCHEMA,
  },
  async ({ bets, dry_run }) => {
      const page = await getPage();
      const community = await resolveCommunity(page);
      const placed = await placeBonusBets(page, community, bets, !dry_run, 'mcp:place_bonus_bets');
      return jsonResult({ success: !dry_run, dry_run: !!dry_run, placed });
    },
);
}


// ── Resources ──────────────────────────────────────────────────────
//
// Slow-changing data is also exposed as MCP resources, so a client can pin or
// re-read it without spending a tool call. They are served from the local
// cache: reading a resource never triggers a login, and it reports an empty
// cache rather than going to the network behind the user's back.

function cachedResource(kind: 'rules' | 'leaderboard' | 'schedule', matchday?: number) {
  const community = loadCommunity();
  if (!community) {
    return { error: 'no_community', message: 'No community set. Call set_community first.' };
  }
  const store = new CacheStore(community);
  const cached = store.read(kind, matchday);
  if (!cached) {
    return {
      error: 'not_cached',
      message: `No cached ${kind}${matchday ? ` for matchday ${matchday}` : ''}. Call sync_history first.`,
      community,
    };
  }
  return { community, fetchedAt: cached.fetchedAt, data: cached.data };
}

function resourceContents(uri: URL, payload: unknown) {
  return {
    contents: [
      { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) },
    ],
  };
}

server.registerResource(
  'rules',
  new ResourceTemplate('kicktipp://{community}/rules', { list: undefined }),
  {
    title: 'Scoring rules',
    description: "The community's rules page, as cached locally.",
    mimeType: 'application/json',
  },
  async (uri) => resourceContents(uri, cachedResource('rules')),
);

server.registerResource(
  'leaderboard',
  new ResourceTemplate('kicktipp://{community}/leaderboard/{matchday}', { list: undefined }),
  {
    title: 'Matchday leaderboard',
    description: 'Cached standings for one matchday.',
    mimeType: 'application/json',
  },
  async (uri, variables) =>
    resourceContents(uri, cachedResource('leaderboard', Number(variables.matchday))),
);

server.registerResource(
  'schedule',
  new ResourceTemplate('kicktipp://{community}/schedule/{matchday}', { list: undefined }),
  {
    title: 'Matchday schedule',
    description: 'Cached fixtures and results for one matchday.',
    mimeType: 'application/json',
  },
  async (uri, variables) =>
    resourceContents(uri, cachedResource('schedule', Number(variables.matchday))),
);

// ── Start ──────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
