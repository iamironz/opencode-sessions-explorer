# Release Guide

## Purpose

Define repeatable steps to cut and publish a release of
`opencode-sessions-explorer` to npm and GitHub.

## Versioning

Use [SemVer](https://semver.org/spec/v2.0.0.html):

- Major: breaking changes
- Minor: new features
- Patch: fixes and docs

## Release Checklist

1. Bump the version in `package.json` to the target `x.y.z`.
1. Move the `## [Unreleased]` notes in `CHANGELOG.md` into a new
   `## [x.y.z] - YYYY-MM-DD` section, and leave an empty `## [Unreleased]`
   above it for the next cycle.
1. Run the quality gates locally and confirm they pass:

   ```bash
   bun run typecheck
   bun test
   bun run build
   ```

1. Confirm the **CI** workflow (`.github/workflows/ci.yml`) is green on the
   commit you intend to tag.
1. Commit the version bump and changelog (for example
   `chore(release): v0.1.0`).
1. Create an annotated tag and push it:

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

Pushing a `vX.Y.Z` tag triggers `.github/workflows/publish.yml`, which publishes
the package to npm with provenance and creates the GitHub Release from the
changelog entry.

## Publish Bootstrap (first release only)

The publish workflow is configured for npm
[Trusted Publishing (OIDC)](https://docs.npmjs.com/trusted-publishers), which
needs the package to already exist on npm before OIDC can be linked. Bootstrap it
once:

1. Create a short-lived **automation** npm token and add it to the repository as
   the `NPM_TOKEN` secret.
1. Cut the first release (`v0.1.0`) so `publish.yml` publishes the initial
   version to npm using that token.
1. In the npm package settings, configure **Trusted Publishing** for this repo's
   `.github/workflows/publish.yml`.
1. **Revoke** the `NPM_TOKEN` secret and the npm token. Subsequent releases
   authenticate via OIDC with no long-lived secret.

## Post-Release

- Verify the new version is live on
  [npm](https://www.npmjs.com/package/opencode-sessions-explorer) and that the
  GitHub Release was created.
- Monitor issues for regressions.
- Triage and label follow-up reports (see [Triage Guide](triage.md)).

## Related Docs

- [Development Guide](development.md)
- [Triage Guide](triage.md)
