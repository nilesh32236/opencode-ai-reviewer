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

for path in sorted(glob.glob(os.path.join(root, '.github/workflows/*.yml'))
                 + glob.glob(os.path.join(root, '.github/workflows/*.yaml'))):
    name = os.path.basename(path)
    doc = yaml.safe_load(open(path)) or {}
    wf_env = doc.get('env') or {}
    for jname, job in (doc.get('jobs') or {}).items():
        job = job or {}
        job_env = job.get('env') or {}
        for step in (job.get('steps') or []):
            step = step or {}
            if not invokes_model(step):
                continue
            # A secret reaches the step through any of the four channels; merge
            # them so one serialised blob carries the whole step environment.
            # Each source is serialised SEPARATELY and concatenated. Merging them
            # into one dict first (merged.update) drops the earlier value whenever a
            # key repeats, so a benign `with:` entry silently erases a secret sitting
            # in workflow- or job-level env. Concatenating keeps every occurrence.
            # The comparison below is presence-only (llm and gh), so a value that
            # legitimately appears in two channels is not counted twice.
            parts = []
            for source in (wf_env, job_env, step.get('env') or {}, step.get('with') or {}):
                if isinstance(source, dict):
                    parts.append(yaml.safe_dump(source))
            text = '\n'.join(parts)
            llm = LLM.search(text)
            gh  = (GH.search(text) or GH_ENV.search(text))
            if llm and gh:
                label = f"{name}:{jname}:{step.get('name') or step.get('uses') or '?'}"
                print(label)
PY
}

# audit <root> <known-violations> — the guard itself, so the fixtures below
# exercise the real comparison logic and not just the detector. Returns 0 only
# when every reference is declared and every declaration is still live.
audit() {
  local root="$1" known="$2" found ref total=0 before="$fail"
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

# Fixture-scoped entry point: scan one fixture corpus and nothing else, with an
# empty grandfather list. Kept inside this script on purpose — the fixtures have
# to drive the shipped logic, not a copy of it.
if [ "${1:-}" = "--fixture-only" ]; then
  audit "$FIXTURES/$2" ""
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

# Fixture non-vacuity: the fixtures above must yield exactly the eleven expected
# references — 6 exposure shapes, 3 model-invocation forms and 2 built-in-token
# forms, and nothing from the 3 negative fixtures. Zero would mean the scan is
# blind and every `ok` above is meaningless, so it fails rather than passes.
fixture_refs="$(
  violations "$FIXTURES/shape-1-uses-with"
  violations "$FIXTURES/shape-2-review"
  violations "$FIXTURES/shape-3-fast-review"
  violations "$FIXTURES/shape-4-autofix"
  violations "$FIXTURES/shape-5-scheduled-audit"
  violations "$FIXTURES/shape-6-upstream-monitor"
  violations "$FIXTURES/form-opencode-run"
  violations "$FIXTURES/form-sec001-wrapper"
  violations "$FIXTURES/form-hourly-agent"
  violations "$FIXTURES/form-builtin-token"
  violations "$FIXTURES/form-builtin-token-json"
  violations "$FIXTURES/negative-no-model"
  violations "$FIXTURES/negative-no-llm-key"
  violations "$FIXTURES/negative-input-key-name"
)"
fixture_count="$(grep -c . <<< "$fixture_refs")"
if [ "$fixture_count" -eq 11 ]; then
  ok "fixture corpus yields 11 references (6 exposure shapes + 3 model forms + 2 built-in-token forms)"
else
  no "fixture corpus yields $fixture_count references, expected 11 — the scan is blind or over-firing"
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
seventh_refs="$(violations "$SEVENTH" | grep -c .)"
seventh_out="$(audit "$SEVENTH" "$KNOWN_VIOLATIONS" 2>&1)" && seventh_rc=0 || seventh_rc=$?
if [ "$seventh_rc" -ne 0 ] \
   && grep -qF 'UNDECLARED violation: synthetic-seventh.yml:seventh:Synthetic write credential via with' <<< "$seventh_out" \
   && [ "$seventh_refs" -eq 7 ]; then
  ok "a seventh exposure in the corpus is rejected (7 references, 1 undeclared)"
else
  no "a seventh exposure was not rejected (rc=$seventh_rc refs=$seventh_refs): $(tr '\n' ';' <<< "$seventh_out")"
fi

# The fixtures exist to exercise the guard, not to join the corpus it guards:
# nothing marked as a fixture may ever sit in .github/workflows.
if grep -rl 'TEST-FIXTURE' "$REPO_ROOT/.github/workflows" 2>/dev/null | grep -q .; then
  no "a fixture leaked into .github/workflows"
else
  ok "no fixture leaked into .github/workflows"
fi

echo
printf 'passed: %d  failed: %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
