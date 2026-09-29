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
# copy that can drift from it. The saturation ceiling is a file-level constant,
# so it is extracted from the same file too — the child must see the SHIPPED
# value, not one the test invented.
extract_fn() { awk '/^find_open_issue\(\) \{/,/^\}/' "$TARGET"; }
extract_const() { awk '/^SEARCH_LIMIT=/ { print; exit }' "$TARGET"; }

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
    bash -c "$(extract_const)
$(extract_fn)
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

# ---------------------------------------------------------------------------
# Saturation. `gh search issues` truncates at 30 results per page, so the lookup
# used to be blind to any part of the backlog past that point: an existing issue
# for a still-failing run fell off page one, the fingerprint matched nothing, and
# the watchdog opened a duplicate. That is how #910 and #952 came to exist with a
# byte-identical health-fingerprint comment.
#
# These cases drive the real create-path slice out of the real script, against a
# fake `gh` that records every invocation, so "did it try to open a duplicate?"
# is answered by what the code actually did rather than by what a comment says.
# ---------------------------------------------------------------------------
SEARCH_LIMIT="$(awk -F= '/^SEARCH_LIMIT=/{gsub(/[^0-9]/,"",$2); print $2; exit}' "$TARGET")"

# The slice from the final duplicate re-check through `gh issue create`. If this
# extraction ever returns nothing, every assertion below would pass vacuously,
# so its shape is asserted before anything is concluded from it.
extract_create_slice() {
  awk '/# Re-check immediately before creating/{flag=1} flag{print} /log "opened #/{exit}' "$TARGET"
}
CREATE_SLICE="$(extract_create_slice)"

slice_is_usable() {
  case "$CREATE_SLICE" in
    *"find_open_issue"*"__LOOKUP_FAILED__"*"gh issue create"*) return 0 ;;
    *) return 1 ;;
  esac
}

# A fake `gh` that dispatches on the --json field list and records every
# invocation, so a test can assert what was NOT called.
make_gh_stub() {
  local dir="$1"
  cat > "$dir/gh" <<'GHSTUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_CALL_LOG"
for a in "$@"; do
  if [ "$a" = "--arg" ]; then
    echo "function not defined: arg/0" >&2
    exit 1
  fi
done
fields=""
prev=""
limit="none"
for a in "$@"; do
  if [ "$prev" = "--json" ]; then fields="$a"; fi
  if [ "$prev" = "--limit" ]; then limit="$a"; fi
  prev="$a"
done
case " $* " in
  *" search issues "*)
    # The saturation probe asks for `--json number` alone; the duplicate
    # lookup asks for `--json number,body`.
    if [ "$fields" = "number" ]; then
      printf '%s' "$GH_BACKLOG"
    else
      # `gh search` truncates at 30 results when no --limit is given. Modelling
      # that is the whole point: a stub that ignored the flag would report a
      # deleted --limit as working.
      n="$GH_ISSUES"
      if [ "$limit" = "none" ]; then n="$GH_DEFAULT_LIMIT"; fi
      jq -n --argjson n "$n" '[range(1;($n+1)) | {number: ., body: "unrelated"}]'
    fi
    ;;
  *" issue create "*) printf 'https://github.com/o/r/issues/4242' ;;
  *) : ;;
esac
GHSTUB
  chmod +x "$dir/gh"
}

# run_fake <lookup|create> <issues> <backlog> -> "<exit>|<output>|<issue-create count>"
run_fake() {
  local mode="$1" issues="$2" backlog="$3" stub out rc creates prelude
  stub="$(mktemp -d)"
  : > "$stub/calls.log"
  make_gh_stub "$stub"
  if [ "$mode" = "lookup" ]; then
    prelude="find_open_issue '$FP_A'"
  else
    # The slice is wrapped in a loop because the real code's `continue`
    # statements sit inside the handler's `for` over failed jobs. Without the
    # loop, `continue` is a no-op error in bash and execution falls straight
    # through to the create — a harness artifact that would look exactly like
    # the bug under test.
    prelude="run_id=42; workflow=CI; job_name=test; class=test-fail; short=sigs; logtail=tail
fp='$FP_A'
__drive() {
  local __once
  for __once in 1; do
$(extract_create_slice)
  done
}
__drive"
  fi
  out="$(PATH="$stub:$PATH" \
    GH_CALL_LOG="$stub/calls.log" GH_ISSUES="$issues" GH_BACKLOG="$backlog" \
    GH_DEFAULT_LIMIT="${GH_DEFAULT_LIMIT:-30}" \
    REPO="o/r" HEALTH_LABEL="workflow-health" DRY_RUN="false" \
    GITHUB_SERVER_URL="https://github.com" \
    bash -c "$(extract_const)
$(extract_fn)
log() { printf 'LOG %s\n' \"\$*\"; }
dry() { :; }
$prelude" 2>&1)"
  rc=$?
  # Counted BEFORE the stub is removed, or the assertion would pass on a
  # missing file — which is how a broken harness reports a clean result.
  creates="$(grep -c 'issue create' "$stub/calls.log" 2>/dev/null)"
  creates="${creates:-0}"
  # The --limit the duplicate lookup actually sent gh. "none" means the call
  # relied on gh's 30-result default, which is the defect.
  lookup_limit="$(awk '/number,body/ { for (i=1;i<NF;i++) if ($(i+1)=="--limit") { print $(i+2); found=1 } } END { if (!found) print "none" }' "$stub/calls.log" | tail -1)"
  rm -rf "$stub"
  # Field order matters: `out` is multi-line and may contain '|', so it goes
  # last and the scalars before it are split positionally.
  printf '%s|%s|%s|%s' "$rc" "$creates" "$lookup_limit" "$out"
}

echo
echo "search saturation (ceiling ${SEARCH_LIMIT:-UNKNOWN})"

if [ -n "$SEARCH_LIMIT" ] && slice_is_usable; then
  ok "the create-path slice was extracted (assertions below are not vacuous)"
else
  no "could not extract a usable create-path slice or SEARCH_LIMIT from $TARGET"
  SEARCH_LIMIT=0
fi

if [ "${SEARCH_LIMIT:-0}" -gt 0 ] 2>/dev/null; then
  # A. Saturated: exactly SEARCH_LIMIT open issues, none matching. The empty
  #    result is untrustworthy, so the create path must never be reached.
  sat="$(run_fake create "$SEARCH_LIMIT" "$SEARCH_LIMIT")"
  sat_rest="${sat#*|}"; sat_creates="${sat_rest%%|*}"; sat_rest="${sat_rest#*|}"
  sat_out="${sat_rest#*|}"
  if [ "$sat_creates" = "0" ]; then
    ok "a saturated backlog never reaches 'gh issue create'"
  else
    no "a saturated backlog reached 'gh issue create' ($sat_creates invocation(s))"
  fi
  if printf '%s' "$sat_out" | grep -q "at or above the ${SEARCH_LIMIT}-issue search ceiling" \
     && printf '%s' "$sat_out" | grep -q "backlog is ${SEARCH_LIMIT}"; then
    ok "saturation emits a WARNING naming the ceiling and the backlog size"
  else
    no "no saturation WARNING naming ceiling and backlog size: $(tr '\n' ' ' <<< "$sat_out")"
  fi

  # B. Control: a small backlog with no match must still create. Saturation
  #    handling that swallowed every no-match would leave the watchdog
  #    permanently silent, which is worse than the duplicate it prevents.
  ctl="$(run_fake create 2 2)"; ctl_creates="${ctl#*|}"; ctl_creates="${ctl_creates%%|*}"
  if [ "$ctl_creates" = "1" ]; then
    ok "an unsaturated backlog with no match still opens an issue"
  else
    no "an unsaturated no-match did NOT open an issue ($ctl_creates invocation(s)) — the watchdog would be silent"
  fi

  # C. The lookup reports saturation as its own state, distinct from API failure.
  sat_rc="$(run_fake lookup "$SEARCH_LIMIT" "$SEARCH_LIMIT")"; sat_rc="${sat_rc%%|*}"
  if [ "$sat_rc" = "4" ]; then
    ok "find_open_issue exits 4 (saturated), distinct from 3 (API failure)"
  else
    no "find_open_issue exit on a saturated backlog: got '$sat_rc', want 4"
  fi
  ctl_rc="$(run_fake lookup 2 2)"; ctl_rc="${ctl_rc%%|*}"
  if [ "$ctl_rc" = "0" ]; then
    ok "find_open_issue still exits 0 on an unsaturated no-match"
  else
    no "find_open_issue exit on an unsaturated no-match: got '$ctl_rc', want 0"
  fi

  # D. The lookup must actually ASK gh for more than the 30-result default.
  #    Asserted on the flag the stub received, not on the flag's presence in the
  #    source: a text grep matches the saturation-count call too, so it stayed
  #    green when the lookup's own --limit was deleted.
  seen="$(run_fake lookup "$SEARCH_LIMIT" "$SEARCH_LIMIT")"
  seen_rest="${seen#*|}"; seen_limit="${seen_rest#*|}"; seen_limit="${seen_limit%%|*}"
  if [ "$seen_limit" = "$SEARCH_LIMIT" ]; then
    ok "the duplicate lookup asks gh for $SEARCH_LIMIT results (not the 30 default)"
  else
    no "the duplicate lookup asked gh for '$seen_limit' results; expected $SEARCH_LIMIT (gh defaults to 30, which is how duplicates were filed)"
  fi
fi

echo
printf 'passed: %d  failed: %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
