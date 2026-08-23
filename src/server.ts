#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Page, launchBrowser } from './browser.js';
import { saveCommunity, savePlayer, loadCommunity, loadPlayer, hasCredentials } from './config.js';
import { CacheStore } from './cache/store.js';
import { loadSeason } from './analytics/season.js';
import { computeSeasonStats } from './analytics/season-stats.js';
import { resolveRulesFromCache } from './rules/resolve.js';
import { syncSeason } from './cache/sync.js';
import { isReadOnly } from './read-only.js';
import { analyseRival } from './analytics/rivals.js';
import { gapBeforeMatchday } from './analytics/gap.js';
import { resolveRules } from './rules/resolve.js';
import { toOddsMatches } from './analytics/odds.js';
import { STRATEGIES, suggestBets } from './analytics/strategies.js';
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

const readOnly = isReadOnly();

const server = new McpServer(
  { name: 'kicktipp', version: '1.0.0' },
  { instructions: (readOnly ? 'READ-ONLY CONNECTION: betting and settings tools are not available, and no tool here can change anything on kicktipp.com. Do not offer to place bets. ' : '') + 'kicktipp.com football prediction game. IMPORTANT: Call get_status first to check if credentials and a community are configured. If credentials are missing, tell the user to either set KICKTIPP_EMAIL and KICKTIPP_PASSWORD env vars in the MCP server config, or run `kicktipp set-community` in a terminal. If only the community is missing, call get_communities then set_community.' },
);

server.tool(
  'get_status',
  'Check current configuration. Call this first to see if a community and player are set. Most tools require a community. Use set_community and set_player if not configured.',
  {},
  async () => {
    const credentials = hasCredentials();
    const community = loadCommunity();
    const player = loadPlayer();
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          read_only: readOnly,
          credentials_saved: credentials,
          community: community || null,
          player: player || null,
          setup_needed: !credentials || !community,
          setup_instructions: !credentials
            ? 'No credentials found. Set KICKTIPP_EMAIL and KICKTIPP_PASSWORD env vars in the MCP server config, or run `kicktipp set-community` in a terminal.'
            : !community
              ? 'No community set. Call get_communities then set_community.'
              : null,
        }, null, 2),
      }],
    };
  },
);

server.tool(
  'get_today_matches',
  "Get today's matches with bet status. Shows which games are happening today and whether bets have been placed.",
  {},
  async () => withFreshSession(async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchTodayMatches(page, community);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }),
);

server.tool(
  'get_bets',
  'Get all matches and your current bets for a matchday. Shows team names (use these exact names for place_bets), your placed bets, and odds.',
  { matchday: z.number().int().min(1).max(34).optional().describe('Matchday number (1-34). Omit for current matchday.') },
  async ({ matchday }) => withFreshSession(async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchBets(page, community, matchday);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }),
);

server.tool(
  'get_schedule',
  'Get the match schedule with results for a matchday.',
  { matchday: z.number().int().min(1).max(34).optional().describe('Matchday number (1-34). Omit for current matchday.') },
  async ({ matchday }) => withFreshSession(async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchSchedule(page, community, matchday);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }),
);

server.tool(
  'get_leaderboard',
  'Get player rankings for a matchday. Includes matches/results and ranking table with points.',
  {
    matchday: z.number().int().min(1).max(34).optional().describe('Matchday number (1-34). Omit for current matchday.'),
    bonus: z.boolean().optional().describe('Show bonus question rankings instead of match rankings.'),
  },
  async ({ matchday, bonus }) => withFreshSession(async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchLeaderboard(page, community, matchday, bonus);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }),
);

server.tool(
  'get_overview',
  'Get the season overview showing all players and their points across matchdays.',
  { view: z.enum(OVERVIEW_VIEW_OPTIONS as [string, ...string[]]).optional().describe('View type. Default: matchday-points.') },
  async ({ view }) => withFreshSession(async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchOverview(page, community, view);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }),
);

server.tool(
  'get_table',
  'Get the league table (standings of the actual football teams, not the prediction game).',
  { option: z.enum(['home', 'away']).optional().describe('Filter by home or away games only.') },
  async ({ option }) => withFreshSession(async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchTable(page, community, option);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }),
);

server.tool(
  'get_rules',
  'Get the game rules and scoring system.',
  {},
  async () => withFreshSession(async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchRules(page, community);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }),
);

server.tool(
  'get_communities',
  'List all kicktipp communities the user belongs to.',
  {},
  async () => withFreshSession(async () => {
    const page = await getPage();
    const data = await fetchCommunities(page);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }),
);

server.tool(
  'get_players',
  'List all players in the saved community.',
  {},
  async () => withFreshSession(async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchPlayers(page, community);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }),
);

if (!readOnly) {
  server.tool(
    'set_community',
    'Set the active community. Use get_communities first to see available options, then pass the exact name.',
    { name: z.string().describe('Exact community name as returned by get_communities.') },
    async ({ name }) => {
      const page = await getPage();
      const communities = await fetchCommunities(page);
      if (!communities.includes(name)) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Community "${name}" not found. Available: ${communities.join(', ')}` }, null, 2) }], isError: true };
      }
      saveCommunity(name);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, community: name }, null, 2) }] };
    },
  );
}

if (!readOnly) {
  server.tool(
    'set_player',
    'Set which player you are (for leaderboard highlighting). Use get_players first to see available names.',
    { name: z.string().describe('Exact player name as returned by get_players.') },
    async ({ name }) => {
      const page = await getPage();
      const community = await resolveCommunity(page);
      const players = await fetchPlayers(page, community);
      if (!players.includes(name)) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Player "${name}" not found. Available: ${players.join(', ')}` }, null, 2) }], isError: true };
      }
      savePlayer(name);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, player: name }, null, 2) }] };
    },
  );
}

server.tool(
  'get_bonus_questions',
  'Get available bonus questions with their options and current selections.',
  {},
  async () => withFreshSession(async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const data = await fetchBonusQuestions(page, community);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }),
);

server.tool(
  'get_stats',
  'Season analytics for a player: form per matchday against the league average, rank history, hit-type breakdown (exact / goal difference / tendency / miss), prediction bias vs. what actually happened, and consistency. Computed from the local cache, so call sync_history first if it is empty. Always quote the data_completeness figures when summarising, so the user knows how many matchdays the numbers rest on.',
  {
    player: z.string().optional().describe('Player name. Defaults to the configured player.'),
    compare: z.string().optional().describe('Optional second player to compute alongside.'),
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
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: 'empty_cache',
            message: 'No season history cached yet. Call sync_history first; it may take a minute.',
          }, null, 2),
        }],
      };
    }

    const own = loadPlayer();
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          rules,
          stats: computeSeasonStats(season, who, rules.values, own),
          compare: compare ? computeSeasonStats(season, compare, rules.values, own) : undefined,
        }, null, 2),
      }],
    };
  },
);

server.tool(
  'sync_history',
  'Download this season into the local cache so get_stats has data to work with. Makes several requests per matchday and paces them politely, so the first run can take a minute. Safe to repeat: matchdays already complete are skipped.',
  {
    from: z.number().int().min(1).max(34).optional().describe('First matchday (default 1).'),
    to: z.number().int().min(1).max(34).optional().describe('Last matchday (default: end of season).'),
  },
  async ({ from, to }) => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const result = await syncSeason(page, community, { from, to });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'get_rival_analysis',
  "Compare the user with another player for one matchday: the points gap, how much each remaining match can still swing it, and what has to happen to overtake them. Check the 'mode' field before answering - 'exact' means both bet sets are known, 'bounds' means the rival's bets are still hidden and the figures are best/worst limits, not predictions. Also report rules.source, since the point values may be assumed defaults rather than this community's real ones.",
  {
    rival: z.string().describe('Player to compare against, as named by get_players.'),
    matchday: z.number().int().min(1).max(34).optional().describe('Matchday number (1-34). Omit for the current one.'),
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
    return { content: [{ type: 'text' as const, text: JSON.stringify({ rules, analysis }, null, 2) }] };
  }),
);

server.tool(
  'suggest_bets',
  "Build a suggested bet slip for a matchday from the odds Kicktipp publishes. READ-ONLY: it returns suggestions and never submits anything. Show the slip and its reasoning to the user, and only if they explicitly agree, call place_bets yourself. Matches that already carry a bet are flagged so they are not silently overwritten. Strategies: 'safe' backs the likeliest outcome, 'ev' maximises expected points under the community's scoring rules, 'contrarian' fades the favourite in close matches and is high variance by design.",
  {
    strategy: z.enum(['safe', 'ev', 'contrarian']).optional().describe('Default: safe.'),
    matchday: z.number().int().min(1).max(34).optional().describe('Matchday number (1-34). Omit for the current one.'),
  },
  async ({ strategy, matchday }) => withFreshSession(async () => {
    const page = await getPage();
    const community = await resolveCommunity(page);
    const store = new CacheStore(community);
    const cache = { store };

    const { matches } = await fetchBets(page, community, matchday, cache);
    const rules = await resolveRules(page, community, cache);
    const chosen = (strategy ?? 'safe') as (typeof STRATEGIES)[number];
    const suggestions = suggestBets(toOddsMatches(matches), rules.values, chosen);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          strategy: chosen,
          matchday: matchday ?? null,
          rules,
          suggestions,
          expectedPointsTotal: suggestions.reduce((sum, s) => sum + s.expectedPoints, 0),
          note: 'Suggestions only - nothing has been submitted. Show these to the user and call place_bets only after they confirm.',
        }, null, 2),
      }],
    };
  }),
);

if (!readOnly) {
  server.tool(
    'place_bets',
    'Place match bets by fixture name. DESTRUCTIVE: submits real bets. Use dry_run=true to preview without submitting. Get exact team names from get_bets first. Format each bet as "Home vs Away=H:G" where H and G are goal counts.',
    {
      bets: z.array(z.string()).min(1).describe('Bets in format "Home vs Away=H:G", e.g. ["FC Bayern München vs Borussia Dortmund=2:1"]'),
      matchday: z.number().int().min(1).max(34).optional().describe('Matchday number (1-34). Omit for current matchday.'),
      dry_run: z.boolean().optional().describe('If true, validate and return what would be placed without submitting.'),
    },
    async ({ bets, matchday, dry_run }) => {
      const page = await getPage();
      const community = await resolveCommunity(page);
      const placed = await placeBets(page, community, bets, matchday, !dry_run);
      return { content: [{ type: 'text', text: JSON.stringify({ success: !dry_run, dry_run: !!dry_run, placed }, null, 2) }] };
    },
  );
}

if (!readOnly) {
  server.tool(
    'place_bonus_bets',
    'Place bonus question answers. DESTRUCTIVE: submits real bets. Use dry_run=true to preview without submitting. Get exact question text and options from get_bonus_questions first. Format each as "Question text=Answer".',
    {
      bets: z.array(z.string()).min(1).describe('Bonus bets in format "Question text=Answer", e.g. ["Who will be champion?=FC Bayern München"]'),
      dry_run: z.boolean().optional().describe('If true, validate and return what would be placed without submitting.'),
    },
    async ({ bets, dry_run }) => {
      const page = await getPage();
      const community = await resolveCommunity(page);
      const placed = await placeBonusBets(page, community, bets, !dry_run);
      return { content: [{ type: 'text', text: JSON.stringify({ success: !dry_run, dry_run: !!dry_run, placed }, null, 2) }] };
    },
  );
}

// ── Start ──────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
