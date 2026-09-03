<div align="center">

# kicktipp-agent

Use [Kicktipp](https://www.kicktipp.com/) from a terminal or an MCP-compatible assistant.

[![GitHub release](https://img.shields.io/github/v/release/Skriipt/kicktipp-agent?style=flat-square)](https://github.com/Skriipt/kicktipp-agent/releases/latest)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Release](https://img.shields.io/github/actions/workflow/status/Skriipt/kicktipp-agent/release-mcpb.yml?style=flat-square&label=release)](https://github.com/Skriipt/kicktipp-agent/actions/workflows/release-mcpb.yml)

[Quick start](#quick-start) · [CLI](#cli) · [MCP](#mcp) · [Privacy](#privacy-and-safety) · [Development](#development)

</div>

`kicktipp-agent` is a local Node.js client for `kicktipp.com` and
`kicktipp.de`. It reads the Kicktipp website over HTTP and provides:

- a command-line interface for direct use and scripts
- a full-screen terminal UI for browsing and placing tips
- a local Model Context Protocol server for Claude and other MCP clients
- season analytics, odds-based suggestions, reminders, and an undo log

> [!IMPORTANT]
> This is an unofficial client. Kicktipp has no public API, so website changes
> can break its parsers. Check tips before submitting them.

## Quick start

Install [Node.js](https://nodejs.org/) 20 or newer.

> [!NOTE]
> This fork is not published on npm. The unscoped `kicktipp-agent` package on
> npm belongs to the upstream project. Build this fork from source or use the
> Claude Desktop bundle from GitHub Releases.

### Terminal

```bash
git clone https://github.com/Skriipt/kicktipp-agent.git
cd kicktipp-agent
npm install
npm run build
npm link

kicktipp login --web
kicktipp tui
```

`login --web` opens a private setup page on `127.0.0.1`. Sign in, select a
community, then return to the terminal.

### Claude Desktop

1. Download [`kicktipp.mcpb`](https://github.com/Skriipt/kicktipp-agent/releases/latest/download/kicktipp.mcpb) from the [latest release](https://github.com/Skriipt/kicktipp-agent/releases/latest).
2. Open it with Claude Desktop and complete the settings form.
3. Fully restart Claude Desktop and open a new chat.
4. Ask, "What is my Kicktipp status?"

The bundle runs locally. It is not a hosted service.

### Claude Code and other MCP clients

Build the repository as shown above, then register `dist/server.js`:

```bash
claude mcp add kicktipp -- node /absolute/path/to/kicktipp-agent/dist/server.js
```

Other MCP clients can run the same `node /absolute/path/.../dist/server.js`
command over standard input and output. Ask the assistant to set up your
Kicktipp account. Open the returned localhost URL and never paste your password
into the chat.

## CLI

Start with:

```bash
kicktipp today
kicktipp deadline
kicktipp leaderboard
kicktipp bet
```

`kicktipp bet` opens the interactive prediction grid in a real terminal.

![Prediction grid with fixtures, score fields, suggestions, and keyboard shortcuts](docs/images/tui-prediction.jpg)

Use arrow keys to move, digits to enter scores, `s` for one suggestion, `a` to
fill empty rows, and `w` to submit. Press `q` to leave without submitting.

You can also pass a fixture directly:

```bash
kicktipp bet "FC Bayern München vs Borussia Dortmund=2:1"
kicktipp bet --bonus "Who will win the league?=FC Bayern München"
```

### Command overview

| Purpose | Commands |
| --- | --- |
| Setup | `login`, `logout`, `communities`, `set-community`, `players`, `set-player`, `profiles`, `set-lang`, `set-site` |
| Matches and tips | `today`, `schedule`, `bets`, `bet`, `tip-status`, `deadline` |
| Rankings and rules | `leaderboard`, `overview`, `table`, `rules` |
| Analytics | `sync`, `stats`, `rival`, `suggest`, `scenario`, `whatif` |
| Automation and history | `remind`, `notify`, `set-notify`, `log`, `cache` |
| Other | `tui`, `guide`, `admin` |

Run `kicktipp <command> --help` for options. Global `--community`, `--profile`,
`--lang`, and `--site` flags override saved settings for one run.

### Analytics and automation

```bash
kicktipp sync
kicktipp stats
kicktipp rival Papa
kicktipp suggest --strategy ev
kicktipp remind --ics season.ics
```

`remind --install` and `--uninstall` manage systemd user units on Linux, while
`--print cron` targets Unix-like crontabs. On Windows, use Task Scheduler or an
`.ics` calendar. Desktop notifications support macOS and Linux; Windows users
should configure the webhook or command backend.

`sync` fills the local season cache. Suggestions use Kicktipp's published odds
with `safe`, `ev`, or `contrarian` strategies. They print a slip but never
submit unless you add `--place`. Existing tips remain unchanged unless you also
add `--replace`.

Submission activity from the CLI, TUI, and MCP server is written to a local
JSONL audit log. `kicktipp log --undo` restores replaced values only from the
latest successful regular match submission for the signed-in account. It skips
bonus tips and Spielleiter submissions made for another member.

Profiles keep separate accounts, communities, players, and sessions:

```bash
kicktipp -c another-pool schedule
kicktipp -p work stats
```

## MCP

The local MCP server exposes the same Kicktipp data, analytics, and submission
logic as the CLI. Tools cover account setup, fixtures, tips, rankings, rules,
deadlines, statistics, suggestions, and Spielleiter actions. MCP clients read
their names and schemas directly from the server.

If setup is incomplete, `connect_account` returns a private localhost URL.
Kicktipp-mutating and local settings tools are available only when read-only
mode is disabled.

Enable read-only mode in the setup page or when starting the server:

```bash
KICKTIPP_READ_ONLY=1 node /absolute/path/to/kicktipp-agent/dist/server.js
```

Read-only mode removes those MCP tools. `connect_account` remains available and
may save credentials and configuration locally, but it cannot submit tips or
change data on Kicktipp. CLI commands and core submission functions also reject
writes, so the restriction does not depend on the MCP client behaving correctly.

## Configuration

Settings and sessions live in `~/.config/kicktipp-agent/`. Cache and audit data
use the platform data directory. Inspect or clear the cache with
`kicktipp cache status` and `kicktipp cache clear`.

Common environment overrides include `KICKTIPP_EMAIL`, `KICKTIPP_PASSWORD`,
`KICKTIPP_COMMUNITY`, `KICKTIPP_PROFILE`, `KICKTIPP_SITE`, `KICKTIPP_LANG`,
`KICKTIPP_TZ`, and `KICKTIPP_READ_ONLY`. Run `kicktipp guide` for detailed
usage and configuration help.

## Privacy and safety

- Credentials go to the configured Kicktipp base URL during login. Treat a
  custom `KICKTIPP_BASE_URL` as trusted.
- The localhost setup page keeps passwords out of prompts and terminal history.
- Passwords stored by the CLI use AES-256-GCM tied to the local hostname and
  operating-system user. Session-only mode stores a login cookie instead.
- Read-only mode blocks submissions in the MCP server, CLI, and core logic.
- Kicktipp hides other players' scores until the deadline. `tip-status` reports
  only whether their tips are complete, partial, or missing.

## Troubleshooting

- If `node` or `npm` is missing, install Node.js 20+ and reopen the terminal.
- If setup does not open, copy the printed `127.0.0.1` URL into a local browser.
- After `git pull`, run `npm run build` because clients execute `dist/server.js`.
- If parsing fails, retry with `--site de` or `--site com`, then open a
  sanitized [issue](https://github.com/Skriipt/kicktipp-agent/issues).

## Development

```bash
git clone https://github.com/Skriipt/kicktipp-agent.git
cd kicktipp-agent
npm install
npm run build
npm test
```

Run `npm run pack:mcpb` to build `kicktipp.mcpb` for Claude Desktop.

## Credits

This repository is a fork of Christian Heidorn's
[kicktipp-agent](https://github.com/christianheidorn/kicktipp-agent). Thanks to
Christian for the upstream project and the work this version builds on.

The upstream project began as a fork of
[schwalle/kicktipp-betbot](https://github.com/schwalle/kicktipp-betbot) and was
later rewritten in TypeScript.
