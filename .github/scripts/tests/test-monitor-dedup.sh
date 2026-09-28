#!/usr/bin/env bash
# The upstream monitor's DEDUPLICATION is delegated to the model by PROMPT.
# These assertions pin the deterministic post-hoc gate that verifies it, so
# "created/skipped/failed" stops being a self-report and becomes a checked fact.
set -uo pipefail
S=".github/scripts/upstream-monitor.sh"
P=0
F=0
ok(){ P=$((P+1)); echo "ok   - $1"; }
no(){ F=$((F+1)); echo "FAIL - $1"; }
has(){ local d="$1" f n; if [ "$#" -ge 3 ]; then f="$2"; n="$3"; else f="$S"; n="$2"; fi; if grep -qF -- "$n" "$f" 2>/dev/null; then ok "$d"; else no "$d (missing: $n in $f)"; fi; }

if bash -n "$S" 2>/dev/null; then ok "upstream-monitor.sh parses"; else no "upstream-monitor.sh does not parse"; fi

has "a deterministic dedup_verify gate exists" "cmd_dedup_verify()"
# KILLS "leave dedup as prompt-only": the gate must run as part of publish.
has "publish invokes the dedup gate" 'cmd_dedup_verify "$CREATED_OUT"'
# KILLS "paginate like the health handler did not": the holder search must not
# be capped at a default that hides older matches.
has "the duplicate-holder search is explicitly uncapped" "--limit 1000"
# Fail closed: an unreadable manifest must not be treated as "nothing to check".
has "an unreadable manifest fails closed" "manifest unreadable, cannot verify; failing closed"
# The gate must close duplicates, not merely report them.
has "duplicates are closed, not just counted" 'gh issue close "$d"'
# It must read the created numbers back from GitHub so a misreporting agent
# cannot hide a duplicate by omitting it from its own manifest.
has "created numbers are re-read from GitHub" "gh issue view \"\$num\""

has "CI runs this script" .github/workflows/ci.yml "test-monitor-dedup.sh"

# BEHAVIOURAL, not a string match. Removing the fail-closed `return 1` leaves
# every grep assertion above intact, so the behaviour itself must be exercised:
# a manifest the gate cannot read must make the gate exit non-zero.
TMPD="$(mktemp -d)"
printf '{"created":"not-an-array"}' > "$TMPD/bad.json"
EXTRACTED="$TMPD/fn.sh"
{
  printf '#!/usr/bin/env bash\nset -uo pipefail\n'
  printf 'REPO=x; OUT_DIR=%s; MONITOR_FP=%s\n' "$TMPD" "'<!-- monitor-id:'"
  sed -n '/^cmd_dedup_verify()/,/^}/p' "$S"
  printf 'created_doc_ok(){ jq -e %s "$1" >/dev/null 2>&1; }\n' \
    "'type==\"object\" and (.created|type==\"array\")'"
  printf 'log(){ :; }\n'
  printf 'cmd_dedup_verify "$1"\n'
} > "$EXTRACTED"
if bash "$EXTRACTED" "$TMPD/bad.json" >/dev/null 2>&1; then
  no "an unreadable manifest must FAIL CLOSED (gate returned success)"
else
  ok "an unreadable manifest fails closed"
fi
# KILLS "fail open on a bad manifest": same command, return 0 expected instead.
if sed 's/^    return 1$/    return 0/' "$S" > "$TMPD/mutant.sh" 2>/dev/null; then
  MUT="$TMPD/mutant.sh"
  {
    printf '#!/usr/bin/env bash\nset -uo pipefail\n'
    printf 'REPO=x; OUT_DIR=%s; MONITOR_FP=%s\n' "$TMPD" "'<!-- monitor-id:'"
    sed -n '/^cmd_dedup_verify()/,/^}/p' "$MUT"
    printf 'created_doc_ok(){ jq -e %s "$1" >/dev/null 2>&1; }\n' \
      "'type==\"object\" and (.created|type==\"array\")'"
    printf 'log(){ :; }\n'
    printf 'cmd_dedup_verify "$1"\n'
  } > "$TMPD/mut.sh"
  if bash "$TMPD/mut.sh" "$TMPD/bad.json" >/dev/null 2>&1; then
    ok "KILLS \"fail open on a bad manifest\": the mutant is caught"
  else
    no "the fail-closed mutant behaves identically, so the test cannot distinguish it"
  fi
fi
rm -rf "$TMPD"

echo "---"
echo "pass=$P fail=$F"
[ "$F" -eq 0 ]
