# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-08-27

### Added

- `kicktipp tip-status` with optional `--matchday` support.
- MCP tool `get_tip_status` for structured, read-only submission status.
- Tests for German and English routes, community slug normalization, and complete/partial/missing tip states.

### Changed

- `https://www.kicktipp.de` and German page routes are now the default.
- `KICKTIPP_BASE_URL=https://www.kicktipp.com` remains available for the English host and routes.
- Legacy direct route calls are normalized to the selected host.

### Fixed

- Community detection now handles display names whose spaces, punctuation, or slashes differ from their URL slug.
