<div align="center">

# kicktipp-agent

Use [Kicktipp](https://www.kicktipp.com/) from a web dashboard, terminal, or MCP-compatible assistant.

[![GitHub release](https://img.shields.io/github/v/release/Skriipt/kicktipp-agent?style=flat-square)](https://github.com/Skriipt/kicktipp-agent/releases/latest)
[![Node.js 24 LTS](https://img.shields.io/badge/Node.js-24_LTS-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Release](https://img.shields.io/github/actions/workflow/status/Skriipt/kicktipp-agent/release-mcpb.yml?style=flat-square&label=release)](https://github.com/Skriipt/kicktipp-agent/actions/workflows/release-mcpb.yml)

[Quick start](#quick-start) · [Dashboard](#web-dashboard) · [CLI](#cli) · [MCP](#mcp) · [Privacy](#privacy-and-safety) · [Development](#development)

</div>

`kicktipp-agent` is a local Node.js client for `kicktipp.com` and
`kicktipp.de`. It reads the Kicktipp website over HTTP and provides:

- a command-line interface for direct use and scripts
- a local web dashboard for account setup, tips, analytics, notifications, and service control
- a full-screen terminal UI for browsing and placing tips
- a local Model Context Protocol server for Claude and other MCP clients
- season analytics, odds-based suggestions, reminders, and an undo log

> [!IMPORTANT]
> This is an unofficial client. Kicktipp has no public API, so website changes
> can break its parsers. Check tips before submitting them.

## Quick start

Install [Node.js](https://nodejs.org/) 24.15 or newer in the 24 LTS line.
Node 22.22.2+ in the 22 LTS line and Node 26+ are also supported.

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

### Web dashboard

After building the repository, run:

```bash
npm run dashboard
# Or, after npm link:
kicktipp dashboard --port 3210
```

Open the complete link printed in the terminal. The dashboard has a German
interface with red accents and works on desktop and mobile viewports. Connect
your Kicktipp account under **Konten**, then choose your community and player.
The CLI, MCP server, and dashboard share the same settings and sessions.

Match and bonus tips have editable forms with preview and confirmation.
The other CLI operations are available as forms in the corresponding sections,
including all their options. Notifications support Discord, Telegram, ntfy,
webhooks, desktop notifications, and local programs. The reminder service can
be configured, started, inspected, and stopped from the dashboard.

The HTTP server listens only on `127.0.0.1`. Its private access link is valid
until the process exits. Keep that terminal running. For setup, the complete
feature mapping, and SSH access, see [Dashboard documentation](docs/dashboard.md).

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
| Other | `dashboard`, `tui`, `guide`, `admin` |

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

Analytics read the community's win/draw point matrix from its rules page.
Incomplete or unsupported scoring schemes are rejected instead of guessed.

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

Settings and sessions live in `~/.config/kicktipp-agent/` by default, preserving
existing CLI installations. `KICKTIPP_CONFIG_DIR` overrides the directory for
`config.ini`; `KICKTIPP_DATA_DIR` independently moves session cookies and Auth
Profile mutation locks to writable storage. Without a Data override, cookies
and auth locks remain beside `config.ini`. Cache and audit data use the platform
data directory. Inspect or clear the cache with `kicktipp cache status` and
`kicktipp cache clear`.

Default `session.json` and simple profile filenames such as `session-work.json`
are unchanged. Other profile names are URL-encoded, not replaced with underscores:
`team/a`, `team?a`, and `team_a` now have separate cookie files. Sessions formerly
saved under a lossy name (for example `session-team_a.json` for `team/a`) are not
automatically adopted: reconnect that profile to avoid using another account's
cookie. On case-insensitive filesystems, avoid profile names differing only by
letter case. Moving to an explicit Data directory requires copying known,
correctly owned sessions there (see Docker below); there is no implicit fallback
to old cookie files.

On Linux, Service and Auth mutation locks require util-linux `flock` (included
in the tested container image). See [lock ownership and upgrade notes](docs/service-lock-ownership.md)
for stranded legacy locks, the persistent `.guard` files, and platform limits.

Common environment overrides include `KICKTIPP_EMAIL`, `KICKTIPP_PASSWORD`,
`KICKTIPP_COMMUNITY`, `KICKTIPP_PROFILE`, `KICKTIPP_SITE`, `KICKTIPP_LANG`,
`KICKTIPP_TZ`, and `KICKTIPP_READ_ONLY`. Run `kicktipp guide` for detailed
usage and configuration help.

### Docker Service

The Compose example builds locally and runs the regular `kicktipp serve`
process without an inbound port. It mounts Config (`service.json`, `config.ini`)
from `./config` read-only, stores Service State, session cookies and Auth Profile
locks in the writable `kicktipp-data` volume, and mounts Secret files
from `./secrets` read-only. Put only Secret References such as
`file:/run/secrets/discord-webhook` in `service.json`; never put secret values
in the image, `compose.yaml`, or `service.json`. `env:NAME` references can
instead receive named variables from a private Compose override.

Create the host directories and prepare a valid Service configuration as
`service.json` in the repository root. This one-time setup container writes
Config and initial State through the existing durable setup operation; its
explicit volume override is the only time `/config` is writable:

```bash
mkdir -p config secrets
chmod 700 config secrets

docker compose build
docker compose run --rm --no-deps \
  --volume "$PWD/config:/config:rw" \
  --volume "$PWD/service.json:/setup/service.json:ro" \
  --entrypoint node kicktipp \
  --input-type=module --eval '
    import fs from "node:fs";
    const { setupService } = await import("./dist/service/store.js");
    setupService(JSON.parse(fs.readFileSync("/setup/service.json", "utf8")));
  '
```

On Linux, `config` must be writable and Secret files readable by UID 1000, the
non-root `node` user in the image; adjust their ownership when the host user
has a different UID. Use BCP 47 language tags such as `de-DE` (not `de_DE`) in
Service configuration.

The Service's `profileId` must also exist in `/config/config.ini`. For example,
for an existing session-only login to profile `work`, place this in
`config/config.ini` (use the account's actual email):

```ini
[profile.work]
email = you@example.com
store = session
```

Copy that account's existing `session-work.json` into `config/` temporarily,
then seed the persistent Data volume without making Config writable:

```bash
chmod 600 config/config.ini config/session-work.json
docker compose run --rm --no-deps --entrypoint node kicktipp --input-type=module --eval '
  import fs from "node:fs";
  fs.copyFileSync("/config/session-work.json", "/data/session-work.json", fs.constants.COPYFILE_EXCL);
  fs.chmodSync("/data/session-work.json", 0o600);
'
rm config/session-work.json
```

Only import a session whose account ownership is known; never reuse an ambiguous
legacy sanitized filename for a different profile. The copy refuses to overwrite
an existing Data session. Session-only profiles require reconnection when cookies
expire. For password-backed profiles, provision credentials in a setup container
with writable Config, using the same `node` user and hostname as the runtime.
Compose fixes the hostname to `kicktipp-agent` so encrypted passwords remain
readable after container recreation. Host-encrypted passwords are **not portable**
into the container; do not copy them and expect decryption to work. Plaintext
passwords in `config.ini` are supported for named profiles but are not recommended.
Credential/config changes require a writable setup mount; ordinary cookie refresh
writes only `/data`, with owner-only file permissions. Back up the Data volume as
sensitive account data; `docker compose down -v` deletes sessions and State.

After setup, start and inspect the Service:

```bash
docker compose up -d
docker compose exec kicktipp kicktipp service health
docker compose logs -f kicktipp
docker compose down
```

Compose uses JSON Service logs, `restart: unless-stopped`, an init process, and
a 35-second stop grace period for the Service's internal 30-second shutdown
contract. The Healthcheck runs `kicktipp service health` locally every 60
seconds and does not contact Kicktipp or a Notification Target. Run the Docker
smoke proof with `npm run test:docker`. It uses disposable fixtures and containers
with `--network none`: a loopback-only mock Kicktipp verifies encrypted credential
loading, expired-cookie refresh under read-only Config, isolation of colliding
profile names, and cookie reuse after container recreation without another login.
It also SIGKILLs the Service and recreates it under a changed hostname to verify
lock recovery while preserving State.
No real account login or Notification delivery occurs.

## Privacy and safety

- Credentials go to the configured Kicktipp base URL during login. Treat a
  custom `KICKTIPP_BASE_URL` as trusted.
  Autonomous Service reminders require an official Kicktipp HTTPS origin;
  custom origins are only supported by the interactive HTTP client and test fixtures.
- The localhost setup page keeps passwords out of prompts and terminal history.
- Passwords stored by the CLI use AES-256-GCM tied to the local hostname and
  operating-system user. Session-only mode stores a login cookie instead.
- Read-only mode blocks submissions in the MCP server, CLI, and core logic.
- Kicktipp hides other players' scores until the deadline. `tip-status` reports
  only whether their tips are complete, partial, or missing.

## Troubleshooting

- If `node` or `npm` is missing, install Node.js 24 LTS and reopen the terminal.
- If setup does not open, copy the printed `127.0.0.1` URL into a local browser.
- After `git pull`, run `npm run build` because clients execute `dist/server.js`.
- If parsing fails, retry with `--site de` or `--site com`, then capture the
  error with account details removed. GitHub Issues are currently disabled on this fork.

## Development

`npm test` builds first and runs against temporary home directories so tests
cannot reuse your saved account. CI covers Windows and Linux on Node 22, 24,
and 26, plus the Docker smoke test.

The Cheerio `encoding-sniffer` override replaces deprecated `whatwg-encoding`
with the maintained `@exodus/bytes` implementation. Remove the override once
Cheerio adopts it. `@types/node` follows the oldest supported runtime; the
explicit `domhandler` type dependency matches Cheerio's DOM version.

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
