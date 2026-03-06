# CLAUDE.md

## Project Overview

**kicktipp-cli** (forked from kicktipp-betbot) is a Python CLI tool for interacting with [kicktipp.com](https://www.kicktipp.com) — a German football prediction game platform. It uses Playwright for headless browser automation, BeautifulSoup for HTML parsing, and docopt for CLI argument parsing. The tool can view leaderboards, schedules, league tables, manage bets (manual and automatic), and use pluggable predictor algorithms.

## File Inventory

```
kicktippbb.py                    # Entry point + all CLI commands (~1327 lines)
helper/__init__.py               # Empty
helper/match.py                  # Match data class (teams, date, odds)
helper/deadline.py               # Duration parsing + deadline comparison
helper/datetime_test.py          # Tests for deadline module
predictors/__init__.py           # Empty
predictors/base.py               # PredictorBase ABC + auto-discovery via pkgutil
predictors/simplepredictor.py    # Threshold-based predictor using odds difference
predictors/calculationpredictor.py # Ratio/nonlinearity formula predictor
predictors/predictors_test.py    # Tests for predictor discovery
test/url_test.py                 # Tests for URL building + odds parsing
requirements.txt                 # docopt, playwright, beautifulsoup4
.github/workflows/python-app.yml # CI: lint (flake8) + test (pytest) on push
README.md                        # Original betbot README (outdated, references old API)
```

## Commands

```bash
# Install
pip install -r requirements.txt
playwright install chromium

# Run tests
pytest                              # all tests
pytest test/url_test.py             # URL + odds parsing tests
pytest helper/datetime_test.py      # deadline/timedelta tests
pytest predictors/predictors_test.py # predictor discovery tests

# CLI usage
python kicktippbb.py --help
python kicktippbb.py --list-communities
python kicktippbb.py --set-community
python kicktippbb.py --list-players
python kicktippbb.py --set-player
python kicktippbb.py --leaderboard [--matchday N] [--bonus]
python kicktippbb.py --overview [--view matchday-points|standings|standings-diff|matchday-standings|points-from-leader]
python kicktippbb.py --schedule [--matchday N]
python kicktippbb.py --table [--home|--away]
python kicktippbb.py --bets [--matchday N]
python kicktippbb.py --set-bets [--matchday N]
python kicktippbb.py --set-all-bets "Home vs Away=2:1" "Home2 vs Away2=0:0" [--matchday N]
python kicktippbb.py --auto-bets [--matchday N] [--predictor NAME] [--override-bets] [--dry-run]
python kicktippbb.py --rules
python kicktippbb.py --logout
python kicktippbb.py [--dry-run] [--override-bets] [--deadline DURATION] [--predictor NAME] [--matchday N] [COMMUNITY]...
```

## Architecture

### Entry Point: `kicktippbb.py`

The module docstring IS the docopt usage spec (lines 1-60). `docopt(__doc__)` parses CLI args from it.

**`main(arguments)`** (line 1115): Dispatches to the appropriate command handler based on parsed CLI flags. Pattern: most commands load/prompt for community, call a handler function, then `browser.close(); exit(0)`.

**Flow:**
1. `validate_arguments()` — checks `--deadline` format
2. Loads predictors via `predictors.base.get_predictors()`
3. Handles `--list-predictors` and `--logout` (no browser needed)
4. Loads credentials via `load_credentials()` (prompts on first run)
5. Launches headless Chromium, tries restoring session from `SESSION_FILE`
6. If session expired or missing, does fresh `login()`
7. Dispatches to command handler

### Credential & Config Storage

- **Dir:** `~/.config/kicktipp-cli/`
- **Config:** `config.ini` (configparser format, chmod 600)
  - `[auth]` section: `email`, `password`
  - `[community]` section: `name` (saved default community)
  - `[player]` section: `name` (saved player identity for leaderboard marker)
- **Session:** `session.json` (Playwright storage state for cookie persistence)

Functions: `load_credentials()`, `load_community()`, `save_community()`, `load_player()`, `save_player()`, `logout()`

### Browser Automation (Playwright)

- Launches `chromium` in headless mode, viewport `1280x900`
- Uses `domcontentloaded` wait strategy (not `networkidle`) for speed
- `dismiss_consent(page)` — handles cookie consent CMP iframe (`iframe[src*="privacy-mgmt"]`), clicks "Accept and continue"
- `login(page, username, password)` — fills `input[name="kennung"]` + `input[name="passwort"]`, clicks `button[type="submit"]`, checks for `/login` in URL to detect failure
- Session cached to `SESSION_FILE` after successful login; restored on next run

### HTML Parsing (BeautifulSoup)

All page parsing follows a pattern: `page.goto(url)` → `page.wait_for_load_state('domcontentloaded')` → `dismiss_consent(page)` → `BeautifulSoup(page.content(), 'html.parser')` → find `#kicktipp-content` → parse tables.

**Key CSS selectors used across the codebase:**
- Content wrapper: `#kicktipp-content`
- Page title: `div.pagetitle`
- Bet form inputs: `input[id$='_heimTipp']`, `input[id$='_gastTipp']`
- Submit button: `button[name="submitbutton"]`
- Non-editable bets: `td.nichttippbar`
- Odds structure: `span.quote-heim > span.quote-text`, `span.quote-remis > span.quote-text`, `span.quote-gast > span.quote-text` (inside `div.tippabgabe-quoten`)
- Rankings table: `table#ranking`
- Matches table: `table#spielplanSpiele`
- Schedule table: `table#spiele`
- Player names: `div.mg_name`
- Match result: `span.kicktipp-ergebnis > span.kicktipp-heim` / `span.kicktipp-gast`
- Community links: `div.menu-title-mit-tippglocke`

### Bet Argument Parsing

- `parse_bet_arg("Home vs Away=H:G")` — splits on last `=`, then on ` vs `, returns `(home, away, h, g)` tuple. Calls `exit()` on invalid format.
- `match_fixture(home, away, editable)` — case-insensitive exact match against list of `(home, away, heim_name, gast_name)` tuples. Calls `exit()` if not found.

### URL Structure

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

Overview `ansicht` values: `spieltagspunkte`, `platzierungen`, `platzierungsdifferenz`, `spieltagsplatzierungen`, `punkteZurSpitze`

### Match Model: `helper/match.py`

`Match(hometeam, roadteam, match_date, rate_home, rate_deuce, rate_road)`

- Odds stored as floats; `.odds` property returns `(home, deuce, road)` tuple
- Date setter tries formats in order: `'%m/%d/%y %I:%M %p'` (kicktipp.com US format), then `'%d.%m.%y %H:%M'` (legacy DE format). Falls back to `None`.
- `__str__` outputs: `"DD.MM.YYYY HH:MM 'Home' vs. 'Away' (h;d;r)"`

### Deadline System: `helper/deadline.py`

- `to_timedelta("10m"|"5h"|"1d")` — parses duration string to `timedelta`
- `is_before_dealine(delta_str, deadline_dt, now=)` — returns True if `now <= deadline` and `deadline - now <= delta`
- `timedelta_tostring(td)` — human-readable format `"2 days and 03:15"`

### Predictor Plugin System: `predictors/base.py`

- `PredictorBase` — abstract base, subclasses must implement `predict(match) -> (home_goals, road_goals)`
- `get_predictors()` — auto-discovers all subclasses by scanning `predictors/` package via `pkgutil.iter_modules` + `importlib.import_module`, returns `{ClassName: Class}` dict
- `explore_package()` — lists all module names in the predictors directory

**Built-in predictors:**

| Predictor | Constants | Logic |
|---|---|---|
| `SimplePredictor` | DOMINATION=6, DRAW=1.2 | If odds diff < 1.2 → 1:1. Else threshold buckets → 1:0, 2:1, or 3:1 based on diff magnitude. Reverses for away favorite. |
| `CalculationPredictor` | MAX_GOALS=5, DOMINATION=9, DRAW=1.3, NONLINEARITY=0.5 | If odds diff < 1.3 → 1:1. Else computes total goals from diff/domination ratio, splits via ratio formula with nonlinearity exponent. |
| `ClaudePredictor` | N/A | Calls `claude -p` with team names and odds, parses H:G response. Requires Claude Code CLI installed with Max subscription. |

### Terminal UI

`Spinner` class (lines 229-265) — background thread spinner with Unicode braille frames. Used via `status(msg)` / `status_clear()` for all network operations.

### Bet Placement: `place_bets()`

For each community:
1. `parse_match_rows()` fetches predict page, parses table rows into `(heim_input_name, gast_input_name, Match)` tuples
2. For each match: skip if already bet (unless `--override-bets`), skip if deadline not reached, predict via predictor, fill inputs
3. Click `button[name="submitbutton"]` to submit (unless `--dry-run`)

### Manual Bet Commands

- `--set-bets` — interactive per-match prompt, enter `2:1` or press Enter to skip
- `--set-all-bets "Home vs Away=2:1" ...` — set bets by fixture name. Each arg is `"Home vs Away=H:G"`. Case-insensitive exact team name match. Use `--bets` first to see fixture names. Partial bets fine (unspecified matches left unchanged).

## Key Details

- Site: `https://www.kicktipp.com` (not .de)
- Python 3.8+ (CI tests on 3.8, local venv uses 3.14)
- Matchday range hardcoded to 1-34 (Bundesliga season)
- Login form: `input[name="kennung"]`, `input[name="passwort"]`
- The `--deadline` flag uses format `<number><unit>` where unit is `m`/`h`/`d`
- Typo in codebase: `is_before_dealine` (missing 'd' in deadline) — preserved for compatibility
- README.md is outdated (references old `--get-login-token`/`--use-login-token` API, kicktipp.de instead of .com)

## Uncommitted Changes (as of 2026-03-06)

The working tree has significant uncommitted changes that represent a major rewrite:
- **kicktippbb.py**: Complete rewrite from ~87 lines to ~1327 lines. Added: Playwright-based auth (replacing token-based), session caching, credential storage, spinner UI, and many new commands (`--list-communities`, `--set-community`, `--list-players`, `--set-player`, `--leaderboard`, `--overview`, `--schedule`, `--table`, `--bets`, `--set-bets`, `--set-all-bets`, `--auto-bets`, `--rules`, `--logout`).
- **helper/match.py**: Date parsing now tries US format (`%m/%d/%y %I:%M %p`) first, then legacy DE format.
- **requirements.txt**: Simplified to just `docopt`, `playwright`, `beautifulsoup4`.
- **test/url_test.py**: Added `test_parse_odds` test for the new structured odds HTML format.
- **.gitignore**: Added `.session.json`.
