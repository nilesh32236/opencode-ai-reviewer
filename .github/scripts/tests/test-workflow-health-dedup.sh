#!/usr/bin/env bash
# Regression tests for .github/scripts/workflow-health.sh duplicate detection.
#
# ROOT CAUSE THIS GUARDS: `gh search issues` truncates at 30 results by default.
# With more than 30 open health issues the older ones fall off the page,
# find_open_issue() returns empty, and the handler CREATES A DUPLICATE for a
# failure that is already tracked. In production that produced 13 copies of a
# single fingerprint before the search limit was raised.
#
# These tests are static (they inspect the script) because exercising the real
# GitHub search would require 30+ live issues. Each assertion names the
# mutation it kills.
set -uo pipefail

SCRIPT=".github/scripts/workflow-health.sh"
PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); echo "ok   - $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL - $1"; }

assert_contains() {
  local desc="$1" file="$2" needle="$3"
  if grep -qF -- "$needle" "$file" 2>/dev/null; then ok "$desc"; else bad "$desc (no match for '$needle')"; fi
}

assert_not_contains() {
  local desc="$1" file="$2" needle="$3"
  if grep -qF -- "$needle" "$file" 2>/dev/null; then bad "$desc (unexpected '$needle')"; else ok "$desc"; fi
}

[ -f "$SCRIPT" ] || { echo "FAIL - $SCRIPT not found"; exit 1; }

# The script must still parse.
if bash -n "$SCRIPT" 2>/dev/null; then
  ok "workflow-health.sh parses"
else
  bad "workflow-health.sh does not parse"
fi

# KILLS "drop the --limit from the duplicate search": without it the search
# truncates at 30 and duplicates reappear.
assert_contains "the duplicate search passes an explicit --limit" "$SCRIPT" \
  '--limit "$SEARCH_LIMIT" --json number,body'

# The limit must be declared as a variable so it is auditable, not a magic number.
assert_contains "SEARCH_LIMIT is declared as a named constant" "$SCRIPT" \
  'SEARCH_LIMIT=500'

# KILLS "raise the limit but leave saturation silent": once the page is full,
# duplicate detection is not trustworthy and the script must refuse to create
# rather than silently add to the pile.
assert_contains "search saturation is detected" "$SCRIPT" \
  'duplicate detection is UNRELIABLE'
assert_contains "saturation refuses to create" "$SCRIPT" \
  "refusing to create"

# KILLS "detect saturation but keep going anyway": the create site must skip on
# a failed lookup rather than treating 'no match' as 'genuinely new'.
assert_contains "the create site skips when detection fails" "$SCRIPT" \
  'duplicate detection unavailable'
assert_contains "the create site handles a failed lookup explicitly" "$SCRIPT" \
  'existing="$(find_open_issue "$fp")" || {'

# The pre-existing throttle behaviour must survive this change.
assert_contains "still-failing notifications remain throttled" "$SCRIPT" \
  'already notified'
assert_contains "CI runs this script" .github/workflows/ci.yml   'test-workflow-health-dedup.sh'
assert_contains "the label constant is unchanged" "$SCRIPT" \
  'HEALTH_LABEL="workflow-health"'

echo "---"
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
