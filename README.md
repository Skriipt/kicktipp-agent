# kicktipp-agent

A self-hosted Kicktipp service for your AI assistant, with automatic reminders through **Discord, Telegram and webhooks**. Start it with Docker Compose, connect your agent over MCP, and let the service check for missing tips even when no agent is connected.

[![CI](https://github.com/Skriipt/kicktipp-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Skriipt/kicktipp-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Quick start](#quick-start) · [Local website](#local-website) · [Notifications](#notifications) · [Connect your agent](#connect-your-agent) · [CLI](#cli) · [Operations](#operations)

The service supports [kicktipp.de](https://www.kicktipp.de/) and [kicktipp.com](https://www.kicktipp.com/). It reads the website over HTTP without browser automation. This is an unofficial client; website changes can require parser updates.

## Quick start

Install Docker with the Compose plugin, then run:

```bash
git clone https://github.com/Skriipt/kicktipp-agent.git
cd kicktipp-agent
docker compose up -d --build
docker compose exec kicktipp node dist/service/main.js web-token
```

Open **http://localhost:8787** and enter the web access token printed by the command. Add your Kicktipp account, check the login, choose your prediction pool and save. The website starts in English; use **EN / DE** to switch languages.

You can also use the terminal wizard: `docker compose run --rm kicktipp setup`, followed by `docker compose restart kicktipp`. The terminal wizard retains its existing reminder defaults. The website starts with no notification channels or prescribed reminder times.

Check the service:

```bash
docker compose ps
docker compose logs --tail=50 kicktipp
docker compose exec kicktipp node dist/service/main.js status
```

This fork is not published to npm. The unscoped npm package belongs to the upstream project; build this repository to use this version.

## What it does

- Reads matches, schedules, results, your tips, deadlines and other players' tip-completeness status.
- Retrieves rankings, season overviews, league tables and community scoring rules.
- Submits regular and bonus tips when write access is enabled, then verifies the saved values.
- Keeps Spielleiter tools for listing members and reading or submitting their tips, with the existing member confirmation safeguards.
- Provides season synchronization, statistics and odds-based suggestions (`safe`, `ev`, `contrarian`, `auto`). Suggestions do not submit anything themselves.
- Keeps a local cache and submission audit log, with CLI undo for the latest eligible submission.
- Sends missing-tip reminders independently of MCP clients and reports account/connectivity problems.

No language model is bundled. Your agent connects when needed; reminder checks do not require an LLM.

## Local website

The local website and MCP share port 8787. No additional container, database or hosted frontend is needed. Compose binds the port to this computer's loopback interface.

- **Overview:** upcoming matches, missing predictions, last successful check, next scheduled check and notification delivery problems. “Check again” reads Kicktipp; it does not submit predictions or send reminders.
- **Notifications:** add, edit, test or remove Discord, Telegram and webhook destinations. Choose your own reminder times, including fractions such as `2.5` hours (`2,5` also works in the form). Use up to ten values greater than zero and at most 168 hours; the times apply to every channel. No preset times are required. With no channels, reminders can stay unconfigured.
- **Account:** update credentials, check the login and choose a pool. One account and one pool are active per instance.
- **Connect agent:** view the MCP address, explicitly reveal its token and control whether the agent may submit or edit predictions. Read-only is the default.

**Save applies changes immediately.** Active Kicktipp operations finish before account settings change. A stale browser cannot overwrite a newer save: reload the configuration after a conflict. Configurations edited through the terminal still require a service restart.

The website uses a separate **administrator token**, stored at `/data/web-admin-token` with mode `0600`. An MCP token cannot administer the service. Retrieve the administrator token again with:

```bash
docker compose exec kicktipp node dist/service/main.js web-token
```

The browser keeps this token only in memory; reload or sign out to lock the page. Only the chosen interface language is remembered in browser storage. Saved account passwords and notification credentials are never returned to the form; leave their replacement fields empty to retain them. “Send test message” makes a real delivery attempt to the selected destination.

For a remote Docker host, use the [SSH tunnel](#agent-on-another-computer) and open localhost through it. An authenticated HTTPS reverse proxy can use an exact origin listed in `server.allowedOrigins`; preserve the Host header. Arbitrary Host values, cross-origin admin requests and embedding in another website are rejected.

## Notifications

All configured channels use the same reminder windows and check interval. You can enable several destinations at once. A reminder is sent only for a missing tip with a known, future kickoff. Existing tips and games that have started are skipped.

Use **Notifications** in the local website to edit channels and times without restarting. The terminal alternative is:

```bash
docker compose run --rm kicktipp setup --notifications
docker compose restart kicktipp
```

The wizard lets you retain existing channels or replace them. It can send a test before saving a new destination. To test all saved destinations without contacting Kicktipp:

```bash
docker compose run --rm kicktipp notify --test
```

### Discord

1. Open the Discord text channel's settings.
2. Choose **Integrations → Webhooks → New Webhook** and copy its URL. You need permission to manage webhooks in that server.
3. Choose **discord** in the wizard and paste the URL.
4. Accept the test message and check the channel.

The service formats the message for Discord automatically. It disables mentions, so a team or community name cannot trigger an `@everyone` ping. No Discord bot or custom message template is needed. Forum channels may require a webhook URL with the appropriate `thread_id` query parameter.

### Telegram

1. Open [@BotFather](https://t.me/BotFather), send `/newbot`, and follow the prompts.
2. Copy the bot token into the wizard's hidden token prompt.
3. Open your new bot and send `/start`.
4. Leave **Chat-ID** empty to discover your chat and select it from the list.
5. Accept the test message.

For a group, add the bot and send `/start@YourBotUsername` in that group before discovery. You can also enter a known chat ID directly. Existing bots that use a Telegram webhook or have another consumer reading their updates may need manual chat-ID entry; setup does not remove their webhook or consume updates. The bot needs permission to post in the destination.

### Generic webhook

Choose **webhook** and paste your receiver's HTTP(S) URL. It receives a JSON `POST`; the receiver must accept that format. The service does not follow redirects. A normal scheduled reminder looks like this:

```json
{
  "event": "missing_tips",
  "summary": "Kicktipp (my-pool): 1 Tipp fehlen. …",
  "community": "my-pool",
  "matchday": null,
  "timeZone": "Europe/Berlin",
  "checkedAt": "2026-10-28T12:00:00.000Z",
  "warnHours": 6,
  "matches": [
    {
      "home": "Home team",
      "away": "Away team",
      "kickoff": "2026-10-28T16:00:00.000Z",
      "bet": null,
      "needsBet": true,
      "closed": false,
      "urgent": true
    }
  ]
}
```

Test messages have `event: "test"` and `summary`. Operational alerts have `event: "service_error"`, a `code` (`auth_required` or `check_failed`) and `summary`. `matchday` can be `null` when checking the current matchday.

### Delivery behavior

Successful reminders are remembered separately for each match, kickoff, warning window and destination. Restarting normally does not resend them. A failed destination retries with backoff without repeating messages to destinations that succeeded. If the service first starts 30 minutes before kickoff, it sends the most urgent crossed window rather than all three reminders at once.

Login or check failures produce an operational alert, at most once per destination every six hours during the same outage. Check time is approximate: with a 15-minute interval, a reminder can arrive up to about 15 minutes after its configured threshold, plus network time. Changes made in the local website apply immediately; changes made through the terminal require a restart.

External delivery and a local checkpoint cannot be atomic. If a process crashes after a provider accepts a message but before the checkpoint is saved, a later retry can duplicate it. Missing-tip reminders are never permission to submit a tip automatically.

## Connect your agent

Use an MCP client that supports **Streamable HTTP** and a bearer-token header:

| Setting | Value |
| --- | --- |
| MCP URL | `http://127.0.0.1:8787/mcp` |
| Transport | Streamable HTTP |
| Header name | `Authorization` |
| Header value | `Bearer YOUR_ACCESS_TOKEN` |

The wizard prints the token. To display it again on your own terminal:

```bash
docker compose run --rm kicktipp connection
```

Keep it in your client's secret configuration. Do not put Kicktipp credentials or the access token into agent prompts. Ask your agent to call `get_status` first, then try “Which upcoming games still need a tip?”

The Compose service uses one active account and community. Change them or enable submission in the local website. The terminal alternative is to rerun setup and restart:

```bash
docker compose run --rm kicktipp setup
docker compose restart kicktipp
```

Read-only mode hides submission tools and enforces the restriction in the shared core. Notification settings and account setup remain local administrator operations; remote MCP calls cannot replace your channel credentials.

### Agent on another computer

Compose publishes port 8787 on the server's loopback interface only. From the computer running your agent, an SSH tunnel can make that endpoint available locally:

```bash
ssh -N -L 8787:127.0.0.1:8787 your-server
```

Keep the tunnel open and use the same localhost URL and token. Alternatively, put an authenticated HTTPS reverse proxy in front of the loopback endpoint, preserving the `Authorization` header. Browser-based clients also need their exact origin added to `server.allowedOrigins` in the service configuration; the default allows no browser origins. Forwarding the port alone does not add HTTPS.

### Optional stdio clients

For a client that can only launch an MCP subprocess, run this command from the repository directory:

```bash
docker compose run --rm -T kicktipp mcp-stdio
```

This launches a separate stdio process; it does not connect to the running HTTP service. Use one Kicktipp process at a time for that data volume. HTTP MCP is the intended way to share the daemon and its reminder scheduler. Webhook notification URLs are outbound destinations and are unrelated to the MCP endpoint.

## CLI

The scriptable CLI remains available inside the image:

```bash
docker compose run --rm kicktipp --help
docker compose run --rm kicktipp today
docker compose run --rm kicktipp bets --json
docker compose run --rm kicktipp leaderboard
docker compose run --rm kicktipp suggest --strategy ev
docker compose run --rm kicktipp admin members
docker compose run --rm kicktipp log
```

Use HTTP MCP while the daemon is running. For standalone Kicktipp CLI work, stop the daemon first and start it afterward, so separate processes cannot race on the same account and files. `notify --test` only tests external destinations and needs no Kicktipp session.

| Area | Commands |
| --- | --- |
| Matches and tips | `today`, `schedule`, `bets`, `bet`, `tip-status`, `deadline` |
| Rankings and rules | `leaderboard`, `overview`, `table`, `rules` |
| Data and suggestions | `sync`, `stats`, `suggest`, `cache` |
| History and administration | `log`, `admin members`, `admin bets`, `admin bet` |
| Setup and help | `setup`, `notify`, `guide`, plus standalone account/profile commands |

`bet` now requires explicit arguments such as `"Home vs Away=2:1"`; there is no terminal grid. Bonus tips use `bet --bonus "Question=Answer"`. Write access must be enabled first. `suggest` previews a slip; `--place` submits it, and `--replace` permits replacing existing tips.

`log --undo` restores replaced tips from the latest successful regular submission by the signed-in account. It does not undo bonus tips, Spielleiter submissions, newly added tips without a previous value, or games whose deadline has passed.

## Operations

### Health and status

- `GET /health` is an unauthenticated liveness check used by Docker. It says that the HTTP process is responding, not that Kicktipp login or notification delivery succeeded.
- `GET /status`, with the same bearer token as MCP, reports the last check, last successful Kicktipp read, next check, failed channels and error category. MCP `get_status` includes this service status too.
- `docker compose logs kicktipp` shows startup and process errors. Channel secrets and provider response bodies are excluded from notification errors.

`auth_required` means the Kicktipp login needs attention; check the Account page or rerun setup. `delivery_failed` means one or more channels need attention or are waiting for retry. `check_failed` can mean connectivity or changed Kicktipp markup. `state_failed` means the reminder history could not be written. Fix the underlying problem before deleting history, since deleting it permits reminders to be sent again.

### Persistent data and backups

Compose creates a named `kicktipp-data` volume mounted at `/data`. It contains:

- `/data/service.json`: account, MCP and notification settings, including secrets in **plain text**, restricted to the file owner (`0600`). This is not encrypted storage.
- `/data/web-admin-token`: the separate local administrator credential (`0600`).
- Account-scoped session cookies, local cache, audit records and reminder-delivery history under `/data/accounts/`.

Keep the entire volume private and include it in encrypted backups. Stop the service while taking a consistent backup. Never commit its contents or copy them into your image. Normal `docker compose down` preserves the volume; `docker compose down -v` deletes it.

Use one service instance per volume and account. Multiple replicas sharing the same volume are not supported. For a separate account, use a separate Compose project and host port:

```bash
docker compose -p kicktipp-second run --rm kicktipp setup
KICKTIPP_PORT=8788 docker compose -p kicktipp-second up -d
```

Use port 8788 in that instance's client URL. Keep the same project name and port setting for subsequent commands.

### Updating

```bash
git pull
docker compose build
docker compose up -d
```

Your configuration and delivery history remain in the volume. Shutdown allows in-flight work to finish; avoid force-killing a process while it is submitting a tip.

### Submission guarantees

Match, bonus and Spielleiter submissions are marked `submitted` only after a fresh read confirms every requested value. A confirmed refusal or unchanged values after a completed request can be `rejected`; lost responses, partial saves or unreadable forms produce `submission_unknown`.

After `submission_unknown`, read the saved tips before trying again. The client does not automatically repeat a bet POST, including after a 307/308 redirect. Other players' predictions remain hidden until Kicktipp reveals them; tip-completeness checks do not expose their scores.

## Migrating from the desktop version

Use the new local website or terminal setup once to configure the Compose volume. TUI and interactive prediction screens, desktop/command notifications, systemd/cron/ICS generation, the old desktop web setup, Claude Desktop `.mcpb` packaging, and `rival`/`scenario`/`whatif` have been removed. Existing Kicktipp reads, submissions, Spielleiter functions, statistics and suggestions remain.

Standalone CLI profiles still use the INI configuration. Newly saved encrypted CLI passwords use a random `credentials.key` stored alongside it; back up both files. Older machine-bound passwords migrate on a successful read on their original machine. If moved before migration, reconnect on the new machine. The Compose service uses its separate portable `service.json` file instead.

Legacy cache, session and audit files without verified account ownership remain untouched and are not automatically used for the new account scope. Reconnect and run `sync` to populate fresh history. Season synchronization checks the opening fixtures before reusing finished history; a changed opening round archives the old cache, while a failed check preserves it.

## Development

For local development, use a supported Node.js version (the container uses Node.js 24):

```bash
npm ci
npm run build
npm test
npm run test:container  # requires Docker; builds and checks an isolated fixture stack
npm start
# In another terminal, retrieve the local website token:
node dist/service/main.js web-token
```

Build before testing: the MCP integration tests execute the compiled server. Tests use fixtures and local HTTP endpoints; they do not prove that your real Kicktipp account, Discord webhook or Telegram bot is configured correctly. The website and setup wizard provide explicit test-message actions for your own notification destinations.

See [CHANGELOG.md](CHANGELOG.md) and [the architecture notes](docs/CLAUDE.md).

## Credits and license

This project is a fork of Christian Heidorn's [kicktipp-agent](https://github.com/christianheidorn/kicktipp-agent), which began as a fork of [schwalle/kicktipp-betbot](https://github.com/schwalle/kicktipp-betbot). Licensed under [MIT](LICENSE).
