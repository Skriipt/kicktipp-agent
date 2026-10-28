# Architecture and development notes

`kicktipp-agent` is a TypeScript service, CLI and MCP adapter for Kicktipp. It fetches and parses the site's HTML using `fetch` and Cheerio; it does not launch a browser or contain an LLM. User setup and operations are documented in [README.md](../README.md).

Repository instructions are in [AGENTS.md](../AGENTS.md) and `docs/agents/`.

## Entry points

| File | Responsibility |
| --- | --- |
| `src/service/main.ts` | Container entry point: `serve`, `setup`, `web-token`, `connection`, `mcp-stdio`, or a CLI command. Starts the profile-aware runtime and per-profile schedulers. |
| `src/setup-cli.ts` | Terminal wizard: profile selection/creation, hidden secret prompts, account validation, community selection, channel setup, optional test sends and Telegram chat discovery. |
| `src/index.ts` | Commander CLI, including matches, tips, statistics, suggestions, history and Spielleiter commands. |
| `src/server.ts` | MCP server factory and optional stdio entry point. Registers tools/resources over the shared core. |
| `src/core.ts` | Kicktipp parsing and business operations. Functions receive a `Page` and community and return structured results. |

`Dockerfile` builds a non-root Node image. `compose.yaml` starts one service with a persistent named volume, loopback host-port binding, read-only root filesystem and a liveness health check. The default command is `serve`.

## Service configuration and identity

`src/service/settings.ts` validates and atomically saves `ServiceConfig`. Its default location is the platform data directory's `service.json`; the container sets `KICKTIPP_SERVICE_CONFIG=/data/service.json`.

The version 2 file contains:

- `server`: shared bearer token, listen host/port and exact allowed browser origins.
- `profiles`: an array with no artificial count limit. Each profile has a stable `id`, a human-readable `name`, `account` (email, password, default `community`, optional tracked `communities`, optional player and `de`/`com` site), `readOnly`, `notifications` (destinations, warning windows and polling interval), and an IANA `timeZone`.

IDs and case-insensitive names must be unique. Within each profile, an optional `account.communities` list contains 1–50 unique pools including the default; omitting it follows only the default pool. Empty profile arrays are valid so removing the last profile returns the UI to setup while retaining the shared MCP token. `validateServiceConfig` accepts a legacy version 1 file and converts it to one `default` profile without losing settings. Reads do not rewrite the file; the next atomic save persists version 2.

The service file stores secrets in plain text with mode `0600`; do not describe it as encrypted. Each profile's config/data paths also include the site/account identity hash. The `default` profile preserves the pre-migration account path; other profiles use `profiles/<id>/accounts/<identity>/`. Renaming preserves IDs and history. Removing a profile deletes its configuration, not historical files. HTTP MCP does not expose profile or subscription administration. MCP/CLI retain the selected profile's default community. Admin saves verify newly added pools against fresh membership for that profile's account. Switching account identity clears inherited subscriptions and player selection.

`src/config.ts` retains standalone INI profiles and session handling. New encrypted passwords use AES-256-GCM with a random persisted `credentials.key`. Legacy machine-derived passwords can be read and migrated on their original machine. Both the key and INI file must be included in CLI backups. Service credentials are read from the service configuration instead.

## HTTP MCP and concurrency

`src/service/http.ts` hosts:

- `/mcp`: authenticated Streamable HTTP MCP; protocol transport/compatibility handled by the MCP SDK.
- `/status`: authenticated operational status.
- `/health`: unauthenticated HTTP-process liveness only.
- `/`, `/app.js`, `/app.css`: self-hosted web UI.
- `/api/admin/*`: separate administrator bearer token, same-origin only; never accessible with MCP credentials.

Bearer comparison is timing-safe. Requests with an unapproved `Origin` are rejected. Request bodies are bounded. Neither status nor error responses may expose account passwords, access tokens, webhook URLs or Telegram bot tokens. Only the explicitly requested admin connection route returns the MCP token.

`src/service/queue.ts` supplies the shared serial queue. All daemon MCP tool/resource work and scheduler Kicktipp reads use it because the core still reads mutable process settings. `src/service/profiles.ts` resolves the requested profile and binds its credentials, state paths, read-only permission, timezone and site for the complete queued operation, including retries and submission read-back. Never switch the profile outside that boundary or create an independent queue per HTTP request.

An HTTP operation queue also gates entire MCP/admin requests during live configuration changes. Stop all schedulers before entering the shared Kicktipp queue so pending reads can drain. Config save constructs replacement scheduler state before atomic persistence, then starts the new schedulers. Account-check sessions use an isolated in-memory cookie jar and restore the global base URL. This is process-local coordination, not a distributed lock: use one service process per volume, with as many profiles as needed.

The shared MCP token grants access to all configured profiles. `get_profiles` exposes IDs, names, communities and permissions without secrets. Every profile-specific tool accepts `profile`; omission resolves only when exactly one profile exists. `get_status` may omit selection for a service overview. MCP instructions require discovery, explicit selection when multiple profiles exist, and the same profile throughout reads, suggestions and submissions. No call changes another client's implicit selection. Profile-specific cache resources use `kicktipp://profiles/{profile}/{community}/...`; legacy resource URIs work only when selection is unambiguous.

On shutdown, stop accepting requests and future scheduler runs, allow in-flight operations to finish, then close transports and sessions. A client disconnect must never be treated as proof that a tip submission did not happen.

## Notifications and scheduler

`src/notify/backends.ts` exports:

- `NotificationChannel`: a generic webhook, Discord webhook, or Telegram bot/chat pair.
- `validateChannel`: returns a validated channel without printing submitted secrets in errors.
- `sendNotification`: one bounded HTTP attempt with no automatic redirects.

Generic webhooks receive the structured JSON payload. Discord receives `content`, with mentions disabled and `wait=true`. Telegram uses `sendMessage` with plain text and disabled link previews. Provider failures are sanitized; retry information is carried by `NotificationError`.

`src/service/scheduler.ts` owns `DeadlineScheduler`. The service creates one scheduler and separate delivery history for each profile. Its injected `fetchReport` accepts a report or report array and is bound to that profile within the shared queue. It reads every tracked pool in that profile's account session, publishes reports together, and marks pool failures with `readError`. The scheduler starts immediately, then schedules the next run after the current one finishes; overlapping scheduler checks reuse the in-flight promise. Failed pools do not suppress reminders for healthy pools.

For each untipped future fixture, the scheduler chooses the most urgent crossed warning window. Per-destination hashes include community, fixture, kickoff and window. Successful sends are checkpointed independently; failed destinations retry with backoff while healthy destinations remain deduplicated. State contains hashes and timestamps, not channel credentials. Expired records are pruned.

Authentication/check failures send operational alerts with a persisted six-hour cooldown. Corrupt state fails startup; unwritable state prevents delivery and appears as `state_failed`. A crash between external acceptance and local checkpoint can duplicate a notification: there is no cross-system exactly-once transaction.

Scheduled `missing_tips` payloads contain `summary`, community, matchday, timezone, check time, warning window and matches. `service_error` payloads contain a sanitized code and summary. `test` payloads are sent only when explicitly requested in the web UI, during setup or via `notify --test`. Web manual refresh only reads matches and does not run notification delivery.

`src/bonus-reminders.ts` reads editable bonus answer slots and joins uniquely matching question titles to the bonus schedule's `table#fragen` / `th[name="tipptermin"]` column. Form array indices are not assumed to be schedule question IDs. Duplicate titles, missing dates and invalid dates retain `deadline: null`. `missing_bonus` notifications use a separate identity namespace and include the question, explicit deadline and missing-answer count. Unknown deadlines are exposed as `unresolvedBonusQuestions`; bonus read failures use `bonusCheckFailed` and leave known match reminders available. A complete successful check is required before a profile's `lastSuccess` advances.

## Kicktipp HTTP and parsing

- `src/browser.ts`: account login, session restoration, community and player discovery. Despite its name, it manages HTTP pages, not a browser.
- `src/http/page.ts`: navigation, form editing/submission, cookies, redirect behavior and response decoding.
- `src/http/cookie-jar.ts`: scoped session cookies with atomic persistence.
- `src/url.ts`: German/English page routes and site selection.
- `src/helpers/parse-bet-arg.ts`: fixture and score arguments.

`loadPage()` in the core classifies authentication, missing pages and missing Spielleiter permissions. Parsing generally reads `#kicktipp-content` tables and forms. Important selectors include:

| Data | Selector |
| --- | --- |
| Bet score fields | `input[id$='_heimTipp']`, `input[id$='_gastTipp']` |
| Non-editable bet cells | `td.nichttippbar` |
| Rankings | `table#ranking` |
| Schedule | `table#spiele` |
| Bonus questions | `table#tippabgabeFragen` |
| Submit button | `button[name="submitbutton"]` |

Read-only session refresh may retry a read after re-authentication. Submission retries require separate reasoning: never automatically repeat a POST after a lost response or 307/308 redirect.

## Cache, scoring and retained features

- `src/cache/`: versioned JSON snapshots, offline reads and season synchronization. Historical cache data is rebuildable; audit and notification history are separate durable records.
- `src/rules/`: scoring-rule parsing, resolution, scoring and verification. Unsupported/incomplete schemes must not be silently treated as supported scoring rules.
- `src/analytics/deadline.ts`: missing-tip and kickoff report.
- `src/analytics/season.ts`, `season-stats.ts`: cached season assembly and statistics.
- `src/analytics/odds.ts`, `score-map.ts`, `strategies.ts`: odds-based suggestions. A suggestion is not a submission.
- `src/audit/log.ts`: submission audit records and eligible previous values for CLI undo.
- `src/commands/admin.ts`: Spielleiter member listing, reads and submissions.

TUI, legacy desktop web setup, desktop/command notification delivery, scheduler artifact generation, MCPB packaging and rival/scenario/what-if analyses have been removed. Do not reintroduce callers to deleted modules.

## Submission boundaries

1. `src/read-only.ts` enforces write restrictions in the shared core as well as at the entry points. MCP hides submission tools if all profiles are read-only. With mixed permissions, the selected profile's read-only setting is still enforced by the shared core.
2. `src/submission.ts` confirms requested values through a fresh read. Preserve `submitted`, `rejected` and `submission_unknown` semantics; a missing confirmation is not success.
3. `src/audit/log.ts` records submission outcomes inside the shared submission lifecycle, so new callers cannot bypass it accidentally.
4. Spielleiter submissions carry the resolved member's `tipperId`; MCP additionally confirms the intended member. Losing that identity must not fall back to the signed-in user's form.
5. Undo only restores replaced regular tips from the latest successful own-account submission. It excludes bonus and other-member submissions.

Never use live tip submission as an installation smoke test. Use fixtures and `dry_run` where supported. Notification tests are external sends too; production destinations require the user's configured intent.

## Development and proof

```bash
npm ci
npm run build
npm test
```

Build before running integration tests that execute `dist/server.js` or the compiled service. Tests cover core parsers/submissions, MCP over stdio/HTTP, configuration/setup and notification scheduling. Use injected providers and local fixture endpoints for repeatable tests; those results do not establish live account or provider acceptance.

When checking the daemon, test authenticated tool calls, rejected unauthenticated calls, per-profile read-only behavior, overlapping calls across two profiles, rejected ambiguous selections, graceful shutdown, persisted reminder state and failed-provider isolation. Verify the actual Compose startup path when changing image, entry-point or volume behavior.

CLI JSON output remains machine-readable. MCP tools return both text and `structuredContent` under `{ data: ... }`. Avoid credentials in logs, fixtures, screenshots, tests or PR descriptions.

## Local administrator UI

`src/web/` contains vanilla HTML/CSS/JavaScript. The build copies these assets to `dist/web/`; no runtime CDN, bundler or additional server is needed. English is the initial language, with a persisted EN/DE preference; credentials are never put in localStorage, URLs or application logs.

`src/service/admin.ts` validates all admin inputs, redacts snapshots and applies one HMAC revision across the whole configuration to prevent stale overwrites, including edits to different profiles. The UI selects a profile for settings and overview requests; profile creation and removal use dedicated admin routes. Empty password/channel secrets preserve existing values only within the selected profile and for the same identity or destination ID/kind. `web-http.ts` bounds JSON bodies, enforces Host/Origin and CSP, and authenticates the independent `web-admin-token`. Fresh containers can serve the locked UI before `service.json` exists. The token is obtained through the local `web-token` command, not through an unauthenticated HTTP endpoint.

Operational status exposes a `profiles` list with a separate `read` for each profile's latest scheduled or manual Kicktipp read and `scheduler` for its notification runs. Selected-profile responses, and the single-profile compatibility view, also expose these fields at the top level. The UI uses `read` for login, timestamps and report freshness; a successful manual refresh clears an earlier read failure without hiding unresolved notification delivery failures.

The selected profile's overview includes `reports` for every tracked pool and retains `report` for its default pool (null if that read failed). Each profile's status includes `communities` and `groupErrors`. Per-pool `readError` must render as a failure, never an empty successful round. Membership discovery responses are invalidated on profile/account edits or logout; the Add action persists that profile's subscriptions immediately through revision-checked admin saves.

Custom reminders permit 1–10 positive fractional hours up to 168. An empty list is allowed only when no destinations are configured. Saving in the web UI applies configuration without a container restart. Settings changed externally still require a restart. Browser API tests and process/container fixtures must never contact real Kicktipp accounts or real notification destinations.
