#!/usr/bin/env bash
#
# autofix-merge-gate.sh — shared green-checks gate for autofix merges.
#
# Verbatim port of the ai-review.yml `auto-merge` job gate
# (ai-review.yml "Merge autofix PR" step): pins the PR head SHA, polls
# statusCheckRollup (up to 20 attempts x 60s), normalizes CheckRuns +
# StatusContexts with jq, and fails closed on empty rollup / pending /
# failures / missing-or-non-SUCCESS required checks. Aborts cleanly when
# the head moves during the wait.
#
# Callers: .github/workflows/hourly-orchestrator.yml (ready-label merge
# site + inline-review merge site). ai-review.yml keeps its own inline
# copy (unchanged); this script exists so hourly merges enforce the SAME
# gate without triplicating the poll block (issue #735 / REF-004).
#
# Usage:
#   .github/scripts/autofix-merge-gate.sh <PR_NUMBER> [REPO] [EXPECTED_HEAD_SHA]
#
#   PR_NUMBER  pull request number (required)
#   REPO       owner/repo (default: $GITHUB_REPOSITORY)
#
# Exit codes:
#   0 = green — all REQUIRED checks SUCCESS, nothing pending/failed,
#       head still pinned. Caller may merge.
#   1 = defer/blocked — empty rollup, pending timeout, failures,
#       missing/non-SUCCESS required checks, or head moved. A ::warning::
#       annotation is printed; the caller must NOT merge (hourly retries
#       later) and must stay exit 0 itself.
#   2 = usage/environment error (missing args, gh/jq unavailable).
#
# Env overrides (tests only; defaults match ai-review.yml):
#   GATE_ATTEMPTS  max poll attempts (default 20)
#   GATE_SLEEP     seconds between attempts (default 60)
set -euo pipefail

PR_NUMBER="${1:-}"
REPO="${2:-${GITHUB_REPOSITORY:-}}"
EXPECTED_SHA="${3:-}"

if [ -z "$PR_NUMBER" ]; then
  echo "::error::autofix-merge-gate: usage: $0 <PR_NUMBER> [REPO]" >&2
  exit 2
fi
if [ -z "$REPO" ]; then
  echo "::error::autofix-merge-gate: REPO not given and GITHUB_REPOSITORY is unset" >&2
  exit 2
fi
command -v gh >/dev/null 2>&1 || { echo "::error::autofix-merge-gate: gh CLI not found" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "::error::autofix-merge-gate: jq not found" >&2; exit 2; }

# Checks that must be SUCCESS (substring match) for the merge to
# proceed. Everything else must at worst be neutral — failures
# anywhere block. SKIPPED required checks block: skipped != verified.
REQUIRED='["test (24)","benchmarks","coverage","Analyze (javascript-typescript)","CodeQL"]'

GATE_ATTEMPTS="${GATE_ATTEMPTS:-20}"
GATE_SLEEP="${GATE_SLEEP:-60}"

# Validate env overrides early: non-numeric values would otherwise abort
# mid-run with a bare integer-expression error. Fail fast with exit 2
# (usage error, matching the convention above).
case "$GATE_ATTEMPTS" in
  ''|*[!0-9]*)
    echo "::error::autofix-merge-gate: GATE_ATTEMPTS must be a positive integer (got '${GATE_ATTEMPTS}')" >&2
    exit 2
    ;;
esac
case "$GATE_SLEEP" in
  ''|*[!0-9]*)
    echo "::error::autofix-merge-gate: GATE_SLEEP must be a positive integer (got '${GATE_SLEEP}')" >&2
    exit 2
    ;;
esac
if [ "$GATE_ATTEMPTS" -le 0 ]; then
  echo "::error::autofix-merge-gate: GATE_ATTEMPTS must be a positive integer (got '${GATE_ATTEMPTS}')" >&2
  exit 2
fi
if [ "$GATE_SLEEP" -le 0 ]; then
  echo "::error::autofix-merge-gate: GATE_SLEEP must be a positive integer (got '${GATE_SLEEP}')" >&2
  exit 2
fi

# Pin the head SHA before waiting: a new push invalidates the poll. Callers
# that already captured a head pass it as the third argument so approval and
# merge use the same immutable target.
if [ -n "$EXPECTED_SHA" ]; then
  [[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "::error::autofix-merge-gate: invalid expected head SHA" >&2; exit 2; }
  PINNED_SHA="$EXPECTED_SHA"
else
  PINNED_SHA="$(gh pr view "$PR_NUMBER" --repo "$REPO" --json headRefOid --jq .headRefOid)"
fi
echo "Pinned head SHA: $PINNED_SHA"
if [ -z "$PINNED_SHA" ] || [ "$PINNED_SHA" = "null" ]; then
  echo "::warning::Autofix PR merge blocked — could not resolve head SHA for PR #${PR_NUMBER}; hourly orchestrator will retry."
  exit 1
fi

ATTEMPTS=0
GATE_OK=0
while [ "$ATTEMPTS" -lt "$GATE_ATTEMPTS" ]; do
  DATA="$(gh pr view "$PR_NUMBER" --repo "$REPO" --json headRefOid,statusCheckRollup)"
  CUR_SHA="$(printf '%s' "$DATA" | jq -r .headRefOid)"
  if [ "$CUR_SHA" != "$PINNED_SHA" ]; then
    echo "::warning::Autofix PR merge aborted — head moved $PINNED_SHA -> $CUR_SHA during the wait; a fresh run will re-evaluate."
    exit 1
  fi
  # statusCheckRollup mixes CheckRuns ({name,status,conclusion}) and
  # legacy StatusContexts ({context,state}): normalize both shapes,
  # then evaluate fail-closed: empty rollup, pending, failures, or
  # missing/non-SUCCESS required checks all block.
  EVAL="$(printf '%s' "$DATA" | jq --argjson required "$REQUIRED" '
    [(.statusCheckRollup // [])[] |
      if .__typename == "StatusContext" then
        {name: .context, done: (.state != "PENDING"), bad: (.state == "FAILURE" or .state == "ERROR"), success: (.state == "SUCCESS")}
      else
        {done: (.status == "COMPLETED"), bad: (.conclusion as $c | $c != null and (["SUCCESS","SKIPPED","NEUTRAL"] | index($c) | not)), success: (.conclusion == "SUCCESS")} + {name: .name}
      end] as $checks |
    {
      total: ($checks | length),
      pending: ([$checks[] | select(.done | not)] | length),
      failed: ([$checks[] | select(.bad)] | length),
      missing: [$required[] as $r | select([$checks[] | select(.success and (.name | contains($r)))] | length == 0) | $r]
    }')"
  TOTAL=$(printf '%s' "$EVAL" | jq -r .total)
  PENDING=$(printf '%s' "$EVAL" | jq -r .pending)
  FAILED=$(printf '%s' "$EVAL" | jq -r .failed)
  MISSING=$(printf '%s' "$EVAL" | jq -r '.missing | join(", ")')
  if [ "$TOTAL" -eq 0 ]; then
    echo "::warning::Autofix PR merge blocked — no CI checks reported for head $PINNED_SHA (empty rollup); hourly orchestrator will retry."
    exit 1
  fi
  if [ "$FAILED" -ne 0 ]; then
    echo "::warning::Autofix PR merge blocked — PR #${PR_NUMBER} has $FAILED failing check(s); hourly orchestrator will retry."
    exit 1
  fi
  if [ -n "$MISSING" ]; then
    echo "::warning::Autofix PR merge blocked — required checks not SUCCESS on head $PINNED_SHA: $MISSING; hourly orchestrator will retry."
    exit 1
  fi
  if [ "$PENDING" -eq 0 ]; then GATE_OK=1; break; fi
  ATTEMPTS=$((ATTEMPTS + 1))
  echo "Waiting for $PENDING check(s)... (attempt $ATTEMPTS/$GATE_ATTEMPTS)"
  sleep "$GATE_SLEEP"
done
if [ "$GATE_OK" -ne 1 ]; then
  echo "::warning::Auto-merge skipped — PR #${PR_NUMBER} still has pending check(s) after ${GATE_ATTEMPTS} attempt(s) x ${GATE_SLEEP}s wait; hourly orchestrator will retry."
  exit 1
fi
# Final re-verification on the pinned SHA immediately before merge.
FINAL_OK="$(gh pr view "$PR_NUMBER" --repo "$REPO" --json headRefOid,statusCheckRollup | jq --arg sha "$PINNED_SHA" --argjson required "$REQUIRED" '
  if .headRefOid != $sha then false
  else
    [(.statusCheckRollup // [])[] |
      if .__typename == "StatusContext" then
        {name: .context, done: (.state != "PENDING"), bad: (.state == "FAILURE" or .state == "ERROR"), success: (.state == "SUCCESS")}
      else
        {done: (.status == "COMPLETED"), bad: (.conclusion as $c | $c != null and (["SUCCESS","SKIPPED","NEUTRAL"] | index($c) | not)), success: (.conclusion == "SUCCESS")} + {name: .name}
      end] as $checks |
    ($checks | length) > 0
    and ([$checks[] | select(.done | not)] | length == 0)
    and ([$checks[] | select(.bad)] | length == 0)
    and ([$required[] as $r | select([$checks[] | select(.success and (.name | contains($r)))] | length == 0)] | length == 0)
  end')"
if [ "$FINAL_OK" != "true" ]; then
  echo "::warning::Autofix PR merge aborted — final gate re-check failed (head moved or checks regressed); hourly orchestrator will retry."
  exit 1
fi
echo "Merge gate green on pinned head $PINNED_SHA for PR #${PR_NUMBER}."
