# kicktipp-agent

A CLI and MCP server for [kicktipp.com](https://www.kicktipp.com) — the German football prediction game. View leaderboards, schedules, league tables, and place bets from the terminal or let an AI agent do it for you.

## Why?

Kicktipp has no public API. Everything goes through the website. This project gives you two ways to skip the browser:

- **CLI** — Check scores, standings, and place bets in seconds from the terminal. No clicking through pages, no waiting for ads to load. Useful for quick lookups during matchday or scripting your predictions.

- **MCP Server** — Connect an AI assistant (Claude Desktop, Claude Code, or any MCP client) to your kicktipp account. Ask it to show today's matches, check who's leading your league, or place bets for you — all through natural conversation. The assistant sees your community's data but never your password.

No browser required. Kicktipp's pages are server-rendered, so this talks to
them over plain HTTP — nothing to download, nothing to keep running. Session
caching keeps it fast: after the first login, subsequent commands reuse the
saved session and skip the login flow entirely.

## Installation

Requires Node.js 20 or newer.

```bash
npm install
npm run build
npm link
```

This gives you two commands:

- **`kicktipp`** — the CLI
- **`kicktipp-mcp`** — the MCP server

## CLI

### First-time setup

On first run, the CLI prompts for your kicktipp.com email and password. Credentials are stored locally in `~/.config/kicktipp-agent/config.ini` (chmod 600).

```console
$ kicktipp set-community
No credentials found. Please enter your kicktipp.com login:
Email: you@example.com
Password: ********
Credentials saved to ~/.config/kicktipp-agent/config.ini

Available communities:
  [1] testspiel
  [2] bundesliga-tipps
Select community (1-2): 1
Saved 'testspiel' as default community.
```

Optionally set your player name so the leaderboard highlights your position:

```console
$ kicktipp set-player
```

### Commands

| Command | Description |
|---------|-------------|
| `communities` | List all communities you belong to |
| `set-community` | Select a default community |
| `players` | List players in the saved community |
| `set-player` | Select which player you are |
| `leaderboard` | Show the matchday leaderboard |
| `overview` | Show the season overview |
| `schedule` | Show the match schedule |
| `table` | Show the league table |
| `bets` | Show your bets for a matchday |
| `bet` | Place bets (interactive, by fixture, or bonus) |
| `today` | Show today's matches and which still need bets |
| `rules` | Show the game rules |
| `guide` | Print a detailed usage guide (useful for LLM agents) |
| `logout` | Remove stored credentials and session |

### Placing bets

```bash
# Interactive — prompts for each match
kicktipp bet

# By fixture name (get exact names from `kicktipp bets`)
kicktipp bet "FC Bayern München vs Borussia Dortmund=2:1"
kicktipp bet "RB Leipzig vs Bayer 04 Leverkusen=0:0" --matchday 5

# Bonus questions — interactive
kicktipp bet --bonus

# Bonus questions — by name
kicktipp bet --bonus "Who will win the league?=FC Bayern München"
```

### Options

- `--matchday <n>` — Target a specific matchday (1-34)
- `--bonus` — Bonus question rankings (with `leaderboard`) or bonus bets (with `bet`)
- `--view <value>` — Overview type (with `overview`)
- `--home` / `--away` — Home/away filter (with `table`)

## MCP Server

The MCP server exposes the same functionality as the CLI through the [Model Context Protocol](https://modelcontextprotocol.io), allowing AI assistants like Claude to interact with kicktipp.com on your behalf.

### Available tools

| Tool | Description |
|------|-------------|
| `get_status` | Check if credentials and community are configured |
| `get_today_matches` | Today's matches with bet status |
| `get_bets` | Matches and current bets for a matchday |
| `get_schedule` | Match schedule with results |
| `get_leaderboard` | Player rankings for a matchday |
| `get_overview` | Season overview across all matchdays |
| `get_table` | League table (actual football standings) |
| `get_rules` | Game rules and scoring system |
| `get_communities` | List communities the user belongs to |
| `get_players` | List players in the community |
| `get_bonus_questions` | Bonus questions with options |
| `set_community` | Set the active community |
| `set_player` | Set which player you are |
| `place_bets` | Place match bets by fixture name |
| `place_bonus_bets` | Place bonus question answers |

### Setup with Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "kicktipp": {
      "command": "kicktipp-mcp",
      "env": {
        "KICKTIPP_EMAIL": "you@example.com",
        "KICKTIPP_PASSWORD": "yourpassword"
      }
    }
  }
}
```

The `env` block passes credentials directly to the server process — Claude never sees them. If you prefer, you can omit `env` and set credentials via the CLI instead (`kicktipp set-community`).

After restarting Claude Desktop, the agent will have access to all kicktipp tools. It will call `get_status` first to check configuration, then prompt you to set a community if needed.

### Setup with Claude Code

Add to `.mcp.json` in your home directory or project:

```json
{
  "mcpServers": {
    "kicktipp": {
      "command": "kicktipp-mcp",
      "env": {
        "KICKTIPP_EMAIL": "you@example.com",
        "KICKTIPP_PASSWORD": "yourpassword"
      }
    }
  }
}
```

### Credentials

The MCP server accepts credentials in two ways (checked in this order):

1. **Environment variables** — `KICKTIPP_EMAIL` and `KICKTIPP_PASSWORD` passed via the `env` block in your MCP client config
2. **Config file** — `~/.config/kicktipp-agent/config.ini`, shared with the CLI

If neither is found, the server returns an error guiding the agent to inform you.

### Analytics

Once a season is cached locally, the agent can answer questions Kicktipp
itself does not:

```bash
kicktipp sync                      # download this season into a local cache
kicktipp stats                     # your form, hit types, biases, consistency
kicktipp stats --player Papa       # or somebody else's
kicktipp rival Papa                # what has to happen for you to overtake them
kicktipp suggest --strategy ev     # a bet slip built from the published odds
```

`sync` walks the season once, pacing its requests, and skips matchdays it has
already stored, so later runs only fetch what is new. Everything downstream of
it reads the cache: `stats` needs no network at all, and `rival`/`suggest`
accept `--offline` to work the same way.

**stats** reports points per matchday against the league average, rank history,
how your hits break down (exact result / goal difference / tendency / miss),
how your predictions compare with what actually happened, and how consistent
you are. It always states how many matchdays the numbers rest on.

**rival** shows the points gap, how much each remaining match can still swing
it, and what would have to happen for you to pass someone. Kicktipp hides other
players' bets until the deadline passes, so before kickoff the answer is given
as best/worst bounds and labelled as such.

**suggest** converts the odds Kicktipp already prints into probabilities and
proposes a full slip, explaining every pick. Three strategies: `safe` backs the
likeliest outcome, `ev` maximises expected points under your community's own
scoring rules, and `contrarian` fades the favourite in close matches (high
variance on purpose). It prints and stops — submitting needs `--place`, which
asks first, and matches that already have a bet are left alone unless you pass
`--replace`.

This is odds arithmetic, not prediction magic: the numbers come from the
bookmaker's own prices, and no external data source or API key is involved.

The cache lives in your platform's data directory (`~/.local/share/kicktipp-agent`
on Linux) and can be inspected with `kicktipp cache status` or removed with
`kicktipp cache clear`.

### Scoring rules

Features that count points read your community's rules page to learn what an
exact result, a goal difference and a tendency are worth. If that page cannot be
parsed, Kicktipp's 4/3/2 defaults are assumed and every affected output says so.
You can also set them explicitly in `~/.config/kicktipp-agent/config.ini`:

```ini
[scoring]
exact = 4
diff = 3
tendency = 2
```

### Choosing the Kicktipp host

By default everything runs against `https://www.kicktipp.com`. Set
`KICKTIPP_BASE_URL=https://www.kicktipp.de` to use the German site and its
German page names instead. You rarely need to: when a page is missing under
one host or spelling, the same page is retried under the other automatically,
so communities that only exist on one of the two still work either way.

## Development

```bash
npm test          # run tests
npm run build     # compile TypeScript
```

## Credits

Originally forked from [schwalle/kicktipp-betbot](https://github.com/schwalle/kicktipp-betbot) by Stefan. The project has since been fully rewritten in TypeScript with a new CLI interface, MCP server, and Cheerio-based parsing.
