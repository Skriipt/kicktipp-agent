# Domain documentation

This repository uses a single-context domain documentation layout.

## Before exploring

Read these resources when they exist:

- `CONTEXT.md` at the repository root
- relevant ADRs under `docs/adr/`

Proceed silently when either resource is absent.

## Layout

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
└── src/
```

## Vocabulary

Use canonical domain terms from `CONTEXT.md` in issue titles, specifications, tests, and implementation discussions.

Avoid synonyms explicitly rejected by the glossary. When a required concept is missing, note the gap for domain modeling rather than silently inventing conflicting terminology.

## Architectural decisions

Read ADRs relevant to the area being changed. Surface conflicts explicitly instead of silently overriding an accepted decision.
