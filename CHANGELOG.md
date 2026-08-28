# Changelog

## [1.1.0] - unreleased

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
