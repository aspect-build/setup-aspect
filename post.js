// Portions of this file are adapted from https://github.com/bazel-contrib/setup-bazel
// Copyright (c) 2023 Alex Rodionov — MIT License (see THIRD_PARTY_NOTICES.md)

/**
 * Post-job entry: save the GHA caches that index.js restored. No-op on
 * Workflows runners (where we never restored anything).
 */

import * as cache from '@actions/cache'
import * as core from '@actions/core'
import config from './config.js'
import { composeCacheKey } from './util.js'

async function run () {
  if (config.onWorkflowsRunner) {
    process.exit(0)
  }
  for (const cacheConfig of config.caches) {
    await saveCache(cacheConfig)
  }
  process.exit(0)
}

async function saveCache (cacheConfig) {
  if (!cacheConfig.enabled) return

  // Skip if restore reported an exact-key hit — content didn't change.
  if (core.getState(`${cacheConfig.name}-cache-hit`) === 'true') {
    core.info(`${cacheConfig.name}: exact cache hit on restore, skipping save`)
    return
  }

  core.startGroup(`Save ${cacheConfig.name} cache`)
  try {
    const { key } = await composeCacheKey(config.baseCacheKey, cacheConfig)
    await cache.saveCache(cacheConfig.paths, key)
    core.info(`Saved ${cacheConfig.name} cache as ${key}`)
  } catch (err) {
    core.warning(`Failed to save ${cacheConfig.name} cache: ${err.message || err}`)
  } finally {
    core.endGroup()
  }
}

run()
