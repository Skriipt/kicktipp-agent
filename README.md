<div align="center">

# kicktipp-agent

Use [Kicktipp](https://www.kicktipp.com/) from a terminal or an MCP-compatible assistant.

[![GitHub release](https://img.shields.io/github/v/release/Skriipt/kicktipp-agent?style=flat-square)](https://github.com/Skriipt/kicktipp-agent/releases/latest)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Release](https://img.shields.io/github/actions/workflow/status/Skriipt/kicktipp-agent/release-mcpb.yml?style=flat-square&label=release)](https://github.com/Skriipt/kicktipp-agent/actions/workflows/release-mcpb.yml)

[Quick start](#quick-start) · [CLI](#cli) · [MCP server](#mcp-server) · [Privacy and safety](#privacy-and-safety) · [Development](#development)

</div>

`kicktipp-agent` is a local Node.js client for `kicktipp.com` and `kicktipp.de`. It reads the Kicktipp website over HTTP, parses the returned HTML, and exposes the result through three interfaces:

- a command-line interface for scripts and direct use
- a full-screen terminal UI for browsing and placing tips
- a local [Model Context Protocol](https://modelcontextprotocol.io/) server for Claude and other MCP clients

It can show fixtures, tips, rankings, rules, deadlines, and season statistics. It can also place tips, create reminders, compare rivals, and calculate suggestions from the odds published by Kicktipp.

> [!IMPORTANT]
> This is an unofficial client. Kicktipp does not provide a public API, so a website change can break a parser. Check the proposed tips before submitting them.

## Quick start

Install [Node.js](https://nodejs.org/) 20 or newer, then choose the setup that matches how you want to use the project.

> [!NOTE]
> This fork is not published on npm. The unscoped `kicktipp-agent` package on
> npm belongs to the upstream project. Install this fork from its source or use
> the Claude Desktop bundle from GitHub Releases.

### Terminal

Clone and build this fork, link its CLI, then open the dashboard:

```bash
git clone https://github.com/Skriipt/kicktipp-agent.git
cd kicktipp-agent
npm install
npm run build
npm link

kicktipp login --web
kicktipp tui
```

The setup page runs on `127.0.0.1`. Enter your Kicktipp credentials there, select a community, then return to the terminal.

Useful first commands:

```bash
kicktipp today
kicktipp deadline
kicktipp leaderboard
kicktipp bet
```

### Claude Desktop

1. Download [`kicktipp.mcpb`](https://github.com/Skriipt/kicktipp-agent/releases/latest/download/kicktipp.mcpb) from the [latest release](https://github.com/Skriipt/kicktipp-agent/releases/latest).
2. Open the file with Claude Desktop and complete the settings form.
3. Fully quit and reopen Claude Desktop.
4. Start a new chat and ask, "What is my Kicktipp status?"

The bundle runs the MCP server on your computer. It is not a hosted service.

### Claude Code

Clone and build the repository as shown under [Terminal](#terminal), then
register the compiled MCP server. Replace the example with the absolute path to
your checkout:

```bash
claude mcp add kicktipp -- node /absolute/path/to/kicktipp-agent/dist/server.js
```

Start a new chat and ask Claude to set up your Kicktipp account. It will return a private localhost URL. Open that page to sign in and select a community. Do not paste your password into the chat.

### Other MCP clients

Build a local checkout, then configure the client to run this command over
standard input and output:

```bash
node /absolute/path/to/kicktipp-agent/dist/server.js
```

## How it works

```text
CLI, TUI, or MCP client
          |
          v
  kicktipp-agent on your computer
          |
          +-- HTTPS requests --> kicktipp.com or kicktipp.de
          +-- local config  --> credentials, profile, preferences
          +-- local data    --> session, cache, and submission log
```

The project does not launch a headless browser. Its small page abstraction uses `fetch`, a cookie jar, and Cheerio. All three interfaces call the same parsing, scoring, cache, and submission code.

Both Kicktipp hosts are supported. The default is `.com`; use `kicktipp set-site de` to prefer `.de`. If a page is missing on the selected host, the client can try the equivalent German or English route on the other host.

## CLI

Run `kicktipp --help` or `kicktipp <command> --help` for the complete option list.

### Everyday commands

| Command | What it does |
| --- | --- |
| `kicktipp tui` | Open the full-screen dashboard |
| `kicktipp today` | Show today's fixtures and missing tips |
| `kicktipp bet` | Open the interactive prediction grid |
| `kicktipp bets` | Show your tips for a matchday |
| `kicktipp tip-status` | Show complete, partial, and missing submissions without exposing hidden scores |
| `kicktipp deadline` | Show time to kickoff and tips still due |
| `kicktipp leaderboard` | Show the matchday ranking |
| `kicktipp overview` | Show the season overview |
| `kicktipp schedule` | Show fixtures and results |
| `kicktipp table` | Show the football league table |
| `kicktipp rules` | Show the community's scoring rules |

Most matchday commands accept `--matchday <number>`. Global `--community`, `--profile`, `--lang`, and `--site` flags override saved settings for one run.

### Prediction grid

On a real terminal, `kicktipp bet` opens the dashboard directly on the place-bets screen.

![Prediction grid with fixtures, score fields, suggestions, and keyboard shortcuts](docs/images/tui-prediction.jpg)

| Key | Action |
| --- | --- |
| Arrow keys | Move between score fields |
| Digits | Enter a score |
| `s` | Apply the suggestion to the current fixture |
| `a` | Fill every empty fixture from suggestions |
| `u` | Clear the current fixture |
| `w` | Submit |
| `q` | Quit without submitting |

You can also place tips without the TUI:

```bash
kicktipp bet "FC Bayern München vs Borussia Dortmund=2:1"
kicktipp bet "RB Leipzig vs Bayer 04 Leverkusen=0:0" --matchday 5
kicktipp bet --bonus "Who will win the league?=FC Bayern München"
```

Use the fixture names returned by `kicktipp bets`. `kicktipp bet --no-tui` keeps the older prompt-based flow.

### Analytics and suggestions

Sync the season once before using cached analytics:

```bash
kicktipp sync
kicktipp stats
kicktipp stats --player Papa
kicktipp rival Papa
kicktipp suggest --strategy ev
```

`sync` stores matchdays locally and fills only gaps on later runs. `stats` reads the cache without a network request. `rival` and `suggest` also support `--offline`.

Suggestions use the odds already published by Kicktipp. They do not use an external prediction service.

| Strategy | Behavior |
| --- | --- |
| `safe` | Selects the most likely outcome |
| `ev` | Maximizes expected points under the community's scoring rules |
| `contrarian` | Fades a narrow favorite and accepts more variance |

`suggest` only prints a slip by default. Add `--place` to submit it. Existing tips remain untouched unless you also use `--replace`.

### Scoring rules

Point calculations read the active community's rules, including exact-result,
goal-difference, tendency, and doubled-matchday values. If the rules page
cannot be parsed, the client labels the fallback and uses Kicktipp's 4/3/2
defaults. You can override those values in `config.ini`:

```ini
[scoring]
exact = 4
diff = 3
tendency = 2
```

Verify the model against a finished matchday:

```bash
kicktipp rules --verify
```

The command recomputes each player's score and compares it with Kicktipp's
reported result. It exits with status `1` when the totals differ.

### Scenarios and audit log

```bash
kicktipp scenario "Bayern vs Dortmund=2:1"
kicktipp scenario --target 1
kicktipp whatif "2:1"
kicktipp whatif suggest:ev
kicktipp log
kicktipp log --undo
```

Every submission made through the CLI, TUI, or MCP server writes an entry to a local JSONL log. The record includes the previous value, which allows `log --undo` to restore the most recent successful submission.

### Deadlines and notifications

```bash
kicktipp deadline --check
kicktipp remind --print cron
kicktipp remind --print systemd
kicktipp remind --ics season.ics
kicktipp set-notify desktop
kicktipp notify
```

`deadline --check` exits with status `2` when a missing tip is due within the warning window. The default is six hours. Change it with `--warn-hours` or `KICKTIPP_WARN_HOURS`.

Notification backends:

- `desktop` uses macOS Notification Center or `notify-send` on Linux
- `webhook` sends JSON to the URL you configure
- `command` passes the summary and report to a local executable

The project has no built-in webhook destination.

### Accounts, communities, and profiles

```bash
kicktipp communities
kicktipp set-community
kicktipp players
kicktipp set-player
kicktipp profiles
kicktipp -c another-pool schedule
kicktipp -p work stats
```

A profile keeps a separate account, community, player, and session. Existing installations without profiles continue to use the default sections in `config.ini`.

### Remaining commands

| Command | What it does |
| --- | --- |
| `login`, `logout` | Connect or remove a stored account and session |
| `set-lang`, `set-site` | Save the interface language or preferred Kicktipp host |
| `set-notify` | Configure one notification backend |
| `cache status`, `cache clear` | Inspect or delete derived cache data |
| `guide` | Print detailed instructions intended for an assistant |
| `admin members` | List community members for a Spielleiter |
| `admin bets <member>` | Inspect a member's tips |
| `admin bet <member> ...` | Place tips for a member after an explicit name confirmation |

## MCP server

The MCP server exposes focused tools instead of a shell. An assistant can read live Kicktipp data, run local analytics, and, when allowed, submit tips.

Read tools include:

- `get_status`, `get_today_matches`, `get_bets`, `get_schedule`
- `get_leaderboard`, `get_tip_status`, `get_overview`, `get_table`, `get_rules`
- `get_communities`, `get_players`, `get_bonus_questions`
- `get_deadline`, `get_stats`, `get_rival_analysis`, `suggest_bets`
- `get_standings_scenarios`, `whatif`, `get_bet_log`
- `list_members`, `get_bets_for_member`

Local setup tools include:

- `connect_account`, `set_community`, `set_player`, `set_notify`

`sync_history` updates the local season cache.

When read-only mode is disabled, the server also exposes:

- `place_bets`, `place_bonus_bets`, `place_bets_for_member`

After `sync_history`, MCP clients can also read cached JSON through these
resource templates without making a request to Kicktipp:

- `kicktipp://{community}/rules`
- `kicktipp://{community}/leaderboard/{matchday}`
- `kicktipp://{community}/schedule/{matchday}`

The server returns a localhost setup link when authentication or community selection is missing. MCP clients never need the raw password in their conversation history.

### Read-only mode

Enable read-only mode in the setup page or start a process with:

```bash
KICKTIPP_READ_ONLY=1 node /absolute/path/to/kicktipp-agent/dist/server.js
```

On PowerShell:

```powershell
$env:KICKTIPP_READ_ONLY = '1'
node C:\absolute\path\to\kicktipp-agent\dist\server.js
```

Read-only mode applies at three levels. The MCP server does not register write tools, CLI write commands stop before submission, and the core submission functions reject writes too.

## Configuration

Settings and sessions live under `~/.config/kicktipp-agent/` on every supported platform. Derived data uses the platform data directory:

| Platform | Data directory |
| --- | --- |
| Linux | `$XDG_DATA_HOME/kicktipp-agent` or `~/.local/share/kicktipp-agent` |
| macOS | `~/Library/Application Support/kicktipp-agent` |
| Windows | `%APPDATA%\kicktipp-agent` |

The cache is safe to delete and rebuild with `kicktipp sync`. Submission logs live in the `audit` subdirectory.

Environment variables override saved configuration for the current process:

| Variable | Purpose |
| --- | --- |
| `KICKTIPP_EMAIL`, `KICKTIPP_PASSWORD` | Provide credentials without writing them to `config.ini` |
| `KICKTIPP_COMMUNITY`, `KICKTIPP_PLAYER` | Select a community and player |
| `KICKTIPP_PROFILE` | Select a saved profile |
| `KICKTIPP_LANG` | Set interface language to `en` or `de` |
| `KICKTIPP_SITE` | Prefer `com` or `de` |
| `KICKTIPP_BASE_URL` | Override the Kicktipp base URL |
| `KICKTIPP_READ_ONLY` | Block all submission paths |
| `KICKTIPP_DATA_DIR` | Override the cache and audit directory |
| `KICKTIPP_TZ` | Override the timezone used for fixture times |
| `KICKTIPP_WARN_HOURS` | Change the deadline warning window |
| `KICKTIPP_SUGGEST_STRATEGY` | Set the default suggestion strategy |
| `KICKTIPP_NOTIFY_KIND`, `KICKTIPP_NOTIFY_TARGET` | Override notification settings |

## Privacy and safety

- During login, the process sends credentials to the configured base URL, normally `kicktipp.com` or `kicktipp.de`. Treat any `KICKTIPP_BASE_URL` override as trusted. Do not put credentials in prompts, repository files, logs, or screenshots.
- Password storage uses AES-256-GCM with a key derived from the local hostname and operating-system user. The encrypted value is tied to that machine and user account. It is not a substitute for an operating-system keychain.
- Session-only storage keeps the login cookie instead of the password. When the session expires, you must reconnect through the setup page.
- The setup listener binds to `127.0.0.1`, uses a random token in the URL, and stops after setup or a short timeout.
- Read-only mode removes MCP write tools and blocks writes again inside the CLI and core logic.
- Submissions are logged locally with their origin and previous values. A log failure is reported, but it does not cancel a submission you already requested.
- Kicktipp hides other players' score predictions until the relevant deadline. `tip-status` reports submission state without revealing those hidden scores.

## Troubleshooting

**`node` or `npm` is not found.** Install Node.js 20 or newer, then open a new terminal so the updated `PATH` takes effect.

**The setup page did not open.** Copy the printed `http://127.0.0.1:.../setup?token=...` URL into a browser on the same computer.

**An assistant still shows no Kicktipp tools.** Restart the MCP client and open a new chat. Make sure you configured either the Desktop bundle or a manual server entry, not both.

**A session-only login expired.** Run `kicktipp login --web` or ask the assistant to reconnect the account.

**A source checkout behaves like the old version after `git pull`.** Run `npm run build` again. MCP clients execute `dist/server.js`, not the TypeScript source.

**A page can no longer be parsed.** Retry against the other host with `--site de` or `--site com`. If the problem remains, [open an issue](https://github.com/Skriipt/kicktipp-agent/issues) with the command and sanitized error output. Never include credentials or private pool data.

## Development

Clone and verify the project:

```bash
git clone https://github.com/Skriipt/kicktipp-agent.git
cd kicktipp-agent
npm install
npm run build
npm test
```

Run a source checkout through the CLI:

```bash
node dist/index.js --help
node dist/index.js login --web
```

Register the local build with Claude Code:

```bash
claude mcp add kicktipp -- node /absolute/path/to/kicktipp-agent/dist/server.js
```

Build the Claude Desktop bundle with `npm run pack:mcpb`. The script compiles the project, installs production dependencies in a staging directory, and writes `kicktipp.mcpb` to the repository root.

The project was originally forked from [schwalle/kicktipp-betbot](https://github.com/schwalle/kicktipp-betbot) and has since been rewritten in TypeScript.
