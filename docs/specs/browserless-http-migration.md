# Spec: Browserless HTTP migration (Playwright removal)

**Status:** Implemented on this branch (see §9 for where the result differs
from the plan below)
**Branch:** `claude/playwright-http-migration-mmw2vh`
**Origin:** Extracted from PR #5 by @nhoelterhoff, with fixes for the issues raised in the maintainer review of 2026-07-07. Commits that reuse his work will credit him as co-author.

## 1. Goal

Replace the Playwright/Chromium automation layer with a plain HTTP client
(`fetch` + cookie jar) that logs in, follows redirects, submits forms, and
hands the same server-rendered HTML to the existing Cheerio parsers.

Kicktipp's pages are fully server-rendered; the current code already parses
`page.content()` with Cheerio. Playwright is only used for navigation, login,
and form submission — all replaceable with HTTP requests. Removing it cuts
~300 MB of install weight, the consent-banner handling, and most startup
latency, for both the CLI and the stdio MCP server.

## 2. Non-goals (explicitly out of scope)

These parts of PR #5 are **not** taken in this change:

1. **Hosted HTTP MCP server, per-request bearer auth, session pool**
   (`http-server.ts`, `session-pool.ts`, `request-context.ts`,
   `auth-description.ts`). Recommendation: **decline indefinitely.** Even
   with the email-only session-keying bug fixed, the design forwards user
   passwords in an `Authorization` header on every request and makes the
   operator a credential custodian for third-party Kicktipp accounts, with
   no rate limiting story that doesn't also break legitimate use. This can
   live in the fork.
2. **Spielleiter admin tools** (`list_members`, `place_bets_for_member`,
   `get_bonus_questions_for_member`, `place_bonus_bets_for_member`).
   Legitimate stdio-mode feature ("Tipps nachtragen"), but a significant new
   capability — review separately in its own PR after this lands.
3. **Docker / Fly configs.** Only meaningful alongside (1). Skip.

## 3. Decisions

| Topic | Decision | Rationale |
|---|---|---|
| Default host | **Keep `https://www.kicktipp.com`** (no change), add `KICKTIPP_BASE_URL` override and automatic `.de`/`.com` + German/English route fallback | PR #5 flipped the default to `.de`, a silent breaking change for existing users. The alias-retry machinery makes the default mostly moot: German-only pools still resolve via fallback. |
| Page API | Keep the Playwright-shaped shim (`goto`, `content`, `url`, `$`, `fill`/`setInputValue`, `selectOption`, `click`) | Minimizes churn in `core.ts`/commands; keeps the diff reviewable. Drop the `waitForNavigation`/waiter machinery — it is a no-op in an HTTP client and only adds state. |
| Session persistence | Same `SESSION_FILE` path, new JSON cookie format; atomic write + `chmod 600` as on `main` | An old Playwright `storageState` file fails to parse as the new format → falls through to fresh login. No migration code needed. |
| Login failure | Throw (`Error`), never `process.exit(1)` from library code | The MCP server must not be killed by a bad login; the CLI entry point catches and exits. (PR #5 already made this change — keep it.) |
| Consent banner | Delete `dismissConsent` entirely rather than keeping a no-op | No HTTP request ever loads the consent iframe. A no-op stub invites confusion; remove the call sites (7 files) in the same commit. |

## 4. Design

### 4.1 `src/browser.ts` — HTTP page shim

Adopted from PR #5 with the following **required fixes**:

**CookieJar (fix: host scoping — review finding #3)**
- Store cookies per **host** (`Map<host, Map<name, value>>`), not in one flat
  map. `header(url)` returns cookies whose host matches the request host or
  is a parent domain of it (Kicktipp sets host-only cookies; domain-suffix
  matching covers `www.` vs apex).
- **Never attach cookies to a non-Kicktipp host**: hard allowlist
  `/(^|\.)kicktipp\.(de|com)$/` plus the `KICKTIPP_BASE_URL` host. Redirects
  to any other host are followed without cookies.
- Honor `Max-Age=0` / `Expires` in the past as deletion (as in PR #5); parse
  the `Domain` attribute when present, ignore `Path` (Kicktipp doesn't use
  path-scoped cookies; document this limitation in a comment).
- Keep `getSetCookie()` with the string-splitting fallback for older Node.

**Redirect loop** — as in PR #5: manual redirects, max 8, 301/302/303 demote
POST→GET, 307/308 preserve method+body, `Referer` maintained. One addition:
resolve relative `Location` against the *current* URL (PR #5 does this
correctly — keep it).

**Form serialization** — as in PR #5 (submitter button value, checkbox/radio
checked state, select defaults, textarea text, skip `disabled`).

**Auth/404 detection (fix: review finding #4)** — the shim exposes
`status()` and `url()`; classification lives in `core.ts` (see 4.3). The
shim itself no longer conflates 404 with anything.

**Alias fallback** — `goto()` retries `getAlternateUrls(url)` only when the
response is a 404 or a Kicktipp "Seite wurde nicht gefunden" page, deduping
attempts (as in PR #5).

**Dropped from PR #5's shim:** `waitForNavigation`/waiters,
`waitForLoadState` (no-op — delete call sites instead), `evaluate` (only
used as a liveness probe; replace with an explicit `isClosed()` method),
`Browser`/`BrowserContext` no-op interfaces (return type becomes
`{ page: Page }`; update the ~9 call sites).

### 4.2 `src/url.ts` — route table

Adopt PR #5's design as-is (it is good): a `ROUTES` table with `de`/`en`
path variants, `buildUrl()` helpers per page type, `getAlternateUrls()`
producing cross-host + cross-language candidates. Changes:

- `DEFAULT_BASE_URL = 'https://www.kicktipp.com'` (see Decisions).
- Drop `adminMembers`/`adminTips` routes (out of scope; they return with the
  admin-tools PR).
- Keep `assertMatchday` consolidation and `URLSearchParams` building.

### 4.3 `src/core.ts` — `loadPage` error classification

Replace the current silent behavior with explicit errors, but distinguish
the three cases PR #5 collapsed:

1. Final URL matches a login route → `AuthError` ("session is not
   authenticated"). Callers (MCP `getPage` wrapper) may evict the cached
   page and retry **once**, read-only tools only.
2. `spielleiter=1` in the login redirect → permission error (kept from
   PR #5, useful message).
3. 404 / "Seite wurde nicht gefunden" **after** alias fallback is exhausted
   → `NotFoundError` ("page not found — check the community name"). **Not**
   an auth error: no eviction, no re-login, no retry.

Introduce small `AuthError` / `NotFoundError` classes in `core.ts` so the
retry wrapper matches on `instanceof`, not message regexes.

All URL construction in `core.ts` and `src/commands/*` moves to the `url.ts`
helpers (mechanical part of PR #5 — adopt).

### 4.4 `src/server.ts` — MCP server

Minimal change only:

- `launchBrowser()` return shape (`{ page }`), drop
  `browserInstance`/`contextInstance`.
- Liveness check becomes `page.isClosed()` instead of `evaluate`.
- Add the stale-session retry wrapper for **read-only** tools (evict + one
  retry on `AuthError`); mutating tools (`place_bets`, `place_bonus_bets`,
  `set_community`, `set_player`) never retry. This is PR #5's
  `withFreshSession` idea, simplified: no request context, stdio only.

None of the request-context / multi-tenant plumbing from PR #5 enters
`server.ts` or `config.ts`.

### 4.5 Dependencies

- Remove `playwright` from `dependencies` (lockfile regenerated via
  `npm install`, never by hand).
- No new dependencies: global `fetch` (Node ≥ 18) and `cheerio` (already
  present) cover everything. Add `"engines": { "node": ">=18" }` to
  `package.json`.

## 5. Test plan

New unit tests (vitest, no network — `fetch` injected/mocked):

| File | Covers |
|---|---|
| `tests/cookie-jar.test.ts` | set-cookie parsing incl. `Expires` with commas, multi-cookie split fallback, deletion via `Max-Age=0`, host scoping, refusal to send cookies to non-Kicktipp hosts, JSON round-trip |
| `tests/form-serialize.test.ts` | submitter value, unchecked boxes omitted, radio groups, select default/explicit/multiple, textarea, disabled fields |
| `tests/page-navigate.test.ts` | redirect chain (302 POST→GET, 307 preserves POST), max-redirect error, relative `Location` resolution, alias fallback triggers only on 404-page, `Referer` propagation |
| `tests/url.test.ts` (extend) | route table for both hosts, `getAlternateUrls` candidates, matchday validation (adopt PR #5's additions minus admin routes) |
| `tests/load-page.test.ts` | error classification: auth redirect vs spielleiter vs not-found; retry-once semantics of the read-only wrapper |

Fixture-based parser smoke tests (saved HTML of a predict/leaderboard page)
are **nice-to-have**, not blocking — the parsers themselves don't change.

Validation before push: `npm run build`, `npm test`, plus one manual live
smoke run of `kicktipp` CLI (login → communities → schedule → leaderboard →
`bet --dry-run`) against a real account.

## 6. Implementation plan

Work happens on this branch in reviewable commits:

1. **`url.ts` route table + tests** — pure refactor, no behavior change with
   the `.com` default; `core.ts`/commands switch to the helpers. Existing
   tests keep passing.
2. **`browser.ts` HTTP shim + CookieJar + tests** — the core swap: Playwright
   removed from `browser.ts`, login rewritten, `getCommunities` slug fix
   adopted (single-path-segment links, `info`/`service` excluded — this also
   fixes issue #3's slug normalization).
3. **`core.ts` `loadPage` classification + `server.ts`/commands cleanup** —
   error classes, retry wrapper, `dismissConsent`/`waitForLoadState` call
   sites removed, `launchBrowser` shape change.
4. **Dependency + docs** — drop `playwright`, regenerate lockfile, `engines`
   field, README ("no browser required", `KICKTIPP_BASE_URL`), update
   `docs/CLAUDE.md` architecture section.
5. **Live smoke test, then PR to `main`** — reference PR #5, credit
   @nhoelterhoff (`Co-authored-by`), and comment on PR #5 linking the
   extraction so the remaining parts can be discussed separately.

Estimated size: ~700 added / ~250 removed lines excluding lockfile — roughly
half of PR #5, with the security-sensitive multi-tenant surface gone.

## 7. Risks

- **Kicktipp markup/flow changes** — the login form is located by
  `input[name="kennung"]`; if Kicktipp adds a CSRF token field, the form
  serializer already submits all hidden inputs, which is the correct
  behavior. Risk considered low; mitigated by the live smoke test.
- **Cookie edge cases** — `Expires` dates contain commas; covered by the
  split-fallback tests. Node ≥ 18.14 exposes `getSetCookie()` which avoids
  the problem entirely.
- **`.com` accounts with German-only pools** — previously broken anyway
  (redirect loses them); now handled by alias fallback. Behavior can only
  improve; the fallback adds at most a few extra requests on the 404 path.
- **Old session files** — parsed as the new format, fail, fall through to a
  fresh login. Worst case: one extra login per user after upgrade.

## 8. Follow-ups (separate PRs, not blocked on this)

- **Spielleiter admin tools** from PR #5, stdio-only, with `dry_run`
  parity and their own review.
- Decision on whether the project ever wants a hosted HTTP mode; if yes, it
  needs a real design (per-user tokens minted out-of-band, rate limiting,
  locking) rather than password-forwarding bearer values.

## 9. What shipped, and where it differs from the plan

- **The shim is split out of `browser.ts`** into `src/http/cookie-jar.ts` and
  `src/http/page.ts`, leaving `browser.ts` as session/login/parsing only.
  Both new files are unit-testable in isolation, which the plan's
  single-file version was not.
- **Charset decoding was added** (not in the original plan). `Response.text()`
  decodes as UTF-8 unconditionally, so a legacy-encoded page would arrive with
  mangled umlauts — and since team names are matched by text, that breaks
  fixture matching rather than merely looking wrong. Bodies are now decoded by
  the `Content-Type` charset, falling back to a `<meta>` declaration, then
  UTF-8.
- **Node floor is `>=20`, not `>=18`.** Node 18 is end-of-life; the
  `getSetCookie()` fallback still covers older runtimes if anyone needs one.
- **Validation is offline, not live.** A live smoke test against a real
  Kicktipp account was not possible here (no credentials, and using someone's
  account for a test is not something to do unasked). In its place the
  compiled CLI is driven end-to-end over real HTTP against a stand-in
  Kicktipp server: login with a hidden CSRF field, cookie-gated pages, the
  German route table, reading schedule/table/bets, submitting a bet through
  the real form path, session reuse across runs (3 runs → 1 login), stale
  session → exactly one re-login, a rejected login reported as a plain
  message with exit code 1, and the MCP server listing its 15 tools.
  **A live run against a real account is still worth doing before merge.**
- **CLI commands keep their own inline parsing** and so do not go through
  `loadPage()`'s error classification — a mistyped community still prints
  "No schedule found." there, exactly as before this change. Only the MCP
  path gets the typed errors. Unifying the two is a reasonable follow-up but
  would have widened this change.
- 103 tests pass (`npm test`); `npm run build` is clean. The `npm audit`
  findings that remain come from the MCP SDK and vitest transitives and
  predate this work.
