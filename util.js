// Aspect Build — Apache 2.0

/**
 * Shared helpers: bazelrc directive appending and GHA cache key
 * composition. Both `index.js` (restore) and `post.js` (save) build cache
 * keys here so the two always hash file lists with identical options —
 * otherwise an identical tree could hash differently and defeat the
 * exact-key save-skip.
 */

import fs from 'fs'
import * as glob from '@actions/glob'

const ASPECT_MARKER = '# Added by aspect-build/setup-aspect'

/**
 * Compose the cache key for `cacheConfig`: the run-wide `baseCacheKey`, the
 * cache's `name`, and a hash of its `files`. Returns `{ key, restoreKey }`,
 * where `restoreKey` is the same string minus the trailing hash — passed to
 * `restoreCache` as a prefix fallback so a near-miss still restores something.
 *
 * `files` may be empty (e.g. the version-keyed cli cache), in which case the
 * hash is empty and `key === restoreKey`.
 *
 * @param {string} baseCacheKey
 * @param {{ name: string, files: string[] }} cacheConfig
 * @returns {Promise<{ key: string, restoreKey: string }>}
 */
export async function composeCacheKey (baseCacheKey, cacheConfig) {
  const hash = await glob.hashFiles(
    cacheConfig.files.join('\n'),
    undefined,
    // Symlink follow is slow on macOS and not what we want here.
    { followSymbolicLinks: false }
  )
  const restoreKey = `${baseCacheKey}-${cacheConfig.name}-`
  return { key: `${restoreKey}${hash}`, restoreKey }
}

/**
 * Append bazelrc directives to a file, but only the lines not already
 * present. Idempotent across runs and friendly when a sibling action
 * (e.g. setup-bazel) has already populated some directives.
 *
 * Adds an `ASPECT_MARKER` comment line on first write so our block is
 * findable on later runs. Dedup compares against the full file, not just
 * our block — if the user has added the same directive elsewhere we
 * don't duplicate it.
 *
 * @param {string} bazelrcPath — absolute path to the rc file.
 * @param {string[]} directives — lines to append.
 * @returns {string[]} the directives actually appended (those not already
 *   present); empty when the file was left untouched.
 */
export function appendBazelrcOnce (bazelrcPath, directives) {
  const existing = fs.existsSync(bazelrcPath)
    ? fs.readFileSync(bazelrcPath, 'utf8')
    : ''

  // Existing non-comment, non-blank lines, normalized for comparison.
  const existingLines = new Set(
    existing
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
  )

  const toAppend = directives.filter(
    d => d.trim() && !existingLines.has(d.trim())
  )
  if (toAppend.length === 0) return []

  const markerAlreadyPresent = existing.includes(ASPECT_MARKER)
  const leading = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
  const header = markerAlreadyPresent ? '' : `${ASPECT_MARKER}\n`
  fs.appendFileSync(bazelrcPath, `${leading}${header}${toAppend.join('\n')}\n`)
  return toAppend
}

/** A release version: `YYYY.WW.N`, and nothing else. */
const RELEASE_VERSION_RE = /^\d+\.\d+\.\d+$/

/**
 * The release version in `reported` — what `aspect version` printed — or `null`
 * when it is not one.
 *
 * A build that is not a release says so in a form of its own
 * (`0.0.0-dev (debug build)`), and comes back null so the caller leaves it
 * alone rather than calling it old.
 */
export function releaseVersion (reported) {
  const trimmed = (reported ?? '').split('\n')[0].trim()
  return RELEASE_VERSION_RE.test(trimmed) ? trimmed : null
}

/**
 * Whether version `have` is at least `want`, compared as numbers component by
 * component: 2026.38.34 is newer than 2026.38.9, which a string compare gets
 * backwards.
 */
export function versionAtLeast (have, want) {
  const left = have.split('.').map(Number)
  const right = want.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l !== r) return l > r
  }
  return true
}
