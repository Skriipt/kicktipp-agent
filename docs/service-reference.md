# Service reference

Start with the [Quick Start](../README.md#quick-start). This page covers the details you may need later. Run Compose commands from the repository directory.

## Local website

The local website and MCP share port 8787. No additional container, database or hosted frontend is needed. Compose binds the port to this computer's loopback interface.

- **Overview:** upcoming matches and incomplete bonus questions for every added pool in the selected profile, last successful check, next scheduled check and notification delivery problems. “Check again” reads Kicktipp; it does not submit predictions or send reminders.
- **Notifications:** add, edit, test or remove Discord, Telegram and webhook destinations. Choose your own reminder times, including fractions such as `2.5` hours (`2,5` also works in the form). Use up to ten values greater than zero and at most 168 hours; the times apply to every channel. No preset times are required. With no channels, reminders can stay unconfigured.
- **Account:** name the selected profile and sign in to discover its existing Kicktipp pools. Click **Add** beside each pool you want to follow; overview and reminders include it immediately. The list also loads automatically when you unlock a configured profile. You can remove pools and choose the default pool for the agent; at least one pool must remain per profile. Adding a pool here does not join it on Kicktipp.
- **Connect agent:** view the MCP address, explicitly reveal its token and control whether the agent may submit or edit predictions for the selected profile. Read-only is the default.

**Save applies changes immediately.** Active Kicktipp operations finish before account settings change. A stale browser cannot overwrite a newer save: reload the configuration after a conflict. Configurations edited through the terminal still require a service restart.

The website uses a separate **administrator token**, stored at `/data/web-admin-token` with mode `0600`. An MCP token cannot administer the service. Retrieve the administrator token again with:

```bash
docker compose exec kicktipp node dist/service/main.js web-token
```

The browser keeps this token only in memory; reload or sign out to lock the page. Only the chosen interface language is remembered in browser storage. Saved account passwords and notification credentials are never returned to the form; leave their replacement fields empty to retain them. “Send test message” makes a real delivery attempt to the selected destination.

For a remote Docker host, use the [SSH tunnel](../README.md#connect-your-agent) and open localhost through it. An authenticated HTTPS reverse proxy can use an exact origin listed in `server.allowedOrigins`; preserve the Host header. Arbitrary Host values, cross-origin admin requests and embedding in another website are rejected.

## Profiles

The profile selector applies to **Overview**, **Account**, **Notifications** and the write permission in **Connect agent**. Add a profile with a name, its Kicktipp login and an initial prediction pool, then save. Each profile can follow several pools and has one default pool for agent calls. There is no fixed profile-count limit. Two profiles can also use the same Kicktipp account with different pools.

Each profile has separate sessions, cache, submission history, reminder destinations, reminder times, timezone and write permission. All configured profiles keep running while you view another one. Renaming a profile keeps its stable ID and history. Removing it stops its reminders and removes its configuration; stored history is retained on disk.

One MCP connection can access every configured profile. The web profile selector only controls the page you are viewing; it never silently changes which profile an agent call uses. See [profile selection for agents](#profile-selection-for-agents).

## Generic webhook payloads

In **Notifications**, add a **Webhook** destination and paste your receiver's HTTP(S) URL. It receives a JSON `POST`; the receiver must accept that format. The service does not follow redirects. A normal scheduled reminder looks like this:

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

Scheduled reminders and operational alerts include `profile: { "id": "...", "name": "..." }` and prefix the summary with the profile name, so messages from the same prediction pool remain distinguishable. Bonus reminders have `event: "missing_bonus"` and the same community, timezone, check time and warning-window fields. Their `bonusQuestions` array contains `id`, `question`, `deadline` (ISO timestamp), `missingAnswers` and `editable`; `summary` describes the deadline and missing answers. Each profile and pool has separate reminder history. Test messages have `event: "test"` and `summary`. Operational alerts have `event: "service_error"`, a `code` (`auth_required` or `check_failed`) and `summary`. `matchday` can be `null` when checking the current matchday.

## Reminder delivery

Successful reminders are remembered separately for each profile, match, kickoff, warning window and destination. Restarting normally does not resend them. A failed destination retries with backoff without repeating messages to destinations that succeeded. If the service first starts 30 minutes before kickoff, it sends the most urgent crossed window rather than all three reminders at once.

Login or check failures produce an operational alert, at most once per destination every six hours during the same outage. Check time is approximate: with a 15-minute interval, a reminder can arrive up to about 15 minutes after its configured threshold, plus network time. Changes made in the local website apply immediately; changes made through the terminal require a restart. Scheduled reminder summaries currently use German.

External delivery and a local checkpoint cannot be atomic. If a process crashes after a provider accepts a message but before the checkpoint is saved, a later retry can duplicate it. Missing-tip reminders are never permission to submit a tip automatically.

## Profile selection for agents

The server supplies these rules in its MCP instructions and tool schemas:

1. Call `get_profiles` to discover profile IDs, names, prediction pools and `read_only` permissions. `get_status` without a profile also provides a service overview.
2. Pass the selected ID in the `profile` argument on every profile-specific tool call. With exactly one profile, this argument can be omitted for compatibility. With several profiles, an omitted or unknown profile is rejected.
3. Keep the same profile for reading fixtures, generating suggestions and submitting tips. There is no persistent “active profile” shared between agent calls. Ask the user when their intended profile is unclear; for all profiles, make a separate call for each and label the results.

For example, after discovering an ID, call `get_bets` with:

```json
{ "profile": "profile-0123456789abcdef", "matchday": 5 }
```

Use an ID actually returned by `get_profiles`; profile names can change. Credentials and notification destinations are excluded from profile discovery.

Write permission is enforced separately for each profile. If every profile is read-only, submission tools are hidden. If some profiles permit writes, those tools are available but reject submissions for read-only profiles. Profile and notification setup remain local administrator operations; MCP calls cannot change credentials or profile permissions.

## Optional stdio clients

For a client that can only launch an MCP subprocess, run this command from the repository directory:

```bash
docker compose run --rm -T kicktipp mcp-stdio
```

This launches a separate stdio process; it does not connect to the running HTTP service. Use one Kicktipp process at a time for that data volume. HTTP MCP is the intended way to share the daemon and its reminder scheduler. Webhook notification URLs are outbound destinations and are unrelated to the MCP endpoint.

## CLI

The scriptable CLI remains available inside the image. Stop the daemon before commands that access Kicktipp; start it again afterward. Do not run a standalone client against a volume the daemon is using:

```bash
docker compose stop kicktipp
# Run the commands below.
# When finished: docker compose up -d
```

```bash
docker compose run --rm kicktipp --help
docker compose run --rm kicktipp today
docker compose run --rm kicktipp bets --json
docker compose run --rm kicktipp leaderboard
docker compose run --rm kicktipp suggest --strategy ev
docker compose run --rm kicktipp admin members
docker compose run --rm kicktipp log
```

List profile IDs with `docker compose run --rm kicktipp profiles`. With multiple profiles, add `--profile PROFILE_ID` before a CLI command, for example `docker compose run --rm kicktipp --profile PROFILE_ID bets --json`. Single-profile commands continue to work without this flag.

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
- `GET /status`, with the same bearer token as MCP, reports each profile's last check, last successful Kicktipp read, next check, failed channels and error category. With one profile these fields also remain available at the top level. MCP `get_status` includes this service status too.
- `docker compose logs kicktipp` shows startup and process errors. Channel secrets and provider response bodies are excluded from notification errors.

`auth_required` means the Kicktipp login needs attention; check the Account page or rerun setup. `delivery_failed` means one or more channels need attention or are waiting for retry. `check_failed` can mean connectivity or changed Kicktipp markup. `state_failed` means the reminder history could not be written. Fix the underlying problem before deleting history, since deleting it permits reminders to be sent again.

### Persistent data and backups

Compose creates a named `kicktipp-data` volume mounted at `/data`. It contains:

- `/data/service.json`: all profiles and shared MCP settings, including secrets in **plain text**, restricted to the file owner (`0600`). This is not encrypted storage.
- `/data/web-admin-token`: the separate local administrator credential (`0600`).
- Profile/account-scoped session cookies, local cache, audit records and reminder-delivery history under `/data/profiles/`. The migrated `default` profile retains its existing `/data/accounts/` location.

Keep the entire volume private and include it in encrypted backups. Stop the service while taking a consistent backup. Never commit its contents or copy them into your image. Normal `docker compose down` preserves the volume; `docker compose down -v` deletes it.

Use one service process per volume. That process can run multiple profiles; separate containers and ports are not needed for additional accounts. Multiple replicas sharing the same volume remain unsupported.

### Migrating an existing service

A version 1 `service.json` is automatically read as a version 2 configuration containing a profile with ID `default` and name **Default**. Its account, default and tracked pools, write permission, notification settings, MCP token, sessions and history are preserved. No manual JSON conversion is needed. The next settings save writes version 2; reading an old file alone does not rewrite it.

Existing agent calls without `profile` keep working while there is one profile. After adding a second profile, have the agent call `get_profiles` and pass an explicit ID for profile-specific operations. The MCP address and token stay the same.

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

See [CHANGELOG.md](../CHANGELOG.md) and [the architecture notes](CLAUDE.md).
