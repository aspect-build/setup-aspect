# setup-aspect

GitHub Action that installs the [Aspect CLI](https://docs.aspect.build/cli/overview) launcher, installs Bazelisk (skipped automatically if `bazel` is already on PATH), points Bazel at Aspect Cloud's remote cache and BES, and authenticates with the Aspect API — all in one step.

Both the remote cache and the web UI that the BES stream powers are available on Aspect Cloud's Free Tier. See [aspect.build/docs](https://aspect.build/docs) for more info.

## Usage

Minimal — latest launcher, Bazelisk, and the Aspect remote cache:

```yaml
- uses: actions/checkout@v6
- uses: aspect-build/setup-aspect@<commit-sha>
  with:
    aspect-api-token: ${{ secrets.ASPECT_API_TOKEN }}
- run: bazel build //...
- run: bazel test //...
```

That is the whole setup. setup-aspect runs `aspect setup bazelrc`, which writes `~/.aspect/bazelrc` with your Aspect deployment's remote cache and BES and `try-import`s it from `~/.bazelrc` — so a plain `bazel` call shares a cache with every other job and branch, and streams its build to Aspect.

The rc goes to `~/.bazelrc`, never into the checkout, so the repository stays clean.

Or run Aspect tasks — `aspect build`, `aspect test`, `aspect lint` and the rest
— which run the same builds with Aspect's own reporting and reach the
deployment on CI without a flag of their own:

```yaml
- uses: actions/checkout@v6
- uses: aspect-build/setup-aspect@<commit-sha>
  with:
    aspect-api-token: ${{ secrets.ASPECT_API_TOKEN }}
- run: aspect build //...
- run: aspect test //...
```

A task configures its own Bazel invocation, so it needs neither the generated
rc nor `--remote`; what it does need is `aspect` on `PATH`, which this action
installs. See [Aspect CLI tasks](https://aspect.build/docs/cli/tasks).

Full — pin versions, key the repository cache per workflow, and authenticate:

```yaml
permissions:
  id-token: write    # required for Aspect CLI's ArtifactUpload feature

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: aspect-build/setup-aspect@<commit-sha>
        with:
          launcher-version: 2026.38.28
          bazelisk-version: 1.x
          bazelisk-cache: true
          repository-cache: ${{ github.workflow }}
          aspect-api-token: ${{ secrets.ASPECT_API_TOKEN }}
      - run: bazel build //...
      - run: bazel test //...
```

`repository-cache` holds the bytes Bazel downloads for external repositories,
in the GitHub Actions cache rather than Aspect's. Keying it on
`github.workflow` gives each workflow its own entry, which is worth doing where
workflows pull genuinely different dependency sets and would otherwise churn
one shared entry; a single `true` shares one across them all. The build outputs
themselves need no input here — those go to the Aspect remote cache, shared
across every job and branch.

**Pin to a full-length commit SHA**, not a branch or tag — tags are mutable and can be repointed at malicious code, so SHA-pinning is the [GitHub-recommended](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions#using-third-party-actions) way to use third-party actions. Annotate with the version in a trailing comment for readability, and let Dependabot or Renovate keep the SHA fresh:

```yaml
- uses: aspect-build/setup-aspect@<commit-sha> # v2026.38.0
```

Find the SHA on the [Releases page](https://github.com/aspect-build/setup-aspect/releases) — each release's notes include a copy-paste snippet pinned to its SHA. (We also push lightweight `YYYY.VV` weekly tags for discoverability.) Either way, pin to the SHA rather than the tag, since tags are mutable.

## What it does

setup-aspect runs in one of two modes depending on the runner:

### On a vanilla GHA runner (`ubuntu-latest`, `macos-latest`, self-hosted, etc.)

1. **Install the Aspect CLI launcher** (`aspect` on `PATH`). Reads `.aspect/version.axl` from your repo on first invocation to fetch the matching CLI binary. Points `ASPECT_LAUNCHER_CACHE` and `ASPECT_CLI_CACHE` at GHA-cacheable directories (with distinct roots) and restores them, so the download is skipped on warm runs.
2. **Install Bazelisk** (default: `latest`). Skipped if `bazel` is already on PATH (you don't need both `setup-bazel` and `setup-aspect`). Caches the binary via `actions/tool-cache` and via `actions/cache` (unless `bazelisk-cache: false`).
3. **Restore caches** via `@actions/cache`. The repository, Bazelisk, and Aspect CLI caches are on by default on ephemeral runners; the disk cache is opt-in (see `disk-cache`). The post-job hook saves them on exit.
4. **Authenticate** to the Aspect API via `aspect auth login --with-api-token` if `aspect-api-token` is set. The resulting short-lived JWT is persisted locally; the long-lived `<client_id>:<secret>` is never written to `GITHUB_ENV` (see [Security](#security) below).
5. **Point `~/.bazelrc` at the Aspect remote cache** by running `aspect setup bazelrc`, which on CI writes `~/.aspect/bazelrc` and adds a `try-import` for it at the top of `~/.bazelrc`, so vanilla `bazel` calls use the deployment's remote cache and BES. No flags are passed: the CLI detects CI and picks that layout over the `<workspace>/.aspect/bazelrc` pair meant to be committed. Set `remote-cache: false` to skip, or `home` to override the layout.
6. **Append `~/.bazelrc` directives** — `--repository_cache`, `--disk_cache` when enabled, and any extra lines from the `bazelrc` input. Idempotent, and appended below step 5's `try-import`, so these lines override the generated ones.

Step 4 comes first deliberately: authenticating puts a single-tenant deployment on record so the generated rc includes it. Step 6's placement is about precedence rather than survival — the rc task only adds its `try-import` at the top of `~/.bazelrc` and leaves the rest alone, and Bazel takes the last value of a flag, so lines below that import win over the generated rc.

### On an Aspect Workflows runner (`ASPECT_WORKFLOWS_RUNNER` env var set)

The runner image already provides `aspect` and `bazel`, and `aspect <task>` invocations always wire themselves into the runner's caching infrastructure on their own. setup-aspect's job on these runners is to extend the same wiring to **vanilla `bazel` calls** outside of `aspect <task>` — many pipelines mix `aspect build` with a separate `bazel build` step, and without setup-aspect those bare `bazel` invocations would miss the deployment's remote cache, BES backend, and local NVMe disk cache.

1. **Waits for runner cache warming to complete** if it is still in progress — the same wait `aspect <task>` performs before running, extended to jobs that go on to run vanilla `bazel` so they don't race the warming bootstrap and miss the warmed caches.
2. **Configures vanilla `bazel` to use the runner's caching infrastructure** — the same remote cache, repository cache, and NVMe disk cache that `aspect <task>` already uses. The rc is generated by `aspect setup bazelrc` (writes `~/.bazelrc`), with a legacy fallback for runners whose CLI predates that task. If neither is available the action warns but does not fail — only vanilla `bazel` calls go unconfigured.
3. **Authenticates** to the Aspect API (same as ephemeral mode).
4. Skips launcher install, Bazelisk install, GHA cache wiring, and `~/.bazelrc` append — not needed on Workflows runners (`aspect`/`bazel` are already available and Bazel is routed through the runner's own caching).

Detection is based on the `ASPECT_WORKFLOWS_RUNNER` env var.

## Inputs

| Input | Default | Purpose |
|---|---|---|
| `launcher-version` | `latest` | Aspect CLI launcher version to install (e.g. `2026.38.28`). The CLI version is pinned by `.aspect/version.axl` in your repo — the launcher reads that file and downloads the matching CLI on first `aspect` invocation. Ignored on Workflows runners or when `launcher-install` is `false`. |
| `launcher-install` | `true` | Whether to install the Aspect CLI launcher. Set to `false` if you're providing `aspect` yourself (e.g. via a `curl install.aspect.build | bash` step earlier in the job). No-op on Aspect Workflows runners (the runner image already ships `aspect`). |
| `aspect-api-token` | — | Long-lived `<CLIENT_ID>:<SECRET>` token, typically passed via the GitHub Actions secrets context (e.g. as `secrets.ASPECT_API_TOKEN` in a `with:` block). When set, setup-aspect runs `aspect auth login --with-api-token` (piping the token via stdin) — the short-lived JWT it produces is persisted locally for downstream `aspect <task>` calls via `ctx.aspect.auth.credentials()`. The long-lived token is **not** exported to `GITHUB_ENV`. Leave empty to skip the auth step. |
| `bazelisk-version` | `latest` | Bazelisk version to install (semver range or exact, e.g. `1.x` or `1.21.0`). Default: `latest` (downloaded via GitHub's `/releases/latest/download/<asset>` redirect — no API call, no rate-limit risk). The install is skipped regardless of this input if `bazel` is already on PATH (setup-bazel ran first, you're on an Aspect Workflows runner, etc.). |
| `bazelisk-cache` | `true` | Cache the Bazelisk binary across runs (keyed on `.bazelversion`). On by default; set `false` to disable. |
| `remote-cache` | `true` | Point Bazel at the Aspect deployment's remote cache and BES via `aspect setup bazelrc`. On by default — this is what makes a plain `bazel build //...` share a cache across jobs. The deployment defaults to Aspect Cloud; `aspect-api-token` is what lets Bazel authenticate to it. `false` leaves `~/.bazelrc` alone. Ignored on Workflows runners, which generate their own rc. |
| `disk-cache` | `false` | Cache Bazel's `--disk_cache` outputs across runs, through the GHA cache. **Off by default** — `remote-cache` covers the same ground and is shared across jobs and branches, where this is per-runner and capped by the GHA cache's 10 GB per-repo budget. `true` re-enables it; a string segregates caches by stage (a common pattern is to key on the GHA `github.workflow` value). Worth turning on when `remote-cache` is off. Ignored on Workflows runners. |
| `repository-cache` | `true` | Enable Bazel `--repository_cache` (external-repo download bytes). On by default. Set to a string to segregate caches by stage (e.g. the GHA `github.workflow` value). `false` disables. Ignored on Workflows runners. |
| `remote` | "" | Which of the deployment's endpoints the generated rc turns on, passed as `--remote=<value>`. Unset leaves the CLI's `auto` (cache + BES on CI, nothing off it). Same grammar as `aspect build --remote`: `exec` adds remote execution, `no-cache` / `no-bes` / `no-exec` subtract, `none` enables nothing. |
| `home` | "" | Which rc to write, passed as `--home=<value>`. Unset leaves the CLI's `auto` (`~/.aspect/bazelrc` on CI, the checkout's off it). `false` writes the committed `<workspace>/.aspect/bazelrc` instead, for a job whose purpose is regenerating it. |
| `force` | `false` | Regenerate the rc even if one is already there (`--force`). Worth turning on for a persistent self-hosted runner, whose home directory survives between jobs; an ephemeral runner starts clean, so it changes nothing there. |
| `bazelrc` | "" | Extra lines appended to `~/.bazelrc`. Multiline YAML supported. Append-only and idempotent. Appended after `remote-cache` generates the rc, so these lines win where they set the same flag. Ignored on Workflows runners. |

Which Bazel flags the generated rc carries is a repository choice, not a workflow
one. To drop a flag the rc would otherwise set, name it in the repo's
`.aspect/config.axl`, where it covers every CI provider and local runs alike:

```python
def config(ctx: ConfigContext):
    ctx.tasks["setup/bazelrc"].args.omit_bazel_flags = [
        "--execution_log_compact_file",
    ]
```

Endpoints, credentials, and the runner's output paths cannot be omitted.

## Security

### How `ASPECT_API_TOKEN` is handled

The typical pattern in GHA workflows is:

```yaml
# DON'T do this — token visible to every step in the job
env:
  ASPECT_API_TOKEN: ${{ secrets.ASPECT_API_TOKEN }}
```

That exposes the long-lived `<client_id>:<secret>` to every step in the job, including any untrusted third-party action you call. If a malicious action reads `process.env`, the secret leaks.

setup-aspect handles the token differently:

1. You pass `aspect-api-token: ${{ secrets.ASPECT_API_TOKEN }}` as an input — visible only to setup-aspect's step.
2. setup-aspect calls `aspect auth login --with-api-token`, piping the token via stdin.
3. The CLI exchanges the long-lived token with the Aspect API for a short-lived session JWT, and persists the JWT on disk.
4. Downstream `aspect <task>` invocations in any later step pick up the persisted JWT via `ctx.aspect.auth.credentials()`.
5. The long-lived token is **never written to `GITHUB_ENV`** — downstream steps see only the JWT on disk.

The JWT has a bounded TTL (24h by default; see [Aspect docs](https://docs.aspect.build/cli/authentication)). For jobs longer than the JWT TTL, downstream tasks will need to re-authenticate; in practice that affects vanishingly few CI jobs since GitHub Actions caps individual jobs at 6h on hosted runners.

### `permissions: id-token: write`

Several Aspect CLI features (notably `ArtifactUpload`, which uses the GHA artifact API) require the workflow to grant `id-token: write` to the job. setup-aspect can't grant the permission itself — only the workflow YAML can — but it detects when the permission is missing and emits a `::warning::` pointing at the docs:

```yaml
permissions:
  id-token: write
```

If you don't use any feature that requires OIDC, you can ignore the warning.

## Coexistence with `setup-bazel`

You typically don't need both — setup-aspect handles Bazelisk install + cache wiring itself. But if you do run both:

- **Cache keys** don't collide: setup-aspect uses `setup-aspect-*` prefixes; setup-bazel uses `setup-bazel-*`.
- **Cache defaults are inverted.** setup-bazel ships its disk/repository/Bazelisk caches *off* by default; setup-aspect ships them *on* (on ephemeral runners) — the common case wants caching, so you opt out rather than in. Set any of `disk-cache` / `repository-cache` / `bazelisk-cache` to `false` to disable.
- **Bazelisk** is shared. Both actions use `${RUNNER_TOOL_CACHE}/bazelisk` so they reuse the cached binary when at the same version.
- **`~/.bazelrc`** — setup-bazel *overwrites*, setup-aspect *appends*. Run setup-aspect *last* if you want both actions' directives in the file.
- **`bazel` already on PATH** — setup-aspect skips its Bazelisk install if `bazel` is already there.

Recommendation: pick one. setup-aspect alone handles every concern setup-bazel does, plus the Aspect-specific install + auth steps.

## Requirements

- GitHub Actions runner running Linux or macOS. Windows is **not** supported (the Aspect CLI launcher is POSIX-only).
- On Aspect Workflows runners only, the action configures the environment such that vanilla `bazel` calls use the Aspect Workflows CI runner NVME drive & deployment remote cache automatically.

## What this action does NOT do

- It does **not** invoke any `aspect` task — you call `aspect <task>` yourself in subsequent steps.
- It does **not** install raw Bazel. Set `bazelisk-version` to install Bazelisk (recommended), or use [bazel-contrib/setup-bazel](https://github.com/bazel-contrib/setup-bazel) separately if you need Bazel without Bazelisk.

## Credits

Inspired by [bazel-contrib/setup-bazel](https://github.com/bazel-contrib/setup-bazel) by [Alex Rodionov](https://github.com/p0deje). The caching architecture (key shape, `@actions/cache` integration, post-hook save) and Bazelisk install flow are adapted from setup-bazel with attribution — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the full MIT license text and per-file headers in [`index.js`](index.js), [`post.js`](post.js), [`config.js`](config.js), and [`install.js`](install.js).

## Related

- [Aspect CLI documentation](https://docs.aspect.build/cli/overview)
- [Aspect CLI Quickstart](https://docs.aspect.build/quickstart) — install to a custom task in 10 minutes.
- [Running AXL tasks in CI](https://docs.aspect.build/cli/usage/tasks-ci) — pipeline examples for GitHub Actions, Buildkite, GitLab CI, CircleCI.
- [Aspect Workflows](https://docs.aspect.build/aspect-workflows) — managed CI runners with `aspect` pre-installed plus remote cache and RBE.

## License

[Apache License 2.0](LICENSE).
