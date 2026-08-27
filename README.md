# kicktipp-agent

A CLI and MCP server for [kicktipp.de](https://www.kicktipp.de) — the German football prediction game. View leaderboards, schedules, league tables, tip submission status, and place bets from the terminal or let an AI agent do it for you.

## Why?

Kicktipp has no public API. Everything goes through the website. This project gives you two ways to skip the browser:

- **CLI** — Check scores, standings, tip status, and place bets in seconds from the terminal. No clicking through pages, no waiting for ads to load. Useful for quick lookups during matchday or scripting your predictions.

- **MCP Server** — Connect an AI assistant (Claude Desktop, Claude Code, or any MCP client) to your Kicktipp account. Ask it to show today's matches, check who's leading your league, see who still needs to tip, or place bets for you — all through natural conversation. The assistant sees your community's data but never your password.

Headless Chromium with session caching keeps things fast. After the first login, subsequent commands reuse the saved session and skip the login flow entirely.

## Installation

```bash
npm install
npx playwright install chromium
npm run build
npm link
```

This gives you two commands:

- **`kicktipp`** — the CLI
- **`kicktipp-mcp`** — the MCP server

## CLI

### First-time setup

On first run, the CLI prompts for your Kicktipp email and password. Credentials are stored locally in `~/.config/kicktipp-agent/config.ini` (chmod 600).

```console
$ kicktipp set-community
No credentials found. Please enter your Kicktipp login:
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
| `tip-status` | Show who has fully, partially, or not yet tipped |
| `overview` | Show the season overview |
| `schedule` | Show the match schedule |
| `table` | Show the league table |
| `bets` | Show your bets for a matchday |
| `bet` | Place bets (interactive, by fixture, or bonus) |
| `today` | Show today's matches and which still need bets |
| `rules` | Show the game rules |
| `guide` | Print a detailed usage guide (useful for LLM agents) |
| `logout` | Remove stored credentials and session |

### Checking tip status

```bash
# Current matchday
kicktipp tip-status

# Specific matchday
kicktipp tip-status --matchday 5
```

The command is read-only and works for normal community members. It reports whether each player has submitted all, some, or none of the matchday tips. Before the deadline it only uses Kicktipp's submission markers; it does not reveal hidden score predictions.

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

The MCP server exposes the same functionality as the CLI through the [Model Context Protocol](https://modelcontextprotocol.io), allowing AI assistants like Claude to interact with Kicktipp on your behalf.

### Available tools

| Tool | Description |
|------|-------------|
| `get_status` | Check if credentials and community are configured |
| `get_today_matches` | Today's matches with bet status |
| `get_bets` | Matches and current bets for a matchday |
| `get_schedule` | Match schedule with results |
| `get_leaderboard` | Player rankings for a matchday |
| `get_tip_status` | Full, partial, or missing tip submissions by player |
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

After restarting Claude Desktop, the agent will have access to all Kicktipp tools. It will call `get_status` first to check configuration, then prompt you to set a community if needed.

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

### Choosing the Kicktipp host

The default is `https://www.kicktipp.de` with German page routes. To prefer the English host and routes instead, set:

```bash
KICKTIPP_BASE_URL=https://www.kicktipp.com
```

Existing direct route calls are normalized to the selected host, so all CLI and MCP commands use the same setting.

## Development

```bash
npm test          # run tests
npm run build     # compile TypeScript
```

See [CHANGELOG.md](CHANGELOG.md) for released changes.

## Credits

Originally forked from [schwalle/kicktipp-betbot](https://github.com/schwalle/kicktipp-betbot) by Stefan. The project has since been fully rewritten in TypeScript with a new CLI interface, MCP server, and Cheerio-based parsing.
