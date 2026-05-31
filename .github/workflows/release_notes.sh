#!/usr/bin/env bash
# Emit the release-notes body for a setup-aspect release. The headline content
# is a copy-paste `uses:` snippet pinned to the released commit SHA — pinning to
# the immutable SHA (not the mutable tag) is the recommended practice; see the
# README and CONTRIBUTING.md. GitHub appends its auto-generated changelog below
# this body (generate_release_notes: true).
#
# Required env: REPO (owner/name), SHA (full 40-char commit), TAG (e.g. 2026.22.3).

set -o errexit -o nounset -o pipefail

cat <<EOF
### Pin this release

Pin to the **commit SHA**, not the tag — tags are mutable, so SHA-pinning is the
[recommended](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions#using-third-party-actions)
way to consume a third-party action. Dependabot and Renovate keep the SHA fresh.

\`\`\`yaml
- uses: ${REPO}@${SHA} # ${TAG}
\`\`\`
EOF
