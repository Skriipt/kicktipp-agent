# CLAUDE.md

## Project Overview

**kicktipp-agent** is a TypeScript CLI and MCP server for Kicktipp ([kicktipp.com](https://www.kicktipp.com) and [kicktipp.de](https://www.kicktipp.de)). It talks to the site over plain HTTP (no browser), uses Cheerio for HTML parsing, Commander.js for CLI argument parsing, and the MCP SDK to expose tools to AI assistants. The tool can view leaderboards, schedules, league tables, and manage bets (manual and bonus).

## File Inventory

```
src/
  index.ts                    # CLI entry point + Commander setup + simple commands
  server.ts                   # MCP server entry point (kicktipp-mcp binary)
  core.ts                     # Shared business logic used by both CLI and MCP server
  shared.ts                   # Shared CLI helpers (ask, ensureCommunity)
  config.ts                   # Credential/community/player storage (~/.config/kicktipp-agent/)
  browser.ts                  # Session management, login, community/player parsing
  url.ts                      # Route table and URL builders
  http/
    cookie-jar.ts             # Host-scoped cookie store
    page.ts                   # fetch-based page client (navigate and submit)
  cache/
    paths.ts                  # Platform data directory
    store.ts                  # Versioned JSON snapshot store
    cached-fetch.ts           # Write-through wrapper + offline mode
    offline.ts                # Cache-only reads for --offline commands
    sync.ts                   # Season backfill, shared by CLI and MCP
  rules/
    scoring.ts                # ScoringRules, scoreBet, hit classification
    parse-rules.ts            # Reads point values and multipliers off the page
    resolve.ts                # config override -> parsed -> defaults
    verify.ts                 # Recompute a matchday to prove the values
  read-only.ts                # KICKTIPP_READ_ONLY enforcement
  audit/
    log.ts                    # Append-only record of every submission
  notify/
    backends.ts               # desktop / webhook / command notifiers
    schedule-artifacts.ts     # cron line, systemd units, ICS calendar
  tui/
    state.ts                  # Betting screen as a pure state machine
    app/                      # Dashboard rendering, screens, and terminal I/O
  analytics/
    season.ts                 # Assembles a season from the cache
    deadline.ts               # Kickoff countdowns and urgency
    scenarios.ts              # Standings projection and target search
    replay.ts                 # Season replay under an alternative strategy
    season-stats.ts           # Form, breakdown, bet profile, consistency
    rivals.ts                 # Points swing and overtake scenarios
    gap.ts                    # Points gap before a matchday
    odds.ts                   # Implied probabilities from decimal odds
    score-map.ts              # Scoreline frequencies and typical scores
    strategies.ts             # safe / ev / contrarian bet slips
  helpers/
    parse-bet-arg.ts          # parseBetArg + matchFixture
    spinner.ts                # Native terminal status output
  commands/
    leaderboard.ts            # leaderboard command (--matchday, --bonus)
    overview.ts               # overview command (--view)
    schedule.ts               # schedule command (--matchday)
    table.ts                  # table command (--home, --away)
    bets.ts                   # bets command (--matchday)
    rules.ts                  # rules command
    bet.ts                    # unified bet command (interactive, fixture, bonus)
    today.ts                  # today command (today's matches + bet status)
    guide.ts                  # guide command (detailed usage for LLM agents)
    sync.ts                   # sync command (fill the local cache)
    cache.ts                  # cache status / cache clear
    stats.ts                  # stats command (season analytics)
    rival.ts                  # rival command (overtake scenarios)
    suggest.ts                # suggest command (odds-based bet slips)
    deadline.ts               # deadline command (--check exits 2)
    remind.ts                 # remind + notify commands
    log.ts                    # bet log and --undo
    scenario.ts               # standings projection
    whatif.ts                 # season replay
    admin.ts                  # Spielleiter subcommands
tests/
  parse-bet-arg.test.ts       # parseBetArg + matchFixture tests
  url.test.ts                 # Route table + URL builder tests
  cookie-jar.test.ts          # Cookie scoping, expiry, persistence
  page-navigate.test.ts       # Redirects, cookies, route fallback
  form-serialize.test.ts      # Form serialization and editing
  load-page.test.ts           # Auth / not-found / admin error classification
  session.test.ts             # Login + session restore round-trip
  cache-store.test.ts         # Snapshot store, versioning, write-through
  scoring.test.ts             # Hit classification and rules parsing
  season-stats.test.ts        # Analytics against hand-checked fixtures
  rivals.test.ts              # Swing and overtake scenarios
  matchday-bets.test.ts       # Per-player bet grid parser
  suggest.test.ts             # Odds maths and the three strategies
  helpers/
    mock-fetch.ts             # Injected fetch used by the tests above
package.json
tsconfig.json
```

## Commands

```bash
# Install (Node.js 20+)
npm install

# Build
npm run build

# Run tests
npm test

# CLI usage (after npm link)
kicktipp --help
kicktipp communities
kicktipp set-community
kicktipp players
kicktipp set-player
kicktipp leaderboard [--matchday N] [--bonus]
kicktipp overview [--view matchday-points|standings|standings-diff|matchday-standings|points-from-leader]
kicktipp schedule [--matchday N]
kicktipp table [--home|--away]
kicktipp bets [--matchday N]
kicktipp bet [--matchday N]
kicktipp bet "Home vs Away=2:1" [--matchday N]
kicktipp bet --bonus ["Question=Answer"]
kicktipp today
kicktipp guide
kicktipp rules
kicktipp logout
```

## Architecture

### Entry Points

- **`src/index.ts`** — CLI. Commander.js program with subcommands. Simple commands (logout, communities, set-community, players, set-player) are defined inline. View and bet commands are registered via import from `src/commands/`.
- **`src/server.ts`** — MCP server. Exposes the same functionality as the CLI through the Model Context Protocol. Uses a persistent Kicktipp session shared across tool calls; read-only tools retry once against a fresh login if it expired.
- **`src/core.ts`** — Shared business logic (fetching data, placing bets) used by both entry points. All functions take a `Page` (the HTTP shim) and community name, return structured data. `loadPage()` classifies failures as `AuthError`, `AdminRequiredError` or `NotFoundError`.

### Credential & Config Storage: `src/config.ts`

- **Dir:** `~/.config/kicktipp-agent/`
- **Config:** `config.ini` (ini format, chmod 600)
  - `[auth]` section: `email`, `password`
  - `[community]` section: `name` (saved default community)
  - `[player]` section: `name` (saved player identity for leaderboard marker)
- **Session:** `session.json` (cookie jar, chmod 600, written atomically)

### HTTP Layer: `src/http/`

- **`page.ts`** — a fetch-based page client. Follows
  redirects manually (301/302/303 demote to GET, 307/308 keep method and
  body, max 8 hops), serializes forms the way a browser would, and exposes
  `goto`, `content`, `url`, `setInputValue`, `selectOption`, `click`,
  `submitForm`. State helpers: `isAuthRedirect()`, `isNotFound()`,
  `isAdminRequired()`, `isClosed()`. Takes an injectable `fetch` for tests.
- **`cookie-jar.ts`** — cookies scoped per host. Cookies are only stored for
  and sent to `kicktipp.de`/`kicktipp.com` (plus the `KICKTIPP_BASE_URL`
  host); a redirect off those hosts is still followed, but without the
  session. Honors `Domain` only when the responding host belongs to it, and
  deletes on `Max-Age=0`/past `Expires`. Reads old Playwright
  `storageState` files too, since the shape matches.

### Session Handling: `src/browser.ts`

- `launchBrowser()` restores the profile's session file and probes the communities page;
  falls back to a fresh login if that bounces to `/login` or 404s
- `login()` — fills `input[name="kennung"]` + `input[name="passwort"]` and
  submits the surrounding form (so hidden fields such as a CSRF token go
  along). Throws on failure rather than exiting the process
- The session is saved after a successful login

### HTML Parsing (Cheerio)

All page parsing follows: `page.goto(url)` → `cheerio.load(await page.content())` → find `#kicktipp-content` → parse tables. In `core.ts` this goes through `loadPage()`, which raises the typed errors above before parsing.

**Key CSS selectors:**
- Content wrapper: `#kicktipp-content`
- Page title: `div.pagetitle`
- Bet form inputs: `input[id$='_heimTipp']`, `input[id$='_gastTipp']`
- Submit button: `button[name="submitbutton"]`
- Non-editable bets: `td.nichttippbar`
- Odds: `span.quote-heim span.quote-text`, `span.quote-remis span.quote-text`, `span.quote-gast span.quote-text`
- Rankings table: `table#ranking`
- Schedule table: `table#spiele`
- Player names: `div.mg_name`
- Match result: `span.kicktipp-ergebnis > span.kicktipp-heim` / `span.kicktipp-gast`
- Bonus questions table: `table#tippabgabeFragen`

### URL Structure: `src/url.ts`

A route table holds the German and English spelling of every page.
`urlBase()` defaults to `https://www.kicktipp.com` (English spellings) and can
be pointed at `https://www.kicktipp.de` (German spellings) with
`kicktipp set-site de`, `[ui] site=de`, `KICKTIPP_SITE=de`, or
`KICKTIPP_BASE_URL`. `getAlternateUrls()` lists the same page on the other
host and in the other language; `Page.goto()` walks those candidates when a
request comes back "not found", so a community that exists on only one host
still resolves.

```
Base:         https://www.kicktipp.com (override: set-site / KICKTIPP_SITE / KICKTIPP_BASE_URL)
Login:        /info/profil/login
Communities:  /info/profil/meinetipprunden
Predict:      /{community}/predict[?spieltagIndex=N]
Predict bonus: /{community}/predict?bonus=true
Leaderboard:  /{community}/leaderboard[?spieltagIndex=N&bonus=true]
Overview:     /{community}/overview?ansicht={view}
Schedule:     /{community}/schedule[?spieltagIndex=N]
Tables:       /{community}/tables[?option=heim|gast]
Rules:        /{community}/rules

German spellings (used when the base is kicktipp.de):
Predict:      /{community}/tippabgabe      Leaderboard: /{community}/tippuebersicht
Overview:     /{community}/gesamtuebersicht Schedule:    /{community}/tippspielplan
Tables:       /{community}/tabellen        Rules:       /{community}/spielregeln
```

### Bet Argument Parsing: `src/helpers/parse-bet-arg.ts`

- `parseBetArg("Home vs Away=H:G")` — splits on last `=`, then on ` vs `, returns `{home, away, h, g}`. Throws on invalid format.
- `matchFixture(home, away, editable)` — case-insensitive exact match. Throws if not found.

## Key Details

- Site: `https://www.kicktipp.com` by default; kicktipp.de is tried automatically when a page is missing (and the other way around). Override with `KICKTIPP_BASE_URL`.
- TypeScript with ES2022 target, Node16 module resolution
- Matchday range: 1-34 (Bundesliga season)
- Login form: `input[name="kennung"]`, `input[name="passwort"]`
- Config shared at `~/.config/kicktipp-agent/config.ini`

## Analytics Layer

Everything below the HTTP layer is pure and testable without a network.

- **Cache (`src/cache/`)** — versioned JSON snapshots under the platform data
  directory, one directory per community, atomic 0600 writes. The `core.ts`
  fetch functions write through on success, so ordinary use fills it as a
  side effect; `--offline` serves the snapshots instead. Variants that share a
  URL but differ in payload (bonus leaderboard, home/away tables, alternate
  overview views) are deliberately not cached so they cannot overwrite the
  canonical copy.
- **Rules (`src/rules/`)** — the community's point values, resolved from a
  config override, then the parsed rules page, then Kicktipp's 4/3/2 defaults.
  `ResolvedRules.source` records which, and every consumer surfaces it.
  Only the standard three-tier scheme is modelled; odds-based or multiplier
  scoring is detected and flagged rather than scored wrongly.
- **Analytics (`src/analytics/`)** — pure functions over cached data. Stats
  degrade per metric and report `completeness`. Another player's hit breakdown
  comes from the per-player bet grid, never from the account owner's own bets
  page. Rival scenarios evaluate representative scorelines per outcome class,
  which is enough because the rules can only distinguish exact / difference /
  tendency / miss.

### New MCP tools

`get_stats`, `sync_history`, `get_rival_analysis`, `suggest_bets`.
`suggest_bets` is strictly read-only: it returns a slip plus an instruction to
confirm with the user, and has no code path into `placeBets`.

## Safety Rails

Three of these are load-bearing and worth knowing before changing anything
nearby.

- **Read-only mode** (`src/read-only.ts`). `KICKTIPP_READ_ONLY=1` blocks every
  write. Mutating MCP tools are never registered, so they do not appear in
  `tools/list`; the CLI refuses up front; and `placeBets`/`placeBonusBets`
  check again themselves. The third check is the point: a future wiring
  mistake still cannot submit.
- **The audit log** (`src/audit/log.ts`). Records are written *inside* the
  submitting functions, not by their callers, so every entry point is covered
  by construction — the caller only passes a source label. Anything that adds
  a new way to bet must go through those functions or it will be invisible.
- **Acting for another member** (`placeBetsForMember`). Refuses to submit
  unless the member's `tipperId` will travel with the form, because a form
  action that lost it would apply the bets to the admin's own entry. The MCP
  tool additionally requires `confirm_member` to match the resolved member.

## Output Conventions

- Every read command takes `--json` and emits exactly what the matching
  `core.ts` fetcher returns; errors in that mode are `{"error": ...}` on
  stdout with exit code 1. Spinners go to stderr, so stdout stays pipeable.
- MCP tools answer twice: text as before, plus `structuredContent` wrapped as
  `{ data: ... }` under one shared output schema.
- Anything derived from parsed scoring rules reports `rules.source` and
  `rules.confidence`, so output can be honest about assumed values.
