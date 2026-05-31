# Contributing to setup-aspect

## Layout

| Path | What |
|---|---|
| `index.js` | Main entry — install, cache restore, auth. |
| `post.js` | Post-job entry — cache save. |
| `config.js` | Input parsing, path resolution, cache key composition, runner-mode detection. |
| `install.js` | Launcher + Bazelisk download / tool-cache install. |
| `util.js` | Shared helpers (bazelrc append, cache key composition). |
| `action.yml` | The action's public input contract and entry points. |
| `dist/` | **Generated.** ncc-bundled output that GitHub actually runs. Do not hand-edit. |
| `.github/workflows/` | self-test, weekly tagging, and the manual release workflow (+ its `release_*.sh` helpers). See [Versioning & releases](#versioning--releases). |

## Build

GitHub runs the bundled code in `dist/`, not the source files. **You must rebuild
and commit `dist/` whenever you change any `.js` file or its dependencies** —
otherwise your change has no effect on the action.

```sh
npm install
npm run build   # ncc bundles index.js → dist/main, post.js → dist/post
```

`action.yml` points `main`/`post` at `dist/main/index.js` and `dist/post/index.js`.
A PR that edits source without a matching `dist/` rebuild is incomplete.

## Test

`.github/workflows/self-test.yaml` exercises the action end-to-end on
`ubuntu-latest` and `macos-latest` (default install, pinned launcher, Bazelisk,
cache restore/save, bazelrc idempotency, setup-bazel coexistence, the id-token
warning). It runs on every PR. There are no unit tests; the action is small
enough that the self-test matrix is the test suite.

## Versioning & releases

This action is **not** published to the GitHub Marketplace. It uses two tiers of
tags, both matching aspect-build/aspect-cli's scheme:

| | Tag | Workflow | Trigger | GitHub Release? |
|---|---|---|---|---|
| **Weekly** | `YYYY.VV` (e.g. `2026.22`) | `weekly_tag.yaml` | cron + push to main | no |
| **Release** | `vYYYY.VV.N` (e.g. `v2026.22.3`) | `tag_release.yaml` | manual `workflow_dispatch` | yes |

Across both tiers: **pin to the commit SHA, not the tag.** Tags are mutable and
can be repointed at malicious code, so [GitHub recommends](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions#using-third-party-actions)
pinning third-party actions to a full commit SHA. The README's usage examples and
the release notes (see `release_notes.sh`) reflect this; keep them SHA-first. We
don't list on the Marketplace — listing would steer users toward tag-based
consumption, undercutting that stance.

**Weekly tags** are dated pointers for discoverability. `weekly_tag.yaml` runs on
a Monday cron **and** on every push to `main`; the push trigger backfills a week
whose cron run was skipped (e.g. the week's first commit lands after Monday) so a
tag is never missed. Every run is gated: it no-ops if the week's tag already
exists (we never move it to a later commit) or if `main` hasn't advanced since
the last `YYYY.VV` tag. This action changes rarely, so an ungated cron would
stack near-identical tags on a quiet repo — gating yields at most one tag per
week, only when something shipped.

**Releases** are cut manually from the Actions tab (`tag_release.yaml`) when you
want richer, changelog-bearing notes — e.g. after landing a fix users are waiting
for. The release version is `vYYYY.VV.N`: the current weekly tag plus the number
of commits since it (`release_version.sh`, derived via `git describe`), so
releases compose with the weekly tags without collisions. The notes lead with a
copy-paste `uses:` snippet pinned to the released SHA, followed by GitHub's
auto-generated changelog. The bare `YYYY.VV.N` is computed against the bare weekly
tags; the `v` prefix is added only to the release tag (matching the Aspect CLI).

## Conventions

- Keep inline comments minimal; prefer function and file docstrings for the
  non-obvious *why*. Update docstrings when you change a signature or behavior.
- The ncc bundle should stay small — avoid adding heavyweight dependencies.
