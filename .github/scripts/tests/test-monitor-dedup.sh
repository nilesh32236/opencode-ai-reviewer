#!/usr/bin/env bash
#
# test-monitor-dedup.sh — behavioural tests for the upstream monitor's dedup gate.
#
# The monitor's deduplication is delegated to the model by PROMPT: it is told to
# search before each create and skip on a matching `<!-- monitor-id: … -->`
# fingerprint, and then it reports its own created/skipped/failed counts. That is
# an instruction, not a control, so `cmd_dedup_verify` re-derives the truth from
# GitHub and closes what slipped through.
#
# THE DEFECTS THIS EXISTS FOR, both the same bug class — a gate that reports
# success because it silently did nothing:
#
# 1. `_monitor_holders` passed `--arg` to `gh issue list`. `--arg` is a JQ flag,
#    not a gh flag: real gh answers "unknown flag: --arg" and exits non-zero.
#    Its stderr was discarded, so the search returned nothing on every run and
#    the gate logged "closed 0 duplicate(s)" and returned 0, unconditionally.
#
# 2. The id was extracted PERMISSIVELY from the created issue, then a comment
#    template was RECONSTRUCTED from it and matched as a literal substring. Any
#    candidate that spelled the comment differently — '<!-- monitor-id:910 -->',
#    '<!--monitor-id: 910 -->', '<!-- monitor-id: 910-->' — produced an empty
#    holder set, and the gate reported a clean pass over a real duplicate pair.
#    Both sides now go through ONE extractor and compare the extracted VALUE.
#
# The test that shipped with #893 could catch neither: it was `grep -F` string
# assertions plus one behavioural check of the manifest path, and it never
# executed `_monitor_holders`. These cases DRIVE the real functions against a
# fake `gh` and assert on what the gate actually did.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TARGET="$REPO_ROOT/.github/scripts/upstream-monitor.sh"

pass=0
fail=0
ok() { pass=$((pass + 1)); printf '  ok  %s\n' "$1"; }
no() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }

# Literal prefix match, not a regex: these definitions contain parentheses and
# braces that an ERE would have to escape, and a silently mis-escaped pattern
# yields an empty extraction that every assertion below would pass against.
extract() { # extract <fixed line prefix>
  awk -v pat="$1" 'index($0, pat) {flag=1} flag {print} flag && /^}/ {exit}' "$TARGET"
}
ID_FN="$(extract 'monitor_id_of() {')"
HOLDERS_FN="$(extract '_monitor_holders() {')"
VERIFY_FN="$(extract 'cmd_dedup_verify() {')"
CALL_SITE="$(grep -c 'cmd_dedup_verify "\$CREATED_OUT" || return 1' "$TARGET")"

# A fake gh driven by env: GH_BODY_910 / GH_BODY_911 supply issue bodies,
# GH_COUNT supplies the saturation count, GH_MODE selects a failure mode.
# Every invocation is recorded so a test can assert what was NOT called.
make_gh_stub() {
  local dir="$1"
  cat > "$dir/gh" <<'GHSTUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_CALL_LOG"
for a in "$@"; do
  # Real gh: "--arg" is not a gh flag.
  if [ "$a" = "--arg" ]; then
    printf 'unknown flag: --arg\n' >&2
    exit 141
  fi
done
fields=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--json" ]; then fields="$a"; fi
  prev="$a"
done
case " $* " in
  *" issue view "*)
    if [ "$GH_MODE" = "empty" ]; then
      printf 'no fingerprint here'
    else
      case " $* " in
        *910*) printf '%s\n' "$GH_BODY_910" ;;
        *)     printf '%s\n' "$GH_BODY_911" ;;
      esac
    fi
    ;;
  *" issue list "*)
    if [ "$GH_MODE" = "apifail" ]; then
      printf 'unknown flag: --arg\n' >&2
      exit 141
    fi
    if [ "$fields" = "number" ]; then
      printf '%s' "$GH_COUNT"
    else
      printf '[{"number":910,"body":%s},{"number":911,"body":%s}]' \
        "$(printf '%s' "$GH_BODY_910" | jq -Rs .)" \
        "$(printf '%s' "$GH_BODY_911" | jq -Rs .)"
    fi
    ;;
  *" issue close "*) printf 'closed' ;;
  *) : ;;
esac
GHSTUB
  chmod +x "$dir/gh"
}

# run_gate <mode> <body-910> <body-911> [manifest] -> "<rc>|<closes>|<output>"
run_gate() {
  local mode="$1" b910="$2" b911="$3" manifest="${4:-}" stub work out rc closes
  stub="$(mktemp -d)"; work="$(mktemp -d)"
  : > "$stub/calls.log"
  make_gh_stub "$stub"
  [ -n "$manifest" ] || manifest='{"created":[{"number":910}],"skipped":[],"failed":[]}'
  printf '%s' "$manifest" > "$work/created-issues.json"

  {
    grep -m1 '^MONITOR_ID_RE=' "$TARGET"
    grep -m1 '^MONITOR_LIMIT=' "$TARGET"
    printf '%s\n' 'created_doc_ok() { jq -e '"'"'type=="object" and (.created|type=="array")'"'"' "$1" >/dev/null 2>&1; }'
    printf '%s\n' 'log() { printf '"'"'[gate] %s\n'"'"' "$*"; }'
    extract 'monitor_id_of() {'
    extract '_monitor_holders() {'
    extract 'cmd_dedup_verify() {'
    printf '%s\n' 'cmd_dedup_verify "$CREATED_OUT"'
  } > "$work/gate.sh"

  out="$(PATH="$stub:$PATH" \
    GH_CALL_LOG="$stub/calls.log" GH_MODE="$mode" \
    GH_BODY_910="$b910" GH_BODY_911="$b911" GH_COUNT="${GH_COUNT:-2}" \
    REPO="o/r" CREATED_OUT="$work/created-issues.json" \
    bash "$work/gate.sh" 2>&1)"
  rc=$?
  # Counted before the stub is removed, or the assertion passes on a missing
  # file — which is how a broken harness reports a clean result.
  closes="$(grep -c 'issue close' "$stub/calls.log" 2>/dev/null)"
  closes="${closes:-0}"
  rm -rf "$stub" "$work"
  # Field order matters: the captured output is multi-line, so it goes last.
  printf '%s|%s|%s' "$rc" "$closes" "$out"
}

echo "upstream-monitor dedup gate"

# Assert the real code was extracted before concluding anything from it.
if [ -n "$ID_FN" ] && [ -n "$HOLDERS_FN" ] && [ -n "$VERIFY_FN" ] \
   && printf '%s' "$HOLDERS_FN" | grep -q 'gh issue list' \
   && printf '%s' "$VERIFY_FN" | grep -q 'closed.*duplicate'; then
  ok "the real monitor_id_of, _monitor_holders and cmd_dedup_verify were extracted"
else
  no "could not extract the dedup functions from $TARGET — assertions below would be vacuous"
  echo
  printf 'passed: %d  failed: %d\n' "$pass" "$fail"
  exit 1
fi

CANON='Summary: s

<!-- monitor-id: 910 -->
'
B910='Summary: original

<!-- monitor-id: 910 -->
'

# ---------------------------------------------------------------------------
# THE REVIEW'S CASE. Same id (910), three different comment spellings on the
# candidate. Any byte-exact comparison misses these; comparing extracted ids
# does not. Note the CREATED issue uses the canonical spelling throughout, so
# these cases fail if and only if the CANDIDATE side is matched by bytes.
# ---------------------------------------------------------------------------
for variant in \
  'no space after the colon|<!-- monitor-id:910 -->' \
  'no space after <!--|<!--monitor-id: 910 -->' \
  'no space before -->|<!-- monitor-id: 910-->'
do
  label="${variant%%|*}"; cand="${variant#*|}"
  b911="Summary: dup

${cand}
"
  r="$(run_gate dupes "$B910" "$b911")"
  rc="${r%%|*}"; rest="${r#*|}"; closes="${rest%%|*}"; out="${rest#*|}"
  if [ "$rc" = "0" ] && [ "$closes" = "1" ] \
     && printf '%s' "$out" | grep -q '#911 duplicates #910'; then
    ok "near-miss spelling (${label}) is still detected as a duplicate"
  else
    no "near-miss spelling (${label}) missed: rc=$rc closes=$closes out=$(tr '\n' ' ' <<< "$out")"
  fi
done

# Canonical spelling must keep working — the fix must not be "match nothing".
r="$(run_gate dupes "$B910" "$CANON")"
rc="${r%%|*}"; rest="${r#*|}"; closes="${rest%%|*}"; out="${rest#*|}"
if [ "$rc" = "0" ] && [ "$closes" = "1" ]; then
  ok "canonical spelling still closes the duplicate (no regression)"
else
  no "canonical spelling regressed: rc=$rc closes=$closes out=$(tr '\n' ' ' <<< "$out")"
fi

# Genuinely DIFFERENT ids are not duplicates. This is what stops the value
# comparison from becoming a mass-closer.
r="$(run_gate dupes "$B910" 'Summary: unrelated

<!-- monitor-id: 999 -->
')"
rc="${r%%|*}"; rest="${r#*|}"; closes="${rest%%|*}"; out="${rest#*|}"
if [ "$rc" = "0" ] && [ "$closes" = "0" ] \
   && printf '%s' "$out" | grep -q 'closed 0 duplicate(s); every created issue verified'; then
  ok "a different monitor-id is not a duplicate (no close, truthful 0)"
else
  no "different-id case wrong: rc=$rc closes=$closes out=$(tr '\n' ' ' <<< "$out")"
fi

# CONTROL: no holder carrying the id at all. The gate must still be green, or it
# is permanently red and gets switched off — the worse outcome.
r="$(run_gate dupes "$B910" 'Summary: unrelated issue, no fingerprint here')"
rc="${r%%|*}"
if [ "$rc" = "0" ]; then
  ok "no holders at all is a clean success (exit 0)"
else
  no "no-holders case exited $rc — the gate would be permanently red"
fi

# A lookup that cannot be performed is UNVERIFIED, never a clean pass.
r="$(run_gate apifail "$B910" "$CANON")"
rc="${r%%|*}"; rest="${r#*|}"; out="${rest#*|}"
if [ "$rc" != "0" ] && ! printf '%s' "$out" | grep -q 'closed 0 duplicate(s)'; then
  ok "a failed lookup exits non-zero and claims no duplicate count"
else
  no "a failed lookup reported success: rc=$rc out=$(tr '\n' ' ' <<< "$out")"
fi

# Saturation: a full page means "no duplicate" cannot be trusted. Same treatment
# find_open_issue received in #959.
r="$(GH_COUNT=500 run_gate dupes "$B910" "$CANON")"
rc="${r%%|*}"; rest="${r#*|}"; out="${rest#*|}"
if [ "$rc" != "0" ] && printf '%s' "$out" | grep -qi 'ceiling'; then
  ok "a saturated monitor backlog is refused, not reported clean"
else
  no "a saturated backlog was not refused: rc=$rc out=$(tr '\n' ' ' <<< "$out")"
fi

r="$(run_gate empty "$B910" "$CANON")"
rc="${r%%|*}"
if [ "$rc" != "0" ]; then
  ok "a created issue with no readable fingerprint is UNVERIFIED and fails"
else
  no "an unreadable fingerprint exited 0"
fi

r="$(run_gate dupes 'x' 'x' '{"created":"not-an-array"}')"
rc="${r%%|*}"
if [ "$rc" != "0" ]; then
  ok "an unreadable manifest fails closed"
else
  no "an unreadable manifest exited 0"
fi

if [ "$CALL_SITE" -eq 1 ]; then
  ok "cmd_publish propagates a failed verification instead of logging past it"
else
  no "expected 1 propagating call site, found $CALL_SITE"
fi

# ---------------------------------------------------------------------------
# Static guards. These are what catch a later "simplification" of the
# comparison back to a byte-exact substring match — which every behavioural
# case above would otherwise quietly be rewritten around.
# ---------------------------------------------------------------------------
code_only() { grep -v '^[[:space:]]*#' <<< "$1"; }

uses="$(code_only "$VERIFY_FN" | grep -c 'monitor_id_of')"
holders_uses="$(code_only "$HOLDERS_FN" | grep -c 'monitor_id_of')"
if [ "$uses" -ge 1 ] && [ "$holders_uses" -ge 1 ]; then
  ok "both sides extract with the SAME monitor_id_of (symmetric pairing)"
else
  no "the two sides do not share one extractor (verify=$uses holders=$holders_uses) — asymmetry is the defect"
fi

if code_only "$VERIFY_FN" | grep -qE '\-\->|<!--'; then
  no "cmd_dedup_verify still reconstructs comment bytes to search with"
else
  ok "cmd_dedup_verify never reconstructs comment bytes"
fi

if code_only "$HOLDERS_FN" | grep -q 'contains('; then
  no "_monitor_holders still substring-matches a comment template"
else
  ok "_monitor_holders compares extracted ids, not comment substrings"
fi

if code_only "$HOLDERS_FN" | grep -q -- '--arg'; then
  no "the gh issue list call passes --arg (unknown flag; the search can never work)"
else
  ok "the gh issue list call passes no --arg"
fi

if code_only "$HOLDERS_FN" | grep -qE 'return 3|return 1'; then
  ok "_monitor_holders can report a failed lookup"
else
  no "_monitor_holders has no failure return — a silent empty result is the bug"
fi

if code_only "$HOLDERS_FN" | grep -q 'MONITOR_LIMIT'; then
  ok "_monitor_holders caps its page and can detect saturation"
else
  no "_monitor_holders has no page ceiling"
fi

echo
printf 'passed: %d  failed: %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
