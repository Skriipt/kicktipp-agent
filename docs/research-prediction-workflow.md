# Research & Prediction Workflow v2

The foundation lives in `src/workflow/`. It is independent of the existing CLI,
MCP tools, dashboard and reminder service. It never installs cron jobs, sends
notifications, or connects to Kicktipp on import. The supplied executable is an
**offline demonstration with synthetic data**, not a football predictor.

The live adapter composition and operating contract now live in
[workflow-live.md](workflow-live.md). `src/workflow/cli.ts` connects the read-only
MCP importer, isolated model processes, Telegram and single-fixture submission.
It defaults to research-only and has not been activated as a production service.

## Run the complete offline example

```bash
nvm install && nvm use # .nvmrc pins Node 24.15.0
npm run build
npm run workflow:demo
# Repeat: persisted completed stages and submissions are not repeated.
npm run workflow:demo
```

The virtual clock advances by 1, 210 and 40 minutes, then the fake submission
adapter returns the exact fixture and score. JSON and one continuously updated
Markdown dossier are written under `data/workflow-demo/` inside this checkout.
The `.invalid` URLs in the demo are in-memory originals; no network is used.
A fresh demo run can use a different directory in `src/workflow/demo.ts`.

## Pipeline and timing

```text
scheduled -> researched -> refreshed -> predicted
  -> waiting_for_submission_window -> eligible_for_submission -> submitted
```

- R1 is due at kickoff − 5 hours; R2 at kickoff − 90 minutes.
- R1 must start before R2 becomes due. An already started R1 may resume and
  finish later, before kickoff; its original start time is retained. R2 then runs
  on the same fixture after R1. A fixture with no R1 start still misses that window.
- R2 updates only its concrete fixture, with no access to another dossier.
- Prediction runs only at or after kickoff − 50 minutes and after finished, validated R2 (partial coverage is allowed). Its only content input is
  the final Markdown dossier; it receives no research tools or shared session.
- Submission eligibility is `now >= kickoff - 50 minutes && now < kickoff`.
  The local loop wakes at the boundary and reevaluates; it does not promise
  second-exact execution. Later games remain open and unsubmitted.
- An unfinished fixture becomes `kickoff_passed` at kickoff, including blocked
  and failed fixtures. Already confirmed submissions retain their status.

`Workflow.run(fixtures, signal)` owns an independent scheduler loop for every
fixture. Each sleeps until its own next stage; there is no batch barrier waiting
for another fixture's research. An unexpected fixture failure stops only that
loop; an AggregateError identifies failures after the other loops finish.
No AI is invoked during sleeping or routine reevaluation. An active competing
owner causes a local one-second contention wait. There is no interval-based
schedule fetch. Import a new fixture list and restart the loop for new games.
SIGINT/SIGTERM abort sleeping and active research, checkpointing its progress.
Prediction and submission also receive the stop signal. A stop prevents new
submission dispatch, and cancelled prediction remains blocked (no automatic
prediction retry). An already dispatched write is still reconciled by read-back
with its own deadline, even when the outer signal is aborted. The production clock caps individual timers at Node's
maximum timer duration and reevaluates after that cap.

## Persistence and identity

The layout is:

```text
ROOT/<season>/<competition>/<matchday>/<profile>/<community>/<fixture-id>.json
ROOT/<season>/<competition>/<matchday>/<profile>/<community>/<fixture-id>.md
```

Each component uses injective UTF-8 lowercase hex encoding (also safe on case-insensitive filesystems), including separators
and Unicode; identifiers are limited to 100 UTF-8 bytes for filesystem safety.
Use canonical provider IDs for competition and fixture, exact team names, and
an absolute UTC kickoff in epoch milliseconds. A fixture is a match, never a
bonus question. Identity is the complete JSON tuple of profile, community,
season, competition, matchday and provider fixture ID. Teams and kickoff are
also immutable and checked on every reopen. A changed kickoff or team requires
explicit operator reconciliation; silently creating a second submission target
under a new fixture ID is unsafe.

`FileWorkflowStore` reuses the repository's `FileLock` and `durableReplace`.
Each fixture has a process-owned lock held across asynchronous work. On Linux,
`flock` retains kernel ownership until release or process death; use a local
filesystem and keep the `.guard` inode. Other platforms retain the existing
conservative PID-based lock behavior. This is a single-host local scheduler,
not a distributed lease service. Do not remove locks belonging to live owners.

State is schema-validated JSON written using fsync + atomic rename + directory
fsync. It contains derived due times, stage start/end times, complete flags,
evidence, prediction, status history, and the active attempt. JSON is committed
before Markdown; reopening repairs a missing/stale Markdown projection.
Markdown edits are not workflow commands and are overwritten by the projection.

Each new research checkpoint embeds the full immutable `fixture`, including both
teams and kickoff. Legacy files without nested research identity are upgraded
only after the store verifies the containing state's full identity and schedule.
Contradictory nested identity is rejected. Direct research/renderer calls require
explicit full identity; they cannot infer it from an arbitrary fixture key.
The additive fields are optional when reading old files, but older releases with
strict schemas cannot read newly written fields: back up state before upgrading
and do not downgrade a live writer against the upgraded store.

Stage intent is persisted before invoking an AI/provider. Each accepted original
and each `tools.record({ findings, uncertainties })` update is committed with
fsync + atomic rename; a hard process kill retains the last completed checkpoint.
No process can checkpoint work it has not yet received. Adapters must record
findings incrementally, before starting their next request.

Research timeout, abort, quota exhaustion or provider failure leaves the fixture
at `scheduled` (R1) or `researched` (R2), with `retryable: true` and
`researchRetryAt` (default five-minute backoff, configurable). The next scheduler
attempt revalidates persisted originals and findings, passes only this fixture's
checkpoint as `input.previous`, and creates a fresh research session. An
interrupted process's R1/R2 attempt marker is also recoverable. Completed stages
are not repeated. Prediction interruption remains blocked. Existing blocked
records from older versions are not silently reset; operator reconciliation is
still required for those records.

Reports with rejected findings or no accepted evidence also pause for retry.
On the next attempt, previous rejection reasons move into `rejectionHistory`,
which is retained in the dossier as an audit trail. `rejected` describes only the
current attempt; previous accepted evidence is revalidated, and rejected findings
never become evidence. New validation failures still prevent prediction. Thus a
corrected report can recover without deleting the record of its earlier failure.
Repeated invalid reports remain paused until kickoff, using the configured backoff.

Submission intent is persisted before sending. After an interrupted send,
recovery performs **read-back only**, even after kickoff. A matching previous
write can then become `submitted`; a mismatch or unavailable read becomes
`submission_failed` (or `kickoff_passed` after kickoff). No automatic write retry
is possible. This is at-most-once dispatch with conservative reconciliation,
not a claim of exactly-once transactions with an external website.

## Research contract and evidence gate

R1 covers form, home/away form, injuries and suspensions, expected lineups,
rest/load, tactics, motivation, statistics, market expectation and news.
R2 covers confirmed lineups, late absences, rotation, coach news, breaking news,
weather and availability. Coverage is reported for each category and each team; a valid match source may
support separate findings for both teams. Missing optional coverage is an explicit
uncertainty, not invalid evidence. At least one valid original-backed finding is
required for provenance. Missing information cannot be fabricated to fill gaps. If a lineup is not yet confirmed, record the checked source's actual
statement and the uncertainty; do not call a predicted lineup confirmed.

Implement `ResearchProvider` with these capabilities:

- `search` returns candidate URLs only. Search snippets are not evidence.
- `open` fetches and checks the original page and returns `Source`: page text,
  publication time, canonical team/season/competition identity, scope and
  reliability. Metadata must come from inspecting the original, not echoing
  the fixture request. Resolve canonical/redirect URLs when providing candidates.
- `investigate` uses only its provided search/open tools, the concrete fixture,
  and phase categories; it returns quoted findings and explicit uncertainties.
  It must not access another fixture's state or bypass the provided tools.
- `tools.record` validates and checkpoints findings incrementally. Returning a
  final report records any remaining findings. Opened pages alone are saved for
  continuation but never become unquoted prediction facts.
- On a no-progress error, change query, original source or category. An unhandled
  repetition makes the workflow try uncovered categories separately; unresolved
  categories remain visible. A failed provider request has one transient retry
  total per phase attempt. Quota/routing failures are never retried within it.

The gate requires exact fixture ID, kickoff and both teams for a match source.
A current team source needs one canonical team plus season/competition/time
provenance; it does **not** require literal opponent, country or every fixture
field in the article. The adapter performs semantic attribution, including
canonical team alias resolution. Reliability (`primary` or `reliable`) is the
adapter's checked assessment; `unchecked` is rejected. The deterministic gate
cannot independently establish a publisher's credibility or verify the meaning
of a paraphrase. This responsibility remains at the original-page adapter.

Quotes must occur in the opened original. Historical and current evidence are
separate. Current R1 sources have a seven-day maximum age; current R2 sources a
24-hour maximum age, measured at observation. R2 cannot reuse historical evidence
or pages observed before its due time. Publication and observation timestamps
are retained. Contradictory claims sharing a canonical team/subject stay visible;
newer reliable information supersedes older information without erasing it.
Adapters should use stable subject keys across phases (e.g. a player's fitness).

There is **no default retrieval count limit** and no global search count limit.
An explicit optional `maxCalls` is operator protection only: reaching it pauses
and checkpoints research, never declares evidence insufficient. There is no
persisted cumulative query budget across resumptions. Different new queries and
new originals remain unlimited in count.

The workflow detects unchanged results for the same query and unchanged originals
for the same URL. Once a retrieval has stalled, further identical requests in
that attempt are rejected locally; they do not spend more provider calls.
Different queries remain available even if their result sets happen to coincide.
Progress tracking, opened pages and tool capabilities belong to one phase of one
fixture. They are never shared with other fixtures.

Default technical watchdogs are **two minutes per retrieval request** and
**30 minutes per fixture research phase attempt**, configurable through
`WorkflowOptions.research.requestTimeoutMs/deadlineMs`. The phase is also stopped
at kickoff. These are failure containment deadlines, not evidence-completeness
requirements; there is no standard 60-second research cutoff. A recovered R1 may
cross the R2 due time without becoming permanently blocked.

Every attempt has its own AbortController. Late provider results cannot commit,
and expired tools are revoked. Providers must use asynchronous I/O and honor
cancellation; JavaScript cannot preempt synchronous CPU loops. The intended production research adapter is Codex, running in a separately
terminable subprocess with private session, working and log directories per
fixture/attempt. The core does not launch or manage that process. The optional
legacy Hermes/Firecrawl adapter below is not the Codex implementation or an
automatically selected fallback.

`complete` means a finished, provenance-valid report, not exhaustive coverage.
`coverage` and missing-evidence uncertainties are persisted and projected into
Markdown. Invalid identity, original provenance, quotes, future timestamps and
staleness remain rejected. Before submission, accepted evidence is revalidated;
the coverage flags never override that gate.

Prediction returns validated probabilities summing to one, expected goals,
integer exact score, confidence and source-linked reasons. The small sanity
check verifies numeric ranges, fixture identity and source membership. It does
not run another AI analysis or prove the truth of generated reasoning. Configure
the prediction agent without web tools and instruct it to use only dossier facts.
Before dispatch, the engine revalidates persisted research and prediction.

## Integrating providers safely

```ts
import { Workflow, systemClock } from './dist/workflow/engine.js';
import { FileWorkflowStore } from './dist/workflow/store.js';

// Application-supplied implementations of the documented interfaces:
const workflow = new Workflow(
  new FileWorkflowStore('./data/research-workflow'),
  createResearchSession, dossierOnlyPredictor, singleFixtureSubmissionAdapter,
  systemClock,
  { research: { deadlineMs: 30 * 60_000, requestTimeoutMs: 2 * 60_000 }, retryDelayMs: 5 * 60_000 },
);
const stop = new AbortController();
process.once('SIGINT', () => stop.abort());
process.once('SIGTERM', () => stop.abort());
await workflow.run(fixtures, stop.signal);
```

`src/workflow/agents.ts` and `kicktipp.ts` now implement the live adapters;
`cli.ts` composes them explicitly. `src/workflow/demo.ts` continues to supply
runnable fakes. Live activation and real E2E acceptance remain separate from
implementation; see [workflow-live.md](workflow-live.md).
`createResearchSession(fixture)` must return a fresh provider instance per attempt.
Reusing an instance is rejected. Do not close over a shared agent conversation,
query cache, original-page cache or dossier store. Each live agent must have
private tools and a private process/profile directory; a new object around a
shared conversation is not an isolated session.
`WorkflowStore`, `Clock`, `ResearchProvider`, `Predictor` and `SubmissionAdapter`
are the test boundaries; filesystem persistence is encapsulated by the store.

The live `SubmissionAdapter` must send exactly the supplied fixture,
with no other match or bonus fields, and recheck the window immediately before
the transport send, **after** awaited authentication/navigation. It receives an
abort signal and clock for that purpose. It must never retry writes. Its `read`
must bypass caches and return the original full fixture identity plus exact score.
Use a write-capable session with explicit authorization; do not reuse
`ScopedKicktippClient.read`, which retries authentication for read operations.

Existing `place_bets` / `core.placeBets` serialize the match form and identify
matches by team names. They remain unchanged and must not be wired directly into
this stricter single-fixture contract without a dedicated transport adapter and
payload tests. Existing MCP compatibility is covered by the full test suite.

## Optional legacy Firecrawl for Hermes

This is retained integration guidance for an explicitly selected legacy bridge.
It is not required by the intended Codex route, and is never selected automatically.

The versioned [example](examples/hermes-firecrawl-free.example.json) is JSON
(valid YAML) for a dedicated Hermes `config.yaml`. It explicitly sets both
`web.search_backend` and `web.extract_backend` to `firecrawl`, disables
managed gateway routing, keyless vendor rotation/rescue and shared web caches.
There is no invented `free: true` billing switch: this setup uses Firecrawl's
**keyless public cloud route**, with no Firecrawl API key or API URL override.
Do not add a paid key, Portal web gateway, paid subscription or pay-as-you-go.

One-time profile setup (operator, outside this repository):

1. Create a dedicated, credential-free Hermes research profile/home. Merge the
   example's `web` section into that profile's `config.yaml`; never replace the
   existing Kicktipp MCP profile or its login/session settings.
2. Keep FIRECRAWL_API_KEY and FIRECRAWL_API_URL absent from both this profile and
   the child environment. Never copy a general-purpose authenticated Hermes home.
   Keep model setup separate; free web retrieval does not promise free inference.
3. With the installed Hermes virtualenv active and its checkout on PYTHONPATH,
   run `python /path/to/this/repo/scripts/check-hermes-firecrawl.py` with that
   isolated HERMES_HOME. It performs no web requests, writes nothing, and emits
   only allowlisted route/policy fields. Unknown Hermes APIs, keyed routes and
   fallback settings fail closed. Do this before each fresh fixture session.
4. For offline example validation only, run
   `python3 scripts/check-hermes-firecrawl.py --config-only docs/examples/hermes-firecrawl-free.example.json`.
   This checks the example, **not** an installed profile or provider availability.

The [official Hermes web documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-search)
describes backend selection and rescue settings. The healthcheck also checks the
[Firecrawl implementation](https://github.com/NousResearch/hermes-agent/blob/922c0d670cf46952248dc22c27e4d01531a4a051/plugins/web/firecrawl/provider.py)
for the effective direct `keyless` route. Compatibility was reviewed against that
revision; rerun the healthcheck after Hermes upgrades.

The official Firecrawl Free plan has finite credits and rate limits, **not
unlimited provider capacity**. Keyless access is also limited and is not a
guarantee of the account Free plan's allowance. Exact allowances change; consult
[Firecrawl pricing](https://www.firecrawl.dev/pricing) and
[rate limits](https://docs.firecrawl.dev/rate-limits). Never upgrade or auto-purchase
capacity on exhaustion.

`freeFirecrawlSession(bridge, investigate)` in `src/workflow/firecrawl.ts` is the
optional guarded boundary for an application-supplied Hermes bridge. Before each
search/open it verifies effective policy; each response must identify its actual
backend, keyless mode and normalized HTTP status. A switched/rescued/paid route
raises `ResearchPaused('backend_changed')`; 402 becomes `quota_exhausted`, 429
becomes `rate_limited`. These stable reasons are checkpointed into the dossier,
without raw provider error strings or secret-bearing configuration. Do not
translate quota errors into empty successful search results. If Hermes encodes
errors inside a 200 response, the bridge must normalize them before returning.

The bridge must inspect actual runtime routing, not echo requested settings,
and must prevent a paid request before transport dispatch. Response checks alone
cannot undo a billed request. It must map extracted originals into semantically
verified Source metadata; search snippets are never originals. No live Hermes
bridge, installed-profile modification, credential access or network healthcheck
is performed by the workflow demo/tests. Free quota exhaustion pauses research
until a later attempt; it never triggers a paid fallback.

## Verification

```bash
npm test
npm run build
npm run workflow:demo
```

`tests/workflow.test.ts` covers boundaries, next-due sleeping, parallel isolation,
lock contention/SIGKILL progress recovery, restart idempotence, original match/team
sources, partial coverage, no-progress strategy changes, unlimited new queries,
provider hangs, independent scheduler progress, quota pauses, Firecrawl routing, prediction sanity, kickoff and exact
read-back mismatches. All workflow submission tests use fakes. Nothing in the
workflow tests installs cron or posts to Kicktipp/Discord.

## Fixed research prompts (version 1)

`src/workflow/prompts.ts` exports `RESEARCH_PROMPT_VERSION`,
`R1_PROMPT_TEMPLATE_V1`, `R2_PROMPT_TEMPLATE_V1` and
`renderResearchPrompt(fixture, phase, { researchTimestamp, r1? })`.
The fixed German wording is an instruction contract; edits require a new version.
R1 is full research; R2 is delta research against this fixture's completed R1.

The renderer replaces every occurrence in one pass. Names and provider/Kicktipp
`fixture.fixtureId` are literal, including Unicode, leading zeroes and dollar
sequences; no ID is generated. Date (`DD.MM.YYYY`) and kickoff (`HH:mm`) use
Europe/Berlin, including DST and local date rollover. Research timestamps are
unambiguous UTC ISO instants: the current attempt time and, for R2, R1 completion
time. Phase is `R1`/`R2`. The supported placeholders are `HOME_TEAM`, `AWAY_TEAM`,
`COMPETITION`, `SEASON`, `MATCHDAY`, `DATE`, `KICKOFF`, `TIMEZONE`, `FIXTURE_ID`,
`RESEARCH_TIMESTAMP`, `RESEARCH_PHASE`, and R2-only `R1_TIMESTAMP` and
`MATCH_DOSSIER`, each enclosed in double braces. The fixed R1 wording has no
matchday placeholder; matchday remains available in the fixture input.
Unknown or malformed template placeholders and placeholder syntax in fixture
metadata fail closed before provider calls or research checkpoints. JSON-encoded
R1 data may contain literal double braces: substitution is nonrecursive and never
interprets those characters as another template. R2 validates baseline schema,
full identity (including teams and kickoff), accepted original evidence, phase
and timestamps; missing, incomplete, foreign or future baselines are rejected.

Every `ResearchProvider.investigate` call receives `input.prompt`, alongside its
existing single fixture, phase, categories and same-phase `previous` checkpoint.
R2 receives a separate R1 baseline projected from that fixture's authoritative
research only; it never receives another fixture or prediction state. The
baseline is a JSON-encoded Markdown string inside the fixed dossier markers.
Angle brackets are escaped to prevent embedded text closing those markers;
decoding recovers the original text. A separate data instruction prohibits
following dossier instructions or changing fixture scope/tool policy. This
framing is not a substitute for the runner's tool/session isolation.

Existing providers may ignore the additional input field. A live model adapter
must deliver the prompt to its research agent and translate its Markdown output
into the existing original-backed `{ findings, uncertainties }` return/record
contract. Raw Markdown and prompt text are never accepted as evidence. This
prompt change originally did not implement that adapter. The subsequent live
adapter in `agents.ts` now translates and validates originals while preserving
the canonical dossier projection. The runner still validates and projects structured evidence, and the
prediction boundary still receives only the final dossier and cancellation
signal. Rendered prompts are not persisted; no checkpoint/report needs them.

Deadlines, retrieval timeouts, no-progress handling, retries, process isolation
and provider selection remain runner/adapter concerns. The prompt grants no
additional tools. Rendering and tests use no network, credentials or sessions.
`tests/workflow-prompts.test.ts` pins the complete template wording by checksum
and verifies substitutions, time conversion, fail-closed behavior and data
framing; workflow tests verify provider integration and dossier-only prediction.
