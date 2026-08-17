// Portions of this file are adapted from https://github.com/bazel-contrib/setup-bazel
// Copyright (c) 2023 Alex Rodionov — MIT License (see THIRD_PARTY_NOTICES.md)

/**
 * Download + tool-cache install of the Aspect CLI launcher and Bazelisk.
 *
 * Both resolve an asset URL on github.com, then share `cacheDownload`:
 * download, chmod +x, `tc.cacheFile` into the runner tool cache, and the
 * caller `addPath`s the result to expose `aspect` / `bazel`. URL
 * resolution differs — see `downloadLauncher` and `downloadBazelisk`.
 *
 * Tool-cache lookup is skipped for the special version string `latest` —
 * the same input string maps to a potentially-different release over
 * time, so a hit on a persistent (self-hosted) runner would serve a
 * stale binary indefinitely.
 */

import fs from 'fs'
import * as core from '@actions/core'
import * as github from '@actions/github'
import * as io from '@actions/io'
import * as tc from '@actions/tool-cache'

/**
 * Install the Aspect CLI launcher and put `aspect` on PATH.
 *
 * @param {string} version — pinned launcher version (e.g. "2026.22.39"),
 *                           or empty string for the latest release.
 */
export async function installLauncher (version) {
  const cacheKey = version || 'latest'
  core.startGroup(`Install Aspect CLI launcher (${cacheKey})`)
  try {
    const toolPath = await findOrDownload({
      tool: 'aspect-launcher',
      version,
      download: () => downloadLauncher(version),
    })
    core.addPath(toolPath)
  } finally {
    core.endGroup()
  }
}

/**
 * Install Bazelisk and put `bazel` on PATH. No-op when `bazel` is already
 * on PATH (setup-bazel ran first, Workflows runner image, etc.).
 *
 * @param {string} version — semver range (e.g. `1.x`), exact (`1.21.0`),
 *                           or `latest` (the default).
 */
export async function installBazelisk (version) {
  if (await onPath('bazel')) {
    core.info('`bazel` already on PATH — skipping Bazelisk install')
    return
  }

  core.startGroup(`Install Bazelisk ${version}`)
  try {
    const toolPath = await findOrDownload({
      tool: 'bazelisk',
      version,
      download: () => downloadBazelisk(version),
    })
    core.addPath(toolPath)
  } finally {
    core.endGroup()
  }
}

/**
 * Look up `tool` at `version` in the runner tool cache; on miss, call
 * `download()` to fetch + cache it. `latest` always misses (see file
 * docstring).
 */
async function findOrDownload ({ tool, version, download }) {
  if (version && version !== 'latest') {
    const hit = tc.find(tool, version)
    if (hit) {
      core.info(`${tool} ${version} found in tool cache: ${hit}`)
      return hit
    }
  }
  return download()
}

// Launcher asset names mirror install.aspect.build:
//   aspect-launcher-<arch>-<platform>
const LAUNCHER_ARCH = { x64: 'x86_64', arm64: 'aarch64' }
const LAUNCHER_PLATFORM = { darwin: 'apple-darwin', linux: 'unknown-linux-musl' }

async function downloadLauncher (version) {
  const arch = lookup(LAUNCHER_ARCH, process.arch, 'arch', 'Aspect CLI launcher')
  const platform = lookup(LAUNCHER_PLATFORM, process.platform, 'platform', 'Aspect CLI launcher')
  const filename = `aspect-launcher-${arch}-${platform}`
  const url = version
    ? `https://github.com/aspect-build/aspect-cli/releases/download/v${version.replace(/^v/, '')}/${filename}`
    : `https://github.com/aspect-build/aspect-cli/releases/latest/download/${filename}`

  return cacheDownload({
    tool: 'aspect-launcher',
    binary: 'aspect',
    version: version || 'latest',
    url,
  })
}

// Bazelisk uses different arch/platform naming than the Aspect launcher.
const BAZELISK_ARCH = { x64: 'amd64', arm64: 'arm64' }
const BAZELISK_PLATFORM = { darwin: 'darwin', linux: 'linux' }

async function downloadBazelisk (version) {
  const arch = lookup(BAZELISK_ARCH, process.arch, 'arch', 'Bazelisk')
  const platform = lookup(BAZELISK_PLATFORM, process.platform, 'platform', 'Bazelisk')
  const filename = `bazelisk-${platform}-${arch}`

  // Three URL paths, ordered by API-call cost:
  //   1. `latest` — GitHub's /releases/latest/download/<asset> redirect.
  //   2. Exact `x.y.z` — deterministic /releases/download/v<x.y.z>/<asset>.
  //   3. Semver range (`1.x`, `>=1.20`) — api.github.com release list +
  //      `tc.evaluateVersions`. The only path that consumes rate budget;
  //      shared CI egress makes anonymous limits painful, so we recommend
  //      pinning an exact version or sticking with `latest`.
  const EXACT_VERSION = /^v?\d+\.\d+\.\d+$/
  let url
  let cacheVersion = version
  if (version === 'latest') {
    url = `https://github.com/bazelbuild/bazelisk/releases/latest/download/${filename}`
  } else if (EXACT_VERSION.test(version)) {
    const tag = version.startsWith('v') ? version : `v${version}`
    url = `https://github.com/bazelbuild/bazelisk/releases/download/${tag}/${filename}`
  } else {
    const resolved = await resolveBazeliskRange(version, filename)
    url = resolved.url
    cacheVersion = resolved.tag // cache under the resolved tag, not the range
  }

  return cacheDownload({
    tool: 'bazelisk',
    binary: 'bazel',
    version: cacheVersion,
    url,
  })
}

/**
 * Resolve a Bazelisk semver range (e.g. `1.x`) to a concrete asset URL
 * via the GitHub releases API. The only code path here that makes an
 * authenticated API call.
 */
async function resolveBazeliskRange (versionRange, filename) {
  const token = process.env.BAZELISK_GITHUB_TOKEN || ''
  const octokit = github.getOctokit(token, { baseUrl: 'https://api.github.com' })
  let releases
  try {
    ({ data: releases } = await octokit.rest.repos.listReleases({
      owner: 'bazelbuild',
      repo: 'bazelisk',
    }))
  } catch (err) {
    throw githubFailure({
      what: 'the Bazelisk release list',
      url: 'https://api.github.com/repos/bazelbuild/bazelisk/releases',
      err,
    })
  }
  const tag = tc.evaluateVersions(releases.map(r => r.tag_name), versionRange)
  const release = releases.find(r => r.tag_name === tag)
  if (!release) {
    throw new Error(`Unable to find Bazelisk version ${versionRange}`)
  }
  const asset = release.assets.find(a => a.name === filename)
  if (!asset) {
    throw new Error(`Bazelisk ${tag} has no asset named ${filename}`)
  }
  return { url: asset.browser_download_url, tag }
}

/**
 * Download a binary, chmod +x, and put it in the runner tool cache as
 * `${binary}` under `${tool}/${version}`. Returns the cache directory
 * path (suitable for `core.addPath`).
 */
async function cacheDownload ({ tool, binary, version, url }) {
  core.info(`Downloading ${tool} from ${url}`)
  let downloadPath
  try {
    downloadPath = await tc.downloadTool(url)
  } catch (err) {
    throw githubFailure({ what: tool, url, err })
  }
  fs.chmodSync(downloadPath, '755')
  const cachePath = await tc.cacheFile(downloadPath, binary, tool, version)
  core.info(`Cached ${tool} to ${cachePath}`)
  return cachePath
}

const GITHUB_STATUS_URL = 'https://www.githubstatus.com'

/**
 * Wrap a failed GitHub download or API error with an actionable message.
 * Distinguishes "this version/asset doesn't exist" (404), rate limiting
 * (403/429), bad credentials (401), other client-side errors (4xx), and
 * "GitHub is down or unreachable" (5xx and network-level errors like
 * `socket hang up`) — pointing at the GitHub status page only where a
 * retry is the likely fix. The original error is preserved as `cause`.
 */
function githubFailure ({ what, url, err }) {
  // tc.downloadTool throws tc.HTTPError (httpStatusCode); octokit throws
  // RequestError (status). Network-level failures have neither.
  const status = err instanceof tc.HTTPError ? err.httpStatusCode : err?.status
  let detail
  if (status === 404) {
    detail =
      'GitHub responded with HTTP 404 (not found) — check that the ' +
      'requested version exists and provides an asset for this platform.'
  } else if (status === 403 || status === 429) {
    detail =
      `GitHub responded with HTTP ${status} — likely rate limiting on ` +
      `shared CI egress. Re-run the job later, or check ${GITHUB_STATUS_URL} ` +
      'for an ongoing incident.'
  } else if (status === 401) {
    detail =
      'GitHub responded with HTTP 401 (unauthorized) — check the supplied ' +
      'token (e.g. BAZELISK_GITHUB_TOKEN).'
  } else if (status >= 400 && status < 500 && status !== 408) {
    // 408 (request timeout) is transient and retried by tool-cache; when
    // retries are exhausted it takes the retry guidance below instead.
    detail =
      `GitHub rejected the request with HTTP ${status}. This is a ` +
      'client-side error — check the request rather than retrying.'
  } else if (status) {
    detail =
      `GitHub responded with HTTP ${status}. This is likely a GitHub-side ` +
      `problem — check ${GITHUB_STATUS_URL} and re-run the job once it recovers.`
  } else {
    detail =
      `${err?.message || err}. github.com appears to be unreachable or ` +
      `down — check ${GITHUB_STATUS_URL} and re-run the job once it recovers.`
  }
  return new Error(`Failed to download ${what} from ${url}: ${detail}`, { cause: err })
}

/** Look up `key` in `map`; throw with a tool-named error on miss. */
function lookup (map, key, kind, toolDisplayName) {
  const v = map[key]
  if (!v) throw new Error(`Unsupported ${kind} for ${toolDisplayName}: ${key}`)
  return v
}

/**
 * True if `binary` resolves on the current PATH. Wrapper around
 * `io.which` so the on-miss behavior (no throw) is explicit at call sites.
 */
export async function onPath (binary) {
  const path = await io.which(binary, false)
  return !!path
}
