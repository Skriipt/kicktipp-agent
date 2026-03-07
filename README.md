kicktipp-cli
============

A CLI tool to interact with [kicktipp.com](https://www.kicktipp.com) — view leaderboards, schedules, league tables, and place bets.

Getting started
---------------

```bash
npm install
npx playwright install chromium
npm run build
npm link
```

On first run you will be prompted for your kicktipp.com credentials. They are stored in `~/.config/kicktipp-cli/` for subsequent runs.

### Set up your community

```console
$ kicktipp set-community
Available communities:
  [1] testspiel
  [2] bundesliga-tipps
Select community (1-2): 1
Saved 'testspiel' as default community.
```

### View bets

```console
$ kicktipp bets
```

### Place bets by fixture

```console
$ kicktipp set-all-bets "FC Bayern München vs Borussia Dortmund=2:1" "RB Leipzig vs Bayer 04 Leverkusen=0:0"
```

### Auto-place bets using a predictor

```console
$ kicktipp auto-bets
```

Commands
--------

| Command | Description |
|---------|-------------|
| `list-predictors` | List available predictor algorithms |
| `list-communities` | List all communities you belong to |
| `set-community` | Select a default community |
| `list-players` | List players in the saved community |
| `set-player` | Select which player you are |
| `leaderboard` | Show the matchday leaderboard |
| `overview` | Show the season overview |
| `schedule` | Show the match schedule |
| `table` | Show the league table |
| `bets` | Show your bets for a matchday |
| `set-bets` | Manually set bets (interactive) |
| `set-all-bets` | Set bets by fixture name |
| `auto-bets` | Auto-place bets using a predictor |
| `rules` | Show the game rules |
| `logout` | Remove stored credentials and session |

### Options

- `--matchday <n>` — Target a specific matchday (1-34)
- `--bonus` — Show bonus questions (with `leaderboard`)
- `--view <value>` — Overview type (with `overview`)
- `--home` / `--away` — Home/away table (with `table`)
- `--predictor <name>` — Choose predictor (with `auto-bets`)
- `--override-bets` — Replace already placed bets
- `--dry-run` — Preview predictions without submitting

### Predictors

By default the first predictor is used. Specify one with `--predictor`:

```console
$ kicktipp auto-bets --predictor CalculationPredictor
```

Available: `SimplePredictor`, `CalculationPredictor`, `ClaudePredictor`

Development
-----------

```bash
npm test          # run tests
npm run build     # compile TypeScript
```
