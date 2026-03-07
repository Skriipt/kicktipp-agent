# CLAUDE.md

## Project Overview

**kicktipp-cli** is a TypeScript CLI tool for interacting with [kicktipp.com](https://www.kicktipp.com) — a German football prediction game platform. It uses Playwright for headless browser automation, Cheerio for HTML parsing, and Commander.js for CLI argument parsing. The tool can view leaderboards, schedules, league tables, manage bets (manual and automatic), and use pluggable predictor algorithms.

## File Inventory

```
src/
  index.ts                    # Entry point + Commander CLI setup + simple commands
  shared.ts                   # Shared helpers (ask, ensureCommunity)
  config.ts                   # Credential/community/player storage (~/.config/kicktipp-cli/)
  browser.ts                  # Playwright session management, login, consent, HTML parsing
  url.ts                      # URL constants and builders
  helpers/
    match.ts                  # Match class (teams, date, odds)
    parse-bet-arg.ts          # parseBetArg + matchFixture
    spinner.ts                # Terminal spinner (ora wrapper)
  predictors/
    base.ts                   # Predictor interface
    simple.ts                 # SimplePredictor (threshold-based)
    calculation.ts            # CalculationPredictor (ratio/nonlinearity formula)
    claude.ts                 # ClaudePredictor (calls claude -p CLI)
    index.ts                  # Registry + choosePredictor
  commands/
    leaderboard.ts            # leaderboard command (--matchday, --bonus)
    overview.ts               # overview command (--view)
    schedule.ts               # schedule command (--matchday)
    table.ts                  # table command (--home, --away)
    bets.ts                   # bets command (--matchday)
    rules.ts                  # rules command
    set-bets.ts               # set-bets command (interactive)
    set-all-bets.ts           # set-all-bets command (fixture-based)
    auto-bets.ts              # auto-bets command (predictor-based)
tests/
  match.test.ts               # Match class tests
  parse-bet-arg.test.ts       # parseBetArg + matchFixture tests
  predictors.test.ts          # Predictor tests
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
kicktipp list-predictors
kicktipp list-communities
kicktipp set-community
kicktipp list-players
kicktipp set-player
kicktipp leaderboard [--matchday N] [--bonus]
kicktipp overview [--view matchday-points|standings|standings-diff|matchday-standings|points-from-leader]
kicktipp schedule [--matchday N]
kicktipp table [--home|--away]
kicktipp bets [--matchday N]
kicktipp set-bets [--matchday N]
kicktipp set-all-bets "Home vs Away=2:1" "Home2 vs Away2=0:0" [--matchday N]
kicktipp auto-bets [--matchday N] [--predictor NAME] [--override-bets] [--dry-run]
kicktipp rules
kicktipp logout
```

## Architecture

### Entry Point: `src/index.ts`

Commander.js program with subcommands. Simple commands (list-predictors, logout, list-communities, set-community, list-players, set-player) are defined inline. View and bet commands are registered via import from `src/commands/`.

### Credential & Config Storage: `src/config.ts`

- **Dir:** `~/.config/kicktipp-cli/`
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

### URL Structure: `src/url.ts`

```
Base:         https://www.kicktipp.com
Login:        /info/profil/login
Communities:  /info/profil/meinetipprunden
Predict:      /{community}/predict[?spieltagIndex=N]
Leaderboard:  /{community}/leaderboard[?spieltagIndex=N&bonus=true]
Overview:     /{community}/overview?ansicht={view}
Schedule:     /{community}/schedule[?spieltagIndex=N]
Tables:       /{community}/tables[?option=heim|gast]
Rules:        /{community}/rules
```

### Match Model: `src/helpers/match.ts`

`new Match(hometeam, roadteam, matchDate, rateHome, rateDeuce, rateRoad)`

- Odds stored as floats; `.odds` returns `[number, number, number]`
- `parseDate()` tries US format (`M/D/YY h:mm AM/PM`) first, then DE format (`DD.MM.YY HH:MM`). Falls back to `null`.

### Bet Argument Parsing: `src/helpers/parse-bet-arg.ts`

- `parseBetArg("Home vs Away=H:G")` — splits on last `=`, then on ` vs `, returns `{home, away, h, g}`. Throws on invalid format.
- `matchFixture(home, away, editable)` — case-insensitive exact match. Throws if not found.

### Predictor System: `src/predictors/`

- `Predictor` interface with `predict(match): [number, number]`
- `getPredictors()` returns `Record<string, Constructor>`
- `choosePredictor(name?)` selects and instantiates

**Built-in predictors:**

| Predictor | Logic |
|---|---|
| `SimplePredictor` | Threshold buckets on odds diff → 1:1, 1:0, 2:1, or 3:1. Reverses for away favorite. |
| `CalculationPredictor` | Ratio/nonlinearity formula with max 5 goals. |
| `ClaudePredictor` | Calls `claude -p` with team names and odds, parses H:G response. Requires Claude Code CLI. |

## Key Details

- Site: `https://www.kicktipp.com` (not .de)
- TypeScript with ES2022 target, Node16 module resolution
- Matchday range: 1-34 (Bundesliga season)
- Login form: `input[name="kennung"]`, `input[name="passwort"]`
- Config shared at `~/.config/kicktipp-cli/config.ini`
