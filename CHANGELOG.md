# Changelog

## [Unreleased]

## [1.2.2] - 2026-09-03

### Changed

- Match, bonus, and Spielleiter submissions now share one audited submit lifecycle.
- Personal and Spielleiter match bets now share the same parsing, duplicate detection, and form-filling path.
- Offline cache reads and CLI community selection use one implementation each.
- Builds clear stale compiler output before creating packages.
- Locked transitive dependencies were refreshed to patched releases within the existing version ranges.

### Removed

- Unused terminal rendering helpers and an unnecessary dashboard type module.
- The stale `.env.example`, whose removal was already documented in 1.1.0.

## [1.2.1] - 2026-09-02

### Added

- `kicktipp tip-status` and MCP `get_tip_status` report full, partial, or missing tip submissions without revealing score predictions.

### Changed

- `kicktipp bet` now opens the dashboard directly on the existing "Place bets" screen instead of maintaining a second terminal application.
- CLI progress messages use the Node.js terminal APIs directly.

### Removed

- The generated `kicktipp tui --demo` season and its parallel data backend.
- The standalone prediction-grid runtime, deprecated time-zone aliases, and leftover Playwright-shaped page helpers.
- The `ora` dependency and its transitive packages.

## [1.2.0] - 2026-09-01

### Added

- `kicktipp tui`: a full-screen dashboard that covers every CLI feature from one keyboard-driven interface. Today, bets, an interactive place-bets grid, odds-based suggestions, leaderboard, season overview, league table, schedule, deadlines, stats, rival watch, scenarios, what-if replay, sync/cache, rules, audit log (with undo), community/player selection, notification settings, and Spielleiter admin tools.
- `kicktipp tui --demo` explores the whole interface with a generated Bundesliga season, so every screen (including the analytics) works without connecting an account.
- Opt-in German UI (`kicktipp set-lang`) and a persistent Kicktipp host (`kicktipp set-site`). English and kicktipp.com stay the default.

The dashboard is dependency-free: it reuses the existing data and analytics layer and renders with a small hand-rolled terminal toolkit, in the same spirit as the existing `kicktipp bet` prediction grid.

### Changed

- `kicktipp sync` and MCP `sync_history` stop at Kicktipp's current matchday, skip finished and still-upcoming cached matchdays, and only refetch an open one. `--to 34` still walks the rest of the season.
- TUI navigation: Enter opens a section and leaves you on the menu. → or a second Enter moves into the pane. Escape or ← returns.

### Fixed

- Live TUI exited after the session spinner. ora paused stdin when it stopped. Wide menu icons also overflowed the frame by a column.
- Screens that load nothing on purpose (sync, rival picker) stayed on "Loading…".
- Rival watch on kicktipp.com treated the rank-change column and hyphen tips with point subscripts as a column mismatch, so finished matchdays showed empty grids. Tied or unpublished matchdays no longer say the rival is out of reach.

## [1.1.2] - 2026-08-28

### Fixed

- Bonus bets: `place_bonus_bets` matched questions by answer text, so mixed slips (champion + relegation) failed and ranking questions only filled the first dropdown.
- MCP dry runs for `place_bets`, `place_bonus_bets`, and `place_bets_for_member` now return `success: true` when validation succeeds; use `dry_run: true` to see that nothing was submitted.

## [1.1.1] - 2026-08-28

### Changed

- npm `homepage` is https://kicktipp-agent.com, matching the GitHub repo website.

## [1.1.0] - 2026-08-28

### Changed

- Dropped Playwright. The CLI and MCP server talk to Kicktipp with `fetch` and Cheerio. There is no Chromium download and no browser window in the background.
- kicktipp.de works as well as kicktipp.com. The default host is still kicktipp.com. Missing pages are retried on the other host and language.
- Credentials live in `~/.config/kicktipp-agent/config.ini`. Environment variables still win if you set them, but they are no longer the intended first setup.

### Removed

- The `playwright` package.
- `.env.example`. Copying a dotenv file is not part of setup anymore.

### Added

- Localhost setup page (`kicktipp login --web`, MCP `connect_account` / `get_status`). The password stays out of chat.
- Optional session-only storage: keep the login cookie, drop the password.
- Claude Desktop pack (`.mcpb`), same version as `package.json`, attached to GitHub releases. Manual `node …/dist/server.js` still works.
- Full-screen tip sheet on `kicktipp bet` in an interactive terminal. `--no-tui` keeps the line-by-line prompts.
- Local season cache (`kicktipp sync`) plus stats, rival analysis, odds-based suggestions, deadlines, reminders, what-if replay, standings scenarios, and a bet log with undo.
- Config profiles, `--community` for a one-off pool, `--json` on read commands, read-only MCP mode, and Spielleiter admin tools.
- MCP tools return structured results. Cached season data is also exposed as MCP resources.

### Fixed

- Response bodies are decoded with the charset Kicktipp actually sent.
- Community names with underscores or spaces are found.
- Live kickoff times, bonus-tab bets, and `set-notify`.

## [1.0.0] - 2026-03-07

CLI and MCP server on `main`. Used Playwright against kicktipp.com. Setup was env vars plus `config.ini`.
