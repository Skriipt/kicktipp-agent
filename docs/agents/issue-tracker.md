# Issue tracker: GitHub

Issues and specifications for this repository live in GitHub Issues under `Skriipt/kicktipp-agent`.

Use the connected GitHub tools when available. In environments with an authenticated `gh` CLI, the equivalent `gh issue` commands may be used.

## Conventions

- Create one GitHub issue per implementation ticket.
- Read the complete issue body and comments before acting on a ticket.
- Apply the configured triage labels from `docs/agents/triage-labels.md`.
- Publish dependent tickets in blocker-first order.
- Use native GitHub issue dependencies when available.
- Otherwise, record dependencies in the issue body as `Blocked by: #<number>`.
- Do not close or modify a parent issue unless explicitly requested.

## Pull requests as a triage surface

**PRs as a request surface: no.**

External pull requests are not automatically treated as feature requests or added to the issue-triage queue.

## When a skill says “publish to the issue tracker”

Create a GitHub issue in `Skriipt/kicktipp-agent`.

## When a skill says “fetch the relevant ticket”

Fetch the complete GitHub issue, including labels and comments.
