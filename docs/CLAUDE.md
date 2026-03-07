# CLAUDE.md

## Project Overview

**kicktipp-agent** is a TypeScript CLI tool for interacting with [kicktipp.com](https://www.kicktipp.com) — a German football prediction game platform. It uses Playwright for headless browser automation, Cheerio for HTML parsing, and Commander.js for CLI argument parsing. The tool can view leaderboards, schedules, league tables, and manage bets (manual and bonus).

## File Inventory

```
src/
  index.ts                    # Entry point + Commander CLI setup + simple commands
  shared.ts                   # Shared helpers (ask, ensureCommunity)
  config.ts                   # Credential/community/player storage (~/.config/kicktipp-agent/)
  browser.ts                  # Playwright session management, login, consent, HTML parsing
  url.ts                      # URL constants and builders
  helpers/
    parse-bet-arg.ts          # parseBetArg + matchFixture
    spinner.ts                # Terminal spinner (ora wrapper)
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
tests/
  parse-bet-arg.test.ts       # parseBetArg + matchFixture tests
  url.test.ts                 # URL builder tests
package.json
tsconfig.json
```

## Commands

```bash
# Install
npm install
npx playwright install chromium

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

### Entry Point: `src/index.ts`

Commander.js program with subcommands. Simple commands (logout, communities, set-community, players, set-player) are defined inline. View and bet commands are registered via import from `src/commands/`.

### Credential & Config Storage: `src/config.ts`

- **Dir:** `~/.config/kicktipp-agent/`
- **Config:** `config.ini` (ini format, chmod 600)
  - `[auth]` section: `email`, `password`
  - `[community]` section: `name` (saved default community)
  - `[player]` section: `name` (saved player identity for leaderboard marker)
- **Session:** `session.json` (Playwright storage state for cookie persistence)

### Browser Automation: `src/browser.ts`

- Launches `chromium` in headless mode, viewport `1280x900`
- Uses `domcontentloaded` wait strategy for speed
- `dismissConsent(page)` — handles cookie consent CMP iframe
- `login()` — fills `input[name="kennung"]` + `input[name="passwort"]`, submits
- Session cached to `SESSION_FILE` after successful login; restored on next run

### HTML Parsing (Cheerio)

All page parsing follows: `page.goto(url)` → `waitForLoadState('domcontentloaded')` → `dismissConsent(page)` → `cheerio.load(await page.content())` → find `#kicktipp-content` → parse tables.

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

```
Base:         https://www.kicktipp.com
Login:        /info/profil/login
Communities:  /info/profil/meinetipprunden
Predict:      /{community}/predict[?spieltagIndex=N]
Predict bonus: /{community}/predict?bonus=true
Leaderboard:  /{community}/leaderboard[?spieltagIndex=N&bonus=true]
Overview:     /{community}/overview?ansicht={view}
Schedule:     /{community}/schedule[?spieltagIndex=N]
Tables:       /{community}/tables[?option=heim|gast]
Rules:        /{community}/rules
```

### Bet Argument Parsing: `src/helpers/parse-bet-arg.ts`

- `parseBetArg("Home vs Away=H:G")` — splits on last `=`, then on ` vs `, returns `{home, away, h, g}`. Throws on invalid format.
- `matchFixture(home, away, editable)` — case-insensitive exact match. Throws if not found.

## Key Details

- Site: `https://www.kicktipp.com` (not .de)
- TypeScript with ES2022 target, Node16 module resolution
- Matchday range: 1-34 (Bundesliga season)
- Login form: `input[name="kennung"]`, `input[name="passwort"]`
- Config shared at `~/.config/kicktipp-agent/config.ini`
