# Triage Guide

## Purpose

Define issue intake, labeling, and follow-up policy. The canonical label
definitions live in [`.github/labels.yml`](../../.github/labels.yml); this guide
documents how they are applied.

## Intake Flow

1. Confirm issue template quality (clear repro, version, environment).
1. Reproduce the issue when possible.
1. Apply labels for type, status, and scope.

## Label Set

Issue type:

- `bug` — something is not working
- `enhancement` — new feature or request
- `documentation` — documentation updates
- `security` — security related issues
- `question` — further information requested

Contributor signals:

- `help wanted` — extra attention is needed
- `good first issue` — good for newcomers

Implementation focus:

- `tests` — test coverage or fixes
- `refactor` — refactoring or cleanup
- `chore` — maintenance tasks

Triage status:

- `triage/needs-info` — needs more information from the reporter
- `triage/confirmed` — repro confirmed by maintainers
- `triage/blocked` — blocked on an external dependency or upstream (e.g.
  OpenCode or `ck`)
- `triage/duplicate` — duplicate of an existing issue
- `triage/wontfix` — will not be addressed

## Follow-Up Policy

- Close `triage/needs-info` after 14 days without a response.
- For `triage/blocked`, document the blocker and a recheck date.
- Close `triage/duplicate` with a link to the canonical issue.
- Close `triage/wontfix` with a concise rationale and alternatives when possible.

## Related Docs

- [Development Guide](development.md)
- [Release Guide](release.md)
