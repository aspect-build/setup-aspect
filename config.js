// Portions of this file are adapted from https://github.com/bazel-contrib/setup-bazel
// Copyright (c) 2023 Alex Rodionov — MIT License (see THIRD_PARTY_NOTICES.md)

/**
 * Parse action inputs and expose a structured config object.
 *
 * One canonical place for: input parsing, OS-specific path resolution,
 * cache key composition, and the Workflows-runner-vs-ephemeral branch
 * decision. Loaded at action start; the resulting object is immutable
 * for the rest of the run.
 */

import fs from 'fs'
import os from 'os'
import * as core from '@actions/core'

/**
 * Read the pinned aspect-cli version from `.aspect/version.axl`
 * (format: `version("2026.22.39")`) so the cli cache can key on the exact
 * version without a download. This is the same file the launcher itself
 * reads, independent of `launcher-version`. Returns '' when the file is
 * absent or unparseable.
 */
function resolveAspectCliVersion () {
  try {
    const m = fs.readFileSync('.aspect/version.axl', 'utf8').match(/version\("([^"]+)"\)/)
    return m ? m[1] : ''
  } catch {
    return ''
  }
}

const launcherVersion = core.getInput('launcher-version')
// `launcher-install: false` lets the caller provide their own `aspect`
// binary instead of having setup-aspect install the launcher — see
// action.yml's `launcher-install` docs.
const launcherInstall = core.getBooleanInput('launcher-install')
const aspectApiToken = core.getInput('aspect-api-token')
// Empty input falls back to `latest` to match the action.yml default. Guards
// against workflows that pass `bazelisk-version: ""` explicitly.
const bazeliskVersion = core.getInput('bazelisk-version') || 'latest'
const bazeliskCacheEnabled = core.getBooleanInput('bazelisk-cache')
const userBazelrcLines = core.getMultilineInput('bazelrc')

const homeDir = os.homedir()
const arch = os.arch()
const platform = os.platform()

// Aspect Workflows runners pre-install aspect + bazel and route Bazel through
// their own remote cache. setup-aspect detects this and skips launcher
// install, Bazelisk install, GHA cache wiring, and ~/.bazelrc updates — the
// only substantive step in that mode is writing /etc/bazel.bazelrc via
// `rosetta bazelrc`.
const onWorkflowsRunner = !!process.env.ASPECT_WORKFLOWS_RUNNER

const bazelDiskCachePath = `${homeDir}/.cache/bazel-disk`
const bazelRepositoryCachePath = `${homeDir}/.cache/bazel-repo`
const userBazelrcPath = `${homeDir}/.bazelrc`

// The launcher downloads the aspect-cli binary into ASPECT_LAUNCHER_CACHE; the
// cli then downloads its own runtime payloads into ASPECT_CLI_CACHE. index.js
// exports both env vars so `aspect` writes here instead of re-fetching over the
// network each run.
const aspectLauncherCachePath = `${homeDir}/.cache/aspect-launcher`
const aspectCliCachePath = `${homeDir}/.cache/aspect-cli`
const userCacheDir = platform === 'darwin'
  ? `${homeDir}/Library/Caches`
  : `${homeDir}/.cache`

// Distinct from setup-bazel's `setup-bazel-*` prefix so caches don't collide
// when both actions run in the same workflow.
const baseCacheKey = `setup-aspect-${platform}-${arch}`

// A string-tagged cache input is `false` (disabled), `true` (enabled, single
// shared cache), or any other string (enabled, segregated under that tag — a
// common pattern is `${{ github.workflow }}` for a per-workflow cache).
function taggedCacheEnabled (tag) {
  return !onWorkflowsRunner && tag !== 'false'
}
function taggedCacheName (base, tag) {
  return tag === 'true' ? base : `${base}-${tag}`
}

const diskCacheTag = core.getInput('disk-cache')
const repositoryCacheTag = core.getInput('repository-cache')
const diskCacheEnabled = taggedCacheEnabled(diskCacheTag)
const repositoryCacheEnabled = taggedCacheEnabled(repositoryCacheTag)

const bazelrcUpdatesEnabled =
  !onWorkflowsRunner &&
  (diskCacheEnabled || repositoryCacheEnabled || userBazelrcLines.length > 0)

// Each cache's `files` are hashed into its key, so a change to any of them
// invalidates the cache. `enabled: false` makes both restore and save no-ops.
const repositoryHashFiles = [
  'MODULE.bazel',
  'WORKSPACE.bazel',
  'WORKSPACE.bzlmod',
  'WORKSPACE',
]
const diskHashFiles = [...repositoryHashFiles, '**/BUILD.bazel', '**/BUILD']

const bazeliskCache = {
  enabled: bazeliskCacheEnabled && !onWorkflowsRunner,
  name: 'bazelisk',
  files: ['.bazelversion'],
  paths: [`${userCacheDir}/bazelisk`],
}
const diskCache = {
  enabled: diskCacheEnabled,
  name: taggedCacheName('disk', diskCacheTag),
  files: diskHashFiles,
  paths: [bazelDiskCachePath],
}
const repositoryCache = {
  enabled: repositoryCacheEnabled,
  name: taggedCacheName('repository', repositoryCacheTag),
  files: repositoryHashFiles,
  paths: [bazelRepositoryCachePath],
}

// The launcher/cli caches are enabled only on ephemeral runners and only when
// we own the launcher install (otherwise the caller's `aspect` controls
// downloads). Their roots are distinct so the two caches hash independently.
const launcherCliCacheEnabled = !onWorkflowsRunner && launcherInstall
const aspectCliVersion = resolveAspectCliVersion()
const aspectLauncherCache = {
  enabled: launcherCliCacheEnabled,
  name: 'aspect-launcher',
  // No repo file maps to the launcher's download dir, so hash its own contents.
  files: [`${aspectLauncherCachePath}/**/*`],
  paths: [aspectLauncherCachePath],
}
const aspectCliCache = {
  enabled: launcherCliCacheEnabled,
  // Prefer keying on the exact version (exact restore hit, clean bust on
  // upgrade). When the version is unknown, fall back to hashing the dir
  // contents — correct, but lags a version bump by one run.
  name: aspectCliVersion ? `aspect-cli-${aspectCliVersion}` : 'aspect-cli',
  files: aspectCliVersion ? [] : [`${aspectCliCachePath}/**/*`],
  paths: [aspectCliCachePath],
}

// Propagate GITHUB_TOKEN to Bazelisk's release-list API call (only used for
// semver-range version resolution, e.g. `bazelisk-version: 1.x`). Authenticated
// callers get a 5000/hr budget vs. 60/hr unauthenticated.
const githubToken = core.getInput('token') || process.env.GITHUB_TOKEN || ''
if (githubToken && !process.env.BAZELISK_GITHUB_TOKEN) {
  core.exportVariable('BAZELISK_GITHUB_TOKEN', githubToken)
}

export default {
  homeDir,
  arch,
  platform,
  onWorkflowsRunner,

  launcherVersion,
  launcherInstall,
  aspectApiToken,
  bazeliskVersion,
  userBazelrcLines,

  paths: {
    bazelDiskCache: bazelDiskCachePath,
    bazelRepositoryCache: bazelRepositoryCachePath,
    userBazelrc: userBazelrcPath,
    systemBazelrc: '/etc/bazel.bazelrc',
    aspectLauncherCache: aspectLauncherCachePath,
    aspectCliCache: aspectCliCachePath,
  },

  // Named cache configs — `enabled: false` makes restore + save no-ops. The
  // disk/repository configs are also read directly by the bazelrc step
  // (`enabled` and `paths`); the rest are only consumed via the `caches` array.
  bazeliskCache,
  diskCache,
  repositoryCache,
  aspectLauncherCache,
  aspectCliCache,

  // Ordered restore/save list. index.js restores in this order before the
  // first `aspect` call; post.js saves in the same order. The two aspect-*
  // caches come first so the cli is on disk before `aspect auth login` runs.
  caches: [
    aspectLauncherCache,
    aspectCliCache,
    bazeliskCache,
    diskCache,
    repositoryCache,
  ],

  bazelrcUpdatesEnabled,
  baseCacheKey,
}
