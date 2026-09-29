#!/usr/bin/env bash
#
# test-workflow-health-dedup-lookup.sh — behavioural tests for find_open_issue.
#
# The watchdog's duplicate detector is the one component that must fail CLOSED:
# if a failed search reads as "no matching issue", the caller opens a duplicate
# on every run. These tests execute the real function against a stubbed `gh`
# and assert the three outcomes are distinguishable.
#
# The defect this exists for: `--arg` is a JQ flag, not a `gh search` flag.
# Passing it to `gh` made gh consume it as the jq expression and treat the
# filter as a search term, so the query always failed and always returned
# empty — the detector had never once found a duplicate. A `grep -F` test for
# the literal flag string cannot see that, because the string is present in
# both the working and the broken version.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TARGET="$REPO_ROOT/.github/scripts/workflow-health.sh"

pass=0
fail=0
ok() { pass=$((pass + 1)); printf '  ok  %s\n' "$1"; }
no() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }

# Extract the real function so the test exercises shipped code rather than a
# copy that can drift from it.
extract_fn() { awk '/^find_open_issue\(\) \{/,/^\}/' "$TARGET"; }

FP_A="aaaa1111bbbb2222"

# Run the real function with a stubbed `gh`. Echoes "<output>|<exit code>".
run_case() {
  local gh_behavior="$1" fp="$2" stub out rc
  stub="$(mktemp -d)"
  cat > "$stub/gh" <<'GHSTUB'
#!/usr/bin/env bash
for a in "$@"; do
  if [ "$a" = "--arg" ]; then
    echo "function not defined: arg/0" >&2
    exit 1
  fi
done
GHSTUB
  chmod +x "$stub/gh"
  printf '%s\n' "$gh_behavior" >> "$stub/gh"
  out="$(PATH="$stub:$PATH" REPO="o/r" HEALTH_LABEL="workflow-health" \
    bash -c "$(extract_fn)
      log() { :; }
      find_open_issue '$fp'" 2>/dev/null)"
  rc=$?
  rm -rf "$stub"
  printf '%s|%s' "$out" "$rc"
}

# expect <label> <expected-output> <expected-exit|"any"> <gh behaviour>
expect() {
  local label="$1" want_out="$2" want_rc="$3" behavior="$4" result out rc
  result="$(run_case "$behavior" "$FP_A")"
  out="${result%%|*}"; rc="${result##*|}"
  if [ "$out" != "$want_out" ]; then
    no "$label (output: got '$out', want '$want_out')"
    return
  fi
  if [ "$want_rc" != "any" ] && [ "$rc" != "$want_rc" ]; then
    no "$label (exit: got $rc, want $want_rc)"
    return
  fi
  ok "$label"
}

echo "workflow-health duplicate-lookup behaviour"

expect "returns the matching issue number" "877" "0" \
  "printf '[{\"number\":877,\"body\":\"x <!-- health-fingerprint: ${FP_A} --> y\"}]'"

expect "no match is empty with exit 0 (distinct from failure)" "" "0" \
  "printf '[{\"number\":1,\"body\":\"unrelated\"},{\"number\":2,\"body\":\"other\"}]'"

expect "API failure exits non-zero so callers can refuse to create" "" "3" "exit 1"

expect "unparseable JSON exits non-zero" "" "3" "printf 'not json at all'"

expect "empty response exits non-zero" "" "3" "true"

expect "a non-numeric issue id reads as no-match, not as an issue" "" "0" \
  "printf '[{\"number\":\"abc\",\"body\":\"x <!-- health-fingerprint: ${FP_A} --> y\"}]'"

expect "a structurally broken payload fails closed" "" "3" \
  "printf '[\"not-a-number\"]'"

if extract_fn | grep -q -- '--jq --arg'; then
  no "find_open_issue still routes --arg through gh (the original bug)"
else
  ok "--arg is no longer passed to gh"
fi

call_sites="$(grep -c 'existing="\$(find_open_issue "\$fp")" || existing=' "$TARGET")"
if [ "$call_sites" -eq 2 ]; then
  ok "both call sites handle the lookup-failure state"
else
  no "expected 2 guarded call sites, found $call_sites"
fi

echo
printf 'passed: %d  failed: %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
