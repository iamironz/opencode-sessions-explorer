# Security Policy

## Reporting a Vulnerability

Please report security issues privately using
[GitHub Security Advisories](https://github.com/iamironz/opencode-sessions-explorer/security/advisories/new)
for this repository. Do not open public issues for security-sensitive reports.

If you cannot access GitHub Security Advisories, email the maintainer at
aleksandr.efremenkov@bolt.eu.

Include the following in your report when possible:

- Affected versions or commit SHA
- Impact and potential exploit scenario
- Steps to reproduce or a proof of concept
- Any known mitigations or workarounds

We aim to acknowledge reports within 3 business days.

## Data Exposure and Redaction Surface

This plugin exposes your OpenCode session history to the running LLM, and
that history can include credentials, API tokens, and file contents captured by
past tool calls. Two surfaces reduce accidental disclosure by default:

- **Search snippets redact secrets by default.** `search-text` and
  `grep-session` redact common secret shapes (`AKIA…`, `ghp_…`, `sk-…`, JWTs,
  bearer tokens, etc.) in returned snippets. `redact:false` is opt-in for local
  forensics only.
- **`get-part` dereference is path-guarded.** Tool-output dereference is
  restricted to the tool-output whitelist root
  (`OPENCODE_SESSIONS_EXPLORER_TOOL_OUTPUT_DIR`); paths outside that root are
  rejected.

All access is local and read-only except the single `unarchive-session` write;
no data leaves your device through this plugin.

## Supported Versions

Security updates are provided for the latest release.
