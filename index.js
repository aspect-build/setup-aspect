// Portions of this file are adapted from https://github.com/bazel-contrib/setup-bazel
// Copyright (c) 2023 Alex Rodionov — MIT License (see THIRD_PARTY_NOTICES.md)

/**
 * setup-aspect main entry: install the Aspect CLI launcher, install
 * Bazelisk (unless `bazel` is already on PATH), authenticate with the Aspect
 * API via the JWT-persist flow, and point Bazel at a cache. On Aspect
 * Workflows runners the action takes a much narrower path — see
 * `setupOnWorkflowsRunner` below.
 *
 * On an ephemeral runner that cache is the Aspect deployment's:
 * `aspect setup bazelrc` writes `~/.aspect/bazelrc` with its remote cache and
 * BES endpoints and `try-import`s it from `~/.bazelrc`, so a plain
 * `bazel build //...` reads and writes the shared cache and streams the build
 * to Aspect with nothing else configured. The
 * GHA-backed `--disk_cache`, which used to be the only cache here, is off by
 * default now that the remote cache covers the same ground; `disk-cache: true`
 * brings it back for repos that want both.
 *
 * Ordering inside `setupOnEphemeralRunner` matters — auth has to precede the rc
 * task, and the `bazelrc` input's lines have to land below its `try-import` — and
 * is documented at each call site.
 *
 * post.js handles the post-job cache save.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { setTimeout } from 'timers/promises'
import * as cache from '@actions/cache'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import config from './config.js'
import { installLauncher, installBazelisk, onPath } from './install.js'
import { appendBazelrcOnce, composeCacheKey } from './util.js'

async function run () {
  try {
    await setupAspect()
  } catch (error) {
    let message = error.stack || error.message || String(error)
    if (error.cause) {
      message += `\nCaused by: ${error.cause.stack || error.cause}`
    }
    core.setFailed(message)
  }
}

async function setupAspect () {
  warnIfIdTokenMissing()

  // Redirect the launcher's cli download and the cli's own downloads into
  // GHA-cacheable dirs (restored below in the ephemeral branch). Exported in
  // both modes so the first `aspect` call — `aspect auth login` — writes there
  // regardless of runner type, even where the cache itself isn't wired up.
  core.exportVariable('ASPECT_LAUNCHER_CACHE', config.paths.aspectLauncherCache)
  core.exportVariable('ASPECT_CLI_CACHE', config.paths.aspectCliCache)

  // Both modes authenticate and generate an rc; they differ in what the rc
  // describes and in what has to be installed first, so each owns its ordering.
  if (config.onWorkflowsRunner) {
    await setupOnWorkflowsRunner()
  } else {
    await setupOnEphemeralRunner()
  }
}

// ─── Workflows-runner branch ─────────────────────────────────────────────────

/**
 * The task that generates the rc. `ci` is the group it shipped under, still
 * accepted as an alias, so both are tried, newest first.
 */
const BAZELRC_SUBCOMMANDS = [['setup', 'bazelrc'], ['ci', 'bazelrc']]

/**
 * The exit code the CLI's argument parser uses for a command line it cannot
 * parse — an unrecognized command, or a flag this version does not have. A task
 * that ran and refused exits 1, so the two are told apart.
 */
const USAGE_EXIT = 2

/**
 * The aspect-cli release that ships `aspect setup bazelrc`, and where to get it.
 * Named in the upgrade hint shown when the CLI has the task under neither name:
 * that CLI has to be upgraded anyway, so point it at the current task rather
 * than at the older release whose only merit is the alias.
 */
const ASPECT_SETUP_BAZELRC_MIN_VERSION = 'v2026.38.30'
const ASPECT_CLI_RELEASES_URL = 'https://github.com/aspect-build/aspect-cli/releases'

// Bazel flags whose values are gRPC/HTTP headers — they carry credentials
// (bearer tokens, API keys) and the runner's `x-identity`, so their values are
// redacted before the rc is echoed to the log. Matches the Aspect CLI's own
// header-redaction list.
const HEADER_FLAG_NAMES = [
  'remote_header',
  'remote_cache_header',
  'remote_exec_header',
  'remote_downloader_header',
  'bes_header',
]
const HEADER_FLAG_RE = new RegExp(
  `(--(?:${HEADER_FLAG_NAMES.join('|')})=[^=\\s]+=).*$`,
)

/**
 * Redact header-flag values in a rendered rc so the echoed copy doesn't leak
 * credentials or the runner identity. `--remote_header=x-identity=<uuid>`
 * becomes `--remote_header=x-identity=<REDACTED>`; the flag and header name
 * stay visible so the echoed rc is still legible.
 */
function redactBazelrc (text) {
  return text
    .split('\n')
    .map((line) => line.replace(HEADER_FLAG_RE, '$1<REDACTED>'))
    .join('\n')
}

/**
 * Echo a generated rc file to the log so users can see exactly what was written
 * and where it came from. Indented so it reads as a quoted block, with
 * header-flag values redacted.
 */
function printBazelrc (rcPath) {
  if (!fs.existsSync(rcPath)) return
  core.info(`Generated ${rcPath}:`)
  core.info(redactBazelrc(fs.readFileSync(rcPath, 'utf8')).replace(/^/gm, '  '))
}

/**
 * On Aspect Workflows runners `aspect <task>` already routes through the
 * runner's caching infrastructure on its own — the launcher wires the
 * right flags regardless of any rc file. setup-aspect's job in this mode
 * is to extend the same treatment to *raw* `bazel <verb>` calls outside
 * of `aspect <task>`: wait for the runner's cache warming to complete
 * (which `aspect <task>` does on its own before running), and generate a
 * Bazel rc so vanilla `bazel` picks up the same configuration.
 *
 * The rc is generated by `aspect setup bazelrc`, with a legacy fallback for
 * runners whose CLI predates the task. If neither path
 * works, it warns (vanilla `bazel` calls won't be configured) but does NOT fail
 * the action — warming is done and `aspect <task>` steps are unaffected.
 *
 * The installs and GHA caching are skipped because they aren't needed here:
 * the runner already has `aspect`/`bazel` available and routes Bazel through
 * its own caching infrastructure.
 */
async function setupOnWorkflowsRunner () {
  core.info('Detected Aspect Workflows runner (ASPECT_WORKFLOWS_RUNNER set)')
  core.info(
    'Skipping launcher install, Bazelisk install, GHA cache wiring, and ' +
    '~/.bazelrc append — not needed on Workflows runners.'
  )

  logWorkflowsRunnerMetadata()

  await waitForWarming()

  // Before ~/.aspect/bazelrc is written: it is built from the runner's environment
  // rather than from what is logged in, but auth is cheap and the credential
  // helper the rc names has to work for the first `bazel` call either way.
  await loginIfApiToken()

  if (config.generateBazelrc) {
    await writeBazelrc()
  } else {
    core.info('bazelrc-generate: false — leaving Bazel\'s configuration to this repository.')
  }
}

/**
 * Every way to ask this CLI for the rc, best first: each set of flags in
 * `flagSets`, under each name in `BAZELRC_SUBCOMMANDS`.
 *
 * Flags are tried outermost so a configured run is preferred over a bare one.
 * The set a caller puts last is its fallback for a CLI too old for the rest —
 * `[]`, a bare run, which is also the whole ladder when nothing is configured.
 */
function bazelrcAttempts (flagSets) {
  // An unconfigured caller passes the same empty set twice — its flags, then
  // its fallback — and there is no point running the same command line again.
  const distinct = [...new Set(flagSets.map((flags) => flags.join('\u0000')))]
    .map((key) => (key === '' ? [] : key.split('\u0000')))
  return distinct.flatMap((flags) => BAZELRC_SUBCOMMANDS.map((argv) => [...argv, ...flags]))
}

/**
 * Run the rc-generating task and report whether it wrote the rc.
 *
 * Walks `bazelrcAttempts` until one succeeds. A non-zero exit moves on to the
 * next form rather than failing: the CLI may not know the name, or may not know
 * the flags. Exit 2 is the argument parser's — an unrecognized command or flag —
 * so a run that exited otherwise is remembered as a real failure and reported as
 * one, rather than as an out-of-date CLI.
 *
 * Callers check `aspect` is on PATH first, so that a missing binary and an
 * out-of-date one get different advice.
 */
async function runBazelrcTask (flagSets, description) {
  // `~/.bazelrc` try-imports the rc that holds the flags; both are echoed, and
  // a CLI old enough to write the whole rc into `~/.bazelrc` leaves only that.
  const userBazelrc = path.join(os.homedir(), '.bazelrc')
  const generatedRc = path.join(os.homedir(), '.aspect', 'bazelrc')
  let ranAndFailed = 0

  for (const full of bazelrcAttempts(flagSets)) {
    const name = `aspect ${full.join(' ')}`
    core.startGroup(`Generate ${generatedRc} via \`${name}\``)
    try {
      const code = await exec.exec('aspect', full, { ignoreReturnCode: true })
      if (code === 0) {
        const written = fs.existsSync(generatedRc) ? generatedRc : userBazelrc
        core.info(`Wrote ${description} bazelrc to ${written}`)
        printBazelrc(userBazelrc)
        printBazelrc(generatedRc)
        return true
      }
      if (code === USAGE_EXIT) {
        core.info(`\`${name}\` is unavailable in this Aspect CLI (exit ${code}); trying the next form.`)
      } else {
        ranAndFailed = code
        core.info(`\`${name}\` failed (exit ${code}); trying the next form.`)
      }
    } catch {
      // `aspect` is on PATH but could not be spawned; the next form will not
      // fare better, so stop here and let the caller fall back.
      return false
    } finally {
      core.endGroup()
    }
  }

  if (ranAndFailed) {
    core.warning(
      `\`aspect setup bazelrc\` ran but failed (exit ${ranAndFailed}), so vanilla \`bazel\` ` +
      'calls are not configured. The message above says why.'
    )
  }
  return false
}

/**
 * Preferred generator on a Workflows runner: `aspect setup bazelrc`, which
 * writes `~/.aspect/bazelrc` and try-imports it from `~/.bazelrc`.
 *
 * The rc holds the runner's remote cache, repository cache, and output flags —
 * the same flags `aspect <task>` injects. It reads the runner's environment,
 * not a Workflows config, so no throwaway config or `.bazelversion` plumbing is
 * needed.
 */
async function aspectSetupBazelrc () {
  if (!(await onPath('aspect'))) return false
  if (await runBazelrcTask([config.rcFlags, []], 'Workflows-tuned')) return true

  core.warning(
    'This Aspect CLI cannot run `aspect setup bazelrc`; ' +
    `it requires aspect-cli ${ASPECT_SETUP_BAZELRC_MIN_VERSION} or newer (${ASPECT_CLI_RELEASES_URL}). ` +
    'Trying the legacy generator instead.'
  )
  return false
}

/**
 * Ephemeral-runner generator: `aspect setup bazelrc`, whose rc holds the Aspect
 * deployment's remote cache and BES endpoints. That is what makes a plain
 * `bazel build //...` share a cache across jobs and stream its build to Aspect
 * without the workflow configuring anything else.
 *
 * No flags by default. The CLI picks the home layout on CI itself, so there is
 * nothing for the action to assert: `~/.aspect/bazelrc` with a `try-import` in
 * `~/.bazelrc`, rather than the `<workspace>/.aspect/bazelrc` pair meant to be
 * committed. The `home` input overrides that when a workflow wants the other.
 *
 * The task defaults to the Aspect Cloud deployment and needs no login to write
 * the rc; `aspect-api-token` is still what lets Bazel authenticate to the cache
 * the rc names, and what the task looks for before enabling those endpoints at
 * all.
 *
 * `authenticated` is whether the ASPECT_API_TOKEN exchange worked; false means
 * the rc is written with the cache and BES disabled rather than not at all.
 *
 * Returns whether the job ends up with the remote cache configured — false when
 * the rc could not be written and when it was written with caching off, since
 * the caller uses this to decide whether any cache is in play. A failure is
 * warned, not fatal: the job still builds, just uncached.
 */
async function writeCloudBazelrc (authenticated) {
  if (!(await onPath('aspect'))) {
    core.warning(
      '`aspect` is not on PATH, so `aspect setup bazelrc` could not run ' +
      'and `bazel` will not reach the Aspect remote cache. This is expected ' +
      'with `launcher-install: false` when you install `aspect` in a later ' +
      'step — run `aspect setup bazelrc` yourself once it is available.'
    )
    return false
  }

  // A token that would not exchange will not authenticate the cache either, and
  // Bazel treats a credential helper that cannot produce a token as fatal — so
  // an rc naming the cache would fail every `bazel` call rather than merely
  // leave it uncached. Say so explicitly instead: the endpoints stay defined in
  // the rc and come back the moment the token is fixed.
  //
  // No bare retry in that case. A CLI too old for `--remote` enables nothing on
  // this path anyway, so there is nothing to fall back to and nothing at risk.
  if (!authenticated) {
    core.warning(
      'The ASPECT_API_TOKEN exchange failed, so the generated rc will not enable ' +
      'the remote cache or BES — pointing Bazel at a cache it cannot authenticate ' +
      'to would fail the build rather than slow it down. Fix the token to restore ' +
      'caching; `--config=aspect-cloud` in the rc still names the endpoints.'
    )
    await runBazelrcTask([[...config.rcFlags, '--remote=none']], 'Aspect (cache disabled)')
    // Not configured, whether or not the rc was written: the caller uses this
    // to decide whether the job has any cache at all.
    return false
  }

  // Whatever the workflow configured, then nothing. Unconfigured means an
  // unadorned `aspect setup bazelrc`, which is the point: the CLI detects CI
  // and picks the home rc itself, so the action has no opinion to add. The bare
  // retry is for a CLI too old to know a flag that was configured — better it
  // writes the rc it can than none at all.
  if (await runBazelrcTask([config.rcFlags, []], 'Aspect remote cache')) return true

  core.warning(
    'This Aspect CLI cannot run `aspect setup bazelrc`, so `bazel` will ' +
    `not reach the Aspect remote cache (${ASPECT_CLI_RELEASES_URL}). ` +
    'Upgrade the CLI, or set `disk-cache: true` to cache through GitHub Actions instead.'
  )
  return false
}

/**
 * Legacy fallback generator, for runners whose CLI predates the bazelrc task.
 *
 * `rosetta bazelrc` reads `.aspect/workflows/config.yaml` by default and fails
 * if that file is absent, so it's pointed at a throwaway config (the schema
 * needs a non-empty task list, hence a single placeholder task). It also
 * resolves the Bazel version from the repo's `.bazelversion` with no fallback,
 * so a missing file is fatal; we pre-flight that for an actionable message.
 * setup-aspect runs after `actions/checkout`, so `.bazelversion` (if committed)
 * is at the workspace root. Returns true on success, false otherwise — a
 * failure degrades to the upgrade-hint warning rather than failing the action.
 */
async function rosettaBazelrc () {
  if (!(await onPath('rosetta'))) return false

  if (!fs.existsSync('.bazelversion')) {
    core.warning(
      'No `.bazelversion` file found in the repository root. The legacy ' +
      '`rosetta bazelrc` fallback resolves the Bazel version from ' +
      '`.bazelversion` and has no fallback, so it cannot generate the ' +
      'Workflows-tuned Bazel rc. Commit a `.bazelversion` (the same file ' +
      'Bazelisk reads), and make sure setup-aspect runs after `actions/checkout`.'
    )
    return false
  }

  core.startGroup('Write /etc/bazel.bazelrc via `rosetta bazelrc`')
  try {
    const dummyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-aspect-rosetta-'))
    const dummyConfig = path.join(dummyDir, 'config.yaml')
    fs.writeFileSync(dummyConfig, 'tasks:\n  - warming:\n')
    let rcContent = ''
    const code = await exec.exec('rosetta', ['bazelrc', '--config', dummyConfig], {
      ignoreReturnCode: true,
      listeners: { stdout: (data) => { rcContent += data.toString() } },
    })
    if (code !== 0) {
      core.warning(`\`rosetta bazelrc\` failed (exit ${code}); see its error above. ${config.paths.systemBazelrc} was left unchanged.`)
      return false
    }
    fs.writeFileSync(config.paths.systemBazelrc, rcContent)
    core.info(`Wrote Workflows-tuned bazelrc to ${config.paths.systemBazelrc}`)
    printBazelrc(config.paths.systemBazelrc)
    return true
  } catch (err) {
    core.warning(`\`rosetta bazelrc\` failed: ${err.message || err}. ${config.paths.systemBazelrc} was left unchanged.`)
    return false
  } finally {
    core.endGroup()
  }
}

/**
 * Configure vanilla `bazel` calls. If no generator can run, warn — but do NOT
 * fail the action: warming has already completed and `aspect <task>` steps
 * still work; only vanilla `bazel` calls go unconfigured.
 */
async function writeBazelrc () {
  if (await aspectSetupBazelrc()) return
  if (await rosettaBazelrc()) return

  core.warning(
    'Could not configure vanilla `bazel` calls on this Workflows runner: ' +
    'no bazelrc generator is available. ' +
    'Warming completed and `aspect <task>` steps are unaffected, ' +
    'but vanilla `bazel` calls will not pick up the runner\'s remote cache, ' +
    'repository cache, or disk cache and so will not function correctly. ' +
    `Upgrade aspect-cli to ${ASPECT_SETUP_BAZELRC_MIN_VERSION} or newer for \`aspect setup bazelrc\` (${ASPECT_CLI_RELEASES_URL}).`
  )
}

// Diagnostic dump of the runner's identity, mirroring the `aspect` CLI's own
// "Workflows runner metadata" block. Surfaced so a failure in this step is
// traceable to a specific runner instance. Each row prints only when its env
// var is set — fields vary by cloud provider and runner version. `yesno`
// renders the `1`/unset boolean flags as `yes`/`no`; ordering follows the CLI.
const yesno = (v) => (v ? 'yes' : 'no')
const WORKFLOWS_METADATA_ROWS = [
  ['Workflows version', 'ASPECT_WORKFLOWS_RUNNER_VERSION'],
  ['Cloud provider', 'ASPECT_WORKFLOWS_RUNNER_CLOUD_PROVIDER', (v) => v.toUpperCase()],
  ['Region', 'ASPECT_WORKFLOWS_RUNNER_REGION'],
  ['Availability zone', 'ASPECT_WORKFLOWS_RUNNER_AZ'],
  ['Cloud account', 'ASPECT_WORKFLOWS_RUNNER_CLOUD_ACCOUNT'],
  ['Instance type', 'ASPECT_WORKFLOWS_RUNNER_INSTANCE_TYPE'],
  ['Instance name', 'ASPECT_WORKFLOWS_RUNNER_INSTANCE_NAME'],
  ['Instance ID', 'ASPECT_WORKFLOWS_RUNNER_INSTANCE_ID'],
  ['Image ID', 'ASPECT_WORKFLOWS_RUNNER_IMAGE_ID'],
  ['Group name', 'ASPECT_WORKFLOWS_RUNNER_GROUP_NAME'],
  ['Group queue', 'ASPECT_WORKFLOWS_RUNNER_GROUP_QUEUE'],
  ['Resource type', 'ASPECT_WORKFLOWS_RUNNER_RESOURCE_TYPE'],
  ['Aspect launcher version', 'ASPECT_WORKFLOWS_RUNNER_ASPECT_LAUNCHER_VERSION'],
  ['CI agent version', 'ASPECT_WORKFLOWS_RUNNER_CI_AGENT_VERSION'],
  ['NVMe storage', 'ASPECT_WORKFLOWS_RUNNER_HAS_NVME_STORAGE', yesno],
  ['Preemptible', 'ASPECT_WORKFLOWS_RUNNER_PREEMPTIBLE', yesno],
  ['Warming enabled', 'ASPECT_WORKFLOWS_RUNNER_WARMING_ENABLED', yesno],
]

function logWorkflowsRunnerMetadata () {
  core.startGroup('Workflows runner metadata')
  try {
    for (const [label, envVar, format] of WORKFLOWS_METADATA_ROWS) {
      const raw = process.env[envVar]
      if (raw === undefined || raw === '') continue
      core.info(`${label}: ${format ? format(raw) : raw}`)
    }
  } finally {
    core.endGroup()
  }
}

/**
 * Block until the runner's cache warming completes, mirroring the Aspect
 * CLI's pre-task wait (aspect-cli `lib/health_check.axl::_wait_for_warming`).
 * `aspect <task>` performs this wait itself, but vanilla `bazel` calls later in
 * the job would otherwise race the still-running bootstrap warming —
 * competing with it for CPU/disk and missing the warmed caches.
 *
 * Warming state is published by the runner agent: enabled when
 * `ASPECT_WORKFLOWS_RUNNER_WARMING_ENABLED` is set, complete when the marker
 * file named by `ASPECT_WORKFLOWS_RUNNER_WARMING_COMPLETE_MARKER_FILE`
 * exists. The poll has no timeout by design: if warming hits a critical
 * error the bootstrap terminates the runner (and this job with it), so the
 * loop cannot hang indefinitely. Will be replaced by a dedicated Aspect CLI
 * health-check command once one is available.
 */
async function waitForWarming () {
  if (!process.env.ASPECT_WORKFLOWS_RUNNER_WARMING_ENABLED) return

  const markerFile = process.env.ASPECT_WORKFLOWS_RUNNER_WARMING_COMPLETE_MARKER_FILE
  if (!markerFile) {
    core.warning(
      'Warming is enabled on this runner but ' +
      'ASPECT_WORKFLOWS_RUNNER_WARMING_COMPLETE_MARKER_FILE is not set — ' +
      'unable to wait for warming to complete.'
    )
    return
  }

  if (!fs.existsSync(markerFile)) {
    core.startGroup('Wait for runner cache warming to complete')
    try {
      core.info('Warming is still in progress — waiting...')
      const start = Date.now()
      while (!fs.existsSync(markerFile)) {
        await setTimeout(1000)
      }
      core.info(`Warming completed after ${Math.round((Date.now() - start) / 1000)}s`)
    } finally {
      core.endGroup()
    }
  }

  const cacheVersionFile = process.env.ASPECT_WORKFLOWS_RUNNER_WARMING_CACHE_VERSION_FILE
  if (cacheVersionFile && fs.existsSync(cacheVersionFile)) {
    const cacheVersion = fs.readFileSync(cacheVersionFile, 'utf8').trim()
    if (cacheVersion) {
      core.info(`Runner warmed from cache version: ${cacheVersion}`)
    }
  }
}

// ─── Ephemeral-runner branch ─────────────────────────────────────────────────

async function setupOnEphemeralRunner () {
  // `launcher-install: false` lets the caller provide their own `aspect`
  // binary (a manual install step, a build-from-source step, etc.). When
  // disabled, the caller is responsible for putting `aspect` on PATH
  // before any later step that needs it.
  if (config.launcherInstall) {
    await installLauncher(config.launcherVersion)
  } else {
    core.info('launcher-install: false — skipping Aspect CLI launcher install')
  }
  await installBazelisk(config.bazeliskVersion)

  // Restore before the first `aspect` call so the cli isn't re-downloaded on
  // warm runs; `config.caches` is ordered cli-caches-first.
  const enabled = config.caches.filter(c => c.enabled)
  if (enabled.length > 0) {
    // Jitter once before the first cache-service call to soften thundering-herd
    // 429s when many jobs start at once.
    await setTimeout(Math.random() * 1000)
    for (const cacheConfig of enabled) {
      await restoreCache(cacheConfig)
    }
  }

  // Auth before the rc is generated: the rc task enables a deployment's
  // endpoints only where something here can authenticate them, and a failed
  // exchange is what tells `writeCloudBazelrc` to write them disabled.
  const authenticated = await loginIfApiToken()

  let remoteCacheConfigured = false
  if (config.generateBazelrc) {
    remoteCacheConfigured = await writeCloudBazelrc(authenticated)
  } else {
    core.info('bazelrc-generate: false — leaving Bazel\'s configuration to this repository.')
  }

  // Last, so these lines sit below the `try-import` the rc task adds at the top
  // of `~/.bazelrc`. Bazel takes the last value of a flag, so that is what lets
  // them override the generated rc.
  if (config.bazelrcUpdatesEnabled) {
    setupBazelrc()
  }

  warnIfUncached(remoteCacheConfigured)
}

/**
 * Warn when the job ends up with no Bazel cache at all. `disk-cache` is off by
 * default now that the remote cache replaces it, so a job whose remote cache
 * also failed to configure would quietly rebuild everything every run — slower
 * CI with nothing in the log to explain it.
 */
function warnIfUncached (remoteCacheConfigured) {
  if (remoteCacheConfigured || config.diskCache.enabled) return
  core.warning(
    'This job has no Bazel cache: `~/.bazelrc` was not pointed at an Aspect ' +
    'remote cache, and `disk-cache` is disabled, so every build starts cold. ' +
    'Leave `bazelrc-generate` on to use the Aspect remote cache, or set ' +
    '`disk-cache: true` for a GitHub Actions-backed disk cache instead.'
  )
}

function setupBazelrc () {
  core.startGroup(`Configure ${config.paths.userBazelrc}`)
  try {
    const directives = []
    if (config.diskCache.enabled) {
      directives.push(`build --disk_cache=${config.paths.bazelDiskCache}`)
    }
    if (config.repositoryCache.enabled) {
      directives.push(`common --repository_cache=${config.paths.bazelRepositoryCache}`)
    }
    directives.push(...config.userBazelrcLines)

    const appended = appendBazelrcOnce(config.paths.userBazelrc, directives)
    if (appended.length === 0) {
      core.info(`${config.paths.userBazelrc} already up to date — no directives appended`)
    } else {
      core.info(
        `Updated ${config.paths.userBazelrc} with ${appended.length} directive(s):\n` +
        appended.map(d => `  ${d}`).join('\n')
      )
    }
  } finally {
    core.endGroup()
  }
}

async function restoreCache (cacheConfig) {
  if (!cacheConfig.enabled) return

  core.startGroup(`Restore ${cacheConfig.name} cache`)
  try {
    const { key, restoreKey } = await composeCacheKey(config.baseCacheKey, cacheConfig)
    const restoredKey = await cache.restoreCache(
      cacheConfig.paths, key, [restoreKey],
      { segmentTimeoutInMs: 300000 }
    )

    if (!restoredKey) {
      core.info(`No cache found for ${cacheConfig.name}`)
      return
    }
    core.info(`Restored cache from ${restoredKey}`)
    if (restoredKey === key) {
      // Exact match — content unchanged, post.js will skip the save.
      core.saveState(`${cacheConfig.name}-cache-hit`, 'true')
    }
  } catch (err) {
    core.warning(`Failed to restore ${cacheConfig.name} cache: ${err.message || err}`)
  } finally {
    core.endGroup()
  }
}

// ─── Cross-mode: auth + permission checks ────────────────────────────────────

/**
 * Exchange the long-lived `ASPECT_API_TOKEN` for a session JWT via the
 * CLI's `aspect auth login --with-api-token` (stdin-fed). The JWT is
 * persisted locally; downstream `aspect <task>` calls pick it up via
 * `ctx.aspect.auth.credentials()` without seeing the long-lived token.
 *
 * Failures are warned-not-failed so a missing token doesn't break tasks
 * that don't need Aspect API access.
 */
async function loginIfApiToken () {
  if (!config.aspectApiToken) return true

  core.startGroup('Exchange ASPECT_API_TOKEN for a session JWT')
  try {
    core.setSecret(config.aspectApiToken)
    await exec.exec('aspect', ['auth', 'login', '--with-api-token'], {
      input: Buffer.from(config.aspectApiToken),
    })
    core.info('Persisted Aspect session JWT for downstream `aspect` invocations')
    return true
  } catch (err) {
    core.warning(
      `aspect auth login --with-api-token failed: ${err.message || err}. ` +
      'Downstream tasks that need Aspect API access will fail to authenticate.'
    )
    return false
  } finally {
    core.endGroup()
  }
}

function warnIfIdTokenMissing () {
  if (process.env.ACTIONS_ID_TOKEN_REQUEST_URL) return
  core.warning(
    '`permissions: id-token: write` is not granted to this job. Aspect ' +
    'features that use the GHA artifact API (e.g. ArtifactUpload) will be ' +
    'disabled. To enable, add:\n' +
    '\n' +
    '  permissions:\n' +
    '    id-token: write\n' +
    '\n' +
    'to your workflow or job. See ' +
    'https://docs.aspect.build/cli/authentication for details.'
  )
}

run()
