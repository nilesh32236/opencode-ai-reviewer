#!/usr/bin/env bash
#
# Verify the committed action bundles are fresh.
#
# The action executes the committed bundles (action/lib/*.js), NOT src/. A stale
# bundle ships unreviewed code in place of the reviewed source, so a rebuild that
# differs from what is committed must fail.
#
# This is the CI gate from .github/workflows/ci.yml ("Verify committed action
# bundles are fresh"), extracted so it can be run locally with the SAME logic.
# That matters because the failure it guards against is invisible to `pnpm test`,
# `pnpm lint` and `pnpm typecheck`: all three pass against src/ while a stale
# bundle keeps executing old code. Several autofix PRs in this repo failed CI on
# exactly this and nothing else (see DECISIONS.md D-095, D-096, D-097).
#
# Usage:
#   pnpm bundles:check          # rebuild, then diff
#
# Build order is significant: lib must be built before action, because action's
# bundle is compiled FROM lib/dist. CI builds them in that order; doing it the
# other way round produces a bundle that no later build reproduces.

set -euo pipefail

# Resolve the repo root. This script lives at scripts/, so it is ONE level up from
# the root, not two — an earlier `../..` silently resolved to the parent of the repo
# and diffed a directory that is not a git working tree.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

echo '==> Building lib (action compiles from lib/dist)'
pnpm --filter @opencode-pr-agent/lib build

echo '==> Building action'
pnpm --filter @opencode-pr-agent/action build

# `git -C` rather than a bare `git diff`: pnpm --filter runs the package build from the
# package's own directory, so a relative `git diff` can end up outside the working tree
# and report "Not a git repository" — which this script would misread as a stale bundle.
if ! git -C "$repo_root" diff --exit-code -- action/lib/; then
  echo "ERROR: committed action bundles are stale — run 'pnpm --filter @opencode-pr-agent/action build' and commit the result." >&2
  exit 1
fi

echo "Committed action bundles are fresh."
