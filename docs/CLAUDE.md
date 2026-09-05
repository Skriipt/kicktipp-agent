# Working on kicktipp-agent

Read `AGENTS.md` for the issue-tracker and domain-documentation conventions.
Use `README.md` for setup and supported Node versions, `package.json` for build
commands, and `kicktipp --help` for the command inventory. `npm test` builds
before running the suite; subprocess tests execute `dist/`.

## Where changes belong

- `src/index.ts` and `src/commands/` expose CLI operations.
- `src/server.ts` exposes MCP tools and cached resources over stdio.
- `src/core.ts` owns shared reads and submissions. Route every bet through it.
- `src/browser.ts` handles authentication; `src/http/` handles cookies, redirects,
  encoding, form serialization, and session persistence.
- `src/client.ts` pins autonomous reads to a named profile and community.
- `src/service/` owns durable reminder scheduling, delivery state, and providers.
- `src/tui/` renders the terminal UI; `src/analytics/` computes from cached data.

## Contracts that must survive edits

### Authentication and storage

Profiles represent separate accounts. Session files and session locks are per
profile. Every `config.ini` read-modify-write takes the shared config mutation
lock, including writes to different profiles, because they share one file.
A competing writer fails before changing the config; retry after it finishes.
Config and Data paths may be separate, with Config mounted read-only. Session
cookies and auth locks belong in writable Data. See
`service-lock-ownership.md` before changing locking or crash recovery.

A named profile never inherits the default account's password. Keep the
session-only flow: when cookies expire, request reconnection rather than
silently authenticating another account. Logout preserves other profiles.
Stored-password encryption is machine/user-bound obfuscation, not a secret
independent of the host. Prefer session-only deployment as described in README.

### HTTP and parsing

Kicktipp has no public API. Read HTML through `Page`; `loadPage()` in `core.ts`
classifies auth redirects, missing pages, and Spielleiter access failures.
Forms must retain hidden fields and the actual submitter. Follow redirects
without leaking form fields, cookies, or private referrer paths to other hosts.
A custom `KICKTIPP_BASE_URL` is trusted for login. Autonomous reminders require
an official HTTPS origin because their clocks and action links are site-specific.

HTML timestamps are printed in Europe/Berlin on .de and America/Chicago on
.com. `KICKTIPP_TZ` changes display only. Autonomous reminders use strict
resolution and reject missing, ambiguous, or invalid deadlines.

### Writes and notifications

Read-only mode is enforced at MCP registration, CLI entry, and core submission.
Keep the core guard even when a caller already checked. Audit records are
written inside the submitting functions so all entry points are covered.
Spielleiter submissions must preserve the selected member's `tipperId` in the
form; MCP additionally requires an explicit matching `confirm_member`.

Service delivery records attempts before sending. An ambiguous response or
crash must not become an automatic duplicate send. Preserve revalidation of
retryable deliveries against fresh Kicktipp data. Notification targets contain
secret references; logs and default status output expose summaries only.

### Analytics and output

Scoring comes from the configured override or parsed community rules.
Incomplete/unsupported scoring is rejected; do not invent default point values.
Cache keys must distinguish variants, accounts, and communities where relevant.
Another player's analysis reads that player's grid, never the owner's tips.

Read commands support `--json`. Keep stdout parseable and spinners on stderr.
MCP tools return text plus `structuredContent: { data: ... }` under the shared
output schema. Scoring-derived results expose rule source and confidence.
