kicktipp-cli
============

A CLI tool to interact with [kicktipp.com](https://www.kicktipp.com) — view leaderboards, schedules, league tables, and place bets.

Getting started
---------------

```bash
pip install -r requirements.txt
playwright install chromium
```

On first run you will be prompted for your kicktipp.com credentials. They are stored in `~/.config/kicktipp-cli/` for subsequent runs.

### Set up your community

```console
$ kicktippbb.py --set-community
Available communities:
  [1] testspiel
  [2] bundesliga-tipps
Select community (1-2): 1
Saved 'testspiel' as default community.
```

### View bets

```console
$ kicktippbb.py --bets
```

### Place bets by fixture

```console
$ kicktippbb.py --set-all-bets "FC Bayern München vs Borussia Dortmund=2:1" "RB Leipzig vs Bayer 04 Leverkusen=0:0"
```

### Auto-place bets using a predictor

```console
$ kicktippbb.py --auto-bets
```

### Options

#### Override
By default bets you already placed are not overridden. Use `--override-bets` to replace them.

#### Matchday
Use `--matchday` to target a specific matchday (1-34).

#### Dry run
Use `--dry-run` to preview predictions without submitting.

### Match Predictor Functions

By default the first detected predictor is used. Specify one with `--predictor`:

```console
$ kicktippbb.py --auto-bets --predictor CalculationPredictor
```

Predictors reside in the `predictors/` subfolder. All must subclass `PredictorBase` and implement `predict()`.

### Usage

```console
$ kicktippbb.py --help
KickTipp BetBot
Automated kicktipp.com bet placement.

Places bets to the upcomming matchday.
Unless specified by parameter it places the bets on all prediction games of the account.

On first run you will be prompted for your kicktipp.com credentials.
They are stored in ~/.config/kicktipp-cli/ for subsequent runs.

Usage:
    kicktippbb.py [ --list-predictors ]
    kicktippbb.py [ --list-communities ]
    kicktippbb.py [ --set-community ]
    kicktippbb.py [ --list-players ]
    kicktippbb.py [ --set-player ]
    kicktippbb.py [ --leaderboard ] [--matchday <value>] [--bonus]
    kicktippbb.py [ --overview ] [--view <value>]
    kicktippbb.py [ --schedule ] [--matchday <value>]
    kicktippbb.py [ --table ] [--home] [--away]
    kicktippbb.py [ --bets ] [--matchday <value>]
    kicktippbb.py [ --set-bets ] [--matchday <value>]
    kicktippbb.py [ --set-all-bets BETS... ] [--matchday <value>]
    kicktippbb.py [ --auto-bets ] [--matchday <value>] [--predictor <value>] [--override-bets] [--dry-run]
    kicktippbb.py [ --rules ]
    kicktippbb.py [ --logout ]

Options:
    --list-communities          Display a list of all communities the user has access to.
    --set-community             Select a community to use as default.
    --list-players              Display a list of all players in the saved community.
    --set-player                Select which player you are and save it.
    --leaderboard               Show the leaderboard for the current (or specified) matchday.
    --bonus                     Show the bonus questions leaderboard instead of the matchday one.
    --overview                  Show the season overview table.
    --view <value>              Which overview to show [default: matchday-points].
                                Options: matchday-points, standings, standings-diff,
                                matchday-standings, points-from-leader
    --bets                      Show your bets for the current (or specified) matchday.
    --set-bets                  Manually set bets for editable matches. Press Enter to skip a match.
    --set-all-bets BETS...      Set bets by fixture, e.g. "Home vs Away=2:1". Use --bets to see fixture names.
    --auto-bets                 Automatically place bets using a predictor on the saved community.
    --rules                     Show the game rules for the community.
    --schedule                  Show the match schedule for the current (or specified) matchday.
    --table                     Show the league table.
    --home                      Show the home table (use with --table).
    --away                      Show the away table (use with --table).
    --logout                    Remove stored credentials and session, then exit.
    --override-bets             Override already placed bets.
    --list-predictors           Display a list of predictors available to be used with '--predictor' option
    --predictor <value>         A specific predictor name to be used during calculation
    --dry-run                   Dont place any bet just print out predicitons
    --matchday <value>          Choose a specific matchday in the range of 1 to 34 to place bets on
```
