#!/usr/bin/env bash
# Compute the bare release version for the current HEAD as `YYYY.VV.N`, where
# `YYYY.VV` is the most recent weekly tag (see weekly_tag.yaml) and `N` is the
# number of commits since it. This makes a release a precise, collision-free
# point on top of the weekly cadence — e.g. 3 commits past tag `2026.22` is
# `2026.22.3`. Mirrors aspect-build/aspect-cli's STABLE_MONOREPO_SHORT_VERSION,
# simplified to just what this repo needs.
#
# Emits the BARE version (no `v` prefix) so the describe-match against the bare
# weekly tags keeps working; the caller prepends `v` for the release tag
# (`vYYYY.VV.N`, matching the Aspect CLI). Requires full tag history
# (`fetch-depth: 0`). Prints the version to stdout.

set -o errexit -o nounset -o pipefail

# `--long` always appends `-<N>-g<sha>` even when HEAD is exactly on a tag, so
# the parse below is uniform. The two --match globs cover weeks 1–9 and 10–59.
# No weekly tag yet (e.g. a fresh repo before the first weekly run): fall back
# to this week's `YYYY.VV.0`.
if ! described=$(git describe --tags --long \
  --match='2[0-9][0-9][0-9].[1-9]' \
  --match='2[0-9][0-9][0-9].[1-5][0-9]' 2>/dev/null); then
  echo "$(date +%G.%-V).0"
  exit 0
fi

# `2026.22-3-g201b9a8` -> drop the `-g<sha>` suffix (`2026.22-3`), then turn the
# single remaining dash into a dot: `2026.22.3`.
counted="${described%-g*}"
echo "${counted/-/.}"
