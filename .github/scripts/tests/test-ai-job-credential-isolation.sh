#!/usr/bin/env bash
#
# test-ai-job-credential-isolation.sh — static assertion over .github/workflows.
#
# Invariant: a step that invokes a model must never also hold an LLM provider
# key AND a GitHub credential (GITHUB_TOKEN or a PAT). The repository maintains
# this boundary deliberately in two of its three automated workflows:
#
#   hourly-orchestrator  agent (LLM keys, no GitHub token) -> publish (PAT, no LLM keys)
#   self-improvement     agent/repair (LLM keys, no token) -> publish (GH_TOKEN only)
#
# Breaking it means model-reachable code executes in a process whose
# environment contains a write-capable credential. `upstream-monitor.yml`
# currently does (issue #937): its `create-issues` step passes both
# `GH_TOKEN` and `OPENCODE_API_KEY`, and the script it runs invokes
# `opencode run --auto` from that same environment.
#
# WHAT COUNTS AS "HOLDS A CREDENTIAL". A step can be handed a secret from four
# places, and the check has to read all four or it reports a clean repository
# over live exposures:
#
#   * `with:`       — inputs of a composite action. This is the common case:
#                     the `uses: ./` steps in ai-review.yml and
#                     scheduled-audit.yml pass the PAT as `github_token:` and
#                     the provider keys as `openai_api_key:` &c. Serialising
#                     only `env:` missed all five of those, because a
#                     composite action never sees an `env:` block at all.
#   * step `env:`
#   * job `env:`    — inherited by every step in the job.
#   * workflow `env:` — inherited by every step in every job.
#
# PERMISSION-BLIND — DELIBERATE. DO NOT ADD `permissions:` AWARENESS.
# A PAT's scope comes from the PAT, not from the job's `permissions:` block, so
# `permissions:` says nothing about whether a credential is write-capable.
# ai-review.yml's `fast-review` job declares `permissions: {}` and still hands
# its step `secrets.GH_PAT` through `with:`. A permission-aware guard would
# therefore DROP that exposure and report 5 violations instead of 6 — a false
# negative on precisely the class this guard exists to catch, which is the
# failure mode backlog item B1 was filed about. Leave the check blind.
#
# THE BUILT-IN TOKEN. The credential arm also matches `github.token` — both
# `${{ github.token }}` and `${{ toJSON(github.token) }}`. Note the asymmetry
# this creates and why it is still the right call: unlike a PAT, `github.token`'s
# scope DOES follow the job's `permissions:`, and this guard deliberately cannot
# see that scope, because consulting `permissions:` is what the note above
# forbids. So it treats a read-scoped `github.token` as a credential and
# over-detects. That is the correct direction for a guard whose failure mode is
# a false negative, and it is the same trade the model-invocation heuristic
# below already makes. `github.token` also needs no repository secret to be
# configured, so it is the cheapest credential to add by accident and the most
# likely form of the next mistake.
#
# MEASURED, so nobody has to re-derive it: on the corpus at this commit the
# pattern detects ZERO new violations — 6 before, 6 after. 15 model-invoking
# steps hold an LLM key, and not one of them references `github.token`. Every
# `github.token` in the repository is `${{ secrets.GH_PAT || github.token }}`
# in a non-model job (hourly-orchestrator discover/publish/trusted-fix and
# self-improvement publish), where the PAT arm already matches it. The
# justification for this pattern is therefore the fixtures below, which prove
# the guard CAN see such a step — not any count on the production corpus.
#
# WHAT COUNTS AS "INVOKES A MODEL":
#   * `uses: ./` — this repository's own composite action, whose whole purpose
#     is to drive the model.
#   * a `run:` body containing `opencode run`.
#   * a `run:` body calling one of the three scripts that reach
#     `opencode run --auto` internally:
#       .github/scripts/upstream-monitor.sh     (opencode run --auto)
#       .github/scripts/run-sec001-opencode.sh  (execve "<bin>" "run" "--auto")
#       .github/scripts/sec001-hourly-agent.sh  (calls the wrapper above)
#     Matched by basename, so the trusted copies under
#     /opt/sec001-trusted-${{ github.run_id }}/ count too. This is a coarse
#     heuristic — a `run:` body that merely names one of these scripts counts
#     even when it only installs it — but over-detection is the correct failure
#     direction for a guard whose purpose is to avoid false negatives.
#
# The check is deliberately static. The property belongs to the workflow file,
# and a runtime test could not observe it: the process either has the token in
# its environment or it does not.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SELF="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"

pass=0
fail=0
ok() { pass=$((pass + 1)); printf '  ok  %s\n' "$1"; }
no() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }

# Known violations, each tied to an issue. Removing an entry here is the
# deliberate act that records the fix — do NOT add a new one without an issue.
#
# upstream-monitor.yml:create-issues — issue #937 (open).
# ai-review.yml:review — issue #852, closed by #917; the structural fix for the
#   class (trusted-ref checkout) is open as #919.
# ai-review.yml:fix-issue, :fast-review, :autofix — the same exposure class as
#   #852 (a `uses: ./` step holding secrets.GH_PAT plus four provider keys in a
#   single `with:` block); #917's fix did not cover these jobs, so #919 tracks
#   the class. fast-review additionally declares `permissions: {}`, which does
#   not narrow a PAT — see the PERMISSION-BLIND note above.
# scheduled-audit.yml:audit — NO ISSUE YET. Untracked debt; an issue has to be
#   opened before this grandfather entry can be removed.
KNOWN_VIOLATIONS="upstream-monitor.yml:create-issues:Publish improvement issues
ai-review.yml:fix-issue:Fix issue
ai-review.yml:review:Review pull request
ai-review.yml:fast-review:Fast review
ai-review.yml:autofix:Autofix review loop
scheduled-audit.yml:audit:./"

# violations <root> — print one "<workflow>:<job>:<step>" label per model-invoking
# step that also holds both credential classes, over <root>/.github/workflows.
violations() {
  python3 - "$1" <<'PY'
import glob, os, re, sys, yaml

root = sys.argv[1]
LLM = re.compile(r'secrets\.([A-Z0-9_]*(?:API_KEY|TOKEN_CONTEXT7|CONTEXT7[A-Z0-9_]*))')
# The built-in token is `github.token`, NOT `github_token` — the dot is escaped
# on purpose. `github_token` is an ordinary action-input KEY, and four
# `uses: ./` steps carry one as the name of a PAT they already match; matching
# the key would flag any step that merely NAMES the input, including ones
# passing a literal placeholder. Case-sensitive for the same reason.
GH  = re.compile(r'secrets\.(GITHUB_TOKEN|GH_PAT)|github\.token')
# The `${{`-anchored form of the same arm, kept in sync deliberately.
GH_ENV = re.compile(r'\$\{\{\s*(?:secrets\.(GITHUB_TOKEN|GH_PAT)|github\.token)')
OPENCODE_RUN = re.compile(r'opencode\s+run')
MODEL_SCRIPT = re.compile(r'(upstream-monitor\.sh|run-sec001-opencode\.sh|sec001-hourly-agent\.sh)')

def invokes_model(step):
    if str(step.get('uses') or '').startswith('./'):
        return True
    run = str(step.get('run') or '')
    return bool(OPENCODE_RUN.search(run) or MODEL_SCRIPT.search(run))

# A SCAN THAT COULD NOT RUN IS NOT A SCAN THAT FOUND NOTHING.
#
# The loop below refuses on its own rather than letting a broken scan reach the
# comparison, and it refuses with a NAMED cause and NO PARTIAL OUTPUT. A raw
# Python traceback pointing at "<stdin>", line 138 tells an operator nothing;
# "could not read or parse hidden.yaml" tells them which file to go and look at.
# Collecting labels and printing them at the very end is what makes "printed
# nothing" mean "crashed" rather than "found nothing" — from outside, those two
# are otherwise the same observation.
def die(msg, where='scan'):
    sys.stderr.write(
        'credential-isolation SCAN FAILED (%s): %s\n'
        'The scan did not complete, so it has NOT established that the '
        'repository is clean. Treating this as a pass is how a real credential '
        'exposure ships undetected.\n' % (where, msg))
    sys.exit(2)

found_labels = []
scanned = 0
for path in sorted(glob.glob(os.path.join(root, '.github/workflows/*.yml'))
                 + glob.glob(os.path.join(root, '.github/workflows/*.yaml'))):
    name = os.path.basename(path)
    try:
        with open(path) as fh:
            doc = yaml.safe_load(fh) or {}
    except Exception as exc:
        die('could not read or parse (%s: %s)' % (type(exc).__name__, exc), name)
    if not isinstance(doc, dict):
        die('top level is %s, not a mapping' % type(doc).__name__, name)
    scanned += 1
    try:
        wf_env = doc.get('env') or {}
        for jname, job in (doc.get('jobs') or {}).items():
            job = job or {}
            job_env = job.get('env') or {}
            for step in (job.get('steps') or []):
                step = step or {}
                if not invokes_model(step):
                    continue
                # A secret reaches the step through any of the four channels.
                # Each source is serialised SEPARATELY and concatenated, so a
                # key that repeats across channels cannot make an earlier value
                # vanish from the scanned text. `env:` and `with:` are DIFFERENT
                # namespaces, so a benign `with:` entry never actually overrides
                # a workflow-`env:` secret in the running process — but merging
                # them into one dict did drop it from the text, which hid a live
                # exposure entirely.
                #
                # The comparison is presence-only (`llm and gh`), so a value that
                # legitimately appears in two channels is not counted twice.
                # Nothing here counts occurrences; that is what makes
                # concatenation safe here.
                parts = []
                for source in (wf_env, job_env, step.get('env') or {}, step.get('with') or {}):
                    if isinstance(source, dict):
                        parts.append(yaml.safe_dump(source))
                text = '\n'.join(parts)
                llm = LLM.search(text)
                gh  = (GH.search(text) or GH_ENV.search(text))
                if llm and gh:
                    found_labels.append(
                        "%s:%s:%s" % (name, jname, step.get('name') or step.get('uses') or '?'))
    except Exception as exc:
        die('could not be walked (%s: %s)' % (type(exc).__name__, exc), name)

# ZERO FILES IS A BROKEN SCAN, NOT A CLEAN REPOSITORY. A corpus that globbed to
# nothing has had every exposure in it skipped, and with KNOWN_VIOLATIONS empty
# the non-vacuity check reads zero references as the goal state — so the guard
# would announce "no step combines an LLM key with a GitHub credential" over a
# directory it never opened. This is the same class as the three #966 closed:
# a guard reporting success because it silently checked nothing.
if scanned == 0:
    die('no workflow files found under %s. A scan of zero files proves nothing, '
        'so this is a broken scan rather than a clean repository.'
        % os.path.join(root, '.github/workflows'))

for label in found_labels:
    print(label)
PY
}

# audit <root> <known-violations> — the guard itself, so the fixtures below
# exercise the real comparison logic and not just the detector. Returns 0 only
# when every reference is declared and every declaration is still live.
audit() {
  local root="$1" known="$2" found ref total=0 before="$fail" scan_rc=0
  found="$(violations "$root")"; scan_rc=$?
  # A crash must never read as a clean scan. This deliberately does NOT depend on
  # KNOWN_VIOLATIONS being non-empty: the non-vacuity check below cannot catch a
  # crash on its own, and tying safety to the debt list means the guard goes blind
  # at exactly the moment the team pays the debt down and empties it.
  if [ "$scan_rc" -ne 0 ]; then
    no "credential scan FAILED (exit $scan_rc) — the scan did not complete, so 'clean' would be a lie"
    return 1
  fi

  # Step names contain spaces, so read line by line rather than word-splitting.
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    total=$((total + 1))
    if grep -qxF "$ref" <<< "$known"; then
      ok "known violation (tracked): $ref"
    else
      no "UNDECLARED violation: $ref — add an issue and an entry in KNOWN_VIOLATIONS, or fix it"
    fi
  done <<< "$found"

  # Non-vacuity: a scan that matched nothing must never read as "clean". With no
  # declarations outstanding, zero references is the goal state; with
  # declarations outstanding, it means the scan went blind and every one of them
  # has just become a silent false negative.
  if [ "$total" -eq 0 ]; then
    if [ -n "$known" ]; then
      no "scan found 0 references but KNOWN_VIOLATIONS is non-empty — the scan matched nothing and would pass silently"
    else
      ok "no step combines an LLM key with a GitHub credential"
    fi
  fi

  # Runs in BOTH branches: once a declared violation is fixed, the declaration
  # itself becomes wrong, and leaving it would silently grandfather any future
  # violation back into "known".
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    if ! grep -qxF "$ref" <<< "$found"; then
      no "stale KNOWN_VIOLATIONS entry — '$ref' no longer violates; remove the declaration"
    fi
  done <<< "$known"

  [ "$fail" -eq "$before" ]
}

# assert_refuses <name> <fixture-slug> [must-mention-regex] — the guard must
# exit non-zero, name the failure, and NOT have printed its clean-pass line.
assert_refuses() {
  local name="$1" slug="$2" want="${3:-}" out rc
  out="$(bash "$0" --fixture-only "$slug" 2>&1)" && rc=0 || rc=$?
  if [ "$rc" -eq 0 ]; then
    no "$name — guard exited 0 on a scan that did not run: $(tr '\n' ';' <<< "$out")"
  elif ! grep -q 'SCAN FAILED' <<< "$out"; then
    no "$name — guard refused but never named the scan failure: $(tr '\n' ';' <<< "$out")"
  elif [ -n "$want" ] && ! grep -qE "$want" <<< "$out"; then
    no "$name — guard refused without naming what it could not read: $(tr '\n' ';' <<< "$out")"
  elif grep -q 'no step combines an LLM key' <<< "$out"; then
    no "$name — guard still printed its clean-pass line: $(tr '\n' ';' <<< "$out")"
  else
    ok "$name"
  fi
}


# MUTATION entry point. `--refuse-must-fail <slug>` runs ONLY the crash
# assertion and INVERTS it: a mutant that restores `|| true` must make this mode
# exit 0, which is how the fn1 check distinguishes "the crash test still catches
# the bug" from "the crash test happens to pass". It lives HERE, above the main
# audit, so a child run does not execute the whole suite first; and it
# re-declares the counters so a nested run cannot inherit the parent's tally.
if [ "${1:-}" = "--refuse-must-fail" ]; then
  pass=0; fail=0
  assert_refuses "mutant check" "$2"
  [ "$fail" -ne 0 ]
  exit
fi

# ---------------------------------------------------------------------------
# Fixtures. Each is a synthetic workflow written to a scratch directory and
# never to .github/workflows, carrying secret NAMES — which the guard has to
# recognise — but no secret values. They exist so the guard is proven against
# every known exposure shape rather than against whatever the corpus happens to
# hold today.
# ---------------------------------------------------------------------------
FIXTURES="$(mktemp -d)"
trap 'rm -rf "$FIXTURES"' EXIT

fixture_write() {
  local slug="$1" file="$2"
  mkdir -p "$FIXTURES/$slug/.github/workflows"
  cat > "$FIXTURES/$slug/.github/workflows/$file"
}

# Shape 1: ai-review.yml `fix-issue` — `uses: ./` with the PAT and a provider
# key as action inputs.
fixture_write shape-1-uses-with ai-review.yml <<'FIXTURE_EOF'
# TEST-FIXTURE (synthetic; secret names only, no real secret, not a live workflow)
# Exposure shape 1: ai-review.yml `fix-issue`.
name: TEST-FIXTURE ai-review
on: workflow_dispatch
permissions: {}
jobs:
  fix-issue:
    runs-on: ubuntu-24.04
    steps:
      - name: Fix issue
        uses: ./
        env:
          JEV_ENABLED: 'true'
        with:
          mode: fix
          github_token: ${{ secrets.GH_PAT }}
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
FIXTURE_EOF

# Shape 2: ai-review.yml `review` — same shape, GITHUB_TOKEN, no step env.
fixture_write shape-2-review ai-review.yml <<'FIXTURE_EOF'
# TEST-FIXTURE (synthetic; secret names only, no real secret, not a live workflow)
# Exposure shape 2: ai-review.yml `review`.
name: TEST-FIXTURE ai-review
on: pull_request
permissions: {}
jobs:
  review:
    permissions:
      pull-requests: write
    runs-on: ubuntu-24.04
    steps:
      - name: Review pull request
        uses: ./
        with:
          mode: review
          github_token: ${{ secrets.GITHUB_TOKEN }}
          opencode_api_key: ${{ secrets.OPENCODE_API_KEY }}
FIXTURE_EOF

# Shape 3: ai-review.yml `fast-review` — `permissions: {}` and still a PAT.
# This fixture fails if anyone makes the guard permission-aware.
fixture_write shape-3-fast-review ai-review.yml <<'FIXTURE_EOF'
# TEST-FIXTURE (synthetic; secret names only, no real secret, not a live workflow)
# Exposure shape 3: ai-review.yml `fast-review`, which declares
# `permissions: {}` and still receives a write-capable PAT. An empty
# permissions block does not narrow a PAT, so this must stay a violation.
name: TEST-FIXTURE ai-review
on: workflow_dispatch
permissions: {}
jobs:
  fast-review:
    permissions: {}
    runs-on: ubuntu-24.04
    steps:
      - name: Fast review
        uses: ./
        env:
          JEV_ENABLED: 'true'
        with:
          mode: review
          github_token: ${{ secrets.GH_PAT || secrets.GITHUB_TOKEN }}
          gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
FIXTURE_EOF

# Shape 4: ai-review.yml `autofix` — the fourth `uses: ./` step.
fixture_write shape-4-autofix ai-review.yml <<'FIXTURE_EOF'
# TEST-FIXTURE (synthetic; secret names only, no real secret, not a live workflow)
# Exposure shape 4: ai-review.yml `autofix`.
name: TEST-FIXTURE ai-review
on: pull_request
permissions: {}
jobs:
  autofix:
    permissions:
      contents: write
    runs-on: ubuntu-24.04
    steps:
      - name: Autofix review loop
        uses: ./
        with:
          mode: fix
          github_token: ${{ secrets.GH_PAT || secrets.GITHUB_TOKEN }}
          opencode_api_key: ${{ secrets.OPENCODE_API_KEY }}
FIXTURE_EOF

# Shape 5: scheduled-audit.yml `audit` — a `uses: ./` step with no `name:`, so
# the label falls back to the `uses` value.
fixture_write shape-5-scheduled-audit scheduled-audit.yml <<'FIXTURE_EOF'
# TEST-FIXTURE (synthetic; secret names only, no real secret, not a live workflow)
# Exposure shape 5: scheduled-audit.yml `audit`. The step carries no `name:`,
# so the guard labels it by its `uses:` value.
name: TEST-FIXTURE scheduled-audit
on:
  schedule:
    - cron: '0 0 * * 0'
permissions: {}
jobs:
  audit:
    runs-on: ubuntu-24.04
    steps:
      - uses: ./
        with:
          mode: audit
          model: opencode/muse-spark-1.3-contributor-free
          github_token: ${{ secrets.GH_PAT || secrets.GITHUB_TOKEN }}
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
FIXTURE_EOF

# Shape 6: upstream-monitor.yml `create-issues` — the one shape the previous
# version of this guard could already see: a `run:` body that calls a script
# which reaches `opencode run --auto` internally.
fixture_write shape-6-upstream-monitor upstream-monitor.yml <<'FIXTURE_EOF'
# TEST-FIXTURE (synthetic; secret names only, no real secret, not a live workflow)
# Exposure shape 6: upstream-monitor.yml `create-issues`.
name: TEST-FIXTURE upstream-monitor
on:
  schedule:
    - cron: '0 3 * * 1'
permissions: {}
jobs:
  create-issues:
    permissions:
      issues: write
    runs-on: ubuntu-24.04
    steps:
      - name: Publish improvement issues
        run: bash .github/scripts/upstream-monitor.sh publish
        env:
          GH_TOKEN: ${{ secrets.GH_PAT || secrets.GITHUB_TOKEN }}
          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
FIXTURE_EOF

# The built-in token. These are the fixtures the `github.token` pattern exists
# for: on the production corpus it detects nothing, so without them the pattern
# would be untested code guarding nothing.
fixture_write form-builtin-token direct-run.yml <<'FIXTURE_EOF'
# TEST-FIXTURE (synthetic; secret names only, no real secret, not a live workflow)
# A model step holding ONLY the implicit built-in token — no PAT, no
# `secrets.GITHUB_TOKEN`. This is what the credential arm could not see.
name: TEST-FIXTURE builtin-token
on: workflow_dispatch
permissions: {}
jobs:
  builtin:
    runs-on: ubuntu-24.04
    steps:
      - name: Built-in token exposure
        run: opencode run --auto --model opencode/test "do the thing"
        env:
          GH_TOKEN: ${{ github.token }}
          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
FIXTURE_EOF

fixture_write form-builtin-token-json direct-run.yml <<'FIXTURE_EOF'
# TEST-FIXTURE (synthetic; secret names only, no real secret, not a live workflow)
# The same exposure written the way a composite-action step usually receives it:
# the token serialised into an action input via toJSON().
name: TEST-FIXTURE builtin-token-json
on: workflow_dispatch
permissions: {}
jobs:
  builtin-json:
    runs-on: ubuntu-24.04
    steps:
      - name: Built-in token toJSON exposure
        uses: ./
        with:
          mode: review
          github_token: ${{ toJSON(github.token) }}
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
FIXTURE_EOF

# Negative: `github_token` with an UNDERSCORE is an action-input key, not the
# `github.token` context, and a literal placeholder is not a credential. This
# fails if the pattern ever loses its escaped dot or its case sensitivity.
fixture_write negative-input-key-name direct-run.yml <<'FIXTURE_EOF'
# TEST-FIXTURE (synthetic; no real secret, not a live workflow)
# Negative case: a step that NAMES the `github_token` input and passes a
# literal placeholder, plus an LLM key. Not a credential, so not a violation.
name: TEST-FIXTURE negative-input-key-name
on: workflow_dispatch
permissions: {}
jobs:
  placeholder:
    runs-on: ubuntu-24.04
    steps:
      - name: Placeholder input name only
        uses: ./
        with:
          mode: review
          github_token: 'not-a-credential-placeholder'
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
FIXTURE_EOF

# The remaining model-invocation forms the guard has to recognise.
fixture_write form-opencode-run direct-run.yml <<'FIXTURE_EOF'
# TEST-FIXTURE (synthetic; secret names only, no real secret, not a live workflow)
# Model-invocation form: a `run:` body calling `opencode run` directly.
name: TEST-FIXTURE direct-run
on: workflow_dispatch
permissions: {}
jobs:
  direct:
    runs-on: ubuntu-24.04
    steps:
      - name: Direct opencode run
        run: opencode run --auto --model opencode/test "do the thing"
        env:
          GH_TOKEN: ${{ secrets.GH_PAT }}
          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
FIXTURE_EOF

fixture_write form-sec001-wrapper direct-run.yml <<'FIXTURE_EOF'
# TEST-FIXTURE (synthetic; secret names only, no real secret, not a live workflow)
# Model-invocation form: a `run:` body calling run-sec001-opencode.sh, which
# execve()s `opencode run --auto`.
name: TEST-FIXTURE sec001-wrapper
on: workflow_dispatch
permissions: {}
jobs:
  wrapper:
    runs-on: ubuntu-24.04
    steps:
      - name: Wrapper invocation
        run: bash .github/scripts/run-sec001-opencode.sh prompt.txt opencode/test
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
FIXTURE_EOF

fixture_write form-hourly-agent direct-run.yml <<'FIXTURE_EOF'
# TEST-FIXTURE (synthetic; secret names only, no real secret, not a live workflow)
# Model-invocation form: a `run:` body calling sec001-hourly-agent.sh, which
# drives the wrapper above. The trusted copy lives outside .github/scripts, so
# the guard has to match the basename.
name: TEST-FIXTURE hourly-agent
on: workflow_dispatch
permissions: {}
jobs:
  agent:
    runs-on: ubuntu-24.04
    steps:
      - name: Agent invocation
        run: bash "/opt/sec001-trusted-42/sec001-hourly-agent.sh" --tasks t.json
        env:
          GH_TOKEN: ${{ secrets.GH_PAT }}
          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
FIXTURE_EOF

# Negative: both secret classes, but no model invocation. A step that hands a
# PAT to a checkout is not a model exposure, and flagging it would bury the six
# real ones in noise.
fixture_write negative-no-model direct-run.yml <<'FIXTURE_EOF'
# TEST-FIXTURE (synthetic; secret names only, no real secret, not a live workflow)
# Negative case: an LLM key and a PAT in one step that never invokes a model.
name: TEST-FIXTURE negative-no-model
on: workflow_dispatch
permissions: {}
jobs:
  checkout:
    runs-on: ubuntu-24.04
    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          token: ${{ secrets.GH_PAT }}
          fetch-depth: 0
        env:
          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
FIXTURE_EOF

# Negative: a model invocation with a PAT but no LLM key — correctly isolated.
fixture_write negative-no-llm-key direct-run.yml <<'FIXTURE_EOF'
# TEST-FIXTURE (synthetic; secret names only, no real secret, not a live workflow)
# Negative case: a model invocation holding a PAT but no LLM provider key.
name: TEST-FIXTURE negative-no-llm-key
on: workflow_dispatch
permissions: {}
jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - name: Publish
        run: opencode run --auto --model opencode/test "publish"
        env:
          GH_TOKEN: ${{ secrets.GH_PAT }}
FIXTURE_EOF

# Shape 7: the `.yaml` extension. GitHub Actions auto-discovers `.yaml`
# exactly as it does `.yml`, so a workflow written that way RUNS on every push.
# The scan globbed `*.yml` only, so such an exposure was invisible while being
# completely live. Every workflow in this repository is `.yml` today, which is
# exactly why nobody could notice: there is no way to notice a guard that has
# never seen the file.
fixture_write form-yaml-extension hidden.yaml <<'FIXTURE_EOF'
# TEST-FIXTURE (synthetic; secret names only, no real secret, not a live workflow)
# Exposure shape 7: an ordinary exposure in a `.yaml` workflow. Identical to
# shape 1 apart from the extension, which is the entire point — the extension is
# the only thing that used to hide it.
name: TEST-FIXTURE yaml-extension
on: workflow_dispatch
permissions: {}
jobs:
  yaml-hidden:
    runs-on: ubuntu-24.04
    steps:
      - name: Hidden by its extension
        uses: ./
        with:
          mode: review
          github_token: ${{ secrets.GH_PAT }}
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
FIXTURE_EOF

# Shape 8: the key-name collision. The four channels used to be merged into one
# dict with `merged.update(source)`, so a repeated key made the last source win
# and the earlier value disappeared from the scanned text entirely. Here the
# workflow `env:` supplies the PAT under the key `token` and the step's `with:`
# redefines `token` with a harmless placeholder — and the step was reported
# CLEAN, because the PAT had been overwritten before anything looked at it.
#
# Not a contrived pairing either. `env:` and `with:` are DIFFERENT namespaces: a
# step-level `with:` input does not override a workflow-level `env:` variable, so
# the process really does receive that PAT in its environment while the action
# input holds the placeholder. The merge was always the category error; the
# collision is just how it showed up.
fixture_write form-key-collision collide.yml <<'FIXTURE_EOF'
# TEST-FIXTURE (synthetic; secret names only, no real secret, not a live workflow)
# Exposure shape 8: a PAT in workflow `env:` masked by a same-named key in the
# step's `with:`. The key `token` appears in both; only one value used to be
# scanned.
name: TEST-FIXTURE key-collision
on: workflow_dispatch
permissions: {}
env:
  token: ${{ secrets.GH_PAT }}
  openai_api_key: ${{ secrets.OPENAI_API_KEY }}
jobs:
  collide:
    runs-on: ubuntu-24.04
    steps:
      - name: Masked by a colliding key
        uses: ./
        with:
          mode: review
          token: benign-placeholder-value
FIXTURE_EOF

# The crashing corpus: malformed YAML, so the scan cannot finish. It must make
# the guard REFUSE, by name, rather than report a repository it never finished
# reading. Not in FIXTURE_SLUGS, because a refusing scan contributes no
# references to that total.
fixture_write crash-malformed broken.yml <<'FIXTURE_EOF'
# TEST-FIXTURE (synthetic; deliberately malformed; not a live workflow)
# This file is INVALID YAML. A scan that cannot parse it has not checked it,
# and must say so rather than reporting the repository clean.
name: TEST-FIXTURE malformed
on: workflow_dispatch
jobs:
  unparseable:
    runs-on: ubuntu-24.04
    steps:
      - name: [unterminated
        uses: ./
        with:
          github_token: ${{ secrets.GH_PAT }}
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
FIXTURE_EOF

# A corpus with ZERO workflow files, and one with no workflows directory at all.
# A scan of nothing has proven nothing, so "I found no violations" and "I looked
# at nothing" must not be the same statement. This is the false negative #966
# left open: with KNOWN_VIOLATIONS empty, a zero-file glob exited 0 and the
# non-vacuity check read it as the goal state.
mkdir -p "$FIXTURES/crash-empty/.github/workflows"
# ...and one with no workflows directory at all, which is the shape a bad
# clone or a renamed directory actually has.

# The second crash corpus: a repository root with no .github/workflows at all.
mkdir -p "$FIXTURES/crash-nodir"

# Fixture-scoped entry point: scan one fixture corpus and nothing else, with an
# empty grandfather list. Kept inside this script on purpose — the fixtures have
# to drive the shipped logic, not a copy of it.
if [ "${1:-}" = "--fixture-only" ]; then
  audit "$FIXTURES/$2" ""
  [ "$fail" -eq 0 ]
  exit
fi

# Same, but with the REAL production grandfather list, so a caller can assert
# that a refusal holds in the world the monitor actually runs in.
if [ "${1:-}" = "--fixture-only-with-known" ]; then
  audit "$FIXTURES/$2" "$KNOWN_VIOLATIONS"
  [ "$fail" -eq 0 ]
  exit
fi

echo "AI job credential isolation"
echo
echo "  scanning .github/workflows for steps holding both an LLM key and a GitHub credential"
echo

audit "$REPO_ROOT" "$KNOWN_VIOLATIONS" || true

# assert_flags <name> <fixture-slug> <expected-label>
# The shape must surface as an UNDECLARED violation and fail the run: this is
# the same condition as removing the production entry from KNOWN_VIOLATIONS.
assert_flags() {
  local name="$1" slug="$2" expected="$3" out rc
  out="$(bash "$0" --fixture-only "$slug" 2>&1)" && rc=0 || rc=$?
  if [ "$rc" -eq 0 ]; then
    no "$name — guard passed, expected it to fail on '$expected'"
  elif grep -qF "UNDECLARED violation: $expected" <<< "$out"; then
    ok "$name"
  else
    no "$name — guard failed, but not on '$expected': $(tr '\n' ';' <<< "$out")"
  fi
}

# assert_clean <name> <fixture-slug>
assert_clean() {
  local name="$1" slug="$2" out rc
  out="$(bash "$0" --fixture-only "$slug" 2>&1)" && rc=0 || rc=$?
  if [ "$rc" -eq 0 ]; then
    ok "$name"
  else
    no "$name — guard flagged a non-violation: $(tr '\n' ';' <<< "$out")"
  fi
}

echo
echo "  fixture corpus (synthetic, no real secrets): one per exposure shape"

assert_flags 'shape 1 flags  ai-review.yml fix-issue (uses ./ + with:)' \
  shape-1-uses-with 'ai-review.yml:fix-issue:Fix issue'
assert_flags 'shape 2 flags  ai-review.yml review (uses ./ + with:)' \
  shape-2-review 'ai-review.yml:review:Review pull request'
assert_flags 'shape 3 flags  ai-review.yml fast-review (permissions: {} + with: PAT)' \
  shape-3-fast-review 'ai-review.yml:fast-review:Fast review'
assert_flags 'shape 4 flags  ai-review.yml autofix (uses ./ + with:)' \
  shape-4-autofix 'ai-review.yml:autofix:Autofix review loop'
assert_flags 'shape 5 flags  scheduled-audit.yml audit (uses ./ + with:)' \
  shape-5-scheduled-audit 'scheduled-audit.yml:audit:./'
assert_flags 'shape 6 flags  upstream-monitor.yml create-issues (run: + env:)' \
  shape-6-upstream-monitor 'upstream-monitor.yml:create-issues:Publish improvement issues'
assert_flags 'model form flags  run: body calling opencode run' \
  form-opencode-run 'direct-run.yml:direct:Direct opencode run'
assert_flags 'model form flags  run: body calling run-sec001-opencode.sh' \
  form-sec001-wrapper 'direct-run.yml:wrapper:Wrapper invocation'
assert_flags 'model form flags  run: body calling sec001-hourly-agent.sh' \
  form-hourly-agent 'direct-run.yml:agent:Agent invocation'
assert_flags 'built-in token flags  ${{ github.token }} + LLM key, no PAT' \
  form-builtin-token 'direct-run.yml:builtin:Built-in token exposure'
assert_flags 'built-in token flags  ${{ toJSON(github.token) }} + LLM key, no PAT' \
  form-builtin-token-json 'direct-run.yml:builtin-json:Built-in token toJSON exposure'
assert_clean  'negative  both secret classes but no model invocation stays clean' \
  negative-no-model
assert_clean  'negative  model invocation with a PAT but no LLM key stays clean' \
  negative-no-llm-key
assert_clean  'negative  github_token input NAME with a literal placeholder stays clean' \
  negative-input-key-name
assert_flags 'shape 7 flags  an exposure in a .yaml workflow (extension-agnostic)' \
  form-yaml-extension 'hidden.yaml:yaml-hidden:Hidden by its extension'
assert_flags 'shape 8 flags  workflow env: PAT masked by a colliding with: key' \
  form-key-collision 'collide.yml:collide:Masked by a colliding key'

echo
echo "  a scan that did not RUN is not a scan that found nothing"


# Both of these run with an EMPTY grandfather list, and that is the point.
# While KNOWN_VIOLATIONS is non-empty a blind scan trips the "0 references but
# declarations outstanding" check by accident, so the guard appeared to catch
# its own crash. The moment the team fixes all six violations and empties the
# list, that accidental cover disappears. Asserting the empty case is what
# stops the safety from depending on the debt list.
assert_refuses 'crash refuses  unparseable YAML, empty grandfather list' \
  crash-malformed 'broken\.yml'
assert_refuses 'crash refuses  a corpus of zero workflow files' \
  crash-empty 'no workflow files found'
assert_refuses 'crash refuses  a repository with no .github/workflows at all' \
  crash-nodir 'no workflow files found'

# ...and the same corpora through the PRODUCTION grandfather list, so a crash is
# refused in both worlds rather than only the empty one. This used to call
# --fixture-only, which hardcodes an EMPTY list, so the comment above it claimed
# a coverage it never had. --fixture-only-with-known exists so the claim is
# real: a crash must be refused whether or not the team still owes six
# declarations, and those are exactly the two worlds that differ.
for slug in crash-malformed crash-empty crash-nodir; do
  out="$(bash "$0" --fixture-only-with-known "$slug" 2>&1)" && rc=0 || rc=$?
  if [ "$rc" -ne 0 ] && grep -q 'SCAN FAILED' <<< "$out" \
     && ! grep -q 'no step combines an LLM key' <<< "$out"; then
    ok "crash refuses  $slug with a non-empty grandfather list too (exit $rc)"
  else
    no "crash not refused for $slug (rc=$rc): $(tr '\n' ';' <<< "$out")"
  fi
done

# Fixture non-vacuity: the fixtures above must yield exactly the THIRTEEN
# expected references — 6 exposure shapes, 3 model-invocation forms, 2
# built-in-token forms, and the 2 added with the .yaml and key-collision fixes
# — and nothing from the 3 negative fixtures. Zero would mean the scan is blind
# and every `ok` above is meaningless, so it fails rather than passes.
#
# `crash-malformed`, `crash-empty` and `crash-nodir` are deliberately NOT in
# FIXTURE_SLUGS: a refusing scan contributes no references, and counting it here
# would turn a refusal into a count mismatch instead of a refusal.
# The loop runs in THIS shell, not in a command substitution, so a scan that
# refuses can actually set a status. Inside `$( ... )` a crash would be a
# subshell exit code nobody reads, and a count computed over a partial read is
# the very false negative this guard exists to prevent.
FIXTURE_SLUGS="shape-1-uses-with shape-2-review shape-3-fast-review shape-4-autofix
shape-5-scheduled-audit shape-6-upstream-monitor form-opencode-run
form-sec001-wrapper form-hourly-agent form-builtin-token form-builtin-token-json
form-yaml-extension form-key-collision
negative-no-model negative-no-llm-key negative-input-key-name"
refs_file="$(mktemp)"
fixture_scan_rc=0
for slug in $FIXTURE_SLUGS; do
  violations "$FIXTURES/$slug" >> "$refs_file" || fixture_scan_rc=$?
done
fixture_refs="$(cat "$refs_file")"
rm -f "$refs_file"
if [ "$fixture_scan_rc" -ne 0 ]; then
  no "the fixture scan refused to run (violations exited $fixture_scan_rc) — the count below is meaningless"
else
  fixture_count="$(grep -c . <<< "$fixture_refs")"
  if [ "$fixture_count" -eq 13 ]; then
    ok "fixture corpus yields 13 references (6 exposure shapes + 3 model forms + 2 built-in-token forms + .yaml + key collision)"
  else
    no "fixture corpus yields $fixture_count references, expected 13 — the scan is blind or over-firing"
  fi
fi

# A seventh synthetic exposure, added to a COPY of the real corpus: the guard
# must fail on it. This is the end-to-end proof that grandfathering the six
# known shapes did not also grandfather the class.
SEVENTH="$FIXTURES/seventh"
mkdir -p "$SEVENTH/.github/workflows"
cp "$REPO_ROOT"/.github/workflows/*.yml "$SEVENTH/.github/workflows/"
cat > "$SEVENTH/.github/workflows/synthetic-seventh.yml" <<'FIXTURE_EOF'
# TEST-FIXTURE (synthetic; secret names only, no real secret, not a live workflow)
# A seventh exposure that the grandfather list does not cover.
name: TEST-FIXTURE synthetic
on: workflow_dispatch
permissions: {}
jobs:
  seventh:
    runs-on: ubuntu-24.04
    steps:
      - name: Synthetic write credential via with
        uses: ./
        with:
          mode: review
          github_token: ${{ secrets.GH_PAT }}
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
FIXTURE_EOF
seventh_scan_rc=0
seventh_raw="$(violations "$SEVENTH")" || seventh_scan_rc=$?
seventh_refs="$(grep -c . <<< "$seventh_raw")"
seventh_out="$(audit "$SEVENTH" "$KNOWN_VIOLATIONS" 2>&1)" && seventh_rc=0 || seventh_rc=$?
if [ "$seventh_scan_rc" -ne 0 ]; then
  no "the seventh-exposure scan refused to run (violations exited $seventh_scan_rc) — the rejection below is meaningless"
elif [ "$seventh_rc" -ne 0 ] \
   && grep -qF 'UNDECLARED violation: synthetic-seventh.yml:seventh:Synthetic write credential via with' <<< "$seventh_out" \
   && [ "$seventh_refs" -eq 7 ]; then
  ok "a seventh exposure in the corpus is rejected (7 references, 1 undeclared)"
else
  no "a seventh exposure was not rejected (rc=$seventh_rc refs=$seventh_refs): $(tr '\n' ';' <<< "$seventh_out")"
fi

# ---------------------------------------------------------------------------
# MUTATION. A test that passes against the broken code is worthless, so each
# fix is reverted in place and the suite is required to notice.
#
# The reverts go through one python helper and every mutant is `compile()`-checked
# before it runs. That check is not ceremony: my first fn2 revert deleted the
# `.yaml` glob line, which left `sorted(glob.glob(os.path.join(...))` one closing
# paren short. The mutant was invalid Python, so the suite went red — for
# entirely the wrong reason, and it would have "proved" the .yaml gap is covered
# while actually testing a SyntaxError. An unparseable mutant now reports
# MUTATION BROKEN rather than counting as a caught one.
#
# The observable is also chosen per mutation rather than uniformly "non-zero".
# fn1's observable IS a failure (the crash assertion failing means the mutant
# read clean), so it is inverted. fn2 and fn3 assert on the EXPOSURE being
# reported, because with a mutant their corpora also trip the zero-file refusal
# and an exit code would be asserting on the wrong failure.
# ---------------------------------------------------------------------------
MUTANT_CREDENTIAL_GUARD="${MUTANT_CREDENTIAL_GUARD:-}"
# Counted so the suite can assert the block RAN. A stray export of
# MUTANT_CREDENTIAL_GUARD in a CI step, a workflow-level env, or a developer's
# shell would otherwise skip every mutation check and the suite would still
# print a confident 33/0 — the exact "reports success because it silently did
# nothing" failure this whole guard exists to prevent, one level up.
mut_checks=0
if [ -z "$MUTANT_CREDENTIAL_GUARD" ]; then
  echo
  echo "  MUTATION: each fix must still be caught when reverted"

  make_mutant() { # make_mutant <fn1|fn2|fn3|fn4> <outfile>
    python3 - "$SELF" "$1" "$2" <<'MUTPY'
import sys
src_path, which, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(src_path).read()

REVERTS = {
    # fn1: discard the scan's exit status again, so a crash reads as clean.
    # Anchored on the `local` line ABOVE the call, not on the call itself. The
    # call's text also appears inside this very literal, so anchoring on the
    # call — with any indentation — is ambiguous. The uniqueness check below
    # is what proved that: it fired AMBIGUOUS on both the bare and the
    # two-space-indent anchors, and only the preceding line is unique.
    'fn1': [('local root="$1" known="$2" found ref total=0 before="$fail" scan_rc=0\n  found="$(violations "$root")"; scan_rc=$?',
             'local root="$1" known="$2" found ref total=0 before="$fail" scan_rc=0\n  found="$(violations "$root" || true)"')],
    # fn2: glob .yml only again. Replaces the WHOLE two-line construct — dropping
    # just the second line leaves `sorted(` unclosed.
    'fn2': [("for path in sorted(glob.glob(os.path.join(root, '.github/workflows/*.yml'))\n"
             "                 + glob.glob(os.path.join(root, '.github/workflows/*.yaml'))):",
             "for path in sorted(glob.glob(os.path.join(root, '.github/workflows/*.yml'))):")],
    # fn3: merge the four channels into one dict again, last-one-wins, so a
    # repeated key drops the earlier value from the scanned text.
    'fn3': [("                parts = []\n"
             "                for source in (wf_env, job_env, step.get('env') or {}, step.get('with') or {}):\n"
             "                    if isinstance(source, dict):\n"
             "                        parts.append(yaml.safe_dump(source))\n"
             "                text = '\\n'.join(parts)",
             "                merged = {}\n"
             "                for source in (wf_env, job_env, step.get('env') or {}, step.get('with') or {}):\n"
             "                    if isinstance(source, dict):\n"
             "                        merged.update(source)\n"
             "                text = yaml.safe_dump(merged)")],
    # fn4: accept a scan that looked at zero files, which is the false negative
    # #966 left open.
    'fn4': [("if scanned == 0:\n    die('no workflow files found under %s. A scan of zero files proves nothing, '\n"
             "        'so this is a broken scan rather than a clean repository.'\n"
             "        % os.path.join(root, '.github/workflows'))", "if False:\n    pass")],
}

for old, new in REVERTS[which]:
    n_hits = src.count(old)
    if n_hits == 0:
        sys.stderr.write('MUTATION %s: pattern not found\n' % which)
        sys.exit(3)
    if n_hits > 1:
        # fn1's pattern also occurs inside this very REVERTS literal. A
        # one-shot replace would hit whichever came first, and if the literal
        # won, the "mutant" would be the pristine file and the mutation would
        # silently certify the original code.
        sys.stderr.write('MUTATION %s: pattern is AMBIGUOUS (%d occurrences)\n' % (which, n_hits))
        sys.exit(3)
    src = src.replace(old, new, 1)
open(out_path, 'w').write(src)
MUTPY
  }

  # mutant_python_ok <file> — the embedded scan must still parse. Extracted the
  # same way the fixtures extract code: between the python3 heredoc markers.
  mutant_python_ok() {
    sed -n "/^  python3 - \"\\\$1\" <<'PY'\$/,/^PY\$/p" "$1" | sed '1d;$d' > "$1.py" 2>/dev/null
    python3 -c "import sys;compile(open(sys.argv[1]).read(),'scan','exec')" "$1.py" 2>/dev/null
    local rc=$?
    rm -f "$1.py"
    return $rc
  }

  mutate_and_check() { # mutate_and_check <fn>; sets MUT_FILE on success
    local mf
    mf="$(mktemp)"
    if ! make_mutant "$1" "$mf"; then
      no "MUTATION NOT APPLIED ($1) — the revert pattern did not match, so this proves nothing"
      rm -f "$mf"; return 1
    fi
    if cmp -s "$SELF" "$mf"; then
      no "MUTATION NOT APPLIED ($1) — the revert produced an identical file"
      rm -f "$mf"; return 1
    fi
    if ! mutant_python_ok "$mf"; then
      no "MUTATION BROKEN ($1) — the revert is not valid Python, so a red suite would prove nothing about $1"
      rm -f "$mf"; return 1
    fi
    MUT_FILE="$mf"
    return 0
  }

  MUT_FILE=""

  if mutate_and_check fn1; then
    mut_checks=$((mut_checks + 1))
    mlog="$(mktemp)"
    MUTANT_CREDENTIAL_GUARD=1 bash "$MUT_FILE" --refuse-must-fail crash-malformed > "$mlog" 2>&1
    if [ $? -eq 0 ] && grep -q 'guard exited 0 on a scan that did not run' "$mlog"; then
      ok "MUTATION (fn1): restoring \`|| true\` makes the crash test go RED (the mutant passed a scan that never ran)"
    else
      no "MUTATION SURVIVED (fn1) — the original || true still satisfies the crash test"
      head -3 "$mlog" | sed 's/^/    /'
    fi
    rm -f "$mlog" "$MUT_FILE"
  fi

  if mutate_and_check fn2; then
    mut_checks=$((mut_checks + 1))
    mlog="$(mktemp)"
    MUTANT_CREDENTIAL_GUARD=1 bash "$MUT_FILE" --fixture-only form-yaml-extension > "$mlog" 2>&1
    if ! grep -q 'UNDECLARED violation: hidden.yaml' "$mlog"; then
      ok "MUTATION (fn2): dropping the .yaml glob makes the .yaml exposure INVISIBLE and the test go RED"
    else
      no "MUTATION SURVIVED (fn2) — a .yml-only glob still flags the .yaml fixture"
    fi
    rm -f "$mlog" "$MUT_FILE"
  fi

  if mutate_and_check fn3; then
    mut_checks=$((mut_checks + 1))
    mlog="$(mktemp)"
    MUTANT_CREDENTIAL_GUARD=1 bash "$MUT_FILE" --fixture-only form-key-collision > "$mlog" 2>&1
    if ! grep -q 'UNDECLARED violation: collide.yml' "$mlog"; then
      ok "MUTATION (fn3): restoring merged.update() makes the masked PAT INVISIBLE and the test go RED"
    else
      no "MUTATION SURVIVED (fn3) — merged.update() still flags the collision fixture"
    fi
    rm -f "$mlog" "$MUT_FILE"
  fi

  if mutate_and_check fn4; then
    mut_checks=$((mut_checks + 1))
    mlog="$(mktemp)"
    MUTANT_CREDENTIAL_GUARD=1 bash "$MUT_FILE" --fixture-only crash-empty > "$mlog" 2>&1
    # Assert the SPECIFIC substitution, not merely that something changed. The
    # mutant is "caught" when the refusal is gone AND the false clean-pass line
    # is what replaced it. Requiring both means an unrelated crash — a
    # traceback, any other error — cannot be mistaken for this mutation, and
    # neither can a silent no-op.
    if ! grep -q 'no workflow files found' "$mlog" \
       && grep -q 'no step combines an LLM key with a GitHub credential' "$mlog"; then
      ok "MUTATION (fn4): removing the zero-file refusal lets a scan of nothing read as clean and the test go RED"
    else
      no "MUTATION SURVIVED (fn4) — a zero-file corpus is still refused"
    fi
    rm -f "$mlog" "$MUT_FILE"
  fi

  # The block above is the only thing that proves these four fixes are still
  # fixed. If it silently did not run, every other `ok` here is still true and
  # the suite would report success for a guard whose fixes have all been
  # reverted. So its execution is itself asserted.
  if [ "$mut_checks" -eq 4 ]; then
    ok "all 4 mutation checks ran (the block cannot be skipped silently)"
  else
    no "only $mut_checks of 4 mutation checks ran — the mutation block was skipped, so nothing here is proven"
  fi
fi

# The fixtures exist to exercise the guard, not to join the corpus it guards:
# nothing marked as a fixture may ever sit in .github/workflows.
#
# NOT `grep -rl … | grep -q .`. This ran under the `set -uo pipefail` at line 80,
# and `grep -q` is not a filter: it exits the instant it matches, closing the
# pipe's read end. `grep -rl`'s stdout is block-buffered, so while its whole
# output fits in one 4096-byte write it cannot be SIGPIPEd — but once the leak
# is big enough to spill past that buffer, `grep -rl` flushes mid-stream, and
# `grep -q` has already exited on the first line. The producer then dies on
# SIGPIPE with 141, and `pipefail` makes 141 the PIPELINE's status. The `if`
# goes false and the assertion reports "no fixture leaked".
#
# That is the wrong way round for a security guard: the leak is exactly what
# this exists to catch, and the size of the leak decides whether it is caught.
# Measured in situ with this suite, one real invocation each, 60 runs:
#
#     0 leaked fixtures   -> reported CLEAN  60/60   (correct)
#     1 leaked fixture    -> reported LEAK   60/60   (correct)
#    20 leaked fixtures   -> reported LEAK   60/60   (correct)
#   100 leaked fixtures   -> reported CLEAN  59/60   <- a real leak read as clean
#   400 leaked fixtures   -> reported CLEAN  59/60   <- ditto
#  1200 leaked fixtures   -> reported CLEAN  60/60   <- NEVER caught
#
# So "36 passed / 0 failed" was not partly luck, but "no fixture leaked" was:
# it was clean whenever the leak was large enough to trigger the race.
#
# The fix makes the verdict a function of the corpus rather than of the
# scheduler. A command substitution has no early-exit reader: the producer runs
# to completion and `$( )` collects all of it, so nothing can close its output
# early and there is no pipeline for `pipefail` to poison. `[ -n … ]` is true
# iff `grep -rl` printed at least one file, exactly as `grep -q .` decided —
# `grep -rl` only ever prints non-empty pathnames. The two arms and their
# wording are untouched.
if [ -n "$(grep -rl 'TEST-FIXTURE' "$REPO_ROOT/.github/workflows" 2>/dev/null)" ]; then
  no "a fixture leaked into .github/workflows"
else
  ok "no fixture leaked into .github/workflows"
fi

echo
printf 'passed: %d  failed: %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
