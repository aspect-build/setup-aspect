// Aspect Build — Apache 2.0

/**
 * What the action makes of the version `aspect version` reports, and how it
 * compares to the minimum it supports.
 *
 * The reading and the comparison are the parts that decide whether a runner is
 * warned, and both have an answer that is easy to get subtly wrong: a build
 * that is not a release must not read as old, and `YYYY.WW.N` must compare as
 * numbers rather than as text.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { releaseVersion, versionAtLeast } from '../util.js'

describe('releaseVersion', () => {
  it('reads what a release build reports', () => {
    assert.equal(releaseVersion('2026.38.34'), '2026.38.34')
    assert.equal(releaseVersion('2026.38.34\n'), '2026.38.34')
  })

  it('ignores a build that is not a release', () => {
    // What a locally built CLI reports; calling it old would warn every
    // developer running the action against their own build.
    assert.equal(releaseVersion('0.0.0-dev (debug build)'), null)
    assert.equal(releaseVersion('2026.38.34-rc1'), null)
  })

  it('ignores anything that is not a version at all', () => {
    assert.equal(releaseVersion(''), null)
    assert.equal(releaseVersion(undefined), null)
    assert.equal(releaseVersion('error: unrecognized subcommand'), null)
  })
})

describe('versionAtLeast', () => {
  it('is true at and above the minimum', () => {
    assert.equal(versionAtLeast('2026.38.34', '2026.38.34'), true)
    assert.equal(versionAtLeast('2026.38.35', '2026.38.34'), true)
    assert.equal(versionAtLeast('2026.39.0', '2026.38.34'), true)
    assert.equal(versionAtLeast('2027.1.0', '2026.38.34'), true)
  })

  it('is false below it', () => {
    assert.equal(versionAtLeast('2026.38.30', '2026.38.34'), false)
    assert.equal(versionAtLeast('2026.37.99', '2026.38.34'), false)
    assert.equal(versionAtLeast('2025.52.1', '2026.38.34'), false)
  })

  it('compares components as numbers', () => {
    // Each of these is newer than the minimum but sorts before it as text.
    assert.equal(versionAtLeast('2026.38.9', '2026.38.34'), false)
    assert.equal(versionAtLeast('2026.39.9', '2026.38.34'), true)
    assert.equal(versionAtLeast('2026.38.100', '2026.38.34'), true)
  })
})
