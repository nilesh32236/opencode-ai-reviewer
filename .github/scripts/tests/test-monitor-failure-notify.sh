#!/usr/bin/env bash
#
# test-monitor-failure-notify.sh — the failure paths of the upstream monitor
# must be SEEN, not just red.
#
# THE DEFECT THIS EXISTS FOR. A red `create-issues` job left a red badge and a
# summary comment and filed nothing. Only `research` had a notify-failure
# companion, so a dedup-gate failure — the single most likely way this workflow
# fails — paged nobody, and `summary` still printed a clean-looking table of
# findings for a run that verified nothing it created. That is the mirror image
# of the check that could not fail: a failure nobody can observe is
# indistinguishable from a failure that did not happen.
#
# WHY THIS IS A STATIC TEST AND NOT A LIVE RUN. Proving the notifier fires for
# real needs a `create-issues` run that actually fails, which needs GH_PAT and
# OPENCODE_API_KEY. What CAN be proven here without secrets is the part that is
# actually wrong when it is wrong: that the job graph is wired so the notifier
# runs exactly when create-issues fails and not otherwise, that it cannot fail
# the workflow in a way that masks the cause, and that it says WHICH cause
# rather than "create-issues failed".
#
# The reachability check below SIMULATES GitHub's own rule — `needs: X` plus
# `if: failure()` means "run iff X failed" — rather than asserting on the
# literal string `if: failure()`. A notifier whose `if:` drifts to
# `if: always()` would still contain that substring and would then page on every
# single run, which is the alert-fatigue failure this test exists to prevent.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# WF_OVERRIDE lets the mutation block below point this file at a mutated
# copy. It was missing at first, which made every mutation VACUOUS: the
# child read the real workflow, passed, and the loop reported "survived"
# for reasons that had nothing to do with the mutation.
WF="${WF_OVERRIDE:-$REPO_ROOT/.github/workflows/upstream-monitor.yml}"
SELF="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
MONITOR="$REPO_ROOT/.github/scripts/upstream-monitor.sh"

pass=0
fail=0
ok() { pass=$((pass + 1)); printf '  ok  %s\n' "$1"; }
no() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }

if [ ! -f "$WF" ]; then
  no "missing $WF — every assertion below would be vacuous"
  printf 'passed: %d  failed: %d\n' "$pass" "$fail"
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  no "python3 is required to parse the workflow"
  printf 'passed: %d  failed: %d\n' "$pass" "$fail"
  exit 1
fi

echo "upstream-monitor failure notification"

# One parse, reused. A strict parse is also the "does GitHub accept this"
# proxy available offline: Actions rejects a workflow it cannot parse, and a
# syntax error here means every assertion below is about a file CI will not run.
if python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" "$WF" 2>/tmp/wf-parse.err; then
  ok "upstream-monitor.yml parses as strict YAML"
else
  no "upstream-monitor.yml does not parse: $(tr '\n' ' ' < /tmp/wf-parse.err)"
  printf 'passed: %d  failed: %d\n' "$pass" "$fail"
  exit 1
fi

# Parse ONCE into a shell-readable cache. Every assertion below reads that, so
# the suite costs one python start instead of one per field — which matters
# because the mutation block re-runs the whole file five times.
WF_CACHE="$(mktemp)"
trap 'rm -f "$WF_CACHE"' EXIT
python3 - "$WF" > "$WF_CACHE" <<'PY'
import json, sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
print(json.dumps({
    'jobs': list(d.get('jobs', {})),
    'needs': {k: v.get('needs') for k, v in d.get('jobs', {}).items()},
    'ifs':   {k: str(v.get('if', 'success()')) for k, v in d.get('jobs', {}).items()},
    'runs':  {k: '\n'.join(s['run'] for s in (v.get('steps') or []) if 'run' in s)
              for k, v in d.get('jobs', {}).items()},
    'summary_env': yaml.safe_dump(((d.get('jobs', {}).get('summary', {}).get('steps') or [{}])[-1]).get('env') or {}),
}, indent=0))
PY

wf_field() { # wf_field <key> — emits JSON, so a caller can json.load it again
  python3 -c "import json,sys;print(json.dumps(json.load(open(sys.argv[1]))[sys.argv[2]]))" \
    "$WF_CACHE" "$1" 2>/dev/null
}
job_runs() { # job_runs <job>
  python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['runs'].get(sys.argv[2],''))" "$WF_CACHE" "$1" 2>/dev/null
}

# notify_fires <job> <result-of-that-job> -> prints 1/0/COMPLEX.
# Models GitHub's own rule rather than substring-matching `if: failure()`: a
# `needs: X` job runs `if` only when X ran, with failure()/success() bound to
# X's result. A near-miss such as `if: always()` or `if: success() || failure()`
# would still page on green, and only the semantics catch that.
notify_fires() { # notify_fires <job> <result>
  python3 - "$WF_CACHE" "$1" "$2" <<'PY'
import json, re, sys
d = json.load(open(sys.argv[1]))
job, result = sys.argv[2], sys.argv[3]
cond, needs = d['ifs'].get(job, 'success()'), d['needs'].get(job)
needs = [needs] if isinstance(needs, str) else (needs or [])
if not re.fullmatch(r"[A-Za-z0-9_ .!&|()\-]*", cond):
    print('COMPLEX'); sys.exit(0)
# GitHub's `failure()` / `success()` / `cancelled()` are three DIFFERENT
# BOOLEAN predicates over the result. Two ways to get this wrong, both done:
# returning the status STRING (truthy for every result, so `if: failure()`
# evaluated TRUE on a green run), and binding all three to one function. Only
# `failure()` is true for a failed result; only `success()` for a green one.
def preds(r):
    return {'failure':   (lambda: r == 'failure'),
            'success':   (lambda: r == 'success'),
            'cancelled': (lambda: r == 'cancelled')}
env = dict(preds(result))
env['always'] = (lambda: True)
# A job's own status functions are bound to its NEEDS, not to itself; here the
# notifier's only need is create-issues, so the same result applies.
env.update({n: dict(preds(result)) for n in needs})
try:
    print('1' if eval(cond, {'__builtins__': {}}, env) else '0')
except Exception:
    print('ERROR')
PY
}

# ---------------------------------------------------------------------------
# 1. THE NOTIFIER EXISTS, AND IS WIRED TO THE RIGHT JOB.
# ---------------------------------------------------------------------------
JOB="notify-create-issues"
if [ -n "$(wf_field jobs | tr -d "[]', " | tr ' ' '\n' | grep -cx "$JOB")" ]; then
  ok "the $JOB job exists"
else
  no "no $JOB job — a red create-issues would still page nobody"
fi

needs="$(wf_field needs | python3 -c "import json,sys;print(json.load(sys.stdin).get('$JOB',''))" 2>/dev/null)"
if [ "$needs" = "create-issues" ]; then
  ok "it needs create-issues (not research — research already has its own notifier)"
else
  no "it needs '$needs', expected 'create-issues'"
fi

# ---------------------------------------------------------------------------
# 2. REACHABILITY, SIMULATED. `needs: X` + `if: failure()` means "run iff X
#    failed". Assert the RULE, not the substring: `if: always()` also contains
#    "failure" nowhere, but a near-miss like `if: success() || failure()` would
#    page on every green run, and `if: failure() && github.event_name == 'x'`
#    would never fire. The evaluator below models GitHub's semantics for the
#    `needs:` list and the documented `if:` forms, so a drifted condition fails
#    here instead of in production.
# ---------------------------------------------------------------------------

f="$(notify_fires "$JOB" failure)"
if [ "$f" = "1" ]; then
  ok "the notifier FIRES when create-issues fails"
else
  no "the notifier does not fire on a failed create-issues (fired=$f)"
fi

f="$(notify_fires "$JOB" success)"
if [ "$f" = "0" ]; then
  ok "the notifier is SKIPPED when create-issues succeeds (no alert fatigue)"
else
  no "the notifier fires on a GREEN create-issues — it would page every run (fired=$f)"
fi

f="$(notify_fires "$JOB" skipped)"
if [ "$f" = "0" ]; then
  ok "the notifier is SKIPPED when create-issues is skipped (no actionable findings)"
else
  no "the notifier fires when create-issues was skipped (fired=$f)"
fi

# ---------------------------------------------------------------------------
# 3. IT MUST NOT LOOP. If the notifier itself fails, it fails the workflow in a
#    way that masks the original cause and can re-trigger attention on an
#    already-reported problem. Every `gh` call is `|| true` and the step ends
#    with an explicit `exit 0`, matching the research notifier.
# ---------------------------------------------------------------------------
job_block="$(job_runs "$JOB")"

gh_starts="$(grep -cE '^[[:space:]]*gh ' <<< "$job_block" | tr -d ' ')"
gh_guards="$(grep -cF '|| true' <<< "$job_block" | tr -d ' ')"
# Counted separately because `gh issue create` is split with line continuations,
# so its `|| true` sits on a different line than the command start. A per-line
# grep under-counts the guards and would report a false unguarded call.
if [ "$gh_starts" -gt 0 ] && [ "$gh_guards" -ge "$gh_starts" ]; then
  ok "all $gh_starts gh command(s) in the notifier are guarded with || true (it cannot fail the workflow)"
else
  no "$gh_starts gh command(s) but only $gh_guards || true guard(s) — it can fail the workflow and mask the cause"
fi

if grep -qE '^\s*exit 0\s*$' <<< "$job_block"; then
  ok "the notifier ends in an explicit exit 0"
else
  no "the notifier has no explicit exit 0 — a gh hiccup could fail the workflow"
fi

# The other half of not looping: no job the notifier depends on may depend on
# the notifier back. GitHub rejects a cyclic needs graph outright, so this is
# asserted directly rather than inferred.
cycle="$(python3 -c "
import json,sys
d=json.load(open(sys.argv[1])); job=sys.argv[2]
n=d['needs'].get(job); n=[n] if isinstance(n,str) else (n or [])
print('ok' if not any(job in (d['needs'].get(x) or []) for x in n) else 'cycle')" "$WF_CACHE" "$JOB")"
if [ "$cycle" = "ok" ]; then
  ok "the notifier introduces no needs cycle"
else
  no "the notifier creates a cyclic needs graph — GitHub would reject the workflow"
fi

# ---------------------------------------------------------------------------
# 4. IT NAMES THE CAUSE. "create-issues failed" tells a maintainer nothing about
#    which of the three distinct failures they are looking at, and these need
#    three different fixes.
# ---------------------------------------------------------------------------
for pair in \
  'a mangled fingerprint (not 64-hex):Fingerprint mangled' \
  'a failed GitHub read:GitHub read failure' \
  'a missing fingerprint entirely:Fingerprint missing' \
  'backlog saturation:Backlog saturation' \
  'a publish failure with no dedup verdict:create-issues failed before the dedup gate reported'
do
  label="${pair%%:*}"; needle="${pair#*:}"
  if grep -qF "$needle" <<< "$job_block"; then
    ok "the notifier distinguishes ${label}"
  else
    no "the notifier does not mention ${label} — a triage would have to read the raw log"
  fi
done

# The cause is selected from the gate's OWN outputs, so the distinction is real
# rather than a comment: mangled vs read-failure must key off different fields.
if grep -q 'DEDUP_MANGLED' <<< "$job_block" && grep -q 'DEDUP_READFAIL' <<< "$job_block" \
   && grep -q 'DEDUP_NOFP' <<< "$job_block"; then
  ok "the notifier selects the cause from the gate's distinct outputs, not a single flag"
else
  no "the notifier cannot tell the causes apart — the per-cause outputs are not wired"
fi

# ---------------------------------------------------------------------------
# 5. THE MANGLING RATE IS REPORTED. A paging path is only useful while it is
#    rare. The rate must be in the notification so the alert carries its own
#    usefulness judgement, and the threshold must be stated, or the next person
#    to be paged has no way to know whether to act or to ignore it.
# ---------------------------------------------------------------------------
if grep -q 'Mangling rate' <<< "$job_block"; then
  ok "the notification reports the mangling rate"
else
  no "the notification omits the mangling rate"
fi
if grep -qE '1 in 8|~12%' <<< "$job_block"; then
  ok "the notification states the rate above which paging stops being useful"
else
  no "the notification gives no threshold for when this alert becomes noise"
fi
if grep -q 'Do NOT relax the id check' <<< "$job_block"; then
  ok "the notification warns against the tempting wrong fix (relaxing the id check)"
else
  no "the notification does not warn that relaxing the id check reopens the false positive"
fi

# The rate must be emitted on EVERY run, not only the failing one — a rate you
# can only see after it has paged you is a rate you cannot trend.
if grep -q 'write_output dedup_mangle_rate' "$MONITOR"; then
  ok "the gate emits dedup_mangle_rate"
else
  no "the gate never emits a mangling rate"
fi
rate_line="$(grep -n 'dedup_verify: fingerprint quality' "$MONITOR" | head -1 | cut -d: -f1)"
mangle_line="$(grep -n 'UNVERIFIED — \${failed} created issue' "$MONITOR" | head -1 | cut -d: -f1)"
if [ -n "$rate_line" ] && [ -n "$mangle_line" ] && [ "$rate_line" -lt "$mangle_line" ]; then
  ok "the rate is computed before the UNVERIFIED return, so a failing run still reports it"
else
  no "the rate is emitted after the failure return, so a failing run never reports it"
fi

# ---------------------------------------------------------------------------
# 6. THE SUMMARY DOES NOT PAPER OVER IT. `summary` runs with `if: always()` and
#    is the one artefact a human is guaranteed to read; on a failed
#    create-issues it must lead with the failure, not a clean results table.
# ---------------------------------------------------------------------------
sum_env="$(wf_field summary_env)"
if grep -q 'CREATE_ISSUES_RESULT' <<< "$sum_env"; then
  ok "the summary job passes create-issues' result into the report"
else
  no "the summary does not know how create-issues ended"
fi
# NOTE: grep the FILE. `grep -q "$x" <<< "$MONITOR"` feeds the variable — which
# holds a PATH, not the file's contents — and so silently asserts on the
# filename. That is how this loop first reported three failures for text that
# was present all along.
for state in FAILED "not run" verified; do
  if grep -q "$state" "$MONITOR"; then
    ok "the report renders a verdict for the '${state}' case"
  else
    no "the report has no rendering for the '${state}' case"
  fi
done

# The failure verdict must come BEFORE the results table, or a reader who
# skims sees a healthy table.
if python3 - "$MONITOR" <<'PY'
import sys
src = open(sys.argv[1]).read()
body = src[src.index('cmd_report()'):]
i_fail = body.find('Issue publication FAILED')
i_res = body.find("## Results")
sys.exit(0 if (i_fail != -1 and i_res != -1 and i_fail < i_res) else 1)
PY
then
  ok "the failure verdict is rendered BEFORE the results table"
else
  no "the failure verdict is not ahead of the results table — a skim reads green"
fi

# ---------------------------------------------------------------------------
# 7. MUTATION. A notifier that is structurally correct on paper but does not
#    fire, or fires on green, must be shown to turn this suite RED — otherwise
#    these assertions are decoration.
# ---------------------------------------------------------------------------
MUTANT_NOTIFY="${MUTANT_NOTIFY:-}"
# Depth guard as well as the flag: a child that somehow re-enters is capped at
# one level by construction, and MUTANT_NOTIFY_DEPTH makes that explicit rather
# than relying on a single env var being threaded correctly.
if [ "${MUTANT_NOTIFY_DEPTH:-0}" -ge 1 ]; then
  MUTANT_NOTIFY=1
fi
if [ -z "$MUTANT_NOTIFY" ]; then
  echo
  echo "  MUTATION: the notifier's wiring must be load-bearing"

  for mut in nofail always-when-green loop-prone; do
    mm="$(mktemp)"; mlog="$(mktemp)"
    case "$mut" in
      # Drop the notifier's `if:` — the default is success(), so it never fires.
      nofail)      sed '/^    if: failure()$/d' "$WF" > "$mm" ;;
      # Make it fire on every run: the alert-fatigue failure.
      always-when-green) sed "s/^    if: failure()$/    if: always()/" "$WF" > "$mm" ;;
      # Remove one of the distinct causes, so the triage collapses.
      unname)      sed '/GitHub read failure/d' "$WF" > "$mm" ;;
      # Remove the `|| true` guards, so a gh hiccup fails the workflow.
      loop-prone)  sed 's/ || true$//' "$WF" > "$mm" ;;
    esac
    if cmp -s "$WF" "$mm"; then
      no "MUTATION NOT APPLIED ($mut) — the sed did not match, so this proves nothing"
      rm -f "$mm" "$mlog"; continue
    fi
    if ! python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" "$mm" 2>/dev/null; then
      no "MUTATION BROKEN ($mut) — the mutant is not valid YAML, so a red suite would prove nothing"
      rm -f "$mm" "$mlog"; continue
    fi
    # MUTANT_NOTIFY=1 is not optional. The child re-reads this file, and
    # without the flag it re-enters this very block and spawns its own
    # children, forever. That is not hypothetical: it happened, and it
    # filled /tmp to 100% before the run was killed.
    MUTANT_NOTIFY=1 MUTANT_NOTIFY_DEPTH=1 WF_OVERRIDE="$mm" bash "$SELF" > "$mlog" 2>&1
    if [ $? -ne 0 ] && grep -q '^  FAIL ' "$mlog"; then
      ok "MUTATION (${mut}): the suite goes RED when the notifier is broken this way"
    else
      no "MUTATION SURVIVED (${mut}) — a broken notifier still passes this suite"
      grep '^  FAIL ' "$mlog" | head -3 | sed 's/^/    /'
    fi
    rm -f "$mm" "$mlog"
  done
fi

echo
printf 'passed: %d  failed: %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
