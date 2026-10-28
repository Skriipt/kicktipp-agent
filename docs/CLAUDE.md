# Architecture and development notes

`kicktipp-agent` is a TypeScript service, CLI and MCP adapter for Kicktipp. It fetches and parses the site's HTML using `fetch` and Cheerio; it does not launch a browser or contain an LLM. User setup and operations are documented in [README.md](../README.md).

Repository instructions are in [AGENTS.md](../AGENTS.md) and `docs/agents/`.

## Entry points

| File | Responsibility |
| --- | --- |
| `src/service/main.ts` | Container entry point: `serve`, `setup`, `connection`, `mcp-stdio`, or a CLI command. Applies service configuration before loading the runtime. |
| `src/setup-cli.ts` | Terminal wizard: hidden secret prompts, account validation, community selection, channel setup, optional test sends and Telegram chat discovery. |
| `src/index.ts` | Commander CLI, including matches, tips, statistics, suggestions, history and Spielleiter commands. |
| `src/server.ts` | MCP server factory and optional stdio entry point. Registers tools/resources over the shared core. |
| `src/core.ts` | Kicktipp parsing and business operations. Functions receive a `Page` and community and return structured results. |

`Dockerfile` builds a non-root Node image. `compose.yaml` starts one service with a persistent named volume, loopback host-port binding, read-only root filesystem and a liveness health check. The default command is `serve`.

## Service configuration and identity

`src/service/settings.ts` validates and atomically saves `ServiceConfig`. Its default location is the platform data directory's `service.json`; the container sets `KICKTIPP_SERVICE_CONFIG=/data/service.json`.

The file contains:

- `account`: email, password, community, optional player, and `de`/`com` site.
- `server`: bearer token, listen host/port, read-only mode and exact allowed browser origins.
- `notifications`: channel destinations, warning windows and polling interval.
- `timeZone`: an IANA display timezone.

The service file stores secrets in plain text with mode `0600`; do not describe it as encrypted. Account-specific config and data directories are selected from a hash of site and account identity. Runtime environment variables connect this configuration to the existing core. A service instance has a fixed account/community; HTTP MCP does not expose tools to change those settings.

`src/config.ts` retains standalone INI profiles and session handling. New encrypted passwords use AES-256-GCM with a random persisted `credentials.key`. Legacy machine-derived passwords can be read and migrated on their original machine. Both the key and INI file must be included in CLI backups. Service credentials are read from the service configuration instead.

## HTTP MCP and concurrency

`src/service/http.ts` hosts:

- `/mcp`: authenticated Streamable HTTP MCP; protocol transport/compatibility handled by the MCP SDK.
- `/status`: authenticated operational status.
- `/health`: unauthenticated HTTP-process liveness only.

Bearer comparison is timing-safe. Requests with an unapproved `Origin` are rejected. Request bodies are bounded. Neither status nor error responses may expose account passwords, access tokens, webhook URLs or Telegram bot tokens.

`src/service/queue.ts` supplies the shared serial queue. All daemon MCP tool/resource work and scheduler Kicktipp reads use it because the page abstraction and stored session state are mutable. Do not create a new independent queue per HTTP request. This is process-local coordination, not a distributed lock: multiple service replicas or independent stdio/CLI processes must not share an active account/data volume.

On shutdown, stop accepting requests and future scheduler runs, allow in-flight operations to finish, then close transports and sessions. A client disconnect must never be treated as proof that a tip submission did not happen.

## Notifications and scheduler

`src/notify/backends.ts` exports:

- `NotificationChannel`: a generic webhook, Discord webhook, or Telegram bot/chat pair.
- `validateChannel`: returns a validated channel without printing submitted secrets in errors.
- `sendNotification`: one bounded HTTP attempt with no automatic redirects.

Generic webhooks receive the structured JSON payload. Discord receives `content`, with mentions disabled and `wait=true`. Telegram uses `sendMessage` with plain text and disabled link previews. Provider failures are sanitized; retry information is carried by `NotificationError`.

`src/service/scheduler.ts` owns `DeadlineScheduler`. Its injected `fetchReport` is queued by the service entry point. It starts immediately, then schedules the next run after the current one finishes; overlapping manual checks reuse the in-flight promise.

For each untipped future fixture, the scheduler chooses the most urgent crossed warning window. Per-destination hashes include community, fixture, kickoff and window. Successful sends are checkpointed independently; failed destinations retry with backoff while healthy destinations remain deduplicated. State contains hashes and timestamps, not channel credentials. Expired records are pruned.

Authentication/check failures send operational alerts with a persisted six-hour cooldown. Corrupt state fails startup; unwritable state prevents delivery and appears as `state_failed`. A crash between external acceptance and local checkpoint can duplicate a notification: there is no cross-system exactly-once transaction.

Scheduled `missing_tips` payloads contain `summary`, community, matchday, timezone, check time, warning window and matches. `service_error` payloads contain a sanitized code and summary. `test` payloads are sent only when explicitly requested during setup or via `notify --test`.

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

TUI, localhost web setup, desktop/command notification delivery, scheduler artifact generation, MCPB packaging and rival/scenario/what-if analyses have been removed. Do not reintroduce callers to deleted modules.

## Submission boundaries

1. `src/read-only.ts` enforces write restrictions in the shared core as well as at the entry points. Read-only MCP clients do not see submission tools.
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

When checking the daemon, test authenticated tool calls, rejected unauthenticated calls, read-only behavior, graceful shutdown, persisted reminder state and failed-provider isolation. Verify the actual Compose startup path when changing image, entry-point or volume behavior.

CLI JSON output remains machine-readable. MCP tools return both text and `structuredContent` under `{ data: ... }`. Avoid credentials in logs, fixtures, screenshots, tests or PR descriptions.
