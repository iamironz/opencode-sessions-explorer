# Contributing

Thanks for contributing to `opencode-sessions-explorer` — an [OpenCode](https://opencode.ai)
plugin written in TypeScript and run on [Bun](https://bun.sh) (it uses `bun:sqlite`, so the
runtime is Bun, not Node).

## Requirements

- [Bun](https://bun.sh) `>= 1.0` (OpenCode ships Bun; install it standalone only if you run
  the bundled CLIs directly; `bun:sqlite` should include SQLite `json1`, and
  `check-deps` / `db-stats` verify it).
- An OpenCode plugin host compatible with `@opencode-ai/plugin >= 1.15.0` for runtime
  validation.
- [`ck`](https://github.com/BeaconBay/ck) `>= 0.7` — only if you work on `search-text` /
  `grep-session`; the other 16 tools work without it.
- A populated OpenCode SQLite DB — only for live testing (the suite is hermetic by default).

## Workflow

```bash
bun install --frozen-lockfile
bun run typecheck   # tsc --noEmit (strict mode)
bun test            # hermetic by default
bun run build       # bundle to dist/
```

For source-dev plugin registration, use [docs/install.md#from-source-dev](docs/install.md#from-source-dev).
For the full local dev loop, the 4-layer architecture, environment overrides, hermetic vs
live testing, and the `.js`-import gotcha (sibling imports in `src/` use `.js` even though
the files are `.ts`), see [docs/maintainers/development.md](docs/maintainers/development.md).

## Pull Request Expectations

- Keep the change scope focused; describe behavior changes and reasoning clearly.
- Pass `bun run typecheck`, `bun test`, and `bun run build` locally.
- For changes that affect tool output, also run `bun tests/verify-end-to-end.ts`.
- Update [`README.md`](README.md) for any user-facing change.
- Add a note under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md), following the
  [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## Documentation Writing Standard

Follow [docs/maintainers/docs-writing.md](docs/maintainers/docs-writing.md) for page
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
