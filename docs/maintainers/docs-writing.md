# Docs Writing Standard

## Purpose

Define consistent structure, markdown style, and explanation patterns for
project docs.

## Core Principles

- Lead with user outcome, then steps, then edge cases.
- One page should have one clear intent.
- Prefer short concrete statements over broad prose.
- Use stable terms (`search-text`, `unarchive-session`, `OPENCODE_SESSIONS_EXPLORER_DB`)
  consistently.

## Page Type Templates

### Start Pages

Use sections in this order:

1. `Purpose`
1. `Prerequisites`
1. `Setup` or `Steps`
1. `Validate` (how to confirm success)
1. `Next steps`

### Guides

Use sections in this order:

1. `Purpose`
1. `Default behavior` or `Mental model`
1. `Controls` or `Entry points`
1. `Recommended flow`
1. `Related docs`

### Reference Pages

Use sections in this order:

1. `Scope`
1. `Definitions/Tables`
1. `Examples`
1. `Related docs`

### Troubleshooting Pages

Use sections in this order:

1. `How to use this page`
1. `Baseline checks`
1. Symptom blocks (`Quick checks`, `Fix`)
1. `Related docs`

## Markdown Conventions

- Keep headings concise and in Title Case.
- Use numbered lists (`1.` style) for procedures.
- Use tables for command/option/tool inventories.
- Wrap commands, paths, options, env vars, and tool names in backticks.
- Prefer fenced code blocks with language identifiers.
- End pages with a `Related Docs` section.

## Explanation Pattern

Use this order for each important concept:

1. What it is
1. Why it matters
1. How to use it
1. How to validate it
1. Where to go next

## Link Policy

- Keep canonical maintainer pages under `docs/maintainers/`.
- Use relative links between docs and back to root files (`../../README.md`).
- Update the "Maintainer Docs" list in [`CONTRIBUTING.md`](../../CONTRIBUTING.md)
  whenever docs paths or ownership change.

## Related Docs

- [Development Guide](development.md)
- [Release Guide](release.md)
- [Triage Guide](triage.md)
