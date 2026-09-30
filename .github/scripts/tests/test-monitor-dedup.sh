#!/usr/bin/env bash
#
# test-monitor-dedup.sh — behavioural tests for the upstream monitor's dedup gate.
#
# The monitor's deduplication is delegated to the model by PROMPT: it is told to
# search before each create and skip on a matching `<!-- monitor-id: ... -->`
# fingerprint. That is an instruction, not a control — the model is the
# untrusted party in this repository's threat model and the only thing
# deduplicating its own findings — so `cmd_dedup_verify` re-derives the truth
# from GitHub and closes what slipped through.
#
# THE DEFECT THIS EXISTS FOR. A version of `_monitor_holders` passed `--arg` to
# `gh issue list`. `--arg` is a JQ flag, not a gh flag: real gh answers
# "unknown flag: --arg" and exits non-zero. Its stderr was discarded, so the
# search returned nothing on every run, `cmd_dedup_verify` skipped every
# iteration, and the gate logged "closed 0 duplicate(s)" and returned 0 —
# unconditionally, whatever the repository actually contained. A check that
# looks green because it silently did nothing.
#
# The test that shipped with it could not catch that: it was `grep -F` string
# assertions plus one behavioural check of the manifest path, and it never
# executed `_monitor_holders`. So these cases DRIVE the real functions against
# a fake `gh` and assert on what the gate actually did.
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
# yields an empty extraction that every assertion below would then pass against.
extract() { # extract <fixed line prefix>
  awk -v pat="$1" 'index($0, pat) {flag=1} flag {print} flag && /^}/ {exit}' "$TARGET"
}
HOLDERS_FN="$(extract '_monitor_holders() {')"
VERIFY_FN="$(extract 'cmd_dedup_verify() {')"
CALL_SITE="$(grep -c 'cmd_dedup_verify "\$CREATED_OUT" || return 1' "$TARGET")"

# A fake `gh` whose behaviour is selected by $GH_MODE:
#   apifail — the issue lookup cannot be performed (real gh's exit 141)
#   dupes  — the created issue and a second holder share a fingerprint
#   clean  — the created issue has a fingerprint, nothing else does
#   empty  — the created issue's body has no fingerprint at all
make_gh_stub() {
  local dir="$1"
  cat > "$dir/gh" <<'GHSTUB'
#!/usr/bin/env bash
# Record every invocation so a test can assert what was and was not called.
printf '%s\n' "$*" >> "$GH_CALL_LOG"
for a in "$@"; do
  # Real gh: "--arg" is not a gh flag.
  if [ "$a" = "--arg" ]; then
    printf 'unknown flag: --arg\n' >&2
    printf 'Usage:  gh issue list [flags]\n' >&2
    exit 141
  fi
done
case " $* " in
  *" issue view "*)
    if [ "$GH_MODE" = "empty" ]; then
      printf 'no fingerprint here'
    else
      printf 'Summary: something\n\n<!-- monitor-id: %s -->\n' "$GH_FP_ID"
    fi
    ;;
  *" issue list "*)
    # apifail models a lookup that CANNOT be performed, and fails it the way
    # real gh fails on an unparseable flag: the exact message and exit 141 the
    # original bug produced. The gate must not read this as "no duplicates".
    if [ "$GH_MODE" = "apifail" ]; then
      printf 'unknown flag: --arg\n' >&2
      printf 'Usage:  gh issue list [flags]\n' >&2
      exit 141
    fi
    if [ "$GH_MODE" = "dupes" ]; then
      printf '[{"number":%s,"body":"<!-- monitor-id: %s -->"},{"number":%s,"body":"<!-- monitor-id: %s -->"}]' \
        "$GH_FP_ID" "$GH_FP_ID" "$GH_DUP_ID" "$GH_FP_ID"
    else
      printf '[{"number":4242,"body":"unrelated monitor issue"}]'
    fi
    ;;
  *" issue close "*) printf 'closed' ;;
  *) : ;;
esac
GHSTUB
  chmod +x "$dir/gh"
}

# run_gate <mode> <manifest-json> -> "<exit>|<close calls>|<combined output>"
#
# The generated driver is written to a FILE and run, rather than handed to
# `bash -c "$( ... )"`. Nesting command substitutions that build a script inside
# a double-quoted argument is a quoting minefield, and a mistake there fails
# silently as an empty extraction.
run_gate() {
  local mode="$1" manifest="$2" stub work out rc closes
  stub="$(mktemp -d)"; work="$(mktemp -d)"
  : > "$stub/calls.log"
  make_gh_stub "$stub"
  printf '%s' "$manifest" > "$work/created-issues.json"

  {
    grep -m1 '^MONITOR_FP=' "$TARGET"
    grep -m1 '^MONITOR_LIMIT=' "$TARGET"
    printf '%s\n' 'created_doc_ok() { jq -e '"'"'type=="object" and (.created|type=="array")'"'"' "$1" >/dev/null 2>&1; }'
    printf '%s\n' 'log() { printf '"'"'[gate] %s\n'"'"' "$*"; }'
    extract '_monitor_holders() {'
    extract 'cmd_dedup_verify() {'
    printf '%s\n' 'cmd_dedup_verify "$CREATED_OUT"'
  } > "$work/gate.sh"

  out="$(PATH="$stub:$PATH" \
    GH_CALL_LOG="$stub/calls.log" GH_MODE="$mode" \
    GH_FP_ID=910 GH_DUP_ID=911 \
    REPO="o/r" CREATED_OUT="$work/created-issues.json" \
    bash "$work/gate.sh" 2>&1)"
  rc=$?
  # Counted before the stub is removed, or the assertion passes on a missing
  # file — which is how a broken harness reports a clean result.
  closes="$(grep -c 'issue close' "$stub/calls.log" 2>/dev/null)"
  closes="${closes:-0}"
  rm -rf "$stub" "$work"
  # Field order matters: the captured output is multi-line, so it goes last and
  # the scalars before it are split positionally.
  printf '%s|%s|%s' "$rc" "$closes" "$out"
}

echo "upstream-monitor dedup gate"

# The assertions below are meaningless unless the real code was actually
# extracted, so that is checked first.
if [ -n "$HOLDERS_FN" ] && [ -n "$VERIFY_FN" ] \
   && printf '%s' "$HOLDERS_FN" | grep -q 'gh issue list' \
   && printf '%s' "$VERIFY_FN" | grep -q 'closed.*duplicate'; then
  ok "the real _monitor_holders and cmd_dedup_verify were extracted"
else
  no "could not extract the dedup functions from $TARGET — assertions below would be vacuous"
  echo
  printf 'passed: %d  failed: %d\n' "$pass" "$fail"
  exit 1
fi

# Strip comment lines: the function documents that --arg must NOT reach gh, and
# matching its own explanation would be a false positive.
code_only() { grep -v '^[[:space:]]*#' <<< "$1"; }

MANIFEST='{"created":[{"number":910,"id":"abc","url":"u","title":"t","score":9}],"skipped":[],"failed":[]}'

# 1. THE BUG. A lookup that cannot be performed, failed exactly the way real gh
#    failed the broken call (exit 141, "unknown flag: --arg"). The gate must not
#    claim a clean result and must not print "closed 0 duplicate(s)" — which is
#    precisely what the broken version did on every single run.
brk="$(run_gate apifail "$MANIFEST")"
brk_rc="${brk%%|*}"; brk_rest="${brk#*|}"; brk_out="${brk_rest#*|}"
if [ "$brk_rc" != "0" ]; then
  ok "a gh that rejects --arg makes the gate exit non-zero (got $brk_rc)"
else
  no "the gate exited 0 when the holder lookup could not run"
fi
if printf '%s' "$brk_out" | grep -q 'closed 0 duplicate(s)'; then
  no "the gate printed 'closed 0 duplicate(s)' after a failed lookup — the original false-success bug"
else
  ok "the gate does NOT print 'closed 0 duplicate(s)' after a failed lookup"
fi
if printf '%s' "$brk_out" | grep -qi 'UNVERIFIED'; then
  ok "a failed lookup is reported as UNVERIFIED"
else
  no "a failed lookup was not reported: $(tr '\n' ' ' <<< "$brk_out")"
fi

# 2. Real holders with a matching fingerprint: the gate must find them and act.
#    Without this the suite would be satisfied by a gate that never closes
#    anything, which is the opposite failure.
dup="$(run_gate dupes "$MANIFEST")"
dup_rc="${dup%%|*}"; dup_rest="${dup#*|}"; dup_closes="${dup_rest%%|*}"; dup_out="${dup_rest#*|}"
if [ "$dup_rc" = "0" ]; then
  ok "a verified run with a real duplicate exits 0"
else
  no "a run that closed a duplicate exited $dup_rc"
fi
if [ "$dup_closes" = "1" ]; then
  ok "a real duplicate holder is actually closed (gh issue close called once)"
else
  no "expected 1 'gh issue close' call for a duplicate, got $dup_closes"
fi
if printf '%s' "$dup_out" | grep -q '#911 duplicates #910'; then
  ok "the gate names the duplicate and the issue it duplicates"
else
  no "the gate did not report the duplicate: $(tr '\n' ' ' <<< "$dup_out")"
fi
if printf '%s' "$dup_out" | grep -q 'every created issue verified'; then
  ok "a completed verification says so explicitly"
else
  no "no explicit 'verified' line: $(tr '\n' ' ' <<< "$dup_out")"
fi

# 3. CONTROL: no holders. A genuine 0-duplicate result must still be a success,
#    or the gate would just be permanently red, which is not a fix.
ctl="$(run_gate clean "$MANIFEST")"
ctl_rc="${ctl%%|*}"; ctl_rest="${ctl#*|}"; ctl_out="${ctl_rest#*|}"
if [ "$ctl_rc" = "0" ]; then
  ok "no holders is a clean success (exit 0)"
else
  no "no holders exited $ctl_rc — the gate is permanently red"
fi
if printf '%s' "$ctl_out" | grep -q 'closed 0 duplicate(s); every created issue verified'; then
  ok "a genuine 0-duplicate result is reported as verified"
else
  no "a genuine 0-duplicate result was not reported: $(tr '\n' ' ' <<< "$ctl_out")"
fi

# 4. An issue with no readable fingerprint is UNVERIFIED, never silently clean.
emp="$(run_gate empty "$MANIFEST")"
emp_rc="${emp%%|*}"; emp_rest="${emp#*|}"; emp_out="${emp_rest#*|}"
if [ "$emp_rc" != "0" ] && printf '%s' "$emp_out" | grep -q 'no readable monitor-id'; then
  ok "a created issue with no readable fingerprint is UNVERIFIED and fails"
else
  no "an unreadable fingerprint was not treated as unverified (rc=$emp_rc)"
fi

# 5. An unreadable manifest still fails closed.
bad="$(run_gate clean '{"created":"not-an-array"}')"
bad_rc="${bad%%|*}"
if [ "$bad_rc" != "0" ]; then
  ok "an unreadable manifest fails closed (exit $bad_rc)"
else
  no "an unreadable manifest exited 0"
fi

# 6. The call site must not swallow a failed verification.
if [ "$CALL_SITE" -eq 1 ]; then
  ok "cmd_publish propagates a failed verification instead of logging past it"
else
  no "expected 1 call site that propagates the dedup result, found $CALL_SITE"
fi

# 7. Static guards against the exact regression, in case the behaviour above is
#    ever re-broken in a way the fake gh does not model.
# The check is about the GH invocation specifically. `--arg` on the separate jq
# filter is correct and required — that is how workflow-health.sh passes the
# fingerprint — so grepping the whole function would fail the right code.
if code_only "$HOLDERS_FN" | grep -- 'gh issue list' | grep -q -- '--arg'; then
  no "the gh issue list call passes --arg (unknown flag; the search can never work)"
else
  ok "the gh issue list call passes no --arg (it is on the jq filter, where it belongs)"
fi
if code_only "$HOLDERS_FN" | grep -qE 'jq .*--arg'; then
  ok "the fingerprint is passed to jq via --arg (the client-side filter)"
else
  no "the client-side jq filter does not receive the fingerprint"
fi
if printf '%s' "$HOLDERS_FN" | grep -qE 'return 3|return 1'; then
  ok "_monitor_holders can report a failed lookup"
else
  no "_monitor_holders has no failure return — a silent empty result is the bug"
fi

echo
printf 'passed: %d  failed: %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
