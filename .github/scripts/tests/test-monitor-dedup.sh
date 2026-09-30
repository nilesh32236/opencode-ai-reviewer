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
SELF="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
# Overridable so the MUTATION block can re-run this whole suite against a
# deliberately broken copy and assert that it goes red.
TARGET="${MUTANT_TARGET:-$REPO_ROOT/.github/scripts/upstream-monitor.sh}"
TEST_CALLS="$(mktemp)"
trap 'rm -f "$TEST_CALLS"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); printf '  ok  %s\n' "$1"; }
no() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }

# Comments off, so a static guard below cannot be satisfied by prose describing
# a behaviour the code does not have.
code_only() { grep -v '^[[:space:]]*#' <<< "$1"; }

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
#
# GH_MODE:
#   (default)   910 and 911 exist, bodies from GH_BODY_910 / GH_BODY_911
#   empty       `gh issue view` returns a body with no fingerprint at all
#   readfail    `gh issue view` FAILS. The read fails and NOTHING else does,
#               so a run that mislabels it as a missing fingerprint cannot be
#               distinguished from a correct one by its exit code alone — only
#               by the wording.
#   apifail     `gh issue list` fails (the original --arg bug)
#   noholders   `gh issue list` returns a genuinely EMPTY array
#   three       910, 911 and 912 all exist and all carry the same fingerprint
#   closefail   `gh issue close` fails
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
    if [ "$GH_MODE" = "readfail" ]; then
      printf 'gh: Not Found (HTTP 404)\n' >&2
      exit 1
    fi
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
    elif [ "$GH_MODE" = "noholders" ]; then
      printf '[]'
    elif [ "$GH_MODE" = "selfonly" ]; then
      # The list holds exactly one issue: the one being evaluated. This is what
      # a real saturated run looks like, because the created issue is always a
      # holder of its own id.
      printf '[{"number":910,"body":%s}]' "$(printf '%s' "$GH_BODY_910" | jq -Rs .)"
    elif [ "$GH_MODE" = "unreadableplus" ]; then
      # 910 and 911 carry a real fingerprint; 912 carries a stale one. The
      # run closes a real duplicate AND has a structurally unmatched candidate.
      printf '[{"number":910,"body":%s},{"number":911,"body":%s},{"number":912,"body":"Summary: stale\\n\\n<!-- monitor-id: ABCDEF0123ABCDEF0123ABCDEF0123ABCDEF0123ABCDEF0123ABCDEF0123ABCDEF01 -->\\n"}]' \
        "$(printf '%s' "$GH_BODY_910" | jq -Rs .)" \
        "$(printf '%s' "$GH_BODY_911" | jq -Rs .)"
    elif [ "$GH_MODE" = "three" ]; then
      printf '[{"number":910,"body":%s},{"number":911,"body":%s},{"number":912,"body":%s}]' \
        "$(printf '%s' "$GH_BODY_910" | jq -Rs .)" \
        "$(printf '%s' "$GH_BODY_911" | jq -Rs .)" \
        "$(printf '%s' "$GH_BODY_912" | jq -Rs .)"
    else
      printf '[{"number":910,"body":%s},{"number":911,"body":%s}]' \
        "$(printf '%s' "$GH_BODY_910" | jq -Rs .)" \
        "$(printf '%s' "$GH_BODY_911" | jq -Rs .)"
    fi
    ;;
  *" issue close "*)
    if [ "$GH_MODE" = "closefail" ]; then
      printf 'gh: cannot close issue (HTTP 403)\n' >&2
      exit 1
    fi
    printf 'closed' ;;
  *) : ;;
esac
GHSTUB
  chmod +x "$dir/gh"
}

# run_gate <mode> <body-910> <body-911> [manifest] -> "<rc>|<closes>|<output>"
#
# The call log is also copied to $TEST_CALLS so a test can assert on the calls
# that were NOT made. `closes` is counted before the stub is removed, or the
# assertion would pass on a missing file — which is how a broken harness
# reports a clean result.
run_gate() {
  local mode="$1" b910="$2" b911="$3" manifest="${4:-}" stub work out rc closes
  stub="$(mktemp -d)"; work="$(mktemp -d)"
  : > "$stub/calls.log"
  make_gh_stub "$stub"
  # badbase64 shadows base64 with a binary that always fails, which is what a
  # host without coreutils' base64 actually presents. A corrupt .body field
  # cannot simulate this: the holder loop re-encodes bodies with jq's own
  # @base64 before decoding, so a bad field still round-trips cleanly and the
  # decode never fails. The failure mode lives in the DECODER, not the data.
  if [ "$mode" = "badbase64" ]; then
    printf '#!/usr/bin/env bash\nexit 1\n' > "$stub/base64"
    chmod +x "$stub/base64"
  fi
  [ -n "$manifest" ] || manifest='{"created":[{"number":910}],"skipped":[],"failed":[]}'
  printf '%s' "$manifest" > "$work/created-issues.json"

  {
    # The real script runs under `set -euo pipefail`, and this driver MUST too.
    # Without it the suite is not testing the shell the gate actually runs in:
    # `x="$(f)"; rc=$?` survives under a bare `bash` but ABORTS the whole
    # monitor under errexit, because an assignment takes the exit status of its
    # command substitution. A suite that omits this exercises code production
    # can never reach, and reports green on a gate that dies silently. Two
    # defects here and the silent-decode defect below all shipped green
    # because of it, so the options are part of the fixture, not a detail.
    printf '%s\n' 'set -euo pipefail'
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
    GH_BODY_910="$b910" GH_BODY_911="$b911" GH_BODY_912="${b911}" GH_COUNT="${GH_COUNT:-2}" \
    REPO="o/r" CREATED_OUT="$work/created-issues.json" \
    bash "$work/gate.sh" 2>&1)"
  rc=$?
  # Counted before the stub is removed, or the assertion passes on a missing
  # file — which is how a broken harness reports a clean result.
  closes="$(grep -c 'issue close' "$stub/calls.log" 2>/dev/null)"
  closes="${closes:-0}"
  [ -n "${TEST_CALLS:-}" ] && cp "$stub/calls.log" "$TEST_CALLS" 2>/dev/null
  rm -rf "$stub" "$work"
  # Field order matters: the captured output is multi-line, so it goes last.
  printf '%s|%s|%s' "$rc" "$closes" "$out"
}

# How many `gh issue list` calls the last run_gate made.
issue_list_calls() { grep -c 'issue list' "$TEST_CALLS" 2>/dev/null || printf '0'; }

# non_id_refused <token> — the gate must treat a `<!-- monitor-id: TOKEN -->`
# whose TOKEN is not a 64-hex id as UNREADABLE: close nothing and report
# UNVERIFIED. Pure predicate (exit status only, no counters) so the MUTATION
# block at the end can assert the OPPOSITE of this without disturbing the run.
non_id_refused() { # non_id_refused <token>
  local val="$1" tb r rc rest closes
  tb="Summary: something

<!-- monitor-id: ${val} -->
"
  r="$(run_gate dupes "$tb" "$tb")"
  rc="${r%%|*}"; rest="${r#*|}"; closes="${rest%%|*}"
  [ "$closes" = "0" ] && [ "$rc" != "0" ]
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

ID1=0f46add13001c4c0cced236495ac5b83cb464cf87d1b2eb1c106de5314e2ba17
ID2=2fdcbf8ba39ada2a4f84703379e39a8f6cd27f45ad9ce53b63f04e2f868663e0
CANON="Summary: s

<!-- monitor-id: ${ID1} -->
"
B910="Summary: original

<!-- monitor-id: ${ID1} -->
"

# ---------------------------------------------------------------------------
# THE REVIEW'S CASE. Same id (910), three different comment spellings on the
# candidate. Any byte-exact comparison misses these; comparing extracted ids
# does not. Note the CREATED issue uses the canonical spelling throughout, so
# these cases fail if and only if the CANDIDATE side is matched by bytes.
# ---------------------------------------------------------------------------
for variant in \
  'no space after the colon|<!-- monitor-id:@ID@ -->' \
  'no space after <!--|<!--monitor-id: @ID@ -->' \
  'no space before -->|<!-- monitor-id: @ID@-->'
do
  label="${variant%%|*}"; cand="${variant#*|}"; cand="${cand//@ID@/$ID1}"
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

# ---------------------------------------------------------------------------
# FIX-CAPABILITY, asserted on the EXTRACTOR rather than through the gate.
# Validating the extracted id's shape is the fix, and the obvious way to break
# it is to over-tighten until real fingerprints stop resolving — which would make
# every duplicate detection above vacuously pass for the wrong reason ("nothing
# matched, nothing was closed, gate is happy"). So pin the four spellings
# directly: the canonical form and all three whitespace near-misses must
# normalise to the SAME 64-hex id. If the pattern ever stops accepting near
# misses, this goes red even though every behavioural case above still passes.
# ---------------------------------------------------------------------------
extract_id() { # extract_id <body> -> what monitor_id_of actually returns
  local src; src="$(mktemp)"
  {
    grep -m1 '^MONITOR_ID_RE=' "$TARGET"
    extract 'monitor_id_of() {'
    printf '%s\n' 'monitor_id_of "$1"'
  } > "$src"
  bash "$src" "$1" 2>/dev/null
  rm -f "$src"
}
for spell in \
  'canonical|<!-- monitor-id: '"$ID1"' -->' \
  'no space after the colon|<!-- monitor-id:'"$ID1"' -->' \
  'no space after <!--|<!--monitor-id: '"$ID1"' -->' \
  'no space before -->|<!-- monitor-id: '"$ID1"'-->' \
  'wrapped onto two lines|<!-- monitor-id:
'"$ID1"' -->'
do
  slabel="${spell%%|*}"; stext="${spell#*|}"
  got="$(extract_id "Summary: x

${stext}
")"
  if [ "$got" = "$ID1" ]; then
    ok "monitor_id_of resolves the ${slabel} spelling to the same 64-hex id"
  else
    no "monitor_id_of lost fix-capability on the ${slabel} spelling: got '$(tr -d '\n' <<< "$got")' want '$ID1'"
  fi
done

# A wrapped fingerprint is what makes the whitespace tolerance a claim or a
# fiction. `sed` is line-oriented, so without folding the body to one line
# first this extracted to nothing and the gate hard-failed a perfectly
# readable issue. The extractor must do what its own comment says.
r="$(run_gate dupes "$B910" "Summary: wrapped

<!-- monitor-id:
${ID1} -->
")"
rc="${r%%|*}"; rest="${r#*|}"; closes="${rest%%|*}"; out="${rest#*|}"
if [ "$rc" = "0" ] && [ "$closes" = "1" ]; then
  ok "a fingerprint wrapped across two lines is still detected as a duplicate"
else
  no "a wrapped fingerprint was not detected: rc=$rc closes=$closes out=$(tr '\n' ' ' <<< "$out")"
fi

# Genuinely DIFFERENT ids are not duplicates. This is what stops the value
# comparison from becoming a mass-closer.
r="$(run_gate dupes "$B910" "Summary: unrelated

<!-- monitor-id: ${ID2} -->
")"
rc="${r%%|*}"; rest="${r#*|}"; closes="${rest%%|*}"; out="${rest#*|}"
if [ "$rc" = "0" ] && [ "$closes" = "0" ] \
   && printf '%s' "$out" | grep -q 'closed 0 duplicate(s); every created issue verified'; then
  ok "a different monitor-id is not a duplicate (no close, truthful 0)"
else
  no "different-id case wrong: rc=$rc closes=$closes out=$(tr '\n' ' ' <<< "$out")"
fi

# ---------------------------------------------------------------------------
# CONTROL, renamed. This used to be called "no holders at all", which it is not:
# the stub always returns issue 910, and 910 carries the same id as the created
# issue, so the holder set is {910} — the created issue and nothing else. What
# it actually exercises is that the created issue itself counts as its own
# single holder and is KEPT rather than closed. The genuinely-empty case is
# below, and it needs its own stub mode.
# ---------------------------------------------------------------------------
r="$(run_gate dupes "$B910" 'Summary: unrelated issue, no fingerprint here')"
rc="${r%%|*}"
if [ "$rc" = "0" ]; then
  ok "only-self holder (the created issue) is kept, not closed — clean success"
else
  no "only-self-holder case exited $rc — the gate would be permanently red"
fi

# The GENUINELY EMPTY holder set: the label exists and no issue at all carries
# the id, not even the created one. This is the everyday case on a healthy
# backlog, and it is the one that must still come back green — if it did not,
# the gate would be permanently red and would get switched off, which is the
# worse outcome. It also is the only path that issues the saturation count.
r="$(run_gate noholders "$B910" "$CANON")"
rc="${r%%|*}"; rest="${r#*|}"; closes="${rest%%|*}"; out="${rest#*|}"
if [ "$rc" = "0" ] && [ "$closes" = "0" ] \
   && printf '%s' "$out" | grep -q 'closed 0 duplicate(s); every created issue verified'; then
  ok "a genuinely empty holder set is a truthful clean success (exit 0, 0 closed)"
else
  no "empty-holder-set case wrong: rc=$rc closes=$closes out=$(tr '\n' ' ' <<< "$out")"
fi

# ---------------------------------------------------------------------------
# THE PLACEHOLDER. The prompt renders the fingerprint as `<!-- monitor-id: <id> -->
#`, and that literal string is NOT an id. A permissive `([^>]*)` extractor read
# it as the id "<id>", so every issue quoting the template shared one id and the
# gate closed them as duplicates of one another — a destructive false positive,
# worse than the false negative it replaced. An id is 64 lowercase hex and
# nothing else.
# ---------------------------------------------------------------------------
PLACEHOLDER='Summary: something

<!-- monitor-id: <id> -->
'
r="$(run_gate dupes "$PLACEHOLDER" "$PLACEHOLDER")"
rc="${r%%|*}"; rest="${r#*|}"; closes="${rest%%|*}"; out="${rest#*|}"
if [ "$closes" = "0" ] && [ "$rc" != "0" ] \
   && printf '%s' "$out" | grep -q 'UNVERIFIED'; then
  ok "the literal <id> placeholder is refused: nothing closed, UNVERIFIED"
else
  no "the placeholder was not refused: rc=$rc closes=$closes out=$(tr '\n' ' ' <<< "$out")"
fi

# The `<id>` case above is NOT by itself enough to pin the pattern down: `[^>]`
# cannot cross the '>' of "<id>", so a permissive `([^>]*)` would also fail to
# match it and the assertion would pass for the wrong reason. The values that
# actually separate strict from permissive are non-hex tokens, which `[^>]*`
# happily accepts and therefore makes every such issue share one id. A model
# that writes a short hex, a word, or an example token must not produce a
# closable "duplicate" group.
#
# The first two are the exact tokens the finding was reported with, and they are
# the ones a body QUOTING the fingerprint mechanism actually produces. This is
# not hypothetical here: the monitor routinely files findings about the monitor
# itself, so an issue explaining the fingerprint format quotes it.
for ph in \
  'a shell placeholder|$id' \
  'a short hex digest|abc123def456' \
  'short hex|abc123' \
  'a word|TBD' \
  'an example token|some-finding-id' \
  'uppercase hex|ABCDEF0123'
do
  plabel="${ph%%|*}"; pval="${ph#*|}"
  if non_id_refused "$pval"; then
    ok "a body quoting the fingerprint (${plabel}) is refused, nothing closed"
  else
    tb="Summary: something

<!-- monitor-id: ${pval} -->
"
    r="$(run_gate dupes "$tb" "$tb")"
    rc="${r%%|*}"; rest="${r#*|}"; closes="${rest%%|*}"
    no "a quoted fingerprint (${plabel}) was treated as a duplicate: rc=$rc closes=$closes"
  fi
done

# Two UNRELATED issues that merely quote the format in prose, with the same
# non-id text. Same outcome: an id we cannot read is an id we cannot compare,
# and a quoted example must never make two unrelated issues look alike.
PROSE='Summary: docs fix

The issue body must end with a fingerprint comment, for example
<!-- monitor-id: <id> -->
See the monitor publish prompt.
'
# Two UNRELATED issues, each quoting the SAME placeholder token. This is the
# DESTRUCTIVE direction — the one that actually closes things — and it is the
# case the permissive extractor gets catastrophically wrong: it reads `$id` as
# an id, so two issues that merely explain the fingerprint mechanism end up
# sharing an id and one is closed as a duplicate of the other, with a PAT and
# an autonomous comment.
#
# Note the two bodies quote DIFFERENT prose around the same token. A case using
# two different tokens would pass against the broken extractor too, so it would
# prove nothing; this one goes red under the mutation (see the MUTATION block).
PROSE_A='Summary: document the fingerprint format

The publish prompt renders the fingerprint as
<!-- monitor-id: $id -->
so I am recording what the placeholder looks like.
'
PROSE_B='Summary: monitor found its own prompt unclear

The lane writes
<!-- monitor-id: $id -->
verbatim when it echoes the template.
'
r="$(run_gate dupes "$PROSE" "$PROSE")"
rc="${r%%|*}"; rest="${r#*|}"; closes="${rest%%|*}"; out="${rest#*|}"
if [ "$closes" = "0" ] && [ "$rc" != "0" ]; then
  ok "prose quoting the format never becomes a duplicate: nothing closed, UNVERIFIED"
else
  no "quoted prose was treated as a duplicate: rc=$rc closes=$closes out=$(tr '\n' ' ' <<< "$out")"
fi

# ...and the DESTRUCTIVE direction, which is the one that actually closes
# things: two DIFFERENT issues, each quoting the SAME placeholder token, must
# not become one closable "duplicate" group.
r="$(run_gate dupes "$PROSE_A" "$PROSE_B")"
rc="${r%%|*}"; rest="${r#*|}"; closes="${rest%%|*}"; out="${rest#*|}"
if [ "$closes" = "0" ] && [ "$rc" != "0" ] \
   && printf '%s' "$out" | grep -q 'UNVERIFIED'; then
  ok "two DIFFERENT issues quoting the fingerprint are both left open, UNVERIFIED"
else
  no "quoted placeholders were closed as duplicates: rc=$rc closes=$closes out=$(tr '\n' ' ' <<< "$out")"
fi

# A valid created issue plus a candidate that quotes the template: the candidate
# has no id, so it is not a holder. It must not be closed, and it must not
# poison the verified result either.
r="$(run_gate dupes "$B910" "$PLACEHOLDER")"
rc="${r%%|*}"; rest="${r#*|}"; closes="${rest%%|*}"; out="${rest#*|}"
if [ "$closes" = "0" ] && [ "$rc" = "0" ]; then
  ok "a candidate quoting the template is not a holder and is not closed"
else
  no "template-quoting candidate mishandled: rc=$rc closes=$closes out=$(tr '\n' ' ' <<< "$out")"
fi

# A lookup that cannot be performed is UNVERIFIED, never a clean pass.
r="$(run_gate apifail "$B910" "$CANON")"
rc="${r%%|*}"; rest="${r#*|}"; out="${rest#*|}"
if [ "$rc" != "0" ] && ! printf '%s' "$out" | grep -q 'closed 0 duplicate(s)'; then
  ok "a failed lookup exits non-zero and claims no duplicate count"
else
  no "a failed lookup reported success: rc=$rc out=$(tr '\n' ' ' <<< "$out")"
fi

# A FAILED READ is not a MISSING FINGERPRINT. The stub fails ONLY `gh issue
# view`; every other call works. Both conditions leave $body empty, so a gate
# that does not check the exit status cannot tell them apart — and it then
# sends an operator to investigate a malformed body that was never written.
# Both are UNVERIFIED, so the exit code is identical either way and the
# assertion has to be on the WORDING.
r="$(run_gate readfail "$B910" "$CANON")"
rc="${r%%|*}"; rest="${r#*|}"; closes="${rest%%|*}"; out="${rest#*|}"
if [ "$rc" != "0" ] && [ "$closes" = "0" ] \
   && printf '%s' "$out" | grep -qi 'could not READ' \
   && ! printf '%s' "$out" | grep -q 'no monitor-id fingerprint at all'; then
  ok "a failed gh issue view is reported as a FAILED READ, not a missing fingerprint"
else
  no "a failed read was misreported: rc=$rc out=$(tr '\n' ' ' <<< "$out")"
fi

# Three holders of one id: the lowest survives, the other two are closed. This
# pins the "close all but the lowest" rule at a size where an off-by-one would
# show up in a count, and it exercises the multi-holder close loop.
r="$(run_gate three "$B910" "$CANON")"
rc="${r%%|*}"; rest="${r#*|}"; closes="${rest%%|*}"; out="${rest#*|}"
if [ "$rc" = "0" ] && [ "$closes" = "2" ] \
   && printf '%s' "$out" | grep -q '#911 duplicates #910' \
   && printf '%s' "$out" | grep -q '#912 duplicates #910'; then
  ok "3 holders of one id close exactly 2 (#911, #912) and keep #910"
else
  no "3-holder case wrong: rc=$rc closes=$closes out=$(tr '\n' ' ' <<< "$out")"
fi

# A close that FAILS is not a close. `closes` from run_gate counts close CALLS,
# so here it is 1 — the attempt happened. What must not happen is the gate
# reporting that as a closed duplicate: the count it prints is a claim about
# GitHub, and a 403 means the issue is still open.
r="$(run_gate closefail "$B910" "$CANON")"
rc="${r%%|*}"; rest="${r#*|}"; closes="${rest%%|*}"; out="${rest#*|}"
if [ "$rc" != "0" ] && [ "$closes" = "1" ] \
   && printf '%s' "$out" | grep -q 'could not close duplicate' \
   && ! printf '%s' "$out" | grep -q 'every created issue verified'; then
  ok "a failed gh issue close is UNVERIFIED and does not claim the duplicate was closed"
else
  no "a failed close reported success: rc=$rc closes=$closes out=$(tr '\n' ' ' <<< "$out")"
fi

# A body that will not DECODE is not a body with no fingerprint. The holder
# loop shuttles every candidate through base64 to survive the line-oriented
# read, and base64 is never `require`d anywhere in the script — so on a host
# without it every decode fails, every candidate is skipped as "no id", and
# the gate prints "closed 0 duplicate(s); every created issue verified" on
# every single run. A green light wired to nothing. Skipping the undecodable
# entry is the same false clean pass, reachable with base64 present.
r="$(run_gate badbase64 "$B910" "$CANON")"
rc="${r%%|*}"; rest="${r#*|}"; closes="${rest%%|*}"; out="${rest#*|}"
if [ "$rc" != "0" ] && [ "$closes" = "0" ] \
   && ! printf '%s' "$out" | grep -q 'closed 0 duplicate(s); every created issue verified'; then
  ok "an undecodable candidate body is UNVERIFIED, not skipped as 'no fingerprint'"
else
  no "an undecodable body was silently skipped into a clean pass: rc=$rc out=$(tr '\n' ' ' <<< "$out")"
fi
# An open monitor issue that mentions a monitor-id but carries an unreadable
# one can NEVER match — the id contract is not negotiable. That is a false
# negative, and before this it was a false negative with NO log line, which is
# the exact shape of bug this gate exists to remove: an issue with an uppercase
# or truncated footer was permanently invisible and nothing said why.
#
# The run stays GREEN here on purpose. The created issue genuinely was
# verified — its id was read, and the page it was looked up on was complete.
# A stale footer on some OTHER issue is a data problem to go and fix, and
# failing the whole publish over one would make the gate permanently red,
# which this suite calls the worse outcome. Loud warning, not a hard stop.
r="$(run_gate dupes "$B910" 'Summary: stale footer

<!-- monitor-id: ABCDEF0123ABCDEF0123ABCDEF0123ABCDEF0123ABCDEF0123ABCDEF0123ABCDEF01 -->
')"
rc="${r%%|*}"; rest="${r#*|}"; closes="${rest%%|*}"; out="${rest#*|}"
if [ "$rc" = "0" ] && [ "$closes" = "0" ] \
   && printf '%s' "$out" | grep -q 'not a 64-hex id' \
   && printf '%s' "$out" | grep -q 'closed 0 duplicate(s); every created issue verified'; then
  ok "an unreadable monitor footer is reported loudly, and the run stays truthful"
else
  no "the unreadable-footer false negative was silent or the count lied: rc=$rc closes=$closes out=$(tr '\n' ' ' <<< "$out")"
fi
# The same warning must appear when the gate DID close a real duplicate, so it
# is a property of the data and not of the clean-pass branch.
r="$(run_gate unreadableplus "$B910" "$CANON")"
rc="${r%%|*}"; rest="${r#*|}"; closes="${rest%%|*}"; out="${rest#*|}"
if [ "$rc" = "0" ] && [ "$closes" = "1" ] \
   && printf '%s' "$out" | grep -q 'not a 64-hex id'; then
  ok "the unreadable-footer warning is emitted even on a run that closed a real duplicate"
else
  no "the unreadable-footer warning is tied to the clean-pass branch: rc=$rc closes=$closes out=$(tr '\n' ' ' <<< "$out")"
fi

# ---------------------------------------------------------------------------
# THE SATURATION COUNT IS ONLY PAID FOR WHERE IT CAN MATTER. The second
# `gh issue list` exists solely to turn "there is nothing for me to close" into
# "there is nothing for me to close AND the page was complete". A run with a
# real duplicate to close has its answer, so paying for the count there doubles
# the API calls of the common path for a number the caller will not read —
# across up to 8 created issues, 8 wasted calls per run, every run, on a gate
# holding a PAT.
#
# "Nothing for me to close" is NOT "no holders at all". The issue being
# evaluated is always a holder of its own id, so a guard keyed on an empty
# result never fires in production — and a run whose only holder is the issue it
# was handed is about to close nothing and print "closed 0 duplicate(s); every
# created issue verified". That is the false-pass string, off a page it could
# not see all of. So the guard is keyed on the set of holders OTHER than the
# issue under evaluation.
# ---------------------------------------------------------------------------
r="$(run_gate dupes "$B910" "$CANON")"; lists="$(issue_list_calls)"
if [ "$lists" = "1" ]; then
  ok "a run with a real duplicate to close issues exactly 1 gh issue list call"
else
  no "the saturation count is still issued on a real hit: $lists gh issue list calls"
fi
r="$(run_gate three "$B910" "$CANON")"; lists="$(issue_list_calls)"
if [ "$lists" = "1" ]; then
  ok "a 3-holder run has real duplicates to close, so it pays 1 call"
else
  no "a 3-holder run paid for the saturation count it does not need: $lists calls"
fi
r="$(run_gate selfonly "$B910" "$CANON")"; lists="$(issue_list_calls)"
if [ "$lists" = "2" ]; then
  ok "an only-self-holder run proves page completeness (2 calls) before claiming 0 duplicates"
else
  no "an only-self-holder run did not prove completeness: $lists gh issue list calls"
fi
r="$(run_gate noholders "$B910" "$CANON")"; lists="$(issue_list_calls)"
if [ "$lists" = "2" ]; then
  ok "a lookup that found nothing issues 2 calls — the second proves the page was complete"
else
  no "the no-match path did not prove completeness: $lists gh issue list calls"
fi

# Saturation: a full page means "no duplicate" cannot be trusted, so the gate
# must CLOSE NOTHING. It must NOT claim a duplicate count, and it must not stop
# the monitor publishing — the issues already exist by this point, so failing the
# step would not prevent them; it would only block the next run while the
# backlog it is complaining about keeps growing.
#
# Two shapes of the same run, because the created issue is always a holder of
# its own id: one where the list came back empty, and one where the list came
# back holding only the issue under evaluation. The second is the one that
# happens in production, and the one that must not print the false-pass string.
for shape in "no holders|noholders" "only a self-holder|selfonly"; do
  slab="${shape%%|*}"; smode="${shape#*|}"
  r="$(GH_COUNT=500 run_gate "$smode" "$B910" "$CANON")"
  rc="${r%%|*}"; rest="${r#*|}"; closes="${rest%%|*}"; out="${rest#*|}"
  if [ "$closes" = "0" ] \
     && ! printf '%s' "$out" | grep -q 'closed 0 duplicate(s); every created issue verified' \
     && printf '%s' "$out" | grep -q 'MONITOR_LIMIT'; then
    ok "a saturated page with ${slab} closes nothing, claims no count, names the remedy"
  else
    no "a saturated page with ${slab} produced the false-pass string: closes=$closes out=$(tr '\n' ' ' <<< "$out")"
  fi
  if [ "$rc" = "0" ] && printf '%s' "$out" | grep -q 'PARTIAL'; then
    ok "a saturated page with ${slab} does not block publishing (exit 0, PARTIAL reported)"
  else
    no "saturation with ${slab} blocked publishing: rc=$rc out=$(tr '\n' ' ' <<< "$out")"
  fi
done

# ---------------------------------------------------------------------------
# FIX 2 — THE CEILING IS NOT A ONE-WAY TRIP. Counted over `--state all`, this
# gate's own duplicate-closing would push the number toward MONITOR_LIMIT
# forever: every issue it closes stays in the count. Counting OPEN issues makes
# closing a duplicate FREE a slot, so the ceiling is reached only by un-triaged
# findings. The assertion is on the search itself, not the constant.
# ---------------------------------------------------------------------------
if code_only "$HOLDERS_FN" | grep -q -- '--state open'; then
  ok "_monitor_holders counts OPEN issues, so closing a duplicate frees ceiling space"
else
  no "_monitor_holders still counts --state all — its own closes push it toward the ceiling forever"
fi
if code_only "$HOLDERS_FN" | grep -q -- '--state all'; then
  no "_monitor_holders still reaches for --state all (monotonic population)"
else
  ok "_monitor_holders issues no monotonic --state all query"
fi
# The growth rate has to be written down next to the number, or the next reader
# treats 500 as a constant instead of a deadline.
lim_note="$(grep -B25 '^MONITOR_LIMIT=' "$TARGET" | grep -c 'GROWTH RATE\|DEADLINE')"
if [ "${lim_note:-0}" -ge 1 ]; then
  ok "MONITOR_LIMIT records its growth rate / deadline beside the constant"
else
  no "MONITOR_LIMIT carries no growth-rate note — the next reader will treat it as a constant"
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

# The id pattern must be constrained, not just symmetric. A one-line static
# check for the literal `[0-9a-f]{64}` would pass against a pattern that
# accepts that AND anything else, so the constraint is proved behaviourally
# below instead.

# These two are properties of code the behavioural driver does not run, so
# they have to be checked statically. Both were reported against this branch
# by the AI review after a green suite, which is the definition of a gap in
# the suite.
if grep -q 'require base64' "$TARGET"; then
  ok "base64 is require'd — the holder loop cannot run silently on a host without it"
else
  no "base64 is never require'd; every holder body decode can fail silently and the gate stays green"
fi
# `x="$(f)"` followed by `rc=$?` takes the exit status of the command
# substitution, so under the script's `set -euo pipefail` it ABORTS the whole
# monitor before `rc` is ever read. The `|| rc=$?` form is required. Assert
# the call site, because a behavioural test cannot see an abort that happens
# before anything is logged.
if code_only "$VERIFY_FN" | grep -qE '^\s*rc=\$\?'; then
  no "cmd_dedup_verify reads \$? from a bare assignment — errexit aborts the script before it"
elif code_only "$VERIFY_FN" | grep -qE '\|\|\s*rc=\$\?'; then
  ok "cmd_dedup_verify captures the holder lookup's status errexit-safely (|| rc=\$?)"
else
  no "no recognisable errexit-safe status capture for the holder lookup in cmd_dedup_verify"
fi
# The driver must run the gate under the same shell options the real script
# does, or every assertion above is about a shell that never runs in CI.
if grep -q "printf '%s\\\\n' 'set -euo pipefail'" "$SELF"; then
  ok "the test driver runs the gate under the script's own set -euo pipefail"
else
  no "the test driver omits set -euo pipefail — errexit defects ship green"
fi

# ---------------------------------------------------------------------------
# MUTATION. A test that passes against the broken code is worthless, so this
# block breaks the code on purpose and requires the suite to notice.
#
# The mutation is the exact regression under test: widen the id validation back
# to "any token" — `([0-9a-f]{64})` -> `([^>]*)` — and re-run this entire suite
# against the mutant. It must go RED.
#
# If it does not, the assertions above are not testing validation at all, and
# this suite would happily certify a gate that closes unrelated issues over a
# shared template string. Run this way the mutant also re-enters this file with
# MUTANT_TARGET set, which is why the block is guarded on that being empty.
# ---------------------------------------------------------------------------
if [ -z "${MUTANT_TARGET:-}" ]; then
  mutant="$(mktemp)"
  sed 's/(\[0-9a-f\]{64})/([^>]*)/' "$TARGET" > "$mutant"
  if cmp -s "$TARGET" "$mutant"; then
    no "MUTATION NOT APPLIED — the permissive-id sed did not match, so this proves nothing"
  elif ! grep -q '^MONITOR_ID_RE=.*\[\^>\]\*' "$mutant"; then
    no "MUTATION NOT APPLIED — the mutant does not carry the permissive pattern"
  else
    mlog="$(mktemp)"
    MUTANT_TARGET="$mutant" bash "$0" > "$mlog" 2>&1
    mrc=$?
    mline="$(grep -E '^passed: [0-9]+  failed: [0-9]+$' "$mlog" | tail -1)"
    mfail="${mline##*failed: }"; mfail="${mfail%% *}"
    if [ "$mrc" -ne 0 ] && [ "${mfail:-0}" -ge 1 ]; then
      ok "MUTATION: widening the id validation to any token turns this suite RED (${mline})"
    else
      no "MUTATION SURVIVED — a permissive id validator still passes this suite ($mline)"
      sed -n 's/^  FAIL /    /p' "$mlog" | head -10
    fi
    rm -f "$mlog"
  fi
  rm -f "$mutant"
fi

echo
printf 'passed: %d  failed: %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
