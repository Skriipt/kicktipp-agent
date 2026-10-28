#!/usr/bin/env node

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { existsSync, realpathSync } from 'node:fs';
import { kicktippQueue, type SerialQueue } from './service/queue.js';
import { localizeMatchDates } from './helpers/match-date.js';
import { Page, getCommunities, getPlayers, launchBrowser } from './browser.js';
import { saveCommunity, savePlayer, loadCommunity, loadPlayer, hasUsableAuth, isSessionOnly, SessionOnlyExpiredError, getActiveProfile, accountScope, readDefaultStrategy, readUiLanguage, readUiSite } from './config.js';
import { createProfileAccess, type describeProfiles } from './service/profiles.js';
import { VERSION } from './version.js';
import { resolveLanguage, setLanguage } from './i18n/index.js';
import { resolveBaseUrl, setUrlBase } from './url.js';
import { CacheStore } from './cache/store.js';
import { loadSeason } from './analytics/season.js';
import { computeSeasonStats } from './analytics/season-stats.js';
import { resolveRulesFromCache } from './rules/resolve.js';
import { syncSeason } from './cache/sync.js';
import { isReadOnly, assertWritable } from './read-only.js';
import { buildDeadlineReport } from './analytics/deadline.js';
import { readAudit } from './audit/log.js';
import { resolveRules } from './rules/resolve.js';
import { toOddsMatches } from './analytics/odds.js';
import { suggestBets, type StrategyName } from './analytics/strategies.js';
import { fetchTipStatus } from './tip-status.js';
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
  fetchBonusQuestions,
  fetchMembers,
  fetchBetsForMember,
  placeBetsForMember,
  resolveMember,
  placeBets,
  placeBonusBets,
  OVERVIEW_VIEW_OPTIONS,
} from './core.js';


// ── Persistent Kicktipp session ────────────────────────────────────

let pageInstance: Page | null = null;
let pageOwner: string | null = null;

const SETUP_INSTRUCTIONS = 'Open the service web interface to configure the selected profile, or run docker compose run --rm kicktipp setup on the server to connect or reconnect the account. Never send passwords in chat.';

async function getPage(): Promise<Page> {
  const owner = `${process.env.KICKTIPP_CONFIG_DIR ?? ''}:${accountScope()}`;
  if (pageOwner !== owner) await discardSession();
  if (pageInstance && !pageInstance.isClosed()) return pageInstance;
  if (!hasUsableAuth()) {
    throw new Error(SETUP_INSTRUCTIONS);
  }
  try {
    const page = await launchBrowser();
    pageInstance = page;
    pageOwner = owner;
    return page;
  } catch (err) {
    if (err instanceof SessionOnlyExpiredError) {
      throw new Error(`Kicktipp session expired. ${SETUP_INSTRUCTIONS}`);
    }
    throw err;
  }
}

export async function discardSession(): Promise<void> {
  const stale = pageInstance;
  pageInstance = null;
  pageOwner = null;
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

const OUTPUT_SCHEMA = z.object({ data: z.unknown() });

export interface McpServerOptions {
  queue?: SerialQueue;
  /** A long-running instance has fixed account, community and player settings. */
  lockedConfiguration?: boolean;
  serviceStatus?: (profile?: string) => unknown;
  profiles?: () => ReturnType<typeof describeProfiles>;
  /** Runs within queue; binds the complete operation to the selected profile. */
  withProfile?: <T>(id: string | undefined, operation: () => Promise<T>) => Promise<T>;
}

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const queue = options.queue ?? kicktippQueue;
  function serial<Args extends unknown[], Result>(fn: (...args: Args) => Promise<Result>): (...args: Args) => Promise<Result> {
    return (...args) => queue.run(async () => {
      const input = args[0] instanceof URL ? args[1] : args[0];
      const profile = input && typeof input === 'object' && 'profile' in input ? input.profile : undefined;
      if (profile !== undefined && typeof profile !== 'string') throw new Error('Invalid profile ID.');
      if (profile !== undefined && !options.withProfile) throw new Error('Per-call profiles require a service configuration. Select standalone CLI profiles through KICKTIPP_PROFILE.');
      return options.withProfile ? options.withProfile(profile, () => fn(...args)) : fn(...args);
    });
  }
  function profileInput<Shape extends z.ZodRawShape>(shape: Shape) {
    return z.object({ ...shape, profile: z.string().min(1).optional().describe(
      'Profile ID from get_profiles. Required when multiple profiles exist; omitted only for a single profile. Use the same profile for reads, suggestions and submissions.',
    ) });
  }
  // Service requests activate settings inside the shared queue. Creating an MCP
  // transport must not change the site under a scheduler operation in flight.
  if (!options.withProfile) {
    setLanguage(resolveLanguage({ configLanguage: readUiLanguage() }));
    setUrlBase(resolveBaseUrl({ configSite: readUiSite() }));
  }
  const readOnly = options.profiles ? options.profiles().every(profile => profile.read_only) : isReadOnly();

  const server = new McpServer(
    { name: 'kicktipp', version: VERSION },
    { instructions: (readOnly ? 'READ-ONLY CONNECTION: betting and settings tools are not available, and no tool here can change anything on Kicktipp. Do not offer to place bets. ' : '') + (options.profiles ? 'Kicktipp football prediction game (kicktipp.com and kicktipp.de). Call get_status and get_profiles first. Each profile is a separate account, prediction pool, permissions and reminders. Use its exact ID in the profile argument on every tool call. If there is one profile, omission selects it; with multiple profiles omission is rejected. Ask which profile the user means when ambiguous. For all profiles, call each separately and label results by profile name. Always use the same profile for get_bets, suggestions and submissions; never infer it from the last call or community name. A shared MCP connection has access to every listed profile; read_only forbids submissions for that profile even if write tools exist for others. Account, profile and notification setup is performed by the owner in the service web interface. Never ask for a password in chat.' : 'Kicktipp football prediction game. Call get_status first. This standalone connection uses the configured CLI account. The owner configures it locally; never ask for a password in chat.') },
  );

  server.registerTool(
    'get_status',
    {
      description: 'Check account configuration and service status without exposing credentials. Call this first. If setup_needed is true, the owner should run the setup command on the server.',
      inputSchema: profileInput({}),
      outputSchema: OUTPUT_SCHEMA,
    },
    async ({ profile }) => queue.run(async () => {
      const profiles = options.profiles?.();
      if (!profiles && profile !== undefined) throw new Error('Per-call profiles require a service configuration.');
      if (profiles && profile === undefined && profiles.length !== 1) {
        return jsonResult({ profiles, read_only: readOnly, setup_needed: !profiles.length,
          service: options.serviceStatus?.() ?? null,
          setup_instructions: !profiles.length ? SETUP_INSTRUCTIONS : null });
      }
      const status = async () => {
        const usable = hasUsableAuth();
        const community = loadCommunity();
        return jsonResult({ read_only: isReadOnly(),
          profile: profiles ? (profile ?? profiles[0]?.id) : getActiveProfile(),
          ...(profiles ? { profiles } : {}), credentials_saved: usable, session_only: isSessionOnly(),
          community: community || null, player: loadPlayer() || null,
          service: options.serviceStatus?.(profile ?? profiles?.[0]?.id) ?? null,
          setup_needed: !usable || !community,
          setup_instructions: !usable || !community ? SETUP_INSTRUCTIONS : null });
      };
      return options.withProfile ? options.withProfile(profile, status) : status();
    }),
  );

  if (options.profiles) server.registerTool('get_profiles', {
    description: 'List all available profiles with stable IDs, names, communities and read-only permissions. Use the profile ID in subsequent tools. Never guess a profile when several exist.',
    inputSchema: z.object({}), outputSchema: OUTPUT_SCHEMA,
  }, async () => jsonResult({ profiles: options.profiles!() }));

  server.registerTool(
    'get_today_matches',
    {
      description: "Get today's matches with bet status. Shows which games are happening today and whether bets have been placed.",
      inputSchema: profileInput({}),
      outputSchema: OUTPUT_SCHEMA,
    },
    serial(async () => withFreshSession(async () => {
      const page = await getPage();
      const community = await resolveCommunity(page);
      const data = await fetchTodayMatches(page, community);
      return jsonResult(data);
    })),
  );

  server.registerTool(
    'get_bets',
    {
      description: 'Get all matches and your current bets for a matchday. Shows team names (use these exact names for place_bets), your placed bets, and odds.',
      inputSchema: profileInput({ matchday: z.number().int().min(1).max(34).optional().describe('Matchday number (1-34). Omit for current matchday.') }),
      outputSchema: OUTPUT_SCHEMA,
    },
    serial(async ({ matchday }) => withFreshSession(async () => {
      const page = await getPage();
      const community = await resolveCommunity(page);
      const data = await fetchBets(page, community, matchday);
      return jsonResult({ ...data, matches: localizeMatchDates(data.matches) });
    })),
  );

  server.registerTool(
    'get_schedule',
    {
      description: 'Get the match schedule with results for a matchday.',
      inputSchema: profileInput({ matchday: z.number().int().min(1).max(34).optional().describe('Matchday number (1-34). Omit for current matchday.') }),
      outputSchema: OUTPUT_SCHEMA,
    },
    serial(async ({ matchday }) => withFreshSession(async () => {
      const page = await getPage();
      const community = await resolveCommunity(page);
      const data = await fetchSchedule(page, community, matchday);
      return jsonResult({ ...data, matches: localizeMatchDates(data.matches) });
    })),
  );

  server.registerTool(
    'get_leaderboard',
    {
      description: 'Get player rankings for a matchday. Includes matches/results and ranking table with points.',
      inputSchema: profileInput({
        matchday: z.number().int().min(1).max(34).optional().describe('Matchday number (1-34). Omit for current matchday.'),
        bonus: z.boolean().optional().describe('Show bonus question rankings instead of match rankings.'),
      }),
      outputSchema: OUTPUT_SCHEMA,
    },
    serial(async ({ matchday, bonus }) => withFreshSession(async () => {
      const page = await getPage();
      const community = await resolveCommunity(page);
      const data = await fetchLeaderboard(page, community, matchday, bonus);
      return jsonResult(
        data.matches ? { ...data, matches: localizeMatchDates(data.matches) } : data,
      );
    })),
  );

  server.registerTool(
    'get_tip_status',
    {
      description:
        'Show which players have submitted all, some, or none of their tips for a matchday. This is read-only and does not reveal the score predictions.',
      inputSchema: profileInput({
        matchday: z
          .number()
          .int()
          .min(1)
          .max(34)
          .optional()
          .describe('Matchday number (1-34). Omit for the current matchday.'),
      }),
      outputSchema: OUTPUT_SCHEMA,
    },
    serial(async ({ matchday }) =>
      withFreshSession(async () => {
        const page = await getPage();
        const community = await resolveCommunity(page);
        return jsonResult(await fetchTipStatus(page, community, matchday));
      })),
  );

  server.registerTool(
    'get_overview',
    {
      description: 'Get the season overview showing all players and their points across matchdays.',
      inputSchema: profileInput({ view: z.enum(OVERVIEW_VIEW_OPTIONS as [string, ...string[]]).optional().describe('View type. Default: matchday-points.') }),
      outputSchema: OUTPUT_SCHEMA,
    },
    serial(async ({ view }) => withFreshSession(async () => {
      const page = await getPage();
      const community = await resolveCommunity(page);
      const data = await fetchOverview(page, community, view);
      return jsonResult(data);
    })),
  );

  server.registerTool(
    'get_table',
    {
      description: 'Get the league table (standings of the actual football teams, not the prediction game).',
      inputSchema: profileInput({ option: z.enum(['home', 'away']).optional().describe('Filter by home or away games only.') }),
      outputSchema: OUTPUT_SCHEMA,
    },
    serial(async ({ option }) => withFreshSession(async () => {
      const page = await getPage();
      const community = await resolveCommunity(page);
      const data = await fetchTable(page, community, option);
      return jsonResult(data);
    })),
  );

  server.registerTool(
    'get_rules',
    {
      description: 'Get the game rules and scoring system.',
      inputSchema: profileInput({}),
      outputSchema: OUTPUT_SCHEMA,
    },
    serial(async () => withFreshSession(async () => {
      const page = await getPage();
      const community = await resolveCommunity(page);
      const data = await fetchRules(page, community);
      return jsonResult(data);
    })),
  );

  server.registerTool(
    'get_communities',
    {
      description: 'List all kicktipp communities the user belongs to.',
      inputSchema: profileInput({}),
      outputSchema: OUTPUT_SCHEMA,
    },
    serial(async () => withFreshSession(async () => {
      const page = await getPage();
      const data = await getCommunities(page);
      return jsonResult(data);
    })),
  );

  server.registerTool(
    'get_players',
    {
      description: 'List all players in the saved community.',
      inputSchema: profileInput({}),
      outputSchema: OUTPUT_SCHEMA,
    },
    serial(async () => withFreshSession(async () => {
      const page = await getPage();
      const community = await resolveCommunity(page);
      const data = await getPlayers(page, community);
      return jsonResult(data);
    })),
  );

  if (!readOnly && !options.lockedConfiguration) {
    server.registerTool(
    'set_community',
    {
      description: 'Set the active community. Use get_communities first to see available options, then pass the exact name.',
      inputSchema: profileInput({ name: z.string().describe('Exact community name as returned by get_communities.') }),
      outputSchema: OUTPUT_SCHEMA,
    },
    serial(async ({ name }) => {
        const page = await getPage();
        const communities = await getCommunities(page);
        if (!communities.includes(name)) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: `Community "${name}" not found. Available: ${communities.join(', ')}` }, null, 2) }], isError: true };
        }
        saveCommunity(name);
        return jsonResult({ success: true, community: name });
      }),
  );
  }

  if (!readOnly && !options.lockedConfiguration) {
    server.registerTool(
    'set_player',
    {
      description: 'Set which player you are (for leaderboard highlighting). Use get_players first to see available names.',
      inputSchema: profileInput({ name: z.string().describe('Exact player name as returned by get_players.') }),
      outputSchema: OUTPUT_SCHEMA,
    },
    serial(async ({ name }) => {
        const page = await getPage();
        const community = await resolveCommunity(page);
        const players = await getPlayers(page, community);
        if (!players.includes(name)) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: `Player "${name}" not found. Available: ${players.join(', ')}` }, null, 2) }], isError: true };
        }
        savePlayer(name);
        return jsonResult({ success: true, player: name });
      }),
  );
  }

  server.registerTool(
    'get_bonus_questions',
    {
      description: 'Get available bonus questions with their options and current selections.',
      inputSchema: profileInput({}),
      outputSchema: OUTPUT_SCHEMA,
    },
    serial(async () => withFreshSession(async () => {
      const page = await getPage();
      const community = await resolveCommunity(page);
      const data = await fetchBonusQuestions(page, community);
      return jsonResult(data);
    })),
  );

  server.registerTool(
    'get_bet_log',
    {
      description: 'Show what this agent has actually submitted to Kicktipp, with timestamps and which entry point did it. Use this to answer "what have you placed?" from the record rather than from memory. Records marked dry-run or intent never reached Kicktipp.',
      inputSchema: profileInput({
        matchday: z.number().int().min(1).max(34).optional().describe('Only this matchday.'),
        include_all: z.boolean().optional().describe('Include dry runs, intents and failures (default: submitted only).'),
      }),
      outputSchema: OUTPUT_SCHEMA,
    },
    serial(async ({ matchday, include_all }) => {
      const community = loadCommunity();
      if (!community) throw new Error('No community set. Call get_communities then set_community.');
      let records = readAudit(community);
      if (!include_all) records = records.filter((r) => r.outcome === 'submitted');
      if (matchday !== undefined) records = records.filter((r) => r.matchday === matchday);
      return jsonResult({ community, records });
    }),
  );

  server.registerTool(
    'get_deadline',
    {
      description: "Show how long is left before kickoff and which matches still need a bet. Use this whenever the user asks what is still open, or before suggesting bets, so you can tell them how urgent it is. Kickoff instants are parsed from Kicktipp's HTML (Central Time on .com, Berlin on .de) and shown in the time_zone field, which is this machine unless KICKTIPP_TZ is set.",
      inputSchema: profileInput({
        matchday: z.number().int().min(1).max(34).optional().describe('Matchday number (1-34). Omit for the current one.'),
        warn_hours: z.number().positive().optional().describe('Urgency window in hours (default 6).'),
      }),
      outputSchema: OUTPUT_SCHEMA,
    },
    serial(async ({ matchday, warn_hours }) => withFreshSession(async () => {
      const page = await getPage();
      const community = await resolveCommunity(page);
      const { matches } = await fetchBets(page, community, matchday);
      const report = buildDeadlineReport(community, matchday ?? null, matches, {
        warnHours: warn_hours,
      });
      return jsonResult(report);
    })),
  );

  server.registerTool(
    'list_members',
    {
      description:
        'ADMIN ONLY: list the community members with their tipperIds, and whether each is a dummy member with no login. Requires the logged-in user to be a Spielleiter. Use this to find the id or exact name before any of the other admin tools.',
      inputSchema: profileInput({}),
      outputSchema: OUTPUT_SCHEMA,
    },
    serial(async () => withFreshSession(async () => {
      const page = await getPage();
      const community = await resolveCommunity(page);
      return jsonResult(await fetchMembers(page, community));
    })),
  );

  server.registerTool(
    'get_bets_for_member',
    {
      description:
        "ADMIN ONLY: read another member's bets for a matchday through Tipps nachtragen. Requires Spielleiter rights.",
      inputSchema: profileInput({
        member: z.string().describe('Member name or tipperId, as listed by list_members.'),
        matchday: z.number().int().min(1).max(34).optional().describe('Matchday (1-34). Omit for the current one.'),
      }),
      outputSchema: OUTPUT_SCHEMA,
    },
    serial(async ({ member, matchday }) => withFreshSession(async () => {
      const page = await getPage();
      const community = await resolveCommunity(page);
      const resolved = resolveMember(await fetchMembers(page, community), member);
      return jsonResult(await fetchBetsForMember(page, community, resolved, matchday));
    })),
  );

  server.registerTool(
    'get_stats',
    {
      description: 'Season analytics for a player: form per matchday against the league average, rank history, hit-type breakdown (exact / goal difference / tendency / miss), prediction bias vs. what actually happened, and consistency. Computed from the local cache, so call sync_history first if it is empty. Always quote the data_completeness figures when summarising, so the user knows how many matchdays the numbers rest on.',
      inputSchema: profileInput({
        player: z.string().optional().describe('Player name. Defaults to the configured player.'),
        compare: z.string().optional().describe('Optional second player to compute alongside.'),
      }),
      outputSchema: OUTPUT_SCHEMA,
    },
    serial(async ({ player, compare }) => {
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
    }),
  );

  server.registerTool(
    'sync_history',
    {
      description: 'Update the local season cache so get_stats has data to work with. Stops at the current matchday, skips finished and still-upcoming ones, and paces requests politely. The first run backfills holes; later runs usually cost one matchday. Pass to=34 to walk the rest of the season.',
      inputSchema: profileInput({
        from: z.number().int().min(1).max(34).optional().describe('First matchday (default 1).'),
        to: z.number().int().min(1).max(34).optional().describe('Last matchday (default: Kicktipp current matchday, not 34).'),
      }),
      outputSchema: OUTPUT_SCHEMA,
    },
    serial(async ({ from, to }) => {
      const page = await getPage();
      const community = await resolveCommunity(page);
      const result = await syncSeason(page, community, { from, to });
      return jsonResult(result);
    }),
  );

  server.registerTool(
    'suggest_bets',
    {
      description: "Build a suggested bet slip for a matchday from the odds Kicktipp publishes. READ-ONLY: it returns suggestions and never submits anything. Show the slip and its reasoning to the user, and only if they explicitly agree, call place_bets yourself. Matches that already carry a bet are flagged so they are not silently overwritten. Strategies: 'safe' backs the likeliest outcome, 'ev' maximises expected points under the community's scoring rules, 'contrarian' fades the favourite in close matches and is high variance by design.",
      inputSchema: profileInput({
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
      }),
      outputSchema: OUTPUT_SCHEMA,
    },
    serial(async ({ strategy, matchday, pin }) => withFreshSession(async () => {
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
    })),
  );

  if (!readOnly) {
    server.registerTool(
      'place_bets_for_member',
      {
        description:
          "ADMIN ONLY and DESTRUCTIVE: submit bets on somebody else's account through Tipps nachtragen. Requires Spielleiter rights. This acts on another person's entry, so confirm with the user first and pass that person's exact name as confirm_member; a mismatch is refused and nothing is submitted. Use dry_run to preview. Format each bet as \"Home vs Away=H:G\".",
        inputSchema: profileInput({
          member: z.string().describe('Member name or tipperId, as listed by list_members.'),
          confirm_member: z
            .string()
            .describe("The member's exact name, repeated as a deliberate confirmation of who is being acted for."),
          bets: z.array(z.string()).min(1).describe('Bets as "Home vs Away=H:G".'),
          matchday: z.number().int().min(1).max(34).optional().describe('Matchday (1-34). Omit for the current one.'),
          dry_run: z.boolean().optional().describe('Validate and report without submitting.'),
        }),
        outputSchema: OUTPUT_SCHEMA,
      },
      serial(async ({ member, confirm_member, bets, matchday, dry_run }) => {
        assertWritable('Placing member bets');
        const page = await getPage();
        const community = await resolveCommunity(page);
        const resolved = resolveMember(await fetchMembers(page, community), member);

        // A second, explicit statement of who is being acted for: getting this
        // wrong would place bets on the wrong person's account.
        if (confirm_member.trim().toLowerCase() !== resolved.name.toLowerCase()) {
          throw new Error(
            `confirm_member ("${confirm_member}") does not match the resolved member ("${resolved.name}"). Nothing was submitted.`,
          );
        }

        const placed = await placeBetsForMember(
          page,
          community,
          resolved,
          bets,
          matchday,
          !dry_run,
          'mcp:place_bets_for_member',
        );
        return jsonResult({ success: true, dry_run: !!dry_run, member: resolved, placed });
      }),
    );
  }

  if (!readOnly) {
    server.registerTool(
    'place_bets',
    {
      description: 'Place match bets by fixture name. DESTRUCTIVE: submits real bets. Use dry_run=true to preview without submitting. Get exact team names from get_bets first. Format each bet as "Home vs Away=H:G" where H and G are goal counts.',
      inputSchema: profileInput({
        bets: z.array(z.string()).min(1).describe('Bets in format "Home vs Away=H:G", e.g. ["FC Bayern München vs Borussia Dortmund=2:1"]'),
        matchday: z.number().int().min(1).max(34).optional().describe('Matchday number (1-34). Omit for current matchday.'),
        dry_run: z.boolean().optional().describe('If true, validate and return what would be placed without submitting.'),
      }),
      outputSchema: OUTPUT_SCHEMA,
    },
    serial(async ({ bets, matchday, dry_run }) => {
        assertWritable('Placing bets');
        const page = await getPage();
        const community = await resolveCommunity(page);
        const placed = await placeBets(page, community, bets, matchday, !dry_run, 'mcp:place_bets');
        return jsonResult({ success: true, dry_run: !!dry_run, placed });
      }),
  );
  }

  if (!readOnly) {
    server.registerTool(
    'place_bonus_bets',
    {
      description: 'Place bonus question answers. DESTRUCTIVE: submits real bets. Use dry_run=true to preview without submitting. Get exact question text and options from get_bonus_questions first. Format each as "Question text=Answer". Ranking questions have several dropdowns (selects.length > 1): pass one array entry per slot in the SAME call, in order, repeating the question text. Example: ["Who will be relegated?=FC St. Pauli", "Who will be relegated?=1. FC Heidenheim", "Who will be relegated?=Holstein Kiel"]. A shorter list fills remaining empty slots instead of overwriting the first dropdown. A successful dry run still returns success=true with dry_run=true; nothing is submitted.',
      inputSchema: profileInput({
        bets: z.array(z.string()).min(1).describe('Bonus bets in format "Question text=Answer". Repeat the question once per ranking dropdown in a single call.'),
        dry_run: z.boolean().optional().describe('If true, validate and return what would be placed without submitting.'),
      }),
      outputSchema: OUTPUT_SCHEMA,
    },
    serial(async ({ bets, dry_run }) => {
        assertWritable('Placing bonus bets');
        const page = await getPage();
        const community = await resolveCommunity(page);
        const placed = await placeBonusBets(page, community, bets, !dry_run, 'mcp:place_bonus_bets');
        return jsonResult({ success: true, dry_run: !!dry_run, placed });
      }),
  );
  }


  // ── Resources ──────────────────────────────────────────────────────
  //
  // Slow-changing data is also exposed as MCP resources, so a client can pin or
  // re-read it without spending a tool call. They are served from the local
  // cache: reading a resource never triggers a login, and it reports an empty
  // cache rather than going to the network behind the user's back.

  function cachedResource(requestedCommunity: string | string[], kind: 'rules' | 'leaderboard' | 'schedule', matchday?: number) {
    const community = loadCommunity();
    if (!community) {
      return { error: 'no_community', message: 'No community set. Call set_community first.' };
    }
    if (requestedCommunity !== community) {
      return { error: 'community_mismatch', message: 'This resource does not belong to the active community.' };
    }
    if (kind !== 'rules' && (!Number.isInteger(matchday) || matchday! < 1 || matchday! > 34)) {
      return { error: 'invalid_matchday', message: 'Matchday must be an integer from 1 to 34.' };
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
    serial(async (uri, variables) => resourceContents(uri, cachedResource(variables.community, 'rules'))),
  );

  server.registerResource(
    'leaderboard',
    new ResourceTemplate('kicktipp://{community}/leaderboard/{matchday}', { list: undefined }),
    {
      title: 'Matchday leaderboard',
      description: 'Cached standings for one matchday.',
      mimeType: 'application/json',
    },
    serial(async (uri, variables) =>
      resourceContents(uri, cachedResource(variables.community, 'leaderboard', Number(variables.matchday)))),
  );

  server.registerResource(
    'schedule',
    new ResourceTemplate('kicktipp://{community}/schedule/{matchday}', { list: undefined }),
    {
      title: 'Matchday schedule',
      description: 'Cached fixtures and results for one matchday.',
      mimeType: 'application/json',
    },
    serial(async (uri, variables) =>
      resourceContents(uri, cachedResource(variables.community, 'schedule', Number(variables.matchday)))),
  );

  if (options.withProfile) {
    for (const kind of ['rules', 'leaderboard', 'schedule'] as const) {
      server.registerResource(`profile_${kind}`,
        new ResourceTemplate(`kicktipp://profiles/{profile}/{community}/${kind}${kind === 'rules' ? '' : '/{matchday}'}`, { list: undefined }),
        { title: `Profile ${kind}`, description: 'Profile-scoped cached data. Select the ID from get_profiles.', mimeType: 'application/json' },
        serial(async (uri, variables) => resourceContents(uri,
          cachedResource(variables.community, kind, kind === 'rules' ? undefined : Number(variables.matchday)))));
    }
  }

  return server;
}

// stdio remains available for clients that launch a local subprocess.
export async function startStdio() {
  const { serviceConfigFile, readServiceConfig } = await import('./service/settings.js');
  const config = existsSync(serviceConfigFile()) ? readServiceConfig() : null;
  const server = createMcpServer({ lockedConfiguration: !!config, ...(config ? createProfileAccess(() => config) : {}) });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  (async () => {
    await startStdio();
  })().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
