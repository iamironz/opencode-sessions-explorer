# Contributing

Thanks for contributing to `opencode-sessions-explorer`.

This is an [OpenCode](https://opencode.ai) plugin written in TypeScript and run on
[Bun](https://bun.sh) — it uses `bun:sqlite`, so the runtime is Bun, not Node. It exposes
your local OpenCode session history to the LLM as 18 tools (17 read-only + 1 write).

## Requirements

- [Bun](https://bun.sh) >= 1.0 (OpenCode ships Bun; install it standalone only if you run
  the bundled CLIs directly).
- A populated OpenCode SQLite DB at `~/.local/share/opencode/opencode.db` — required only
  for live testing (see [Tests: hermetic vs live](#tests-hermetic-vs-live)).
- [`ck`](https://github.com/BeaconBay/ck) >= 0.7 — required only if you work on
  `search-text` / `grep-session`; the other 16 tools work without it.

## Setup

```bash
bun install
```

See [docs/maintainers/development.md](docs/maintainers/development.md) for the full local
dev loop, the 4-layer architecture, and the environment overrides.

## Quality Gates

Run these before opening a PR:

```bash
bun run typecheck   # tsc --noEmit (strict mode)
bun test            # hermetic by default
bun run build       # bundle to dist/
```

For changes that affect tool output, also run the end-to-end verifier, which compares each
tool against ground-truth SQL (this one needs a live DB):

```bash
bun tests/verify-end-to-end.ts
```

## Tests: hermetic vs live

- `bun test` is **hermetic by default** — it runs against a synthetic fixture DB and does
  not need your real history. This is what CI runs.
- To exercise the suite against your real `~/.local/share/opencode/opencode.db`, opt in:

  ```bash
  OPENCODE_SESSIONS_EXPLORER_LIVE=1 bun test
  # or
  bun run test:live
  ```

  Live runs read real `ses_/msg_/prt_` IDs and minimum counts from your machine; failures
  there reflect your local data, not necessarily a regression.

## The `.js`-import gotcha (do not "fix" it)

Inside `src/`, sibling imports use a **`.js`** extension even though the files are `.ts`:

```ts
import { stmt } from "../lib/db.js"; // the file is db.ts — this is correct
```

This is required by `tsc` (`moduleResolution: bundler`) and `bun build`. Rewriting these to
`.ts` will break typecheck and the build. (Files under `tests/` import `src` with `.ts`;
that is fine, because Bun runs them unbuilt.)

## Pull Request Expectations

- Keep the change scope focused and describe behavior changes and reasoning clearly.
- Include reproducible steps and outcomes.
- Pass `bun run typecheck`, `bun test`, and `bun run build` locally.
- Update [`README.md`](README.md) for any user-facing change.
- Add a note under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md), following the
  [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.
- Adding or editing a tool? Follow the per-tool contract documented in
  [docs/maintainers/development.md](docs/maintainers/development.md) and `AGENTS.md`
  (one tool per file, named const, registered in `src/tools/index.ts`, wrapped in
  `runWithEnvelope`, list results wrapped in `table(...)`).

## Documentation Writing Standard

Use [docs/maintainers/docs-writing.md](docs/maintainers/docs-writing.md) for page
structure, markdown conventions, and explanation style.

## Maintainer Docs

- Development: [docs/maintainers/development.md](docs/maintainers/development.md)
- Release: [docs/maintainers/release.md](docs/maintainers/release.md)
- Triage: [docs/maintainers/triage.md](docs/maintainers/triage.md)

## Code of Conduct

This project follows the [Contributor Covenant](.github/CODE_OF_CONDUCT.md). By
participating, you agree to uphold it.

## Security

Please report vulnerabilities privately — see [SECURITY.md](.github/SECURITY.md). Do not
open public issues for security-sensitive reports.

## License

By contributing, you agree that your contributions are licensed under the project's
[MIT License](LICENSE).
