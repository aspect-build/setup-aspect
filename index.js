// Portions of this file are adapted from https://github.com/bazel-contrib/setup-bazel
// Copyright (c) 2023 Alex Rodionov — MIT License (see THIRD_PARTY_NOTICES.md)

/**
 * setup-aspect main entry: install the Aspect CLI launcher, install
 * Bazelisk (unless `bazel` is already on PATH), configure Bazel for CI
 * caching, and authenticate with the Aspect API via the JWT-persist
 * flow. On Aspect Workflows runners the action takes a much narrower
 * path — see `setupOnWorkflowsRunner` below.
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
    core.setFailed(error.stack || error.message || String(error))
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

  if (config.onWorkflowsRunner) {
    await setupOnWorkflowsRunner()
  } else {
    await setupOnEphemeralRunner()
  }

  // Auth runs in both modes — same JWT-persist benefit either way.
  await loginIfApiToken()
}

// ─── Workflows-runner branch ─────────────────────────────────────────────────

/**
 * On Aspect Workflows runners `aspect <task>` already routes through the
 * runner's caching infrastructure on its own — the launcher wires the
 * right flags regardless of any rc file. setup-aspect's job in this mode
 * is to extend the same treatment to *raw* `bazel <verb>` calls outside
 * of `aspect <task>`: wait for the runner's cache warming to complete
 * (which `aspect <task>` does on its own before running), and generate
 * the Workflows-tuned bazelrc via the runner-provided `rosetta` binary,
 * writing it to `/etc/bazel.bazelrc` (the first rc Bazel loads). The
 * installs and GHA caching are skipped because they aren't needed here:
 * the runner already has `aspect`/`bazel` available and routes Bazel
 * through its own caching infrastructure.
 */
async function setupOnWorkflowsRunner () {
  core.info('Detected Aspect Workflows runner (ASPECT_WORKFLOWS_RUNNER set)')
  core.info(
    'Skipping launcher install, Bazelisk install, GHA cache wiring, and ' +
    '~/.bazelrc append — not needed on Workflows runners.'
  )

  logWorkflowsRunnerMetadata()

  await waitForWarming()

  // The runner sets ASPECT_WORKFLOWS_RUNNER_BAZELRC_GENERATE during the
  // transition window where a newer bazelrc-generation mechanism is
  // available alongside the legacy `rosetta` binary. Warn early —
  // `rosetta` is guaranteed to be removed in a future major Aspect
  // Workflows release, at which point this version of setup-aspect will
  // stop configuring the environment for raw `bazel` calls.
  if (process.env.ASPECT_WORKFLOWS_RUNNER_BAZELRC_GENERATE) {
    markActionDeprecated(
      'This version of aspect-build/setup-aspect is out of date. The ' +
      'Aspect Workflows runner is signaling that a newer mechanism for ' +
      'configuring the Bazel environment is available ' +
      '(`ASPECT_WORKFLOWS_RUNNER_BAZELRC_GENERATE` is set). setup-aspect ' +
      'will continue to work in this Aspect Workflows version via the ' +
      'legacy `rosetta` fallback, but will stop configuring raw `bazel` ' +
      'calls after the next major Aspect Workflows release removes ' +
      '`rosetta`. Upgrade aspect-build/setup-aspect to the latest release.'
    )
  }

  if (!(await onPath('rosetta'))) {
    markActionDeprecated(
      '`rosetta` is not on PATH on this Workflows runner. setup-aspect ' +
      'expected to call `rosetta bazelrc > /etc/bazel.bazelrc` to populate ' +
      'the Workflows-tuned Bazel rc. Upgrade aspect-build/setup-aspect to ' +
      'the latest release to pick up the replacement mechanism.'
    )
    return
  }

  core.startGroup('Write /etc/bazel.bazelrc via `rosetta bazelrc`')
  try {
    // `rosetta bazelrc` reads `.aspect/workflows/config.yaml` by default and
    // fails the whole action if that file is absent or unreadable. We only
    // need the generated rc, not a real Workflows config, so point it at a
    // throwaway config. The schema requires a non-empty task list, so define a
    // single placeholder task.
    const dummyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-aspect-rosetta-'))
    const dummyConfig = path.join(dummyDir, 'config.yaml')
    fs.writeFileSync(dummyConfig, 'tasks:\n  - warming:\n')
    let rcContent = ''
    await exec.exec('rosetta', ['bazelrc', '--config', dummyConfig], {
      listeners: { stdout: (data) => { rcContent += data.toString() } },
    })
    fs.writeFileSync(config.paths.systemBazelrc, rcContent)
    core.info(`Wrote Workflows-tuned bazelrc to ${config.paths.systemBazelrc}`)
  } finally {
    core.endGroup()
  }
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
 * `aspect <task>` performs this wait itself, but raw `bazel` calls later in
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

  if (config.bazelrcUpdatesEnabled) {
    setupBazelrc()
  }

  // Restore before `loginIfApiToken` runs `aspect auth login` so the cli isn't
  // re-downloaded on warm runs; `config.caches` is ordered cli-caches-first.
  const enabled = config.caches.filter(c => c.enabled)
  if (enabled.length > 0) {
    // Jitter once before the first cache-service call to soften thundering-herd
    // 429s when many jobs start at once.
    await setTimeout(Math.random() * 1000)
    for (const cacheConfig of enabled) {
      await restoreCache(cacheConfig)
    }
  }
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
  if (!config.aspectApiToken) return

  core.startGroup('Exchange ASPECT_API_TOKEN for a session JWT')
  try {
    core.setSecret(config.aspectApiToken)
    await exec.exec('aspect', ['auth', 'login', '--with-api-token'], {
      input: Buffer.from(config.aspectApiToken),
    })
    core.info('Persisted Aspect session JWT for downstream `aspect` invocations')
  } catch (err) {
    core.warning(
      `aspect auth login --with-api-token failed: ${err.message || err}. ` +
      'Downstream tasks that need Aspect API access will fail to authenticate.'
    )
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

/**
 * Emit a `::warning::` and export `SETUP_ASPECT_GITHUB_ACTION_DEPRECATED=1`
 * to `GITHUB_ENV` so that downstream `aspect <task>` invocations can pick
 * up the same signal and surface it on their own status surfaces (task
 * summaries, BES reports, etc.) — without users having to scroll back to
 * the setup-aspect step in the GHA log to learn the action is out of date.
 */
function markActionDeprecated (warningMessage) {
  core.warning(warningMessage)
  core.exportVariable('SETUP_ASPECT_GITHUB_ACTION_DEPRECATED', '1')
}

run()
