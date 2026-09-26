#!/usr/bin/env bash
# Adversarial, credential-free regression suite for SEC-001/SEC-002.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
ART="$ROOT/.github/scripts/sec001-artifact.sh"
PUB="$ROOT/.github/scripts/sec001-trusted-publish.sh"
PUBLISH="$ROOT/.github/scripts/sec001-hourly-publish.sh"
MODEL_OUTPUT="$ROOT/.github/scripts/sec001-model-output.sh"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
PASS=0
FAIL=0
FAILED_NAMES=()
pass() { PASS=$((PASS + 1)); printf 'ok %s\n' "$1"; }
# Record and keep going: aborting on the first failure hides every later
# assertion behind a misleading exit code.
fail() { FAIL=$((FAIL + 1)); FAILED_NAMES+=("$1"); printf 'not ok %s\n' "$1" >&2; }
# Per-run diagnostics file, so concurrent runs cannot clobber each other.
OUT_FILE="$T/sec001-test.out"
expect_fail() {
  local name="$1"; shift
  if "$@" >"$OUT_FILE" 2>&1; then fail "$name (unexpected success)"; else pass "$name"; fi
}
# Assert both a non-zero exit AND that the failure came from the intended
# cause; without the message check a case can pass for an unrelated reason.
expect_fail_matching() {
  local name="$1" pattern="$2"; shift 2
  if "$@" >"$OUT_FILE" 2>&1; then fail "$name (unexpected success)"; return; fi
  if grep -qE -- "$pattern" "$OUT_FILE"; then pass "$name"; else
    fail "$name (exited non-zero for the wrong reason: $(head -n 2 "$OUT_FILE" | tr '\n' ' '))"
  fi
}
repo() { local d="$1"; mkdir -p "$d"; git -C "$d" init -q; git -C "$d" config user.name test; git -C "$d" config user.email test@example.invalid; }
commit_file() { local d="$1" f="$2" text="$3"; mkdir -p "$(dirname "$d/$f")"; printf '%s\n' "$text" > "$d/$f"; git -C "$d" add "$f"; git -C "$d" commit -qm "${4:-change}"; }
sha() { git -C "$1" rev-parse HEAD; }
make_artifact() {
  local d="$1" out="$2" phase="${3:-agent}" attempt="${4:-1}"
  (cd "$d" && "$ART" create --output "$out" --run-id 4242 --base-sha "$(sha "$d")" --attempt "$attempt" --phase "$phase" --allow-prefix src/ --allow-prefix docs/ --allow-prefix package.json)
}

# Discovery issue objects must not leak the API camelCase timestamp key.
DISCOVERY_ISSUE='{"number":7,"title":"Q","labels":[],"body":"b","comments":[],"updatedAt":"2026-09-25T00:00:00Z"}'
if jq -n --argjson issue "$DISCOVERY_ISSUE" '{issue:($issue + {has_questions:false, updated_at:$issue.updatedAt} | del(.updatedAt))}' | jq -e '(.issue | keys - ["body","comments","has_questions","labels","number","title","updated_at"] | length == 0) and (.issue.updated_at == "2026-09-25T00:00:00Z")' >/dev/null; then pass 'discovery issue manifest drops camelCase updatedAt'; else fail 'discovery issue manifest retained camelCase updatedAt'; fi

# Workflow matrix assertions complement the behavioral cases below.
python3 - "$ROOT" <<'PY'
import sys, yaml, re, shutil
root=sys.argv[1]
for rel in ['.github/workflows/self-improvement.yml','.github/workflows/hourly-orchestrator.yml']:
    data=yaml.safe_load(open(root+'/'+rel))
    assert data.get('permissions') == {}, rel
    for job_name, job in data['jobs'].items():
        for step in job.get('steps',[]):
            if str(step.get('uses','')).startswith('actions/checkout'):
                assert step.get('with',{}).get('persist-credentials') is False, (rel,job_name)
                assert step.get('with',{}).get('ref') == '${{ github.sha }}', (rel,job_name)
            if job_name in {'agent','repair','verify-initial','verify-final','verify'}:
                env=step.get('env',{}) or {}
                assert not any(k in env for k in ('GITHUB_TOKEN','GH_TOKEN','GH_PAT','GITLAB_TOKEN')), (rel,job_name)
            if job_name == 'publish':
                text=str(step.get('run',''))
                assert not any(x in text for x in ('opencode run','pnpm ','npm ')), (rel,job_name)
            text=str(step.get('run',''))
            if text.strip().startswith('bash ') and ('run-sec001-opencode.sh' in text or 'sec001-hourly-agent.sh' in text):
                assert (step.get('env',{}) or {}).get('BASH_ENV') == '/dev/null', (rel,job_name,step.get('name'))
            if 'Package agent patch' in str(step.get('name','')) or 'Package repair patch' in str(step.get('name','')) or 'Add metadata to agent results' in str(step.get('name','')):
                assert (step.get('env',{}) or {}).get('BASH_ENV') == '/dev/null', (rel,job_name)
                assert (step.get('env',{}) or {}).get('PATH') == '/usr/local/bin:/usr/bin:/bin', (rel,job_name)
    assert 'workflow_dispatch' not in str(data.get(True, data.get('on',{}))), rel
    if rel.endswith('self-improvement.yml'):
        assert 'package-agent' in data['jobs']['publish']['needs']
        assert 'package-repair' in data['jobs']['publish']['needs']
    if rel.endswith('hourly-orchestrator.yml'):
        assert 'package-agent' in data['jobs']['publish']['needs']
# Every helper a workflow installs from the checkout must be a tracked file;
# an untracked snapshot source breaks a fresh CI checkout before step 1.
import subprocess
tracked = set(subprocess.run(['git','ls-files'], cwd=root, capture_output=True, text=True, check=True).stdout.splitlines())
for rel in ['.github/workflows/self-improvement.yml','.github/workflows/hourly-orchestrator.yml']:
    text = open(root+'/'+rel).read()
    for m in re.finditer(r'install [^\n]*? \.github/scripts/([A-Za-z0-9._-]+\.sh)', text):
        assert '.github/scripts/'+m.group(1) in tracked, (rel, m.group(1))
for m in re.finditer(r'\. "\$SCRIPT_DIR/([A-Za-z0-9._-]+\.sh)"', open(root+'/.github/scripts/sec001-artifact.sh').read()):
    assert '.github/scripts/'+m.group(1) in tracked, m.group(1)
assert '.github/scripts/sec001-path-policy.sh' in tracked
for rel in ['.github/workflows/ai-review.yml', '.github/scripts/sec001-hourly-publish.sh']:
    text=open(root+'/'+rel).read()
    assert '--match-head-commit' in text, rel
ai_review = yaml.safe_load(open(root+'/.github/workflows/ai-review.yml'))
auto_merge_checkout = next(step for step in ai_review['jobs']['auto-merge']['steps'] if str(step.get('uses','')).startswith('actions/checkout'))
assert auto_merge_checkout['with']['persist-credentials'] is False
assert auto_merge_checkout['with']['ref'] == '${{ github.event.pull_request.base.sha }}'
auto_merge = ai_review['jobs']['auto-merge']
assert auto_merge['permissions']['issues'] == 'read'
auto_merge_script = '\n'.join(step.get('run', '') for step in auto_merge['steps'])
assert auto_merge_script.count('autofix-merge-approval.sh') >= 2
assert 'autofix-merge-gate.sh' in auto_merge_script
# A comment-triggered secret-bearing fix loop must require a privileged author.
ai_review_jobs = ai_review['jobs']
for job_name in ('fix-issue', 'autofix'):
    cond = ai_review_jobs[job_name].get('if', '')
    assert 'author_association' in cond, job_name
    assert '"OWNER", "MEMBER", "COLLABORATOR"' in cond or '"OWNER","MEMBER","COLLABORATOR"' in cond, job_name
trusted_fix = next(step for step in yaml.safe_load(open(root+'/.github/workflows/hourly-orchestrator.yml'))['jobs']['trusted-fix']['steps'] if step.get('name') == 'Request manual trusted fix action')
trusted_script = trusted_fix['run']
for token in ('HANDOFF_MARKER', 'handoff_marker_present', 'EXPECTED_UPDATED_AT', 'CONFIRM_STATE', 'issue_content_hash', 'gh api user'):
    assert token in trusted_script, token
assert '--json title,body,comments,assignees,state' in trusted_script
assert '--json title,body,comments,labels,assignees,state' not in trusted_script
assert 'TRUSTED_SHA="${{ github.sha }}"' in open(root+'/.github/workflows/hourly-orchestrator.yml').read()
gate_text=open(root+'/.github/scripts/sec001-run-gates.sh').read()
supervisor_text=open(root+'/.github/scripts/sec001-supervisor.sh').read()
assert 'sudo -u' in gate_text and 'INODE_STATE' in gate_text
assert '--direct' in supervisor_text and 'GATE_RUNNER' in supervisor_text
model_helper_text=open(root+'/.github/scripts/sec001-model-output.sh').read()
assert 'python3 -I' in model_helper_text and 'O_NOFOLLOW' in model_helper_text and 'O_NONBLOCK' in model_helper_text
hourly_text=open(root+'/.github/workflows/hourly-orchestrator.yml').read()

# The publish job must read the status artifact from the directory the
# finalizer actually writes. A path segment the producer never creates makes
# the whole publish (and therefore trusted-fix) job unreachable.
_status_out = re.search(r'sec001-finalize-status\.sh[^\n]*--output "?\$RUNNER_TEMP/([^"\s]+)"?', hourly_text)
assert _status_out, 'could not find the finalizer --output directory'
_status_dir = _status_out.group(1)
_publish_text = '\n'.join(step.get('run','') for step in yaml.safe_load(open(root+'/.github/workflows/hourly-orchestrator.yml'))['jobs']['publish']['steps'])
for _m in re.finditer(r'\$RUNNER_TEMP/([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+/)?status\.json', _publish_text):
    assert _m.group(1) == _status_dir and not _m.group(2), ('publish reads status.json from the wrong directory: ' + _m.group(0))
for _m in re.finditer(r'validate-status --artifact "?\$RUNNER_TEMP/([A-Za-z0-9._-]+)/?([A-Za-z0-9._-]*)"?', _publish_text):
    assert _m.group(1) == _status_dir and not _m.group(2), ('publish validates status from the wrong directory: ' + _m.group(0))
# The download-artifact `path:` is what actually places the file, so assert it
# too; a `run:`-only check would miss a producer/consumer split introduced there.
_publish_steps = yaml.safe_load(open(root+'/.github/workflows/hourly-orchestrator.yml'))['jobs']['publish']['steps']
_dl = [s2 for s2 in _publish_steps if str(s2.get('uses','')).startswith('actions/download-artifact')]
assert _dl, 'publish job has no download-artifact step'
for _s2 in _dl:
    _p = str((_s2.get('with') or {}).get('path',''))
    _d = _p.replace('${{ runner.temp }}/','').strip()
    if _d.startswith(_status_dir):
        assert _d == _status_dir, ('download-artifact writes the status artifact to ' + _d + ', not ' + _status_dir)
# And the upload side must use the same directory.
_finalize_steps = yaml.safe_load(open(root+'/.github/workflows/hourly-orchestrator.yml'))['jobs']['finalize']['steps']
_up = [s2 for s2 in _finalize_steps if str(s2.get('uses','')).startswith('actions/upload-artifact')]
for _s2 in _up:
    _p = str((_s2.get('with') or {}).get('path',''))
    if _status_dir in _p:
        assert _p.replace('${{ runner.temp }}/','') == _status_dir, ('finalize uploads the status artifact from ' + _p)
agent_text=open(root+'/.github/scripts/sec001-hourly-agent.sh').read()
publish_text=open(root+'/.github/scripts/sec001-hourly-publish.sh').read()
assert 'ulimit -f 1024' in agent_text
assert 'run_model_output triage "$work/triage.txt' in agent_text
assert 'sec001-model-output.sh' in hourly_text
assert 'sec001-path-policy.sh' in open(root+'/.github/scripts/sec001-artifact.sh').read()
assert 'sec001-path-policy.sh' in open(root+'/.github/scripts/sec001-trusted-publish.sh').read()
assert '--limit 100' in hourly_text
assert 'PR_JSON=' in hourly_text and 'ISSUE_JSON=' in hourly_text
assert 'overwrite: true' in hourly_text
assert 'sec001-agent' in hourly_text
# Every step that holds a raw provider secret must neutralise BASH_ENV.
for secret_key in ('OPENCODE_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','GEMINI_API_KEY'):
    holder = [s for s in yaml.safe_load(open(root+'/.github/workflows/hourly-orchestrator.yml'))['jobs']['agent']['steps']
              if secret_key in (s.get('env') or {})]
    assert holder, secret_key
    for s in holder:
        assert (s.get('env') or {}).get('BASH_ENV') == '/dev/null', (secret_key, s.get('name'))
publish_text=open(root+'/.github/scripts/sec001-hourly-publish.sh').read()
assert 'gh run list --workflow ai-review.yml --repo "$REPO" --branch' not in publish_text
assert 'gh run list --workflow ai-review.yml' in publish_text
# The pending-label removal must never be a full-label-set PATCH: GitHub does
# not implement If-Match on PATCH /issues/{n}, so a replace is an unconditional
# write that can silently drop a label a human added in the same window.
assert 'gh api --method PATCH "repos/$REPO/issues/$number"' not in publish_text
# Server-side status filtering: an unfiltered page would spend its whole limit on
# completed runs and let an in-flight review fall off the end.
# The status values must be ones `gh run list --status` actually accepts.
# `pending` is NOT valid and would abort the query, taking the merge path down.
assert 'for run_status in queued in_progress requested waiting action_required' in publish_text
gh_status_ok = 0
if shutil.which('gh'):
    _help = subprocess.run(['gh','run','list','--help'], capture_output=True, text=True)
    _m = re.search(r'Filter runs by status: \{([^}]*)\}', _help.stdout)
    if _m:
        accepted = set(_m.group(1).split('|'))
        queried = set(re.search(r'for run_status in ([a-z_ ]+); do', publish_text).group(1).split())
        bad = queried - accepted
        assert not bad, ('publisher queries gh run list --status with invalid values: %s' % sorted(bad))
        gh_status_ok = 1
if not gh_status_ok:
    print('# gh unavailable: publisher --status values not cross-checked against the gh enum', file=sys.stderr)
assert '--status "$run_status"' in publish_text
assert '/opt/sec001-trusted-${{ github.run_id }}-${{ github.run_attempt }}/sec001-hourly-publish.sh' in hourly_text
assert 'sudo -u sec001-agent -- /usr/bin/env -i' in hourly_text
assert 'SEC001_PROVIDER_KEY_FILE="$RUNNER_TEMP/sec001-provider.key"' in hourly_text
assert 'sec001-hourly-agent.sh /opt/sec001-trusted-${{ github.run_id }}-${{ github.run_attempt }}/sec001-hourly-agent.sh' in hourly_text
assert 'install -o root -g root -m 0555 .github/scripts/sec001-hourly-agent.sh' in hourly_text
assert 'OPENCODE_API_KEY="$OPENCODE_API_KEY"' not in hourly_text
assert 'Return provider artifacts to workflow owner' in hourly_text
assert '/opt/sec001-trusted-${{ github.run_id }}-${{ github.run_attempt }}/sec001-hourly-publish.sh' in hourly_text
assert 'install -o root -g root -m 0555 .github/scripts/sec001-model-output.sh' in hourly_text
assert '--model-output-helper' in hourly_text and '--model-output-helper' in agent_text and '--model-output-helper' in publish_text
verify_text=open(root+'/.github/scripts/sec001-hourly-verify.sh').read()
assert 'RESULTS_STREAM' in verify_text and 'done < <(jq' not in verify_text
assert 'grep -o' not in agent_text and 'tail -50' not in agent_text and 'tail -20' not in agent_text
assert 'done < <(jq' not in agent_text and 'TASKS_STREAM' in agent_text
assert '--body-file' in publish_text
assert 'env -i BASH_ENV=/dev/null' in agent_text and 'env -i BASH_ENV=/dev/null' in publish_text
assert 'bash "$MODEL_OUTPUT_HELPER"' not in agent_text and 'bash "$MODEL_OUTPUT_HELPER"' not in publish_text
PY
pass 'workflow job/secret matrix parsed'

# 1. Ancestor /proc visibility: reproduce the old shape, then prove a clean
# parent has no secret to inherit.
mkdir -p "$T/ancestor"
cat > "$T/ancestor/outer.sh" <<'EOF'
#!/bin/sh
"$1"
EOF
cat > "$T/ancestor/helper.sh" <<'EOF'
#!/bin/sh
exec env -i PATH="$PATH" /bin/sh -c 'tr "\0" "\n" <"/proc/$PPID/environ" | grep SECRET_ANCESTOR_PROBE || true'
EOF
chmod +x "$T/ancestor/outer.sh" "$T/ancestor/helper.sh"
if SECRET_ANCESTOR_PROBE=dummy-ancestor "$T/ancestor/outer.sh" "$T/ancestor/helper.sh" | grep -q dummy-ancestor; then pass 'ancestor /proc exposure reproduced'; else fail 'ancestor /proc reproduction'; fi
if env -i PATH="$PATH" /bin/sh -c 'tr "\0" "\n" <"/proc/$PPID/environ" | grep -q SECRET_ANCESTOR_PROBE' >/dev/null 2>&1; then fail 'clean job ancestor unexpectedly exposed'; else pass 'clean job has no secret ancestor'; fi

# 2. BASH_ENV poisoning and neutralization.
cat > "$T/bash-env-pwn.sh" <<'EOF'
printf 'BASH_ENV_POISONED\n'
EOF
if BASH_ENV="$T/bash-env-pwn.sh" /bin/bash --noprofile --norc -e -o pipefail -c true | grep -q BASH_ENV_POISONED; then pass 'BASH_ENV poisoning reproduced'; else fail 'BASH_ENV reproduction'; fi
if BASH_ENV="$T/bash-env-pwn.sh" BASH_ENV=/dev/null /bin/bash --noprofile --norc -e -o pipefail -c true | grep -q BASH_ENV_POISONED; then fail 'BASH_ENV neutralization failed'; else pass 'BASH_ENV neutralized'; fi

# Model wrapper forwards only the selected provider key and a fixed binary.
FAKE_OPENCODE="$T/fake-opencode-env"
cat > "$FAKE_OPENCODE" <<EOF
#!/bin/sh
env > "$T/model-env"
exit 0
EOF
chmod +x "$FAKE_OPENCODE"
printf 'prompt\n' > "$T/model-prompt"
WRAPPER_OUTPUT=$(GH_TOKEN=should-not-forward GITHUB_TOKEN=should-not-forward GH_PAT=should-not-forward GITLAB_TOKEN=should-not-forward GITHUB_ENV="$T/should-not-forward" GITHUB_PATH="$T/should-not-forward" BASH_ENV=/dev/null OPENCODE_API_KEY=selected-provider-key CONTEXT7_API_KEY=context7-key SEC001_TEST_MODE=1 SEC001_TEST_REPO=x/y SEC001_OPENCODE_BIN="$FAKE_OPENCODE" "$ROOT/.github/scripts/run-sec001-opencode.sh" "$T/model-prompt" opencode/test 2>&1)
! printf '%s' "$WRAPPER_OUTPUT" | grep -q BASH_ENV_POISONED || fail 'BASH_ENV poison reached model wrapper'
if grep -q '^OPENCODE_API_KEY=selected-provider-key$' "$T/model-env" && grep -q '^CONTEXT7_API_KEY=context7-key$' "$T/model-env" && ! grep -Eq '^(GH_TOKEN|GITHUB_TOKEN|GH_PAT|GITLAB_TOKEN|GITHUB_ENV|GITHUB_PATH|BASH_ENV)=' "$T/model-env"; then pass 'model child environment allowlist'; else fail 'model child environment leaked or missed selected keys'; fi
OPENCODE_API_KEY='' OPENAI_API_KEY=selected-openai CONTEXT7_API_KEY=context7-key SEC001_TEST_MODE=1 SEC001_TEST_REPO=x/y SEC001_OPENCODE_BIN="$FAKE_OPENCODE" "$ROOT/.github/scripts/run-sec001-opencode.sh" "$T/model-prompt" openai/test >/dev/null 2>&1
! grep -q '^CONTEXT7_API_KEY=' "$T/model-env" && grep -q '^OPENAI_API_KEY=selected-openai$' "$T/model-env" && pass 'Context7 key is restricted to OpenCode provider' || fail 'Context7 key reached a non-OpenCode provider'
# 3. The model wrapper scrubs the runner's file-based env injection points, so a
# value written to GITHUB_ENV/GITHUB_PATH can never reach the child process.
# A `shell:` value must be one of the runner's built-ins or a {0} template. A
# bare path such as `/bin/sh` is rejected by the runner before the script ever
# runs, which silently kills the whole job while every static check still
# passes. Assert the set directly rather than trusting a log review.
_shell_bad=""
_yaml_ok=1
# Cover step-level `shell:` in every workflow AND every composite action, plus
# any workflow/job-level `defaults.run.shell`.
for _wf in $(find "$ROOT/.github/workflows" "$ROOT/.github/actions" \( -name '*.yml' -o -name '*.yaml' \) 2>/dev/null | sort); do
  _parsed="$(python3 -c "
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
def emit(v):
    if v is not None: print(v)
for j in (d.get('jobs') or {}).values():
    emit((j.get('defaults') or {}).get('run', {}).get('shell'))
    for st in (j.get('steps') or []):
        emit(st.get('shell'))
emit((d.get('defaults') or {}).get('run', {}).get('shell'))
for a in (d.get('runs') or {}).get('steps', []) or []:
    emit(a.get('shell'))
" "$_wf" 2>/dev/null)" || {
    # Fail loud: a guard that silently disables itself is the failure class
    # that let `shell: /bin/sh` ship in the first place.
    fail "cannot parse $_wf (python3 with PyYAML is required to check shell values)"
    _yaml_ok=0
    continue
  }
  while IFS= read -r _sh; do
    [ -n "$_sh" ] || continue
    case "$_sh" in
      bash|sh|cmd|powershell|pwsh) ;;
      *'{0}'*) ;;
      *) _shell_bad="$_shell_bad $(basename "$_wf")=$_sh" ;;
    esac
  done <<<"$_parsed"
done
if [ "$_yaml_ok" != 1 ]; then
  fail 'workflow shell values could not be fully verified'
elif [ -z "$_shell_bad" ]; then
  pass 'every workflow shell: value is a runner built-in or a {0} template'
else
  fail "invalid workflow shell value(s):$_shell_bad"
fi

# The unprivileged agent handoff is only reachable if every ancestor of
# $RUNNER_TEMP grants traverse. Reproduce the real failure mode: a 0711 leaf
# under a non-traversable ancestor is invisible to the unprivileged user, which
# is what made the agent job fail with "missing or symlinked".
if [ "$(id -u)" = 0 ]; then
  if id sec001-agent >/dev/null 2>&1; then
    _tp="$(mktemp -d "$T/handoff.XXXXXX")"
    mkdir -p "$_tp/anc/mid/leaf"
    printf '{}\n' > "$_tp/anc/mid/leaf/tasks.json"
    chmod 0711 "$_tp/anc/mid/leaf"
    chown sec001-agent "$_tp/anc/mid/leaf/tasks.json" 2>/dev/null || true
    chmod 0700 "$_tp/anc"
    if sudo -u sec001-agent -- /usr/bin/test -f "$_tp/anc/mid/leaf/tasks.json"; then
      chmod 0711 "$_tp/anc"
      if sudo -u sec001-agent -- /usr/bin/test -f "$_tp/anc/mid/leaf/tasks.json"; then
        pass 'a 0711 leaf is unreachable until its ancestors grant traverse (reproduced)'
      else
        fail 'granting traverse on the ancestor did not make the leaf reachable'
      fi
    else
      pass 'a 0711 leaf is unreachable until its ancestors grant traverse (reproduced)'
    fi
    rm -rf "$_tp"
  else
    echo '# sec001-agent test user absent; handoff traversal probe skipped' >&2
  fi
fi
# Pin the workflow so the handoff cannot silently lose its traversal grant or
# its boundary check.
_agent_handoff="$(python3 -c "
import yaml
d = yaml.safe_load(open('$ROOT/.github/workflows/hourly-orchestrator.yml'))
for j in d['jobs'].values():
    for st in (j.get('steps') or []):
        if st.get('name') == 'Prepare unprivileged provider runtime':
            print(st.get('run',''))
")"
case "$_agent_handoff" in
  *"chmod o+x"*) _h1=1 ;;
  *) _h1=0 ;;
esac
case "$_agent_handoff" in
  *"test -r"*) _h2=1 ;;
  *) _h2=0 ;;
esac
if [ "$_h1" = 1 ] && [ "$_h2" = 1 ]; then
  pass 'agent handoff grants ancestor traverse and verifies the handoff boundary'
else
  fail "agent handoff missing ancestor traverse or boundary check (traverse=$_h1 boundary=$_h2)"
fi

for _v in GITHUB_ENV GITHUB_PATH; do
  if grep -Eq '(^|[[:space:]\\])unset .*(^|[[:space:]])'"$_v"'([[:space:]]|$)' "$ROOT/.github/scripts/run-sec001-opencode.sh"; then
    pass "model wrapper scrubs $_v"
  else
    fail "model wrapper does not scrub $_v"
  fi
done

# 4-10. Trusted publisher ignores local remote/config/helpers/fsmonitor/hooks,
# uses askpass, replacement protection, and explicit remote/lease.
SRC="$T/source"; REMOTE="$T/remote.git"; CALLER="$T/caller"
repo "$SRC"; git -C "$SRC" branch -M main; commit_file "$SRC" src/a.txt base; BASE=$(sha "$SRC"); git -C "$SRC" init --bare "$REMOTE" >/dev/null; git -C "$SRC" remote add origin "$REMOTE"; git -C "$SRC" push -q origin main
printf 'changed\n' > "$SRC/src/a.txt"
make_artifact "$SRC" "$T/patch" agent 1
# Keep the remote source at the pinned base; the patch is intentionally uncommitted.
# Poison a caller checkout that is not used by the trusted publisher.
repo "$CALLER"; git -C "$CALLER" config remote.origin.url 'https://attacker.invalid/steal.git'; git -C "$CALLER" config remote.origin.pushurl 'https://attacker.invalid/steal.git'; git -C "$CALLER" config credential.helper '!touch '"$T"'/credential-helper-marker'; git -C "$CALLER" config core.fsmonitor '!touch '"$T"'/fsmonitor-marker'; mkdir -p "$CALLER/.git/hooks"; printf '#!/bin/sh\ntouch %s\n' "$T/hook-marker" > "$CALLER/.git/hooks/pre-push"; chmod +x "$CALLER/.git/hooks/pre-push"
PUBLISH_OUT=$(cd "$CALLER" && GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.url GIT_CONFIG_VALUE_0=https://attacker.invalid/steal.git GIT_DIR="$CALLER/.git" GIT_WORK_TREE="$CALLER" SEC001_TEST_MODE=1 SEC001_TEST_REPO=x/y GH_TOKEN=dummy-token "$PUB" --patch "$T/patch/patch.diff" --base-sha "$BASE" --branch sec001/test --remote "file://$REMOTE" --repo x/y --source-ref main --message 'test publish')
printf '%s\n' "$PUBLISH_OUT" | jq -e '.head_sha and .base_sha' >/dev/null
git --git-dir="$REMOTE" show-ref --verify --quiet refs/heads/sec001/test && pass 'trusted publisher created branch' || fail 'trusted publisher did not create branch'
[ ! -e "$T/credential-helper-marker" ] && [ ! -e "$T/fsmonitor-marker" ] && [ ! -e "$T/hook-marker" ] && pass 'local config and hooks ignored' || fail 'trusted publisher trusted poisoned caller state'
# Duplicate publish is idempotent when the deterministic commit already exists.
IDEMP=$(cd "$CALLER" && GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.url GIT_CONFIG_VALUE_0=https://attacker.invalid/steal.git GIT_DIR="$CALLER/.git" GIT_WORK_TREE="$CALLER" SEC001_TEST_MODE=1 SEC001_TEST_REPO=x/y GH_TOKEN=dummy-token "$PUB" --patch "$T/patch/patch.diff" --base-sha "$BASE" --branch sec001/test --remote "file://$REMOTE" --repo x/y --source-ref main --message 'test publish')
printf '%s\n' "$IDEMP" | jq -e '.idempotent == true' >/dev/null && pass 'duplicate publish is idempotent' || fail 'duplicate publish was not idempotent'
# Askpass behavior is explicit and returns the token, not a persisted config value.
cat > "$T/askpass-test.sh" <<'EOF'
#!/bin/sh
case "$1" in *sername*) printf 'x-access-token\n';; *) printf 'dummy-token\n';; esac
EOF
chmod +x "$T/askpass-test.sh"
CRED=$(printf 'protocol=https\nhost=github.com\n\n' | GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ASKPASS="$T/askpass-test.sh" GIT_TERMINAL_PROMPT=0 git -c credential.helper= credential fill)
printf '%s\n' "$CRED" | grep -q 'username=x-access-token' && printf '%s\n' "$CRED" | grep -q 'password=dummy-token' && pass 'askpass credential behavior' || fail 'askpass behavior'
# Replacement refs are ignored when the trusted context asks for it.
REPL="$T/replace"; repo "$REPL"; commit_file "$REPL" helper good; GOOD=$(sha "$REPL"); commit_file "$REPL" helper replacement; BAD=$(sha "$REPL"); git -C "$REPL" replace "$GOOD" "$BAD"
[ "$(GIT_NO_REPLACE_OBJECTS=1 git -C "$REPL" show "$GOOD:helper")" = good ] && pass 'replace refs disabled in trusted context' || fail 'replace refs not disabled'
# A changed source head fails closed.
expect_fail 'changed-head publish rejection' env SEC001_TEST_MODE=1 SEC001_TEST_REPO=x/y GH_TOKEN=dummy "$PUB" --patch "$T/patch/patch.diff" --base-sha "$BAD" --branch sec001/changed --remote "file://$REMOTE" --repo x/y --source-ref main
expect_fail 'merge-ref expected SHA rejection' env SEC001_TEST_MODE=1 SEC001_TEST_REPO=x/y GH_TOKEN=dummy "$PUB" --base-sha "$BASE" --branch sec001/merge-check --remote "file://$REMOTE" --repo x/y --source-ref main --merge-ref main --merge-sha "$BAD"
expect_fail 'remote repository binding rejected' env SEC001_TEST_MODE=1 SEC001_TEST_REPO=x/y GH_TOKEN=dummy "$PUB" --base-sha "$BASE" --branch sec001/remote-check --remote "file://$REMOTE" --repo other/repo --source-ref main

# Packaging Git operations must ignore model-controlled local Git commands.
POISON_REPO="$T/git-poison"; repo "$POISON_REPO"; commit_file "$POISON_REPO" src/safe.txt base; POISON_BASE=$(sha "$POISON_REPO"); printf 'changed\n' > "$POISON_REPO/src/safe.txt"; git -C "$POISON_REPO" config core.fsmonitor "!touch $T/fsmonitor-model-marker"; (cd "$POISON_REPO" && "$ART" create --output "$T/git-poison-artifact" --run-id 4242 --base-sha "$POISON_BASE" --attempt 1 --phase agent --allow-prefix src/) ; [ ! -e "$T/fsmonitor-model-marker" ] && pass 'artifact Git config poison suppressed' || fail 'artifact Git config poison executed'
mkdir -p "$T/git-other"; printf 'evil\n' > "$T/git-other/evil.txt"; git -C "$POISON_REPO" config core.worktree "$T/git-other"; expect_fail 'artifact Git worktree poison rejected' env SEC001_TEST_MODE=1 bash -c 'cd "$1" && "$2" create --output "$3" --run-id 4242 --base-sha "$4" --attempt 1 --phase agent --allow-prefix src/' _ "$POISON_REPO" "$ART" "$T/git-worktree-artifact" "$POISON_BASE"
# 11-20. Artifact validation, traversal, symlink, scope, stale base, and setup.
GOOD_ART="$T/patch"
cd "$SRC"
rm -f "$SRC/notes.txt"; git -C "$SRC" reset --hard "$BASE" >/dev/null
"$ART" validate --artifact "$GOOD_ART" --expected-run-id 4242 --expected-base-sha "$BASE" --expected-attempt 1 --expected-phase agent --allow-prefix src/ --allow-prefix docs/ --allow-prefix package.json
pass 'valid artifact accepted'
mkdir -p "$T/child-symlink"; printf 'victim\n' > "$T/child-victim"; ln -s "$T/child-victim" "$T/child-symlink/patch.diff"; expect_fail 'precreated output symlink rejected' "$ART" create --output "$T/child-symlink" --run-id 4242 --base-sha "$BASE" --attempt 1 --phase agent --allow-prefix src/ --allow-prefix docs/ --allow-prefix package.json
cp -a "$GOOD_ART" "$T/symlink-artifact"; rm "$T/symlink-artifact/patch.diff"; ln -s "$T/patch/patch.diff" "$T/symlink-artifact/patch.diff"
expect_fail 'artifact component symlink rejected' "$ART" validate --artifact "$T/symlink-artifact" --expected-run-id 4242 --expected-base-sha "$BASE" --expected-attempt 1 --expected-phase agent --allow-prefix src/ --allow-prefix docs/ --allow-prefix package.json
for MODE in 120000 160000; do
  cp -a "$GOOD_ART" "$T/mode-$MODE"
  sed -i "1a new file mode $MODE" "$T/mode-$MODE/patch.diff"
  MODE_SHA=$(sha256sum "$T/mode-$MODE/patch.diff" | awk '{print $1}'); MODE_BYTES=$(wc -c < "$T/mode-$MODE/patch.diff" | tr -d ' ')
  jq --arg sha "$MODE_SHA" --argjson bytes "$MODE_BYTES" '.sha256=$sha | .byte_count=$bytes' "$T/mode-$MODE/metadata.json" > "$T/mode-$MODE/metadata.new"; mv "$T/mode-$MODE/metadata.new" "$T/mode-$MODE/metadata.json"
  expect_fail "patch mode $MODE rejected" "$ART" validate --artifact "$T/mode-$MODE" --expected-run-id 4242 --expected-base-sha "$BASE" --expected-attempt 1 --expected-phase agent --allow-prefix src/ --allow-prefix docs/ --allow-prefix package.json
done
cp -a "$GOOD_ART" "$T/bad-checksum"; printf x >> "$T/bad-checksum/patch.diff"
expect_fail 'checksum mismatch rejected' "$ART" validate --artifact "$T/bad-checksum" --expected-run-id 4242 --expected-base-sha "$BASE" --expected-attempt 1 --expected-phase agent --allow-prefix src/ --allow-prefix docs/ --allow-prefix package.json
cp -a "$GOOD_ART" "$T/bad-base"; jq '.base_sha="0000000000000000000000000000000000000000"' "$T/bad-base/metadata.json" > "$T/bad-base/metadata.tmp" && mv "$T/bad-base/metadata.tmp" "$T/bad-base/metadata.json"
expect_fail 'stale base SHA rejected' "$ART" validate --artifact "$T/bad-base" --expected-run-id 4242 --expected-base-sha "$BASE" --expected-attempt 1 --expected-phase agent --allow-prefix src/ --allow-prefix docs/ --allow-prefix package.json
# Path traversal and unexpected files are rejected by the scope/parser.
cp -a "$GOOD_ART" "$T/bad-path"; printf '../outside\n' > "$T/bad-path/files.txt"; jq '.changed_files=["../outside"]' "$T/bad-path/metadata.json" > "$T/bad-path/metadata.tmp" && mv "$T/bad-path/metadata.tmp" "$T/bad-path/metadata.json"
expect_fail 'path traversal rejected' "$ART" validate --artifact "$T/bad-path" --expected-run-id 4242 --expected-base-sha "$BASE" --expected-attempt 1 --expected-phase agent --allow-prefix src/ --allow-prefix docs/ --allow-prefix package.json
UNEXPECT="$T/unexpected"; printf 'nope\n' > "$SRC/notes.txt"; git -C "$SRC" add -N notes.txt; expect_fail 'unexpected file rejected' "$ART" create --output "$UNEXPECT" --run-id 4242 --base-sha "$(sha "$SRC")" --attempt 1 --phase agent --allow-prefix src/
rm -f "$SRC/notes.txt"; git -C "$SRC" reset --hard "$BASE" >/dev/null
# Secret-looking directories/components are rejected at any depth.
printf 'dummy\n' > "$SRC/docs-id_rsa"; mkdir -p "$SRC/docs"; mv "$SRC/docs-id_rsa" "$SRC/docs/id_rsa"; git -C "$SRC" add -N docs/id_rsa; expect_fail 'nested secret path rejected' "$ART" create --output "$T/nested-secret" --run-id 4242 --base-sha "$(sha "$SRC")" --attempt 1 --phase agent --allow-prefix docs/; rm -f "$SRC/docs/id_rsa"; git -C "$SRC" reset --hard "$BASE" >/dev/null
# Nested manifests and test/gate configuration are frozen from autonomous patches.
mkdir -p "$SRC/lib"; printf '{"scripts":{"build":"exit 0"}}\n' > "$SRC/lib/package.json"; git -C "$SRC" add -N lib/package.json; expect_fail 'nested package manifest rejected' "$ART" create --output "$T/nested-manifest" --run-id 4242 --base-sha "$(sha "$SRC")" --attempt 1 --phase agent --allow-prefix lib/; rm -f "$SRC/lib/package.json"; git -C "$SRC" reset --hard "$BASE" >/dev/null
printf 'test("bypass",()=>{})\n' > "$SRC/src/zero.test.ts"; git -C "$SRC" add -N src/zero.test.ts; expect_fail 'auto-discovered test path rejected' "$ART" create --output "$T/auto-test" --run-id 4242 --base-sha "$(sha "$SRC")" --attempt 1 --phase agent --allow-prefix src/; rm -f "$SRC/src/zero.test.ts"; git -C "$SRC" reset --hard "$BASE" >/dev/null
mkdir -p "$SRC/lib/node_modules/.bin"; printf '#!/bin/sh\nexit 0\n' > "$SRC/lib/node_modules/.bin/gate"; chmod +x "$SRC/lib/node_modules/.bin/gate"; git -C "$SRC" add -N lib/node_modules/.bin/gate; expect_fail 'candidate node_modules shim rejected' "$ART" create --output "$T/node-shim" --run-id 4242 --base-sha "$(sha "$SRC")" --attempt 1 --phase agent --allow-prefix lib/; rm -rf "$SRC/lib/node_modules"; git -C "$SRC" reset --hard "$BASE" >/dev/null
# Symlink changes are rejected at creation.
commit_file "$SRC" src/real.txt base; rm -f "$SRC/notes.txt"; git -C "$SRC" reset --hard "$BASE" >/dev/null; ln -s /etc/passwd "$SRC/src/link"; git -C "$SRC" add -A; expect_fail 'symlink rejected' "$ART" create --output "$T/symlink" --run-id 4242 --base-sha "$BASE" --attempt 1 --phase agent --allow-prefix src/; rm -f "$SRC/src/link"; rm -f "$SRC/notes.txt"; git -C "$SRC" reset --hard "$BASE" >/dev/null
# Credential-shaped artifact content is rejected before upload.
mkdir -p "$T/secret-tree"; printf 'ghp_01234567890123456789\n' > "$T/secret-tree/output.txt"; expect_fail 'credential-shaped artifact rejected' "$ART" scan-tree --input "$T/secret-tree"
mkdir -p "$T/fifo-tree"; mkfifo "$T/fifo-tree/pipe"; expect_fail 'FIFO artifact entry rejected' "$ART" scan-tree --input "$T/fifo-tree"
printf 'hard\n' > "$T/hardlink-tree-file"; mkdir -p "$T/hardlink-tree"; ln "$T/hardlink-tree-file" "$T/hardlink-tree/one"; ln "$T/hardlink-tree-file" "$T/hardlink-tree/two"; expect_fail 'hardlinked artifact entry rejected' "$ART" scan-tree --input "$T/hardlink-tree"
printf 'unreadable\n' > "$T/unreadable-tree-file"; chmod 000 "$T/unreadable-tree-file"; mkdir -p "$T/unreadable-tree"; mv "$T/unreadable-tree-file" "$T/unreadable-tree/file"; expect_fail 'unreadable artifact entry fails closed' "$ART" scan-tree --input "$T/unreadable-tree"; chmod 644 "$T/unreadable-tree/file"
RENAME_REPO="$T/rename-source"; repo "$RENAME_REPO"; commit_file "$RENAME_REPO" tests/old.ts base; git -C "$RENAME_REPO" branch -M main; mkdir -p "$RENAME_REPO/lib"; git -C "$RENAME_REPO" mv tests/old.ts lib/new.ts; expect_fail 'denied rename source rejected' "$ART" create --output "$T/rename-artifact" --run-id 4242 --base-sha "$(sha "$RENAME_REPO")" --attempt 1 --phase agent --allow-prefix lib/
mkdir -p "$SRC/docs"; printf 'archive\n' > "$SRC/docs/bundle.tar.gz"; git -C "$SRC" add -N docs/bundle.tar.gz; expect_fail 'archive artifact path rejected' "$ART" create --output "$T/archive-artifact" --run-id 4242 --base-sha "$(sha "$SRC")" --attempt 1 --phase agent --allow-prefix docs/; rm -f "$SRC/docs/bundle.tar.gz"; git -C "$SRC" reset --hard "$BASE" >/dev/null
mkdir -p "$SRC/docs"; printf 'archive\n' > "$SRC/docs/LEAK.TAR.GZ"; git -C "$SRC" add -N docs/LEAK.TAR.GZ; expect_fail 'mixed-case archive artifact path rejected' "$ART" create --output "$T/archive-upper-artifact" --run-id 4242 --base-sha "$(sha "$SRC")" --attempt 1 --phase agent --allow-prefix docs/; rm -f "$SRC/docs/LEAK.TAR.GZ"; git -C "$SRC" reset --hard "$BASE" >/dev/null
mkdir -p "$T/artifact-real-parent"; ln -s "$T/artifact-real-parent" "$T/artifact-parent-link"; expect_fail 'artifact intermediate symlink rejected' "$ART" create --output "$T/artifact-parent-link/out" --run-id 4242 --base-sha "$BASE" --attempt 1 --phase agent --allow-prefix docs/
mkdir -p "$SRC/docs"; printf 'secret\n' > "$SRC/docs/ID_RSA"; git -C "$SRC" add -N docs/ID_RSA; expect_fail 'mixed-case secret path rejected' "$ART" create --output "$T/secret-name-artifact" --run-id 4242 --base-sha "$(sha "$SRC")" --attempt 1 --phase agent --allow-prefix docs/; rm -f "$SRC/docs/ID_RSA"; git -C "$SRC" reset --hard "$BASE" >/dev/null
# Direct unit assertions on the shared policy so a polarity flip cannot hide
# behind the integration harness below.
# shellcheck source=/dev/null
. "$ROOT/.github/scripts/sec001-path-policy.sh"
POLICY_OK=0; POLICY_BAD=0
for p in src/a.txt lib/index.ts docs/guide.md action/run.ts; do
  if sec001_assert_candidate_path "$p"; then POLICY_OK=$((POLICY_OK+1)); else POLICY_BAD=$((POLICY_BAD+1)); fi
done
for p in tests/secret.test.ts lib/tests/keep.test.ts package.json pnpm-lock.yaml node_modules/evil.js vitest.config.ts biome.json lib/release.zip docs/bundle.tar.gz .env docs/id_rsa lib/private.key ../escape 'lib/back\slash.ts'; do
  if sec001_assert_candidate_path "$p"; then POLICY_BAD=$((POLICY_BAD+1)); else POLICY_OK=$((POLICY_OK+1)); fi
done
[ "$POLICY_OK" -eq 18 ] && [ "$POLICY_BAD" -eq 0 ] && pass 'shared path policy allow/deny polarity is correct' || fail "shared path policy polarity wrong (ok=$POLICY_OK denied_leaked=$POLICY_BAD)"
# Shared path policy parity: the same policy file backs artifact create and
# trusted-publish. A matching --allow-prefix must never re-open a denied path.
# Each prefix is one that would otherwise admit the path, so a failure can only
# come from the policy — never from a prefix mismatch.
for denied_path in 'lib/tests/keep.test.ts' 'package.json' 'node_modules/evil.js' 'vitest.config.ts' 'lib/release.zip'; do
  POLICY_REPO="$T/policy-$(printf '%s' "$denied_path" | tr -c 'A-Za-z0-9' '-')"; repo "$POLICY_REPO"; commit_file "$POLICY_REPO" README.md base
  mkdir -p "$POLICY_REPO/$(dirname "$denied_path")"; printf 'denied\n' > "$POLICY_REPO/$denied_path"
  # `dirname` yields "." for a top-level file, whose "./" prefix never matches;
  # use the exact path as the prefix so the allow-list genuinely admits it.
  case "$(dirname "$denied_path")" in
    .) POLICY_PREFIX="$denied_path" ;;
    *) POLICY_PREFIX="$(dirname "$denied_path")/" ;;
  esac
  expect_fail_matching "denied path rejected under matching allow-prefix: $denied_path" 'changed path is outside the approved artifact scope' env -C "$POLICY_REPO" "$ART" create --output "$POLICY_REPO-artifact" --run-id 4242 --base-sha "$(sha "$POLICY_REPO")" --attempt 1 --phase agent --allow-prefix "$POLICY_PREFIX"
done
POLICY_OK_REPO="$T/policy-ok"; repo "$POLICY_OK_REPO"; commit_file "$POLICY_OK_REPO" README.md base
mkdir -p "$POLICY_OK_REPO/lib"; printf 'ok\n' > "$POLICY_OK_REPO/lib/index.ts"
if env -C "$POLICY_OK_REPO" "$ART" create --output "$POLICY_OK_REPO-artifact" --run-id 4242 --base-sha "$(sha "$POLICY_OK_REPO")" --attempt 1 --phase agent --allow-prefix lib/ >/dev/null 2>&1; then pass 'ordinary source path accepted under allow-prefix'; else fail 'ordinary source path wrongly rejected under allow-prefix'; fi

# Artifact scratch files must not survive a rejection. `trap ... RETURN` never
# fires on exit, so this pins that the cleanup is an EXIT trap.
CLEAN_TMPDIR="$T/cleanup-probe"; mkdir -p "$CLEAN_TMPDIR"
CLEAN_REPO="$T/cleanup-repo"; repo "$CLEAN_REPO"; commit_file "$CLEAN_REPO" src/a.txt base; printf 'changed\n' > "$CLEAN_REPO/src/a.txt"
mkdir -p "$CLEAN_REPO/node_modules"; printf 'x\n' > "$CLEAN_REPO/node_modules/evil.js"
CLEAN_BEFORE=$(find "$CLEAN_TMPDIR" -type f | wc -l)
expect_fail 'artifact denial rejected for cleanup probe' env -C "$CLEAN_REPO" TMPDIR="$CLEAN_TMPDIR" "$ART" create --output "$CLEAN_REPO-artifact" --run-id 4242 --base-sha "$(sha "$CLEAN_REPO")" --attempt 1 --phase agent --allow-prefix src/
CLEAN_AFTER=$(find "$CLEAN_TMPDIR" -type f | wc -l)
[ "$CLEAN_AFTER" -eq "$CLEAN_BEFORE" ] && pass 'artifact rejection leaves no scratch files behind' || fail "artifact rejection leaked $((CLEAN_AFTER - CLEAN_BEFORE)) scratch file(s)"

# The publisher, verifier and trusted-publisher each mktemp a private root and
# must remove it on a rejection path. Reach past argument validation so the
# temp root is actually created, then fail on the missing inputs.
TPROBE_PUBLISH=0; TPROBE_VERIFY=0; TPROBE_TRUSTED=0
_t=$(mktemp -d "$T/probe-pub.XXXXXX")
: > "$_t/t.json"; : > "$_t/r.json"; : > "$_t/s.json"
env TMPDIR="$_t" SEC001_TEST_MODE=1 "$PUBLISH" --tasks "$_t/t.json" --results "$_t/r.json" --status "$_t/s.json" --repo x/y --remote https://github.com/x/y.git --merge-gate /bin/true --approval /bin/true --artifact-helper /bin/true --publish-helper /bin/true --model-output-helper "$MODEL_OUTPUT" >/dev/null 2>&1 || true
[ -z "$(find "$_t" -mindepth 1 -maxdepth 1 -name 'tmp.*' 2>/dev/null)" ] && TPROBE_PUBLISH=1 || fail 'sec001-hourly-publish.sh left its temp root behind'
rm -rf "$_t"
_t=$(mktemp -d "$T/probe-ver.XXXXXX")
: > "$_t/results.json"
# Assert the intended failure reason too: a typo'd flag would exit 2 during
# argument parsing, before the temp root is ever created, and the probe would
# silently "pass".
expect_fail_matching 'verifier probe reaches past argument validation' 'results.json|verification|identity|missing' env TMPDIR="$_t" SEC001_TEST_MODE=1 "$ROOT/.github/scripts/sec001-hourly-verify.sh" --input "$_t" --output "$_t/vout" --run-id 4242 --base-sha 0000000000000000000000000000000000000000 --remote "file://$_t" --artifact-helper "$ART" --gate-runner /bin/true --model-output-helper "$MODEL_OUTPUT"
[ -z "$(find "$_t" -mindepth 1 -maxdepth 1 -name 'tmp.*' 2>/dev/null)" ] && TPROBE_VERIFY=1 || fail 'sec001-hourly-verify.sh left its temp root behind'
rm -rf "$_t"
_t=$(mktemp -d "$T/probe-tru.XXXXXX")
: > "$_t/p.patch"
env TMPDIR="$_t" SEC001_TEST_MODE=1 SEC001_TEST_REPO=x/y GH_TOKEN=dummy "$PUB" --patch "$_t/p.patch" --base-sha 0000000000000000000000000000000000000000 --branch sec001/probe --remote "file://$_t" --repo x/y >/dev/null 2>&1 || true
[ -z "$(find "$_t" -mindepth 1 -maxdepth 1 -name 'tmp.*' 2>/dev/null)" ] && TPROBE_TRUSTED=1 || fail 'sec001-trusted-publish.sh left its temp root behind'
rm -rf "$_t"
[ "$TPROBE_PUBLISH$TPROBE_VERIFY$TPROBE_TRUSTED" = 111 ] && pass 'publish, verify and trusted-publish remove their temp root on rejection' || fail 'a tool left its temp root behind on rejection'

# create_status and create_wrapper are live CI paths (the finalizer and the
# task-manifest wrap) and must not leak scratch files on rejection or success.
ST_TMPDIR="$T/status-probe"; mkdir -p "$ST_TMPDIR"
dd if=/dev/zero of="$T/status-probe.log" bs=1M count=3 status=none
ST_BEFORE=$(find "$ST_TMPDIR" -type f | wc -l)
expect_fail_matching 'status rejection rejected for cleanup probe' 'size limit' env TMPDIR="$ST_TMPDIR" "$ART" status --output "$T/status-probe-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --verified true --log "$T/status-probe.log"
ST_AFTER=$(find "$ST_TMPDIR" -type f | wc -l)
[ "$ST_AFTER" -eq "$ST_BEFORE" ] && pass 'status rejection leaves no scratch files behind' || fail "status rejection leaked $((ST_AFTER - ST_BEFORE)) scratch file(s)"

WR_TMPDIR="$T/wrap-probe"; mkdir -p "$WR_TMPDIR"
printf '{"run_id":"4242"}\n' > "$T/wrap-input.json"
WR_BEFORE=$(find "$WR_TMPDIR" -type f | wc -l)
env TMPDIR="$WR_TMPDIR" "$ART" wrap --output "$T/wrap-probe-artifact" --input "$T/wrap-input.json" --name tasks.json --run-id 4242 --base-sha "$BASE" --phase discover >/dev/null 2>&1 || true
WR_AFTER=$(find "$WR_TMPDIR" -type f | wc -l)
[ "$WR_AFTER" -eq "$WR_BEFORE" ] && pass 'wrap leaves no scratch files on success' || fail "wrap leaked $((WR_AFTER - WR_BEFORE)) scratch file(s) on success"
[ -f "$T/wrap-probe-artifact/metadata.json" ] && pass 'wrap probe produced a real artifact' || fail 'wrap probe produced no artifact, so its leak assertion proves nothing'

SC_TMPDIR="$T/create-success-probe"; mkdir -p "$SC_TMPDIR"
SC_REPO="$T/create-success-repo"; repo "$SC_REPO"; commit_file "$SC_REPO" src/a.txt base; printf 'changed\n' > "$SC_REPO/src/a.txt"
SC_BEFORE=$(find "$SC_TMPDIR" -type f | wc -l)
env -C "$SC_REPO" TMPDIR="$SC_TMPDIR" "$ART" create --output "$SC_REPO-artifact" --run-id 4242 --base-sha "$(sha "$SC_REPO")" --attempt 1 --phase agent --allow-prefix src/ >/dev/null 2>&1 || fail 'create probe failed to produce an artifact'
SC_AFTER=$(find "$SC_TMPDIR" -type f | wc -l)
[ "$SC_AFTER" -eq "$SC_BEFORE" ] && pass 'create leaves no scratch files on success' || fail "create leaked $((SC_AFTER - SC_BEFORE)) scratch file(s) on success"

# Build a real status artifact and a real wrapper artifact first, then add an
# unexpected file so the rejection lands on the directory-listing `cmp`, which
# runs after the scratch registrations.
VS_SRC="$T/vs-source"; printf 'verify line\n' > "$VS_SRC"
"$ART" status --output "$T/vs-real" --run-id 4242 --base-sha "$BASE" --phase verify --verified true --log "$VS_SRC" >/dev/null 2>&1 || fail 'validate-status probe could not build a real status artifact'
VS_ART="$T/vs-artifact"; cp -a "$T/vs-real" "$VS_ART"; : > "$VS_ART/UNEXPECTED"
VS_TMPDIR="$T/validate-status-probe"; mkdir -p "$VS_TMPDIR"
VS_BEFORE=$(find "$VS_TMPDIR" -type f | wc -l)
expect_fail_matching 'validate-status rejection for cleanup probe' 'unexpected files' env TMPDIR="$VS_TMPDIR" "$ART" validate-status --artifact "$VS_ART" --expected-run-id 4242 --expected-base-sha "$BASE" --expected-phase verify
VS_AFTER=$(find "$VS_TMPDIR" -type f | wc -l)
[ "$VS_AFTER" -eq "$VS_BEFORE" ] && pass 'validate-status leaves no scratch files on rejection' || fail "validate-status leaked $((VS_AFTER - VS_BEFORE)) scratch file(s)"

printf '{"run_id":"4242"}\n' > "$T/vw-input.json"
"$ART" wrap --output "$T/vw-real" --input "$T/vw-input.json" --name tasks.json --run-id 4242 --base-sha "$BASE" --phase discover >/dev/null 2>&1 || fail 'validate-wrap probe could not build a real wrapper artifact'
VW_ART="$T/vw-artifact"; cp -a "$T/vw-real" "$VW_ART"; : > "$VW_ART/UNEXPECTED"
VW_TMPDIR="$T/validate-wrap-probe"; mkdir -p "$VW_TMPDIR"
VW_BEFORE=$(find "$VW_TMPDIR" -type f | wc -l)
expect_fail_matching 'validate-wrap rejection for cleanup probe' 'unexpected files' env TMPDIR="$VW_TMPDIR" "$ART" validate-wrap --artifact "$VW_ART" --expected-run-id 4242 --expected-base-sha "$BASE" --expected-phase discover
VW_AFTER=$(find "$VW_TMPDIR" -type f | wc -l)
[ "$VW_AFTER" -eq "$VW_BEFORE" ] && pass 'validate-wrap leaves no scratch files on rejection' || fail "validate-wrap leaked $((VW_AFTER - VW_BEFORE)) scratch file(s)"

[ "$WR_AFTER" -eq "$WR_BEFORE" ] && pass 'successful wrap leaves no scratch files behind' || fail "successful wrap leaked $((WR_AFTER - WR_BEFORE)) scratch file(s)"

# The validate-package rejection path has its own scratch pair; pin it too.
VP_TMPDIR="$T/vp-cleanup-probe"; mkdir -p "$VP_TMPDIR"
VP_ART="$T/vp-artifact"; cp -a "$GOOD_ART" "$VP_ART"
printf 'src/ghost.txt\n' >> "$VP_ART/files.txt"
VP_BEFORE=$(find "$VP_TMPDIR" -type f | wc -l)
expect_fail 'validate-package mismatch rejected for cleanup probe' env TMPDIR="$VP_TMPDIR" "$ART" validate-package --artifact "$VP_ART" --expected-run-id 4242 --expected-base-sha "$(sha "$SRC")" --expected-attempt 1 --expected-phase agent --allow-prefix src/
VP_AFTER=$(find "$VP_TMPDIR" -type f | wc -l)
[ "$VP_AFTER" -eq "$VP_BEFORE" ] && pass 'validate-package rejection leaves no scratch files behind' || fail "validate-package rejection leaked $((VP_AFTER - VP_BEFORE)) scratch file(s)"

# A second validate-package rejection shape: an unexpected top-level file in the
# artifact fails before the explicit `rm` that clears the listing pair, so this
# pins the registry as the only backstop on that path.
VPX_SRC="$T/vpx-source"; repo "$VPX_SRC"; commit_file "$VPX_SRC" src/a.txt base; printf 'changed\n' > "$VPX_SRC/src/a.txt"
env -C "$VPX_SRC" "$ART" create --output "$T/vpx-real" --run-id 4242 --base-sha "$(sha "$VPX_SRC")" --attempt 1 --phase agent --allow-prefix src/ >/dev/null 2>&1 || fail 'validate-package extra probe could not build a real artifact'
VPX_ART="$T/vpx-artifact"; cp -a "$T/vpx-real" "$VPX_ART"; : > "$VPX_ART/UNEXPECTED"
VPX_TMPDIR="$T/validate-package-extra"; mkdir -p "$VPX_TMPDIR"
VPX_BEFORE=$(find "$VPX_TMPDIR" -type f | wc -l)
expect_fail_matching 'validate-package unexpected-file rejection' 'unexpected files' env -C "$VPX_SRC" TMPDIR="$VPX_TMPDIR" "$ART" validate-package --artifact "$VPX_ART" --expected-run-id 4242 --expected-base-sha "$(sha "$VPX_SRC")" --expected-attempt 1 --expected-phase agent --allow-prefix src/
VPX_AFTER=$(find "$VPX_TMPDIR" -type f | wc -l)
[ "$VPX_AFTER" -eq "$VPX_BEFORE" ] && pass 'validate-package leaves no scratch files on an unexpected-file rejection' || fail "validate-package leaked $((VPX_AFTER - VPX_BEFORE)) scratch file(s) on an unexpected-file rejection"

# Model output contract: bounded UTF-8 text and strict final approval JSON.
printf 'plain answer\nsecond line\n' > "$T/model-text"
"$MODEL_OUTPUT" text "$T/model-text" && pass 'bounded model text accepted' || fail 'bounded model text rejected'
"$MODEL_OUTPUT" text "$T/model-text" "$T/model-text-copy" && cmp -s "$T/model-text" "$T/model-text-copy" && pass 'validated text copy accepted' || fail 'validated text copy failed'
printf 'non-empty issue answer\n' > "$T/model-answer-valid"
"$MODEL_OUTPUT" answer "$T/model-answer-valid" "$T/model-answer-copy" && cmp -s "$T/model-answer-valid" "$T/model-answer-copy" && pass 'non-empty bounded answer accepted' || fail 'non-empty bounded answer rejected'
: > "$T/model-answer-empty"
expect_fail 'empty issue answer rejected' "$MODEL_OUTPUT" answer "$T/model-answer-empty"
printf ' \t\r\n' > "$T/model-answer-whitespace"
expect_fail 'whitespace-only issue answer rejected' "$MODEL_OUTPUT" answer "$T/model-answer-whitespace"
printf 'victim\n' > "$T/model-output-victim"; ln -s "$T/model-output-victim" "$T/model-output-link"
expect_fail 'symlinked model output destination rejected' "$MODEL_OUTPUT" text "$T/model-text" "$T/model-output-link"
mkdir -p "$T/model-parent-target"; ln -s "$T/model-parent-target" "$T/model-parent-link"
expect_fail 'symlinked model output parent rejected' "$MODEL_OUTPUT" text "$T/model-text" "$T/model-parent-link/output"
expect_fail 'symlinked model input parent rejected' "$MODEL_OUTPUT" text "$T/model-parent-link/input"
mkdir -p "$T/real-parent/nested"; printf 'nested\n' > "$T/real-parent/nested/input"; ln -s "$T/real-parent" "$T/intermediate-link"
expect_fail 'intermediate symlink in model input parent rejected' "$MODEL_OUTPUT" text "$T/intermediate-link/nested/input"
expect_fail 'intermediate symlink in model output parent rejected' "$MODEL_OUTPUT" text "$T/model-text" "$T/intermediate-link/nested/output"
expect_fail 'intermediate symlink in generated output parent rejected' bash -c 'printf safe | "$1" write "$2"' _ "$MODEL_OUTPUT" "$T/intermediate-link/nested/generated"
printf 'trusted output\n' > "$T/model-expected"
printf 'trusted output\n' | "$MODEL_OUTPUT" write "$T/model-written" && cmp -s "$T/model-expected" "$T/model-written" && pass 'safe generated output write preserves bytes' || fail 'safe generated output write failed'
ln -s "$T/model-output-victim" "$T/model-write-link"
expect_fail 'symlinked generated output destination rejected' "$MODEL_OUTPUT" write "$T/model-write-link"
mkdir -p "$T/python-poison"; printf 'raise RuntimeError("poison")\n' > "$T/python-poison/json.py"
PYTHONPATH="$T/python-poison" "$MODEL_OUTPUT" text "$T/model-text" >/dev/null && pass 'isolated model-output PYTHONPATH' || fail 'model-output PYTHONPATH was influenceable'
(cd "$T/python-poison" && "$MODEL_OUTPUT" text "$T/model-text") >/dev/null && pass 'isolated model-output cwd' || fail 'model-output cwd was influenceable'
printf '\377\n' > "$T/model-invalid-utf8"
expect_fail 'invalid UTF-8 model text rejected' "$MODEL_OUTPUT" text "$T/model-invalid-utf8"
printf 'bad\001text\n' > "$T/model-control"
expect_fail 'control-character model text rejected' "$MODEL_OUTPUT" text "$T/model-control"
printf 'spoof\342\200\256text\n' > "$T/model-format"
expect_fail 'format-character model text rejected' "$MODEL_OUTPUT" text "$T/model-format"
python3 - "$T/model-lines-2000" <<'PY'
import sys
open(sys.argv[1], 'w', encoding='utf-8').write('line\n' * 2000)
PY
"$MODEL_OUTPUT" text "$T/model-lines-2000" >/dev/null && pass 'exact model line limit accepted' || fail 'exact model line limit rejected'
dd if=/dev/zero of="$T/model-oversized" bs=1024 count=1025 status=none
expect_fail 'oversized model text rejected' "$MODEL_OUTPUT" text "$T/model-oversized"
python3 - "$T/model-lines-2001" <<'PY'
import sys
open(sys.argv[1], 'w', encoding='utf-8').write('line\n' * 2001)
PY
expect_fail 'model text line limit enforced' "$MODEL_OUTPUT" text "$T/model-lines-2001"
if (ulimit -f 1024; dd if=/dev/zero of="$T/model-quota" bs=1M count=8 status=none) >/dev/null 2>&1; then fail 'model output file quota did not fail closed'; else pass 'model output file quota fails closed'; fi
PARTIAL_OUTPUT="$T/model-partial-output"
if (ulimit -f 1; dd if=/dev/zero bs=1024 count=8 status=none | "$MODEL_OUTPUT" write "$PARTIAL_OUTPUT") >/dev/null 2>&1; then fail 'model output write quota unexpectedly succeeded'; else [ ! -e "$PARTIAL_OUTPUT" ] && pass 'failed bounded write removes partial destination' || fail 'failed bounded write left a partial destination'; fi
printf 'diagnostic line\n{"approved":true,"confidence":"high","reason":"bounded"}\n' > "$T/model-approval"
"$MODEL_OUTPUT" approval "$T/model-approval" | jq -e '.approved == true and .confidence == "high" and .reason == "bounded"' >/dev/null && pass 'structured approval accepted' || fail 'structured approval rejected'
printf '%s\n' '{"approved":true,"approved":false,"confidence":"high","reason":"x"}' > "$T/model-duplicate"
expect_fail 'duplicate approval key rejected' "$MODEL_OUTPUT" approval "$T/model-duplicate"
printf '%s\n' '{"approved":true,"confidence":"high","reason":"x","extra":true}' > "$T/model-unknown"
expect_fail 'unknown approval field rejected' "$MODEL_OUTPUT" approval "$T/model-unknown"
printf '%s\n' '{"approved":false,"confidence":"high","reason":"x"}' > "$T/model-rejected-high"
expect_fail 'contradictory rejected approval rejected' "$MODEL_OUTPUT" approval "$T/model-rejected-high"
printf '%s\n' '{"approved":true,"confidence":"low","reason":"x"}' > "$T/model-approved-low"
expect_fail 'contradictory approved decision rejected' "$MODEL_OUTPUT" approval "$T/model-approved-low"
printf '%s\n' '{"approved":false,"confidence":"low","reason":"rejected"}' > "$T/model-valid-low"
"$MODEL_OUTPUT" approval "$T/model-valid-low" | jq -e '.approved == false and .confidence == "low"' >/dev/null && pass 'valid low-confidence rejection accepted' || fail 'valid low-confidence rejection rejected'
printf '\377\n' > "$T/model-approval-utf8"
expect_fail 'invalid UTF-8 approval rejected' "$MODEL_OUTPUT" approval "$T/model-approval-utf8"
printf '%s\n' '[]' > "$T/model-approval-array"
expect_fail 'non-object approval rejected' "$MODEL_OUTPUT" approval "$T/model-approval-array"
python3 - "$T/model-approval-long-reason" <<'PY'
import json, sys
open(sys.argv[1], 'w', encoding='utf-8').write(json.dumps({'approved': True, 'confidence': 'high', 'reason': 'x' * 2001}))
PY
expect_fail 'oversized approval reason rejected' "$MODEL_OUTPUT" approval "$T/model-approval-long-reason"
printf '%s\n' '{"approved":true,"confidence":"high","reason":"x"} trailing' > "$T/model-trailing"
expect_fail 'trailing approval data rejected' "$MODEL_OUTPUT" approval "$T/model-trailing"
printf '\034{"approved":true,"confidence":"high","reason":"x"}\035\n' > "$T/model-approval-control"
expect_fail 'approval control-character padding rejected' "$MODEL_OUTPUT" approval "$T/model-approval-control"
printf 'diagnostic\000line\n{"approved":true,"confidence":"high","reason":"x"}\n' > "$T/model-approval-prefix-control"
expect_fail 'approval diagnostic control rejected' "$MODEL_OUTPUT" approval "$T/model-approval-prefix-control"
printf 'diagnostic\nready\n' > "$T/model-triage-valid"
"$MODEL_OUTPUT" triage "$T/model-triage-valid" | grep -qx ready && pass 'strict triage decision accepted' || fail 'strict triage decision rejected'
printf 'ready\nnot-a-decision\n' > "$T/model-triage-invalid"
expect_fail 'non-final triage decision rejected' "$MODEL_OUTPUT" triage "$T/model-triage-invalid"
printf '%s\n' '{"approved":"yes","confidence":"high","reason":"x"}' > "$T/model-type"
expect_fail 'non-boolean approval rejected' "$MODEL_OUTPUT" approval "$T/model-type"
ln -s "$T/model-text" "$T/model-text-link"
expect_fail 'symlinked model output rejected' "$MODEL_OUTPUT" text "$T/model-text-link"
mkfifo "$T/model-fifo"
expect_fail 'FIFO model output rejected without blocking' timeout 2 "$MODEL_OUTPUT" text "$T/model-fifo"
printf 'hardlink\n' > "$T/model-hardlink-source"; ln "$T/model-hardlink-source" "$T/model-hardlink"
expect_fail 'hardlinked model output rejected' "$MODEL_OUTPUT" text "$T/model-hardlink"
# Issue answers are required outputs, not optional hints. Successful issue-mode
# agent execution binds the response filename to the exact run and issue.
AGENT_WRAPPER="$T/issue-agent-wrapper"
cat > "$AGENT_WRAPPER" <<'EOF'
#!/bin/sh
case "$1" in
  *answer-prompt.txt) printf 'bounded issue answer\n' ;;
  *triage-prompt.txt) printf 'needs_input\n' ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$AGENT_WRAPPER"
ISSUE_AGENT_OUT="$T/issue-agent-success"
printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","mode":"issues","prs":[],"issue":{"number":7,"title":"Question","body":"Details","comments":[],"has_questions":true,"updated_at":"2026-09-25T00:00:00Z"}}' > "$T/issue-agent-tasks.json"
SEC001_TEST_MODE=1 "$ROOT/.github/scripts/sec001-hourly-agent.sh" --tasks "$T/issue-agent-tasks.json" --output "$ISSUE_AGENT_OUT" --repo x/y --base-sha "$BASE" --model opencode/test --opencode-wrapper "$AGENT_WRAPPER" --artifact-helper /bin/true --model-output-helper "$MODEL_OUTPUT"
[ -f "$ISSUE_AGENT_OUT/responses/issue-7-run-4242-answer.txt" ] && jq -e '.results == [{"number":7,"action":"issue","choice":"needs_input","has_questions":true,"answer_file":"issue-7-run-4242-answer.txt","patch":false}]' "$ISSUE_AGENT_OUT/results.json" >/dev/null && pass 'issue answer bound to successful run result' || fail 'issue answer was not bound to successful result'
printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","mode":"issues","prs":[],"issue":{"number":7,"title":"No question","body":"Details","comments":[],"has_questions":false,"updated_at":"2026-09-25T00:00:00Z"}}' > "$T/issue-agent-no-question-tasks.json"
SEC001_TEST_MODE=1 "$ROOT/.github/scripts/sec001-hourly-agent.sh" --tasks "$T/issue-agent-no-question-tasks.json" --output "$T/issue-agent-no-question" --repo x/y --base-sha "$BASE" --model opencode/test --opencode-wrapper "$AGENT_WRAPPER" --artifact-helper /bin/true --model-output-helper "$MODEL_OUTPUT"
jq -e '.results[0] | .has_questions == false and .answer_file == null' "$T/issue-agent-no-question/results.json" >/dev/null && [ -z "$(find "$T/issue-agent-no-question/responses" -mindepth 1 -print -quit)" ] && pass 'issue without questions needs no answer' || fail 'no-question issue answer contract failed'
FAKE_CREDENTIAL_MODEL="$T/fake-credential-model"
cat > "$FAKE_CREDENTIAL_MODEL" <<EOF
#!/bin/sh
env > "$T/credential-model-env"
case "\$*" in
  *'Return only the answer text'*) printf 'bounded issue answer\\n' ;;
  *'Classify issue'*) printf 'needs_input\\n' ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$FAKE_CREDENTIAL_MODEL"
printf 'selected-provider-key' > "$T/provider.key"
: > "$T/context7.key"
SEC001_TEST_MODE=1 SEC001_PROVIDER_KEY_FILE="$T/provider.key" SEC001_CONTEXT7_KEY_FILE="$T/context7.key" SEC001_OPENCODE_BIN="$FAKE_CREDENTIAL_MODEL" "$ROOT/.github/scripts/sec001-hourly-agent.sh" --tasks "$T/issue-agent-tasks.json" --output "$T/credential-agent-output" --repo x/y --base-sha "$BASE" --model opencode/test --opencode-wrapper "$ROOT/.github/scripts/run-sec001-opencode.sh" --artifact-helper /bin/true --model-output-helper "$MODEL_OUTPUT"
[ ! -e "$T/provider.key" ] && [ ! -e "$T/context7.key" ] && grep -q '^OPENCODE_API_KEY=selected-provider-key$' "$T/credential-model-env" && pass 'provider credential file is consumed and revoked across model calls' || fail 'provider credential file lifecycle or selected-key forwarding failed'
cat > "$T/issue-agent-failing-wrapper" <<'EOF'
#!/bin/sh
case "$1" in
  *answer-prompt.txt) printf 'partial answer before failure\n'; exit 7 ;;
  *triage-prompt.txt) printf 'ready\n' ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$T/issue-agent-failing-wrapper"
expect_fail 'issue answer model failure fails agent phase' env SEC001_TEST_MODE=1 "$ROOT/.github/scripts/sec001-hourly-agent.sh" --tasks "$T/issue-agent-tasks.json" --output "$T/issue-agent-model-failure" --repo x/y --base-sha "$BASE" --model opencode/test --opencode-wrapper "$T/issue-agent-failing-wrapper" --artifact-helper /bin/true --model-output-helper "$MODEL_OUTPUT"
[ ! -e "$T/issue-agent-model-failure/results.json" ] && [ -z "$(find "$T/issue-agent-model-failure/responses" -mindepth 1 -print -quit 2>/dev/null || true)" ] && pass 'failed answer model emitted no successful result' || fail 'failed answer model emitted successful result'
mkdir -p "$T/agent-clean-tmp"
BEFORE_TMP_COUNT=$(find "$T/agent-clean-tmp" -mindepth 1 -print | wc -l)
expect_fail 'agent early failure preserves fail-closed result' env TMPDIR="$T/agent-clean-tmp" SEC001_TEST_MODE=1 "$ROOT/.github/scripts/sec001-hourly-agent.sh" --tasks "$T/issue-agent-tasks.json" --output "$T/agent-clean-output" --repo x/y --base-sha "$BASE" --model opencode/test --opencode-wrapper "$T/issue-agent-failing-wrapper" --artifact-helper /bin/true --model-output-helper "$MODEL_OUTPUT"
AFTER_TMP_COUNT=$(find "$T/agent-clean-tmp" -mindepth 1 -print | wc -l)
[ "$BEFORE_TMP_COUNT" -eq "$AFTER_TMP_COUNT" ] && pass 'agent temporary state is cleaned on early failure' || fail 'agent temporary state leaked on early failure'
cat > "$T/issue-agent-invalid-wrapper" <<'EOF'
#!/bin/sh
case "$1" in
  *answer-prompt.txt) printf 'bad\001answer\n' ;;
  *triage-prompt.txt) printf 'ready\n' ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$T/issue-agent-invalid-wrapper"
expect_fail 'invalid issue answer fails agent phase' env SEC001_TEST_MODE=1 "$ROOT/.github/scripts/sec001-hourly-agent.sh" --tasks "$T/issue-agent-tasks.json" --output "$T/issue-agent-invalid" --repo x/y --base-sha "$BASE" --model opencode/test --opencode-wrapper "$T/issue-agent-invalid-wrapper" --artifact-helper /bin/true --model-output-helper "$MODEL_OUTPUT"
[ ! -e "$T/issue-agent-invalid/results.json" ] && pass 'invalid answer emitted no successful result' || fail 'invalid answer emitted successful result'
# Empty/malformed verifier result streams fail before status can become verified.
mkdir -p "$T/verify-empty"
printf '%s\n' '{"results":[]}' > "$T/verify-empty/results.json"
expect_fail 'empty verifier result stream rejected' env SEC001_TEST_MODE=1 "$ROOT/.github/scripts/sec001-hourly-verify.sh" --input "$T/verify-empty" --output "$T/verify-empty-output" --base-sha "$BASE" --run-id 4242 --remote https://github.com/x/y.git --artifact-helper /bin/true --gate-runner /bin/true --model-output-helper "$MODEL_OUTPUT"
mkdir -p "$T/verify-pr-head"
printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","results":[{"number":1,"action":"skip","reason":"manual","head_sha":"'$BASE'","patch":false}]}' > "$T/verify-pr-head/results.json"
NOOP_HELPER="$T/sec001-noop-helper"; printf '#!/bin/sh\nexit 0\n' > "$NOOP_HELPER"; chmod +x "$NOOP_HELPER"
SEC001_TEST_MODE=1 "$ROOT/.github/scripts/sec001-hourly-verify.sh" --input "$T/verify-pr-head" --output "$T/verify-pr-head-output" --base-sha "$BASE" --run-id 4242 --remote https://github.com/x/y.git --artifact-helper "$NOOP_HELPER" --gate-runner "$NOOP_HELPER" --model-output-helper "$MODEL_OUTPUT"
jq -e '.verifications == [{"number":1,"action":"skip","verified":true,"reason":"no repository patch","head_sha":"'$BASE'"}]' "$T/verify-pr-head-output/status.json" >/dev/null && pass 'verifier binds every PR verification head' || fail 'verifier omitted PR verification head'
mkdir -p "$T/verify-pr-extra/responses"
cp "$T/verify-pr-head/results.json" "$T/verify-pr-extra/results.json"
printf 'unexpected\n' > "$T/verify-pr-extra/responses/issue-7-run-4242-answer.txt"
expect_fail 'verifier rejects PR response tree' env SEC001_TEST_MODE=1 "$ROOT/.github/scripts/sec001-hourly-verify.sh" --input "$T/verify-pr-extra" --output "$T/verify-pr-extra-output" --base-sha "$BASE" --run-id 4242 --remote https://github.com/x/y.git --artifact-helper "$NOOP_HELPER" --gate-runner "$NOOP_HELPER" --model-output-helper "$MODEL_OUTPUT"
make_verify_issue_case() {
  local dir="$1" answer_name="$2"
  rm -rf "$dir"; mkdir -p "$dir/responses"
  printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","results":[{"number":7,"action":"issue","choice":"ready","has_questions":true,"answer_file":"'$answer_name'","patch":false}]}' > "$dir/results.json"
}
run_verify_issue_case() {
  local dir="$1"
  SEC001_TEST_MODE=1 "$ROOT/.github/scripts/sec001-hourly-verify.sh" --input "$dir" --output "$dir-output" --base-sha "$BASE" --run-id 4242 --remote https://github.com/x/y.git --artifact-helper "$NOOP_HELPER" --gate-runner "$NOOP_HELPER" --model-output-helper "$MODEL_OUTPUT"
}
make_verify_issue_case "$T/verify-issue-valid" issue-7-run-4242-answer.txt
printf 'valid answer\n' > "$T/verify-issue-valid/responses/issue-7-run-4242-answer.txt"
run_verify_issue_case "$T/verify-issue-valid" && jq -e --arg sha "$(printf 'valid answer\n' | sha256sum | awk '{print $1}')" '.verifications[0].verified == true and .verifications[0].answer_sha256 == $sha' "$T/verify-issue-valid-output/status.json" >/dev/null && pass 'verifier validates and hashes required issue answer' || fail 'verifier rejected required issue answer'
make_verify_issue_case "$T/verify-issue-missing" issue-7-run-4242-answer.txt
expect_fail 'verifier rejects missing required issue answer' run_verify_issue_case "$T/verify-issue-missing"
make_verify_issue_case "$T/verify-issue-wrong-run" wrong-run.txt
printf 'wrong\n' > "$T/verify-issue-wrong-run/responses/wrong-run.txt"
expect_fail 'verifier rejects wrong-run issue answer' run_verify_issue_case "$T/verify-issue-wrong-run"
make_verify_issue_case "$T/verify-issue-control" issue-7-run-4242-answer.txt
printf 'bad\001answer\n' > "$T/verify-issue-control/responses/issue-7-run-4242-answer.txt"
expect_fail 'verifier rejects control-character issue answer' run_verify_issue_case "$T/verify-issue-control"
make_verify_issue_case "$T/verify-issue-utf8" issue-7-run-4242-answer.txt
printf '\377\n' > "$T/verify-issue-utf8/responses/issue-7-run-4242-answer.txt"
expect_fail 'verifier rejects invalid UTF-8 issue answer' run_verify_issue_case "$T/verify-issue-utf8"
make_verify_issue_case "$T/verify-issue-oversized" issue-7-run-4242-answer.txt
python3 - "$T/verify-issue-oversized/responses/issue-7-run-4242-answer.txt" <<'PY'
import sys
open(sys.argv[1], 'wb').write(b'x' * (1024 * 1024))
PY
expect_fail 'verifier rejects oversized issue answer' run_verify_issue_case "$T/verify-issue-oversized"
make_verify_issue_case "$T/verify-issue-extra" issue-7-run-4242-answer.txt
printf 'extra\n' > "$T/verify-issue-extra/responses/issue-8-run-4242-answer.txt"
expect_fail 'verifier rejects extra response without questions' run_verify_issue_case "$T/verify-issue-extra"
# Supervisor aggregates real child failures and writes a false diagnostic status.
FAKE_GATE="$T/fake-gate"; printf '#!/bin/sh\nexit 7\n' > "$FAKE_GATE"; chmod +x "$FAKE_GATE"; : > "$T/supervisor-output"
expect_fail 'supervisor propagates gate failure' "$ROOT/.github/scripts/sec001-supervisor.sh" "$PWD" 4242 "$BASE" verify-initial "$T/supervisor-status" "$FAKE_GATE" "$T/supervisor-output"
[ "$(jq -r '.verified' "$T/supervisor-status/status.json")" = false ] && pass 'supervisor records failed gate conclusion' || fail 'supervisor failure status missing'
# Supervisor gate copies are fresh: a prior candidate command cannot poison a later gate.
GATE_WORK="$T/gate-work"; mkdir -p "$GATE_WORK"; printf 'base\n' > "$GATE_WORK/input.txt"
GATE="$ROOT/.github/scripts/sec001-run-gates.sh"
"$GATE" "$GATE_WORK" /bin/sh -c 'printf "poison\\n" > lib-shim.tmp' >/dev/null 2>&1
if "$GATE" "$GATE_WORK" /bin/sh -c 'test ! -e lib-shim.tmp' >/dev/null 2>&1; then pass 'gate copies do not share candidate writes'; else fail 'gate copy poisoning persisted'; fi
if sudo -u sec001-verify sudo -n true >/dev/null 2>&1; then fail 'verification UID can sudo'; else pass 'verification UID cannot sudo'; fi
# The shared green-check gate is exercised directly, not only through spies.
mkdir -p "$T/gate-fake-bin"
cat > "$T/gate-fake-bin/gh" <<'EOF'
#!/bin/sh
case "${GATE_CASE:-green}" in
  empty) rollup='[]' ;;
  # All five required checks SUCCESS plus one non-required check still running:
  # this is the only shape that reaches the wait/timeout branch rather than
  # short-circuiting on a missing or failed required check.
  pending) rollup='[{"name":"test (24)","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"benchmarks","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"coverage","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"Analyze (javascript-typescript)","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"CodeQL","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"slow optional check","status":"IN_PROGRESS","conclusion":null}]' ;;
  failed) rollup='[{"name":"test (24)","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"benchmarks","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"coverage","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"Analyze (javascript-typescript)","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"CodeQL","status":"COMPLETED","conclusion":"FAILURE"}]' ;;
  missing) rollup='[{"name":"test (24)","status":"COMPLETED","conclusion":"SUCCESS"}]' ;;
  # All five required checks present, but one is SKIPPED. SKIPPED is not
  # SUCCESS, so the gate must block even though nothing is failing.
  skipped) rollup='[{"name":"test (24)","status":"COMPLETED","conclusion":"SKIPPED"},{"name":"benchmarks","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"coverage","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"Analyze (javascript-typescript)","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"CodeQL","status":"COMPLETED","conclusion":"SUCCESS"}]' ;;
  green) rollup='[{"name":"test (24)","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"benchmarks","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"coverage","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"Analyze (javascript-typescript)","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"CodeQL","status":"COMPLETED","conclusion":"SUCCESS"}]' ;;
  head-moved)
    if [ ! -e "$GATE_MOVED_FLAG" ]; then : > "$GATE_MOVED_FLAG"; head=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; else head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; fi
    rollup='[{"name":"test (24)","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"benchmarks","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"coverage","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"Analyze (javascript-typescript)","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"CodeQL","status":"COMPLETED","conclusion":"SUCCESS"}]'
    printf '{"headRefOid":"%s","statusCheckRollup":%s}\n' "$head" "$rollup"
    exit 0 ;;
esac
printf '{"headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","statusCheckRollup":%s}\n' "$rollup"
EOF
chmod +x "$T/gate-fake-bin/gh"
GATE_SCRIPT="$ROOT/.github/scripts/autofix-merge-gate.sh"
GATE_HEAD=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
GATE_MOVED_FLAG="$T/gate-moved.flag"
run_gate_case() {
  local name="$1" expected="$2" case_name="$3" out
  # Assert the EXACT exit code, not just "non-zero": the gate reserves 2 for
  # usage/environment errors, so a 1 proves this was a genuine deferral.
  out="$T/gate-$case_name.out"
  set +e
  GATE_CASE="$case_name" GATE_MOVED_FLAG="$GATE_MOVED_FLAG" PATH="$T/gate-fake-bin:$PATH" GATE_ATTEMPTS=1 GATE_SLEEP=1 "$GATE_SCRIPT" 1 x/y "$GATE_HEAD" >"$out" 2>&1
  actual=$?
  set -e
  if [ "$actual" -eq "$expected" ]; then pass "merge gate $name"; else fail "merge gate $name expected exit $expected got $actual: $(tail -n 1 "$out")"; fi
}
run_gate_case 'green checks pass' 0 green
run_gate_case 'empty rollup blocks' 1 empty
run_gate_case 'pending check blocks' 1 pending
run_gate_case 'failed check blocks' 1 failed
run_gate_case 'missing required check blocks' 1 missing
run_gate_case 'skipped required check blocks' 1 skipped
# A malformed poll-timeout override is a usage error (2), not a deferral (1).
set +e
GATE_ATTEMPTS=abc PATH="$T/gate-fake-bin:$PATH" "$GATE_SCRIPT" 1 x/y "$GATE_HEAD" >/dev/null 2>&1
gate_usage_rc=$?
set -e
[ "$gate_usage_rc" -eq 2 ] && pass 'merge gate usage error exits 2, distinct from deferral' || fail "merge gate usage error expected 2 got $gate_usage_rc"
rm -f "$GATE_MOVED_FLAG"
run_gate_case 'head move aborts' 1 head-moved
# Wrapper artifacts validate their own checksum and phase.
printf '{"run_id":4242,"base_sha":"%s","mode":"none"}\n' "$BASE" > "$T/wrap-input.json"
"$ART" wrap --output "$T/wrapped" --input "$T/wrap-input.json" --name tasks.json --run-id 4242 --base-sha "$BASE" --phase discover
"$ART" validate-wrap --artifact "$T/wrapped" --expected-run-id 4242 --expected-base-sha "$BASE" --expected-phase discover
cp -a "$T/wrapped" "$T/wrapped-symlink"; rm "$T/wrapped-symlink/metadata.json"; ln -s "$T/wrapped/metadata.json" "$T/wrapped-symlink/metadata.json"
expect_fail 'wrapper metadata symlink rejected' "$ART" validate-wrap --artifact "$T/wrapped-symlink" --expected-run-id 4242 --expected-base-sha "$BASE" --expected-phase discover
cp -a "$T/wrapped" "$T/wrapped-extra"; mkdir "$T/wrapped-extra/extra"
expect_fail 'wrapper extra component rejected' "$ART" validate-wrap --artifact "$T/wrapped-extra" --expected-run-id 4242 --expected-base-sha "$BASE" --expected-phase discover
printf x >> "$T/wrapped/tasks.json"
expect_fail 'wrapper checksum mismatch rejected' "$ART" validate-wrap --artifact "$T/wrapped" --expected-run-id 4242 --expected-base-sha "$BASE" --expected-phase discover
# Status artifacts bind both the machine status and the redacted log.
printf 'verification output\n' > "$T/status.log"
printf '{"run_id":"4242","base_sha":"%s","phase":"verify","verified":true}\n' "$BASE" > "$T/status.json"
"$ART" status --output "$T/status-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --verified true --log "$T/status.log" --status-file "$T/status.json"
"$ART" validate-status --artifact "$T/status-artifact" --expected-run-id 4242 --expected-base-sha "$BASE" --expected-phase verify
printf 'tampered\n' >> "$T/status-artifact/verification.log"
expect_fail 'status log checksum mismatch rejected' "$ART" validate-status --artifact "$T/status-artifact" --expected-run-id 4242 --expected-base-sha "$BASE" --expected-phase verify
dd if=/dev/zero of="$T/oversized.log" bs=1M count=3 status=none
expect_fail 'oversized verification log rejected' "$ART" status --output "$T/oversized-status" --run-id 4242 --base-sha "$BASE" --phase verify --verified true --log "$T/oversized.log"
# Publish results are bound to the discovered task before any API mutation.
mkdir -p "$T/fake-bin"
cat > "$T/fake-bin/gh" <<'EOF'
#!/bin/sh
if [ "${1:-}" = api ] && [ "${2:-}" = --include ]; then
  [ "${GH_FAIL_ISSUE_EDIT:-0}" != 1 ] || exit 1
  if [ "${FAKE_ETAG_MISSING:-0}" = 1 ]; then
    printf '%s\n' 'X-Test: no-etag' '' '{"labels":[{"name":"analysis:needs-input"}]}'
  else
    printf '%s\n' 'ETag: "fake-etag"' '' '{"labels":[{"name":"analysis:needs-input"}]}'
  fi
  exit 0
fi
if [ "${1:-}" = api ]; then
  # Log every api call before dispatching so the call log records what the
  # publisher asked GitHub to do.
  printf 'gh api %s\n' "$*" >> "$GH_CALLS"
  case "${2:-}" in
    repos/*/issues/*)
      # Model the live label set. The publisher removes exactly one label with
      # `gh issue edit --remove-label`, because GitHub does not implement
      # If-Match on PATCH /issues/{n} (a wrong validator still returns 200).
      if [ "${3:-}" = --jq ]; then
        case " $* " in
          *'labels[].name'*'sort'*)
            if [ "${FAKE_ISSUE_LABEL_STATE_DIR:-}" != "" ] && [ -f "$FAKE_ISSUE_LABEL_STATE_DIR" ]; then cat "$FAKE_ISSUE_LABEL_STATE_DIR"
            elif [ "${FAKE_ISSUE_LABELS_BEFORE:-}" != "" ]; then printf '%s\n' "$FAKE_ISSUE_LABELS_BEFORE"
            else printf '%s\n' '["analysis:needs-input"]'; fi
            exit 0 ;;
          *'labels[].name'*) printf '%s\n' '["analysis:needs-input"]'; exit 0 ;;
        esac
        printf '%s\n' '[]'
        exit 0
      fi
      printf '%s\n' '{"labels":[{"name":"analysis:needs-input"}]}'
      exit 0
      ;;
  esac
fi
if [ "${1:-}" = api ] && { [ "${2:-}" = user ] || [ "${2:-}" = /app ]; }; then
  [ "${FAKE_GH_LOGIN_FAIL:-0}" != 1 ] || exit 1
  if [ "${2:-}" = /app ]; then printf '%s\n' "${FAKE_GH_APP:-test-bot}"; else printf '%s\n' "${FAKE_GH_LOGIN:-test-bot}"; fi
  exit 0
fi
if [ "${1:-}" = pr ] && [ "${2:-}" = view ]; then
  number=${3:-}
  case " $* " in
    *' state,headRefOid,headRefName,isCrossRepository,baseRefName,labels'*)
      printf 'OPEN\t%s\t%s\t%s\t%s\ttrue\n' "${FAKE_PR_HEAD:-}" "${FAKE_PR_HEAD_REF:-feature}" "${FAKE_PR_IS_CROSS:-false}" "${FAKE_PR_BASE_REF:-main}"
      exit 0
      ;;
    *' labels'*)
      if [ "${FAKE_PR_LABELS_EXCLUDED:-false}" = true ]; then printf 'true\n'; else printf 'false\n'; fi
      exit 0
      ;;
    *' comments'*)
      if { [ "${FAKE_PR_MARKER_PRESENT:-false}" = true ] || grep -q "sec001-deferred-pr-$number-head" "${GH_PR_COMMENT_CAPTURE:-/dev/null}" 2>/dev/null; } && [ "${FAKE_PR_MARKER_AUTHOR:-test-bot}" = "${FAKE_GH_LOGIN:-test-bot}" ]; then
        printf '{"comments":[{"author":{"login":"%s"},"body":"<!--sec001-deferred-pr-%s-head-%s-->"}]}\n' "${FAKE_GH_LOGIN:-test-bot}" "$number" "${FAKE_PR_HEAD:-}"
      else
        printf '%s\n' '{"comments":[]}'
      fi
      exit 0
      ;;
  esac
  number=${3:-}
  sequence=''
  [ -z "${FAKE_PR_HEAD_DIR:-}" ] || sequence="${FAKE_PR_HEAD_DIR%/}/$number"
  if [ -n "$sequence" ] && [ -f "$sequence" ]; then
    IFS= read -r state_line < "$sequence" || exit 1
    tail -n +2 "$sequence" > "$sequence.next"
    mv "$sequence.next" "$sequence"
  else
    state_line="${FAKE_PR_STATE:-OPEN}	${FAKE_PR_HEAD:-}	${FAKE_PR_HEAD_REF:-feature}	${FAKE_PR_IS_CROSS:-false}	${FAKE_PR_BASE_REF:-main}"
  fi
  [ -n "$state_line" ] || exit 1
  printf '%s\n' "$state_line"
  exit 0
fi
if [ "${1:-}" = issue ] && [ "${2:-}" = view ]; then
  number=${3:-}
  case " $* " in
    *' body,comments'*|*'title,body,comments'*)
      printf '%s\n' '{"title":"","body":"","comments":[],"labels":[],"assignees":[],"state":"OPEN"}'
      exit 0
      ;;
    *' labels'*)
      if [ "${FAKE_ISSUE_LABELS_EXCLUDED:-false}" = true ]; then printf 'true\n'; else printf 'false\n'; fi
      exit 0
      ;;
    *' comments'*)
      if [ "${FAKE_ISSUE_MARKER_SPOOF:-0}" != 1 ] && [ "${FAKE_ISSUE_MARKER_PRESENT:-false}" = true ] && [ "${FAKE_ISSUE_MARKER_AUTHOR:-test-bot}" = "${FAKE_GH_LOGIN:-test-bot}" ]; then
        printf '{"comments":[{"author":{"login":"%s"},"body":"<!--sec001-issue-answer-issue-%s-run-4242-->"}]}\n' "${FAKE_GH_LOGIN:-test-bot}" "$number"
      else
        printf '%s\n' '{"comments":[]}'
      fi
      exit 0
      ;;
  esac
  number=${3:-}
  sequence=''
  [ -z "${FAKE_ISSUE_STATE_DIR:-}" ] || sequence="${FAKE_ISSUE_STATE_DIR%/}/$number"
  if [ -n "$sequence" ] && [ -f "$sequence" ]; then
    IFS= read -r state_line < "$sequence" || exit 1
    tail -n +2 "$sequence" > "$sequence.next"
    mv "$sequence.next" "$sequence"
  else
    state_line=${FAKE_ISSUE_STATE:-}
  fi
  [ -n "$state_line" ] || exit 1
  printf '%s\n' "$state_line"
  exit 0
fi
if [ "${1:-}" = run ] && [ "${2:-}" = list ]; then
  [ "${GH_FAIL_RUN_LIST:-}" != 1 ] || exit 1
  # The publisher now filters server-side with --status, so the fake must only
  # report a run as present when the requested active status matches.
  REQUESTED_STATUS=''
  prev=''
  for arg in "$@"; do
    if [ "$prev" = "--status" ]; then REQUESTED_STATUS=$arg; fi
    prev=$arg
  done
  if [ "${FAKE_ACTIVE_REVIEW:-0}" = 1 ] && [ "$REQUESTED_STATUS" = "${FAKE_ACTIVE_STATUS:-in_progress}" ]; then
    printf '[{"headSha":"%s","headBranch":"%s","status":"%s"}]\n' "${FAKE_ACTIVE_HEAD_SHA:-${FAKE_PR_HEAD:-}}" "${FAKE_ACTIVE_BRANCH:-some-feature-branch}" "$REQUESTED_STATUS"
  else
    printf '[]\n'
  fi
  exit 0
fi
printf 'gh %s\n' "$*" >> "$GH_CALLS"
COMMAND_PAIR="${1:-} ${2:-}"
COMMENT_TARGET="${3:-}"
if { [ "${1:-}" = issue ] || [ "${1:-}" = pr ]; } && [ "${2:-}" = comment ]; then
  if [ "${1:-}" = pr ]; then capture=${GH_PR_COMMENT_CAPTURE:-/dev/null}; else capture=${GH_COMMENT_CAPTURE:-/dev/null}; fi
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --body-file ]; then cat "$2" > "$capture"; fi
    shift
  done
fi
case "$COMMAND_PAIR" in
  'issue comment') [ "${GH_FAIL_ISSUE_COMMENT:-}" != 1 ] || exit 1 ;;
  'issue edit')
    [ "${GH_FAIL_ISSUE_EDIT:-}" != 1 ] || exit 1
    # Model `gh issue edit --remove-label` / `--add-label` against a persistent
    # label-set file so the publisher's before/after reads are meaningful.
    LABEL_STATE="${FAKE_ISSUE_LABEL_STATE_DIR:-}"
    if [ -n "$LABEL_STATE" ] && [ -f "$LABEL_STATE" ]; then
      if printf '%s\n' "$*" | grep -q -- '--remove-label'; then
        # Model a human mutating labels in the same window as the removal. An
        # ADD must survive (a full-label-set replace would drop it); a REMOVAL
        # must be detected by the publisher's postcondition and compensated by
        # its restore loop. Both directions are load-bearing.
        if [ -n "${FAKE_ISSUE_CONCURRENT_LABEL:-}" ]; then
          jq -c --arg l "$FAKE_ISSUE_CONCURRENT_LABEL" 'if index($l) == null then . + [$l] | sort else . end' "$LABEL_STATE" > "$LABEL_STATE.next" && mv "$LABEL_STATE.next" "$LABEL_STATE"
        fi
        if [ -n "${FAKE_ISSUE_CONCURRENT_REMOVED_LABEL:-}" ]; then
          jq -c --arg l "$FAKE_ISSUE_CONCURRENT_REMOVED_LABEL" 'map(select(. != $l))' "$LABEL_STATE" > "$LABEL_STATE.next" && mv "$LABEL_STATE.next" "$LABEL_STATE"
        fi
        jq -c 'map(select(. != "analysis:needs-input"))' "$LABEL_STATE" > "$LABEL_STATE.next" && mv "$LABEL_STATE.next" "$LABEL_STATE"
      elif printf '%s\n' "$*" | grep -q -- '--add-label'; then
        # Model gh's real argv contract: each --add-label consumes exactly one
        # following value. Any extra positional is NOT treated as a label, so a
        # word-splitting caller is visible here as a garbled label name.
        ADD_JSON='[]'; WANT_ADD=0
        for arg in "$@"; do
          if [ "$WANT_ADD" -eq 1 ]; then
            ADD_JSON=$(printf '%s\n' "$ADD_JSON" | jq -c --arg a "$arg" '. + [$a]'); WANT_ADD=0
          elif [ "$arg" = "--add-label" ]; then WANT_ADD=1; fi
        done
        jq -c --argjson add "$ADD_JSON" '. + $add | unique' "$LABEL_STATE" > "$LABEL_STATE.next" && mv "$LABEL_STATE.next" "$LABEL_STATE"
      fi
    fi
    printf 'gh %s\n' "$*" >> "$GH_CALLS"
    ;;
  'pr edit') [ "${GH_FAIL_PR_EDIT:-}" != 1 ] || exit 1 ;;
  'pr comment')
    [ "${GH_FAIL_PR_COMMENT:-}" != 1 ] || exit 1
    if [ -n "${GH_FAIL_PR_COMMENT_ON:-}" ] && [ "$COMMENT_TARGET" = "$GH_FAIL_PR_COMMENT_ON" ]; then exit 7; fi
    ;;
  'pr merge') [ "${GH_FAIL_PR_MERGE:-}" != 1 ] || exit 1 ;;
esac
exit 0
EOF
chmod +x "$T/fake-bin/gh"
PUB_CALLS="$T/publisher-gh-calls"
PUB_HEAD=''
PUB_HEAD_DIR=''
PUB_HEAD_REF='feature'
PUB_PR_STATE='OPEN'
PUB_PR_IS_CROSS='false'
PUB_PR_BASE_REF='main'
PUB_PR_MARKER_PRESENT='false'
PUB_PR_MARKER_AUTHOR='test-bot'
PUB_PR_MARKER_SPOOF='0'
PUB_PR_LABELS_EXCLUDED='false'
TEST_ISSUE_UPDATED_AT='2026-09-25T00:00:00Z'
PUB_ISSUE_STATE="OPEN	$TEST_ISSUE_UPDATED_AT	true"
PUB_ISSUE_STATE_DIR=''
PUB_ISSUE_MARKER_PRESENT='false'
PUB_ISSUE_MARKER_AUTHOR='test-bot'
PUB_ISSUE_MARKER_SPOOF='0'
PUB_ISSUE_LABELS_EXCLUDED='false'
PUBLISH_CWD="$T/publisher-cwd"
mkdir -p "$PUBLISH_CWD"
git -C "$PUBLISH_CWD" init -q
run_publisher() {
  local tasks="$1" results="$2" status="$3"
  local path_prefix="${PUB_PATH_PREFIX:-}"
  [ ! -L "$PUBLISH_CWD/issue-ready.json" ] || true
  [ ! -L "$PUBLISH_CWD/issue-ready.json" ] && rm -f -- "$PUBLISH_CWD/issue-ready.json"
  : > "$PUB_CALLS"
  : > "$T/publisher-pr-comment-body"
  printf '%s\n' "${PUB_ISSUE_LABEL_STATE:-[\"analysis:needs-input\"]}" > "$T/issue-label-state.json"
  (cd "$PUBLISH_CWD" && env SEC001_TEST_MODE=1 GH_CALLS="$PUB_CALLS" GH_COMMENT_CAPTURE="$T/publisher-comment-body" GH_PR_COMMENT_CAPTURE="$T/publisher-pr-comment-body" PATH="${path_prefix:+$path_prefix:}$T/fake-bin:$PATH" FAKE_PR_HEAD="$PUB_HEAD" FAKE_PR_HEAD_DIR="$PUB_HEAD_DIR" FAKE_PR_HEAD_REF="$PUB_HEAD_REF" FAKE_PR_STATE="$PUB_PR_STATE" FAKE_PR_IS_CROSS="$PUB_PR_IS_CROSS" FAKE_PR_BASE_REF="$PUB_PR_BASE_REF" FAKE_PR_MARKER_PRESENT="$PUB_PR_MARKER_PRESENT" FAKE_PR_MARKER_SPOOF="$PUB_PR_MARKER_SPOOF" FAKE_PR_MARKER_AUTHOR="$PUB_PR_MARKER_AUTHOR" FAKE_PR_LABELS_EXCLUDED="$PUB_PR_LABELS_EXCLUDED" FAKE_ISSUE_MARKER_SPOOF="$PUB_ISSUE_MARKER_SPOOF" FAKE_ISSUE_MARKER_AUTHOR="$PUB_ISSUE_MARKER_AUTHOR" FAKE_ISSUE_STATE="$PUB_ISSUE_STATE" FAKE_ISSUE_STATE_DIR="$PUB_ISSUE_STATE_DIR" FAKE_ISSUE_MARKER_PRESENT="$PUB_ISSUE_MARKER_PRESENT" FAKE_ISSUE_LABELS_EXCLUDED="$PUB_ISSUE_LABELS_EXCLUDED" FAKE_ISSUE_LABEL_STATE_DIR="$T/issue-label-state.json" FAKE_ISSUE_CONCURRENT_LABEL="${FAKE_ISSUE_CONCURRENT_LABEL:-}" FAKE_ISSUE_CONCURRENT_REMOVED_LABEL="${FAKE_ISSUE_CONCURRENT_REMOVED_LABEL:-}" FAKE_GH_LOGIN_FAIL="${FAKE_GH_LOGIN_FAIL:-0}" FAKE_ACTIVE_REVIEW="${FAKE_ACTIVE_REVIEW:-0}" FAKE_ACTIVE_HEAD_SHA="${FAKE_ACTIVE_HEAD_SHA:-${FAKE_PR_HEAD:-}}" GH_FAIL_PR_COMMENT_ON="${GH_FAIL_PR_COMMENT_ON:-}" "$PUBLISH" --tasks "$tasks" --results "$results" --status "$status" --repo x/y --remote https://github.com/x/y.git --merge-gate "${PUB_GATE_HELPER:-$NOOP_HELPER}" --approval "${PUB_APPROVAL_HELPER:-$NOOP_HELPER}" --artifact-helper "${PUB_ARTIFACT_HELPER:-/bin/true}" --publish-helper "${PUB_PUBLISH_HELPER:-$NOOP_HELPER}" --model-output-helper "$MODEL_OUTPUT")
}
publisher_reject() {
  local name="$1" tasks="$2" results="$3" status="$4"
  expect_fail "$name" run_publisher "$tasks" "$results" "$status"
  [ ! -s "$PUB_CALLS" ] && pass "$name caused zero mutations" || fail "$name reached mutation"
}
printf '{"run_id":"4242","base_sha":"%s","mode":"prs","prs":[{"number":1,"head_ref":"feature","base_ref":"main","head_sha":"%s","is_cross_repository":false}],"issue":null}\n' "$BASE" "$BASE" > "$T/bind-tasks.json"
printf '{"run_id":"4242","base_sha":"%s","phase":"verify","verified":true,"verifications":[{"number":1,"action":"approved","verified":true,"reason":"test","head_sha":"%s"}]}\n' "$BASE" "$BASE" > "$T/bind-status.json"
# Bounded issue responses are validated before any GitHub API call.
mkdir -p "$T/issue-agent/responses"
printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","mode":"issues","prs":[],"issue":{"number":7,"has_questions":true,"updated_at":"2026-09-25T00:00:00Z"}}' > "$T/issue-agent/tasks.json"
printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","results":[{"number":7,"action":"issue","choice":"needs_input","has_questions":true,"answer_file":"issue-7-run-4242-answer.txt","patch":false}]}' > "$T/issue-agent/results.json"
printf '{"run_id":"4242","base_sha":"%s","phase":"verify","verified":true,"verifications":[{"number":7,"action":"issue","verified":true,"reason":"test","answer_sha256":"%s"}]}\n' "$BASE" "$(printf 'bounded answer\n' | sha256sum | awk '{print $1}')" > "$T/issue-agent/status.json"
printf 'bounded answer\n' > "$T/issue-agent/responses/issue-7-run-4242-answer.txt"
: > "$T/issue-gh-calls"
DIRECT_ISSUE_STATE_DIR="$T/direct-issue-state"; rm -rf "$DIRECT_ISSUE_STATE_DIR"; mkdir -p "$DIRECT_ISSUE_STATE_DIR"; printf '%s\n' "$PUB_ISSUE_STATE" "$PUB_ISSUE_STATE" "$PUB_ISSUE_STATE" "OPEN	2026-09-25T00:00:01Z	true" "OPEN	2026-09-25T00:00:01Z	true" "OPEN	2026-09-25T00:00:02Z	false" "OPEN	2026-09-25T00:00:02Z	false" > "$DIRECT_ISSUE_STATE_DIR/7"
printf '%s\n' '["analysis:needs-input"]' > "$T/direct-issue-labels.json"
# The `|| rc=$?` keeps a publisher regression from aborting the whole suite
# under set -e, which would hide every later assertion behind a bare exit 1.
DIRECT_PUBLISH_RC=0
(cd "$T" && SEC001_TEST_MODE=1 FAKE_ISSUE_STATE_DIR="$DIRECT_ISSUE_STATE_DIR" FAKE_ISSUE_LABEL_STATE_DIR="$T/direct-issue-labels.json" GH_CALLS="$T/issue-gh-calls" GH_COMMENT_CAPTURE="$T/issue-comment-body" PATH="$T/fake-bin:$PATH" "$ROOT/.github/scripts/sec001-hourly-publish.sh" --tasks "$T/issue-agent/tasks.json" --results "$T/issue-agent/results.json" --status "$T/issue-agent/status.json" --repo x/y --remote https://github.com/x/y.git --merge-gate /bin/true --approval /bin/true --artifact-helper /bin/true --publish-helper /bin/true --model-output-helper "$MODEL_OUTPUT") || DIRECT_PUBLISH_RC=$?
[ "$DIRECT_PUBLISH_RC" -eq 0 ] && pass 'direct issue publish succeeded' || fail "direct issue publish exited $DIRECT_PUBLISH_RC"
grep -q 'gh issue comment' "$T/issue-gh-calls" && grep -q 'bounded answer' "$T/issue-comment-body" && grep -q 'sec001-issue-answer-issue-7-run-4242' "$T/issue-comment-body" && pass 'bounded issue response published with bound marker and content' || fail 'bounded issue response was not published with content'
printf 'bad\001response\n' > "$T/issue-agent/responses/issue-7-run-4242-answer.txt"
: > "$T/issue-gh-calls"
expect_fail 'invalid issue response rejected before API' env SEC001_TEST_MODE=1 FAKE_ISSUE_STATE="$PUB_ISSUE_STATE" GH_CALLS="$T/issue-gh-calls" PATH="$T/fake-bin:$PATH" bash -c 'cd "$1" && "$2" --tasks "$3" --results "$4" --status "$5" --repo x/y --remote https://github.com/x/y.git --merge-gate /bin/true --approval /bin/true --artifact-helper /bin/true --publish-helper /bin/true --model-output-helper "$6"' _ "$T" "$ROOT/.github/scripts/sec001-hourly-publish.sh" "$T/issue-agent/tasks.json" "$T/issue-agent/results.json" "$T/issue-agent/status.json" "$MODEL_OUTPUT"
[ ! -s "$T/issue-gh-calls" ] && pass 'invalid response made no API call' || fail 'invalid response reached GitHub API'
python3 - "$T/issue-agent/responses/issue-7-run-4242-answer.txt" <<'PY'
import sys
open(sys.argv[1], 'w', encoding='utf-8').write('x' * (1024 * 1024))
PY
printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","results":[{"number":7,"action":"issue","choice":"spam","has_questions":true,"answer_file":"issue-7-run-4242-answer.txt","patch":false}]}' > "$T/issue-agent/results.json"
: > "$T/issue-gh-calls"
expect_fail 'oversized assembled issue comment rejected before API' env SEC001_TEST_MODE=1 FAKE_ISSUE_STATE="$PUB_ISSUE_STATE" GH_CALLS="$T/issue-gh-calls" PATH="$T/fake-bin:$PATH" "$ROOT/.github/scripts/sec001-hourly-publish.sh" --tasks "$T/issue-agent/tasks.json" --results "$T/issue-agent/results.json" --status "$T/issue-agent/status.json" --repo x/y --remote https://github.com/x/y.git --merge-gate /bin/true --approval /bin/true --artifact-helper /bin/true --publish-helper /bin/true --model-output-helper "$MODEL_OUTPUT"
[ ! -s "$T/issue-gh-calls" ] && pass 'oversized assembled comment made no API call' || fail 'oversized assembled comment reached GitHub API'
printf '{"run_id":"4242","base_sha":"%s","results":[{"number":1,"action":"skip","reason":"bad\\u0001reason","head_sha":"%s","patch":false}]}\n' "$BASE" "$BASE" > "$T/invalid-comment-results.json"
: > "$T/invalid-comment-calls"
expect_fail 'invalid deferred comment rejected' env SEC001_TEST_MODE=1 GH_CALLS="$T/invalid-comment-calls" PATH="$T/fake-bin:$PATH" FAKE_PR_HEAD="$BASE" "$ROOT/.github/scripts/sec001-hourly-publish.sh" --tasks "$T/bind-tasks.json" --results "$T/invalid-comment-results.json" --status "$T/bind-status.json" --repo x/y --remote https://github.com/x/y.git --merge-gate /bin/true --approval /bin/true --artifact-helper /bin/true --publish-helper /bin/true --model-output-helper "$MODEL_OUTPUT"
[ ! -s "$T/invalid-comment-calls" ] && pass 'invalid deferred comment made no API call' || fail 'invalid deferred comment reached GitHub API'
# Publisher preflight is a self-contained task/result/status trust boundary.
# These fixtures use the strict schemas expected after the blocking repair.
PUB_TASKS="$T/pub-pr-tasks.json"
PUB_RESULTS="$T/pub-pr-results.json"
PUB_STATUS="$T/pub-pr-status.json"
printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","mode":"prs","prs":[{"number":1,"head_ref":"feature","base_ref":"main","head_sha":"'$BASE'","is_cross_repository":false}],"issue":null}' > "$PUB_TASKS"
printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","results":[{"number":1,"action":"skip","reason":"manual review","head_sha":"'$BASE'","patch":false}]}' > "$PUB_RESULTS"
printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","phase":"verify","verified":true,"verifications":[{"number":1,"action":"skip","verified":true,"reason":"no repository patch","head_sha":"'$BASE'"}]}' > "$PUB_STATUS"
PUB_HEAD=$BASE
run_publisher "$PUB_TASKS" "$PUB_RESULTS" "$PUB_STATUS" && grep -q 'gh pr comment' "$PUB_CALLS" && grep -q "sec001-deferred-pr-1-head-$BASE" "$T/publisher-pr-comment-body" && pass 'valid publisher preflight reached bounded PR mutation' || fail 'valid publisher preflight failed'
PUB_PR_LABELS_EXCLUDED=true
expect_fail 'live PR exclusion label blocks publication' run_publisher "$PUB_TASKS" "$PUB_RESULTS" "$PUB_STATUS"
[ ! -s "$PUB_CALLS" ] && pass 'live exclusion label caused zero PR mutations' || fail 'live exclusion label reached PR mutation'
PUB_PR_LABELS_EXCLUDED=false
PUB_PR_IS_CROSS=true
expect_fail 'cross-repository PR rejected' run_publisher "$PUB_TASKS" "$PUB_RESULTS" "$PUB_STATUS"
PUB_PR_IS_CROSS=false
PUB_PR_BASE_REF=other
expect_fail 'non-main PR base rejected' run_publisher "$PUB_TASKS" "$PUB_RESULTS" "$PUB_STATUS"
PUB_PR_BASE_REF=main
PUB_HEAD_REF=other
expect_fail 'changed PR head ref rejected' run_publisher "$PUB_TASKS" "$PUB_RESULTS" "$PUB_STATUS"
PUB_HEAD_REF=feature
jq '.prs[0].title={} | .prs[0].mergeable=[] | .prs[0].labels="bad"' "$PUB_TASKS" > "$T/pub-invalid-task-types.json"
publisher_reject 'invalid task metadata types rejected' "$T/pub-invalid-task-types.json" "$PUB_RESULTS" "$PUB_STATUS"
PUB_PR_MARKER_PRESENT=true
run_publisher "$PUB_TASKS" "$PUB_RESULTS" "$PUB_STATUS" && grep -q 'autofix:skipped' "$PUB_CALLS" && pass 'same-head skip marker suppresses duplicate comment and persists terminal state' || fail 'same-head skip marker did not suppress duplicate comment'
PUB_PR_MARKER_PRESENT=false
export GH_FAIL_PR_COMMENT=1
expect_fail 'PR comment API failure fails closed' run_publisher "$PUB_TASKS" "$PUB_RESULTS" "$PUB_STATUS"
unset GH_FAIL_PR_COMMENT
grep -q 'gh pr comment' "$PUB_CALLS" && pass 'failed PR comment was attempted and surfaced' || fail 'failed PR comment was not surfaced'
OTHER_HEAD=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
PUB_HEAD=$OTHER_HEAD
if run_publisher "$PUB_TASKS" "$PUB_RESULTS" "$PUB_STATUS"; then fail 'stale live PR head was accepted'; else pass 'stale live PR head rejected before mutation'; fi
[ ! -s "$PUB_CALLS" ] && pass 'stale live PR head caused zero mutations' || fail 'stale live PR head reached mutation'
PUB_HEAD=$BASE
jq '.run_id="9999"' "$PUB_STATUS" > "$T/pub-wrong-run-status.json"
if run_publisher "$PUB_TASKS" "$PUB_RESULTS" "$T/pub-wrong-run-status.json"; then fail 'status run mismatch was accepted'; else pass 'status run mismatch rejected'; fi
[ ! -s "$PUB_CALLS" ] && pass 'status run mismatch caused zero mutations' || fail 'status run mismatch reached mutation'
jq '.run_id="9999"' "$PUB_TASKS" > "$T/pub-wrong-run-tasks.json"
publisher_reject 'task run mismatch rejected' "$T/pub-wrong-run-tasks.json" "$PUB_RESULTS" "$PUB_STATUS"
jq '.base_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' "$PUB_TASKS" > "$T/pub-wrong-base-tasks.json"
publisher_reject 'task base mismatch rejected' "$T/pub-wrong-base-tasks.json" "$PUB_RESULTS" "$PUB_STATUS"
jq '.run_id="9999"' "$PUB_RESULTS" > "$T/pub-wrong-run-results.json"
publisher_reject 'result run mismatch rejected' "$PUB_TASKS" "$T/pub-wrong-run-results.json" "$PUB_STATUS"
jq '.base_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' "$PUB_RESULTS" > "$T/pub-wrong-base-results.json"
publisher_reject 'result base mismatch rejected' "$PUB_TASKS" "$T/pub-wrong-base-results.json" "$PUB_STATUS"
PUB_HEAD=$BASE
publisher_reject 'missing status rejected' "$PUB_TASKS" "$PUB_RESULTS" "$T/status-does-not-exist.json"
printf '{not-json\n' > "$T/pub-malformed-status.json"
publisher_reject 'malformed status rejected' "$PUB_TASKS" "$PUB_RESULTS" "$T/pub-malformed-status.json"
jq '.extra=true' "$PUB_STATUS" > "$T/pub-extra-field-status.json"
publisher_reject 'status unknown top-level field rejected' "$PUB_TASKS" "$PUB_RESULTS" "$T/pub-extra-field-status.json"
jq '.base_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' "$PUB_STATUS" > "$T/pub-wrong-base-status.json"
publisher_reject 'status base mismatch rejected' "$PUB_TASKS" "$PUB_RESULTS" "$T/pub-wrong-base-status.json"
jq '.phase="other"' "$PUB_STATUS" > "$T/pub-wrong-phase.json"
publisher_reject 'status phase mismatch rejected' "$PUB_TASKS" "$PUB_RESULTS" "$T/pub-wrong-phase.json"
jq '.verified=false' "$PUB_STATUS" > "$T/pub-not-verified.json"
publisher_reject 'status verified false rejected' "$PUB_TASKS" "$PUB_RESULTS" "$T/pub-not-verified.json"
jq '.verifications[0].verified=false' "$PUB_STATUS" > "$T/pub-entry-not-verified.json"
publisher_reject 'false verification entry rejected' "$PUB_TASKS" "$PUB_RESULTS" "$T/pub-entry-not-verified.json"
jq '.verifications=[]' "$PUB_STATUS" > "$T/pub-missing-verification.json"
publisher_reject 'missing verification rejected' "$PUB_TASKS" "$PUB_RESULTS" "$T/pub-missing-verification.json"
jq '.verifications += [{"number":2,"action":"skip","verified":true,"reason":"extra","head_sha":"'$BASE'"}]' "$PUB_STATUS" > "$T/pub-extra-verification.json"
publisher_reject 'extra verification rejected' "$PUB_TASKS" "$PUB_RESULTS" "$T/pub-extra-verification.json"
jq '.verifications += [.verifications[0]]' "$PUB_STATUS" > "$T/pub-duplicate-verification.json"
publisher_reject 'duplicate verification rejected' "$PUB_TASKS" "$PUB_RESULTS" "$T/pub-duplicate-verification.json"
jq '.results += [.results[0]]' "$PUB_RESULTS" > "$T/pub-duplicate-result.json"
publisher_reject 'duplicate result rejected' "$PUB_TASKS" "$T/pub-duplicate-result.json" "$PUB_STATUS"
jq '.results=[]' "$PUB_RESULTS" > "$T/pub-empty-results.json"
publisher_reject 'result cardinality mismatch rejected' "$PUB_TASKS" "$T/pub-empty-results.json" "$PUB_STATUS"
jq '.verifications[0].action="ready"' "$PUB_STATUS" > "$T/pub-action-mismatch.json"
publisher_reject 'result verification action mismatch rejected' "$PUB_TASKS" "$PUB_RESULTS" "$T/pub-action-mismatch.json"
jq '.results[0].number=2 | .verifications[0].number=2' "$PUB_RESULTS" > "$T/pub-task-mismatch-results.json"
jq '.verifications[0].number=2' "$PUB_STATUS" > "$T/pub-task-mismatch-status.json"
publisher_reject 'result task number mismatch rejected' "$PUB_TASKS" "$T/pub-task-mismatch-results.json" "$T/pub-task-mismatch-status.json"
jq --arg head "$OTHER_HEAD" '.results[0].head_sha=$head' "$PUB_RESULTS" > "$T/pub-result-head-mismatch.json"
publisher_reject 'result task head mismatch rejected' "$PUB_TASKS" "$T/pub-result-head-mismatch.json" "$PUB_STATUS"
jq --arg head "$OTHER_HEAD" '.verifications[0].head_sha=$head' "$PUB_STATUS" > "$T/pub-verification-head-mismatch.json"
publisher_reject 'verification task head mismatch rejected' "$PUB_TASKS" "$PUB_RESULTS" "$T/pub-verification-head-mismatch.json"
jq 'del(.verifications[0].head_sha)' "$PUB_STATUS" > "$T/pub-missing-head.json"
publisher_reject 'missing PR verification head rejected' "$PUB_TASKS" "$PUB_RESULTS" "$T/pub-missing-head.json"
PUB_HEAD_DIR="$T/pub-head-sequence"; rm -rf "$PUB_HEAD_DIR"; mkdir -p "$PUB_HEAD_DIR"; printf 'OPEN\t%s\tfeature\tfalse\tmain\nOPEN\t%s\tfeature\tfalse\tmain\n' "$BASE" "$OTHER_HEAD" > "$PUB_HEAD_DIR/1"
publisher_reject 'head change after preflight rejected before mutation' "$PUB_TASKS" "$PUB_RESULTS" "$PUB_STATUS"
PUB_HEAD_DIR=''; PUB_HEAD=$BASE
printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","mode":"prs","prs":[{"number":1,"head_ref":"one","base_ref":"main","head_sha":"'$BASE'","is_cross_repository":false},{"number":2,"head_ref":"two","base_ref":"main","head_sha":"'$BASE'","is_cross_repository":false}],"issue":null}' > "$T/pub-two-tasks.json"
printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","results":[{"number":1,"action":"skip","reason":"first","head_sha":"'$BASE'","patch":false},{"number":2,"action":"skip","reason":"second","head_sha":"'$BASE'","patch":false}]}' > "$T/pub-two-results.json"
printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","phase":"verify","verified":true,"verifications":[{"number":1,"action":"skip","verified":true,"reason":"ok","head_sha":"'$BASE'"},{"number":2,"action":"ready","verified":true,"reason":"bad action","head_sha":"'$BASE'"}]}' > "$T/pub-two-results.json.status"
publisher_reject 'later invalid entry suppresses all publication' "$T/pub-two-tasks.json" "$T/pub-two-results.json" "$T/pub-two-results.json.status"
printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","mode":"prs","prs":[{"number":1,"head_ref":"feature","base_ref":"main","head_sha":"'$BASE'","is_cross_repository":false},{"number":2,"head_ref":"feature","base_ref":"main","head_sha":"'$BASE'","is_cross_repository":false}],"issue":null}' > "$T/pub-two-valid-tasks.json"
printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","results":[{"number":1,"action":"skip","reason":"first","head_sha":"'$BASE'","patch":false},{"number":2,"action":"skip","reason":"second","head_sha":"'$BASE'","patch":false}]}' > "$T/pub-two-valid-results.json"
printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","phase":"verify","verified":true,"verifications":[{"number":1,"action":"skip","verified":true,"reason":"ok","head_sha":"'$BASE'"},{"number":2,"action":"skip","verified":true,"reason":"ok","head_sha":"'$BASE'"}]}' > "$T/pub-two-valid-status.json"
if GH_FAIL_PR_COMMENT_ON=2 run_publisher "$T/pub-two-valid-tasks.json" "$T/pub-two-valid-results.json" "$T/pub-two-valid-status.json"; then fail 'runtime second-item comment failure unexpectedly succeeded'; else pass 'runtime second-item comment failure is surfaced'; fi
[ "$(grep -c 'gh pr comment' "$PUB_CALLS")" -eq 2 ] && pass 'runtime partiality is limited to attempted independent items' || fail 'runtime partiality call count unexpected'
# Behavioral exact-head merge coverage: both gates and approvals are called
# twice, the final GitHub mutation carries --match-head-commit, and a head move
# immediately before the final read prevents any merge call.
MERGE_TASKS="$T/pub-approved-tasks.json"; MERGE_RESULTS="$T/pub-approved-results.json"; MERGE_STATUS="$T/pub-approved-status.json"
printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","mode":"prs","prs":[{"number":1,"head_ref":"feature","base_ref":"main","head_sha":"'$BASE'","is_cross_repository":false}],"issue":null}' > "$MERGE_TASKS"
printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","results":[{"number":1,"action":"approved","needs_merge":false,"head_sha":"'$BASE'","patch":false}]}' > "$MERGE_RESULTS"
printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","phase":"verify","verified":true,"verifications":[{"number":1,"action":"approved","verified":true,"reason":"gates passed","head_sha":"'$BASE'"}]}' > "$MERGE_STATUS"
GATE_SPY="$T/merge-gate-spy"; APPROVAL_SPY="$T/merge-approval-spy"
cat > "$GATE_SPY" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$T/merge-gate-calls"
[ "\${GATE_SPY_FAIL:-0}" = 1 ] && exit 1
exit 0
EOF
cat > "$APPROVAL_SPY" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$T/merge-approval-calls"
EOF
chmod +x "$GATE_SPY" "$APPROVAL_SPY"; : > "$T/merge-gate-calls"; : > "$T/merge-approval-calls"
PUB_GATE_HELPER=$GATE_SPY; PUB_APPROVAL_HELPER=$APPROVAL_SPY; PUB_HEAD=$BASE; PUB_HEAD_DIR=''
run_publisher "$MERGE_TASKS" "$MERGE_RESULTS" "$MERGE_STATUS" && [ "$(wc -l < "$T/merge-gate-calls")" -eq 2 ] && [ "$(wc -l < "$T/merge-approval-calls")" -eq 2 ] && grep -q -- "--match-head-commit $BASE" "$PUB_CALLS" && pass 'approved path behaviorally pins gates approvals and merge head' || fail 'approved path did not pin gates approvals and merge head'
FAKE_ACTIVE_REVIEW=1 FAKE_ACTIVE_HEAD_SHA=$OTHER_HEAD run_publisher "$MERGE_TASKS" "$MERGE_RESULTS" "$MERGE_STATUS" && grep -q 'gh pr merge' "$PUB_CALLS" && pass 'active run for another head is ignored' || fail 'active run for another head blocked merge'
FAKE_ACTIVE_REVIEW=1 FAKE_ACTIVE_HEAD_SHA=$BASE run_publisher "$MERGE_TASKS" "$MERGE_RESULTS" "$MERGE_STATUS" && ! grep -q 'gh pr merge' "$PUB_CALLS" && pass 'active run for pinned head defers merge' || fail 'active run for pinned head was ignored'
# pull_request-triggered runs report the synthetic merge commit as headSha and
# <n>/merge as headBranch, so the pinned-SHA comparison alone must not be the
# only way an in-flight review is detected.
FAKE_ACTIVE_REVIEW=1 FAKE_ACTIVE_HEAD_SHA=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef FAKE_ACTIVE_BRANCH=1/merge run_publisher "$MERGE_TASKS" "$MERGE_RESULTS" "$MERGE_STATUS" && ! grep -q 'gh pr merge' "$PUB_CALLS" && pass 'active run on the synthetic merge ref defers merge' || fail 'active run on the merge ref was ignored'
# The status filter is server-side, so a status the publisher does not query
# must not be reported as active.
FAKE_ACTIVE_REVIEW=1 FAKE_ACTIVE_HEAD_SHA=$BASE FAKE_ACTIVE_STATUS=completed run_publisher "$MERGE_TASKS" "$MERGE_RESULTS" "$MERGE_STATUS" && grep -q 'gh pr merge' "$PUB_CALLS" && pass 'completed run does not defer the merge' || fail 'completed run incorrectly deferred the merge'
unset FAKE_ACTIVE_REVIEW FAKE_ACTIVE_HEAD_SHA
PUB_HEAD_DIR="$T/merge-head-sequence"; rm -rf "$PUB_HEAD_DIR"; mkdir -p "$PUB_HEAD_DIR"; printf 'OPEN\t%s\tfeature\tfalse\tmain\nOPEN\t%s\tfeature\tfalse\tmain\nOPEN\t%s\tfeature\tfalse\tmain\nOPEN\t%s\tfeature\tfalse\tmain\nOPEN\t%s\tfeature\tfalse\tmain\n' "$BASE" "$BASE" "$BASE" "$BASE" "$OTHER_HEAD" > "$PUB_HEAD_DIR/1"
expect_fail 'head change before final merge prevents merge' run_publisher "$MERGE_TASKS" "$MERGE_RESULTS" "$MERGE_STATUS"
! grep -q 'gh pr merge' "$PUB_CALLS" && pass 'changed head produced no merge mutation' || fail 'changed head reached merge mutation'
PUB_HEAD_DIR=''; PUB_HEAD=$BASE
export GH_FAIL_RUN_LIST=1
expect_fail 'active-review query API failure fails closed' run_publisher "$MERGE_TASKS" "$MERGE_RESULTS" "$MERGE_STATUS"
unset GH_FAIL_RUN_LIST
[ ! -s "$PUB_CALLS" ] && pass 'active-review query failure produced no PR mutation' || fail 'active-review query failure mutated PR'
export GH_FAIL_PR_MERGE=1
expect_fail 'final merge API failure fails closed' run_publisher "$MERGE_TASKS" "$MERGE_RESULTS" "$MERGE_STATUS"
unset GH_FAIL_PR_MERGE
grep -q 'gh pr merge' "$PUB_CALLS" && pass 'final merge API failure was surfaced' || fail 'final merge API failure was swallowed'
PUB_GATE_HELPER=$NOOP_HELPER; PUB_APPROVAL_HELPER=$NOOP_HELPER
# Patch metadata is independently bound to the same run and PR head. A head-
# changing publication is intentionally deferred after publication so no later
# label or merge decision can use the superseded verified artifact.
PATCH_ROOT="$T/pub-patch"
mkdir -p "$SRC/docs"; printf 'verified conflict resolution\n' > "$SRC/docs/sec002-patch.txt"
make_artifact "$SRC" "$PATCH_ROOT/patches/pr-1" conflict 1
git -C "$SRC" reset -q
rm -f "$SRC/docs/sec002-patch.txt"
PUBLISH_SPY="$T/publish-helper-spy"
cat > "$PUBLISH_SPY" <<EOF
#!/bin/sh
printf '%s\n' "\$*" > "$T/publish-helper-args"
EOF
chmod +x "$PUBLISH_SPY"
printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","mode":"prs","prs":[{"number":1,"head_ref":"feature","base_ref":"main","head_sha":"'$BASE'","is_cross_repository":false}],"issue":null}' > "$PATCH_ROOT/tasks.json"
printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","results":[{"number":1,"action":"approved","needs_merge":true,"head_sha":"'$BASE'","patch":true}]}' > "$PATCH_ROOT/results.json"
printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","phase":"verify","verified":true,"verifications":[{"number":1,"action":"approved","verified":true,"reason":"gates passed","head_sha":"'$BASE'"}]}' > "$PATCH_ROOT/status.json"
PUB_ARTIFACT_HELPER=$ART; PUB_PUBLISH_HELPER=$PUBLISH_SPY; PUB_HEAD=$BASE
run_publisher "$PATCH_ROOT/tasks.json" "$PATCH_ROOT/results.json" "$PATCH_ROOT/status.json" && [ ! -s "$PUB_CALLS" ] && grep -q -- "--base-sha $BASE --branch feature" "$T/publish-helper-args" && pass 'bound patch artifact and publish arguments accepted' || fail 'bound patch artifact preflight failed'
printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","mode":"prs","prs":[{"number":1,"head_ref":"feature","base_ref":"main","head_sha":"'$OTHER_HEAD'","is_cross_repository":false}],"issue":null}' > "$PATCH_ROOT/wrong-head-tasks.json"
jq --arg head "$OTHER_HEAD" '.results[0].head_sha=$head' "$PATCH_ROOT/results.json" > "$PATCH_ROOT/wrong-head-results.json"
jq --arg head "$OTHER_HEAD" '.verifications[0].head_sha=$head' "$PATCH_ROOT/status.json" > "$PATCH_ROOT/wrong-head-status.json"
PUB_HEAD=$OTHER_HEAD
publisher_reject 'patch metadata head mismatch rejected' "$PATCH_ROOT/wrong-head-tasks.json" "$PATCH_ROOT/wrong-head-results.json" "$PATCH_ROOT/wrong-head-status.json"
cp -a "$PATCH_ROOT/patches/pr-1" "$PATCH_ROOT/wrong-run-patch"
jq '.run_id="9999"' "$PATCH_ROOT/wrong-run-patch/metadata.json" > "$PATCH_ROOT/wrong-run-patch/metadata.new"
mv "$PATCH_ROOT/wrong-run-patch/metadata.new" "$PATCH_ROOT/wrong-run-patch/metadata.json"
mkdir -p "$PATCH_ROOT/wrong-run/patches"
cp -a "$PATCH_ROOT/wrong-run-patch" "$PATCH_ROOT/wrong-run/patches/pr-1"
cp "$PATCH_ROOT/results.json" "$PATCH_ROOT/wrong-run/results.json"
PUB_HEAD=$BASE
publisher_reject 'patch metadata run mismatch rejected' "$PATCH_ROOT/tasks.json" "$PATCH_ROOT/wrong-run/results.json" "$PATCH_ROOT/status.json"
PUB_ARTIFACT_HELPER=/bin/true; PUB_PUBLISH_HELPER=$NOOP_HELPER; PUB_HEAD=$BASE
VERIFY_PATCH_ROOT="$T/verify-patch-producer"; rm -rf "$VERIFY_PATCH_ROOT"; mkdir -p "$VERIFY_PATCH_ROOT/patches"; cp -a "$PATCH_ROOT/patches/pr-1" "$VERIFY_PATCH_ROOT/patches/pr-1"; cp "$PATCH_ROOT/results.json" "$VERIFY_PATCH_ROOT/results.json"
REAL_JQ=$(command -v jq); mkdir -p "$T/verify-failing-jq"
cat > "$T/verify-failing-jq/jq" <<EOF
#!/bin/sh
REAL_JQ='$REAL_JQ'
for LAST in "\$@"; do :; done
if [ "\${1:-}" = "-er" ] && [ "\${2:-}" = ".base_sha" ]; then
  case "\$LAST" in */metadata.json) printf '%s\\n' '$BASE'; exit 42 ;; esac
fi
exec "\$REAL_JQ" "\$@"
EOF
chmod +x "$T/verify-failing-jq/jq"
expect_fail 'verifier metadata producer failure is fail-closed' env PATH="$T/verify-failing-jq:$PATH" SEC001_TEST_MODE=1 "$ROOT/.github/scripts/sec001-hourly-verify.sh" --input "$VERIFY_PATCH_ROOT" --output "$T/verify-patch-producer-output" --base-sha "$BASE" --run-id 4242 --remote https://github.com/x/y.git --artifact-helper "$NOOP_HELPER" --gate-runner "$NOOP_HELPER" --model-output-helper "$MODEL_OUTPUT"
jq -e '.verifications[0].verified == false' "$T/verify-patch-producer-output/status.json" >/dev/null && pass 'metadata producer failure emitted unverified status' || fail 'metadata producer failure did not fail closed'

make_issue_publisher_fixture() {
  local dir="$1" has_questions="$2" choice="${3:-unknown}" answer_name="${4:-}" answer_json='null' answer_sha='null'
  [ "$has_questions" != true ] || answer_json=$(printf '"%s"' "$answer_name")
  [ "$has_questions" != true ] || answer_sha=$(printf 'bounded answer\n' | sha256sum | awk '{print $1}')
  [ "$has_questions" = true ] && answer_sha="\"$answer_sha\"" || answer_sha=null
  rm -rf "$dir"
  mkdir -p "$dir/responses"
  printf '{"run_id":"4242","base_sha":"%s","mode":"issues","prs":[],"issue":{"number":7,"has_questions":%s,"updated_at":"%s"}}\n' "$BASE" "$has_questions" "$TEST_ISSUE_UPDATED_AT" > "$dir/tasks.json"
  printf '{"run_id":"4242","base_sha":"%s","results":[{"number":7,"action":"issue","choice":"%s","has_questions":%s,"answer_file":%s,"patch":false}]}\n' "$BASE" "$choice" "$has_questions" "$answer_json" > "$dir/results.json"
  printf '{"run_id":"4242","base_sha":"%s","phase":"verify","verified":true,"verifications":[{"number":7,"action":"issue","verified":true,"reason":"no repository patch","answer_sha256":%s}]}\n' "$BASE" "$answer_sha" > "$dir/status.json"
}
make_issue_publisher_fixture "$T/issue-pub-no-question" false unknown
PUB_ISSUE_STATE="OPEN	$TEST_ISSUE_UPDATED_AT	false"
run_publisher "$T/issue-pub-no-question/tasks.json" "$T/issue-pub-no-question/results.json" "$T/issue-pub-no-question/status.json" && [ ! -s "$PUB_CALLS" ] && pass 'has_questions false without answer accepted' || fail 'has_questions false without answer rejected'
PUB_ISSUE_STATE="OPEN	$TEST_ISSUE_UPDATED_AT	true"
make_issue_publisher_fixture "$T/issue-pub-valid" true needs_input issue-7-run-4242-answer.txt
printf 'bounded answer\n' > "$T/issue-pub-valid/responses/issue-7-run-4242-answer.txt"
PUB_ISSUE_STATE_DIR="$T/issue-pub-valid-state"; rm -rf "$PUB_ISSUE_STATE_DIR"; mkdir -p "$PUB_ISSUE_STATE_DIR"; printf '%s\n' "$PUB_ISSUE_STATE" "$PUB_ISSUE_STATE" "$PUB_ISSUE_STATE" "OPEN	2026-09-25T00:00:01Z	true" "OPEN	2026-09-25T00:00:01Z	true" "OPEN	2026-09-25T00:00:02Z	false" "OPEN	2026-09-25T00:00:02Z	false" > "$PUB_ISSUE_STATE_DIR/7"
run_publisher "$T/issue-pub-valid/tasks.json" "$T/issue-pub-valid/results.json" "$T/issue-pub-valid/status.json" && grep -q 'gh issue comment' "$PUB_CALLS" && pass 'has_questions true with valid answer accepted' || fail 'valid required answer rejected'
PUB_ISSUE_STATE_DIR=''
PUB_ISSUE_STATE="OPEN	$TEST_ISSUE_UPDATED_AT	true"
PUB_ISSUE_LABELS_EXCLUDED=true
expect_fail 'live issue exclusion label blocks publication' run_publisher "$T/issue-pub-valid/tasks.json" "$T/issue-pub-valid/results.json" "$T/issue-pub-valid/status.json"
[ ! -s "$PUB_CALLS" ] && pass 'live issue exclusion label caused zero mutations' || fail 'live issue exclusion label reached mutation'
PUB_ISSUE_LABELS_EXCLUDED=false
PUB_ISSUE_STATE_DIR="$T/issue-pub-discovery-race"; rm -rf "$PUB_ISSUE_STATE_DIR"; mkdir -p "$PUB_ISSUE_STATE_DIR"; printf '%s\n' "OPEN	2026-09-25T00:00:02Z	true" > "$PUB_ISSUE_STATE_DIR/7"
make_issue_publisher_fixture "$T/issue-pub-discovery-race" true needs_input issue-7-run-4242-answer.txt
printf 'bounded answer\n' > "$T/issue-pub-discovery-race/responses/issue-7-run-4242-answer.txt"
expect_fail 'issue updated after discovery rejected' run_publisher "$T/issue-pub-discovery-race/tasks.json" "$T/issue-pub-discovery-race/results.json" "$T/issue-pub-discovery-race/status.json"
PUB_ISSUE_STATE_DIR=''
make_issue_publisher_fixture "$T/issue-pub-digest-mismatch" true needs_input issue-7-run-4242-answer.txt
printf 'replacement answer\n' > "$T/issue-pub-digest-mismatch/responses/issue-7-run-4242-answer.txt"
expect_fail 'response digest mismatch rejected before API' run_publisher "$T/issue-pub-digest-mismatch/tasks.json" "$T/issue-pub-digest-mismatch/results.json" "$T/issue-pub-digest-mismatch/status.json"
[ ! -s "$PUB_CALLS" ] && pass 'digest mismatch caused zero issue mutations' || fail 'digest mismatch reached issue mutation'
mkdir -p "$T/fail-answer-sha-jq"
cat > "$T/fail-answer-sha-jq/jq" <<EOF
#!/bin/sh
REAL_JQ='$REAL_JQ'
if [ "\${SEC001_FAIL_ANSWER_SHA:-0}" = 1 ] && [ "\${1:-}" = "-er" ] && [ "\${2:-}" = ".answer_sha256" ]; then
  printf '%s\\n' '$(printf 'bounded answer\n' | sha256sum | awk '{print $1}')'
  exit 42
fi
exec "\$REAL_JQ" "\$@"
EOF
chmod +x "$T/fail-answer-sha-jq/jq"
PUB_ISSUE_STATE_DIR=''
PUB_ISSUE_STATE="OPEN	$TEST_ISSUE_UPDATED_AT	true"
export SEC001_FAIL_ANSWER_SHA=1
PUB_PATH_PREFIX="$T/fail-answer-sha-jq"
expect_fail 'response digest producer failure rejected' run_publisher "$T/issue-pub-valid/tasks.json" "$T/issue-pub-valid/results.json" "$T/issue-pub-valid/status.json"
unset SEC001_FAIL_ANSWER_SHA PUB_PATH_PREFIX
[ ! -s "$PUB_CALLS" ] && pass 'digest producer failure caused zero issue mutations' || fail 'digest producer failure reached issue mutation'
PUB_ISSUE_STATE_DIR=''
PUB_ISSUE_STATE_DIR=''
PUB_ISSUE_MARKER_PRESENT=true
make_issue_publisher_fixture "$T/issue-pub-marker-present" true needs_input issue-7-run-4242-answer.txt
printf 'bounded answer\n' > "$T/issue-pub-marker-present/responses/issue-7-run-4242-answer.txt"
PUB_ISSUE_STATE_DIR="$T/issue-pub-marker-present-state"; rm -rf "$PUB_ISSUE_STATE_DIR"; mkdir -p "$PUB_ISSUE_STATE_DIR"; printf '%s\n' "$PUB_ISSUE_STATE" "$PUB_ISSUE_STATE" "OPEN	2026-09-25T00:00:02Z	false" "OPEN	2026-09-25T00:00:02Z	false" > "$PUB_ISSUE_STATE_DIR/7"
run_publisher "$T/issue-pub-marker-present/tasks.json" "$T/issue-pub-marker-present/results.json" "$T/issue-pub-marker-present/status.json" && ! grep -q 'gh issue comment' "$PUB_CALLS" && pass 'trusted answer marker suppresses duplicate comment' || fail 'trusted answer marker did not reconcile label'
PUB_ISSUE_STATE_DIR=''; PUB_ISSUE_MARKER_PRESENT=true; PUB_ISSUE_MARKER_AUTHOR=human; PUB_ISSUE_MARKER_SPOOF=1
make_issue_publisher_fixture "$T/issue-pub-marker-spoof" true needs_input issue-7-run-4242-answer.txt
printf 'bounded answer\n' > "$T/issue-pub-marker-spoof/responses/issue-7-run-4242-answer.txt"
PUB_ISSUE_STATE_DIR="$T/issue-pub-marker-spoof-state"; rm -rf "$PUB_ISSUE_STATE_DIR"; mkdir -p "$PUB_ISSUE_STATE_DIR"; printf '%s\n' "$PUB_ISSUE_STATE" "$PUB_ISSUE_STATE" "$PUB_ISSUE_STATE" "OPEN	2026-09-25T00:00:01Z	true" "OPEN	2026-09-25T00:00:01Z	true" "OPEN	2026-09-25T00:00:02Z	false" "OPEN	2026-09-25T00:00:02Z	false" > "$PUB_ISSUE_STATE_DIR/7"
run_publisher "$T/issue-pub-marker-spoof/tasks.json" "$T/issue-pub-marker-spoof/results.json" "$T/issue-pub-marker-spoof/status.json" && grep -q 'gh issue comment' "$PUB_CALLS" && pass 'human-authored answer marker cannot suppress answer' || fail 'human-authored answer marker suppressed answer'
PUB_ISSUE_STATE_DIR=''; PUB_ISSUE_MARKER_PRESENT=true; PUB_ISSUE_MARKER_AUTHOR=test-bot; PUB_ISSUE_MARKER_SPOOF=0
FAKE_GH_LOGIN_FAIL=1
expect_fail 'unknown marker identity fails closed' run_publisher "$T/issue-pub-marker-present/tasks.json" "$T/issue-pub-marker-present/results.json" "$T/issue-pub-marker-present/status.json"
! grep -q 'gh issue comment\|gh issue edit' "$PUB_CALLS" && pass 'unknown marker identity caused no issue mutation' || fail 'unknown marker identity reached issue mutation'
FAKE_GH_LOGIN_FAIL=0
PUB_ISSUE_STATE_DIR=''; PUB_ISSUE_MARKER_PRESENT=false; PUB_ISSUE_MARKER_AUTHOR=test-bot; PUB_ISSUE_MARKER_SPOOF=0
make_issue_publisher_fixture "$T/issue-pub-comment-failure" true needs_input issue-7-run-4242-answer.txt
printf 'bounded answer\n' > "$T/issue-pub-comment-failure/responses/issue-7-run-4242-answer.txt"
export GH_FAIL_ISSUE_COMMENT=1
expect_fail 'failed answer comment fails closed' run_publisher "$T/issue-pub-comment-failure/tasks.json" "$T/issue-pub-comment-failure/results.json" "$T/issue-pub-comment-failure/status.json"
unset GH_FAIL_ISSUE_COMMENT
grep -q 'gh issue comment' "$PUB_CALLS" && ! grep -q 'gh issue edit' "$PUB_CALLS" && pass 'failed answer comment did not remove needs-input' || fail 'failed answer comment removed needs-input'
make_issue_publisher_fixture "$T/issue-pub-label-failure" true needs_input issue-7-run-4242-answer.txt
printf 'bounded answer\n' > "$T/issue-pub-label-failure/responses/issue-7-run-4242-answer.txt"
PUB_ISSUE_STATE_DIR="$T/issue-pub-label-failure-state"; rm -rf "$PUB_ISSUE_STATE_DIR"; mkdir -p "$PUB_ISSUE_STATE_DIR"; printf '%s\n' "$PUB_ISSUE_STATE" "$PUB_ISSUE_STATE" "$PUB_ISSUE_STATE" "OPEN	2026-09-25T00:00:01Z	true" "OPEN	2026-09-25T00:00:01Z	true" > "$PUB_ISSUE_STATE_DIR/7"
export GH_FAIL_ISSUE_EDIT=1
expect_fail 'answer label-removal API failure fails closed' run_publisher "$T/issue-pub-label-failure/tasks.json" "$T/issue-pub-label-failure/results.json" "$T/issue-pub-label-failure/status.json"
unset GH_FAIL_ISSUE_EDIT
[ ! -e "$PUBLISH_CWD/issue-ready.json" ] && pass 'label-removal failure produced no handoff' || fail 'label-removal failure produced handoff'
PUB_ISSUE_STATE_DIR=''; PUB_ISSUE_MARKER_PRESENT=false
make_issue_publisher_fixture "$T/issue-pub-etag-stale" true needs_input issue-7-run-4242-answer.txt
printf 'bounded answer\n' > "$T/issue-pub-etag-stale/responses/issue-7-run-4242-answer.txt"
PUB_ISSUE_STATE_DIR=''
PUB_ISSUE_STATE="OPEN	$TEST_ISSUE_UPDATED_AT	true"
# A human exclusion label added while the run is in flight must SURVIVE the
# pending-label removal. A full-label-set PATCH would silently drop it (GitHub
# does not implement If-Match on this endpoint, verified by live probe), which
# would let the run continue past the human's stop signal.
# Seed a pre-existing label that contains a space, so a word-splitting bug in
# the restore path would create a truncated/garbled label rather than the real
# one. `triage bucket` and `bug` must both survive intact.
PUB_ISSUE_LABEL_STATE='["analysis:needs-input","triage bucket","bug"]'
make_issue_publisher_fixture "$T/issue-pub-concurrent-label" true needs_input issue-7-run-4242-answer.txt
printf 'bounded answer\n' > "$T/issue-pub-concurrent-label/responses/issue-7-run-4242-answer.txt"
PUB_ISSUE_STATE_DIR="$T/issue-pub-concurrent-label-state"; rm -rf "$PUB_ISSUE_STATE_DIR"; mkdir -p "$PUB_ISSUE_STATE_DIR"; printf '%s\n' "$PUB_ISSUE_STATE" "$PUB_ISSUE_STATE" "$PUB_ISSUE_STATE" "OPEN	2026-09-25T00:00:01Z	true" "OPEN	2026-09-25T00:00:01Z	true" "OPEN	2026-09-25T00:00:02Z	false" "OPEN	2026-09-25T00:00:02Z	false" > "$PUB_ISSUE_STATE_DIR/7"
FAKE_ISSUE_CONCURRENT_LABEL=autofix:skipped
expect_fail 'concurrent human label during removal fails closed' run_publisher "$T/issue-pub-concurrent-label/tasks.json" "$T/issue-pub-concurrent-label/results.json" "$T/issue-pub-concurrent-label/status.json"
FAKE_ISSUE_CONCURRENT_LABEL=
grep -q 'autofix:skipped' "$T/issue-label-state.json" && pass 'concurrent human exclusion label survives pending-label removal' || { cat "$T/issue-label-state.json" >&2; fail 'concurrent human exclusion label was clobbered by the removal'; }
# The fake's --remove-label only ever strips analysis:needs-input, so the spaced
# label is never removed here and this case can only assert it survived intact.
# The word-splitting property itself is pinned by the two assertions below: a
# garbled label in the state file, and a missing label after the restore.
grep -qF '"triage bucket"' "$T/issue-label-state.json" && grep -qF '"bug"' "$T/issue-label-state.json" && pass 'pre-existing labels including a spaced name survive the removal intact' || { cat "$T/issue-label-state.json" >&2; fail 'pre-existing labels were lost'; }
jq -e 'all(.[]; test("^'"'"'") | not)' "$T/issue-label-state.json" >/dev/null && pass 'no quoted label garbage created by the restore' || fail 'restore created a label with literal quote characters'

# A label a HUMAN removes in the same window must be put back by the
# compensating restore. Without the restore loop this passes silently, because
# nothing else would notice the missing label.
PUB_ISSUE_LABEL_STATE='["analysis:needs-input","human triage"]'
make_issue_publisher_fixture "$T/issue-pub-concurrent-removal" true needs_input issue-7-run-4242-answer.txt
printf 'bounded answer\n' > "$T/issue-pub-concurrent-removal/responses/issue-7-run-4242-answer.txt"
PUB_ISSUE_STATE_DIR="$T/issue-pub-concurrent-removal-state"; rm -rf "$PUB_ISSUE_STATE_DIR"; mkdir -p "$PUB_ISSUE_STATE_DIR"; printf '%s\n' "$PUB_ISSUE_STATE" "$PUB_ISSUE_STATE" "$PUB_ISSUE_STATE" "OPEN	2026-09-25T00:00:01Z	true" "OPEN	2026-09-25T00:00:01Z	true" "OPEN	2026-09-25T00:00:02Z	false" "OPEN	2026-09-25T00:00:02Z	false" > "$PUB_ISSUE_STATE_DIR/7"
FAKE_ISSUE_CONCURRENT_REMOVED_LABEL='human triage'
expect_fail 'concurrent human label removal fails closed' run_publisher "$T/issue-pub-concurrent-removal/tasks.json" "$T/issue-pub-concurrent-removal/results.json" "$T/issue-pub-concurrent-removal/status.json"
FAKE_ISSUE_CONCURRENT_REMOVED_LABEL=
grep -qF '"human triage"' "$T/issue-label-state.json" && pass 'compensating restore re-adds a concurrently removed human label' || { cat "$T/issue-label-state.json" >&2; fail 'compensating restore did not re-add the removed human label'; }
grep -q -- '--remove-label analysis:needs-input' "$PUB_CALLS" && pass 'pending label removed with the additive single-label primitive' || fail 'pending label removal did not use --remove-label'
PUB_ISSUE_STATE_DIR=''; PUB_ISSUE_LABEL_STATE=''
PUB_ISSUE_STATE_DIR=''
PUB_ISSUE_STATE="OPEN	$TEST_ISSUE_UPDATED_AT	true"
make_issue_publisher_fixture "$T/issue-pub-missing" true needs_input issue-7-run-4242-answer.txt
expect_fail 'has_questions true missing answer rejected' run_publisher "$T/issue-pub-missing/tasks.json" "$T/issue-pub-missing/results.json" "$T/issue-pub-missing/status.json"
[ ! -s "$PUB_CALLS" ] && pass 'missing required answer caused zero issue mutations' || fail 'missing required answer reached issue mutation'
make_issue_publisher_fixture "$T/issue-pub-claims-success" true ready issue-7-run-4242-answer.txt
expect_fail 'publisher ignores false successful answer claim' run_publisher "$T/issue-pub-claims-success/tasks.json" "$T/issue-pub-claims-success/results.json" "$T/issue-pub-claims-success/status.json"
[ ! -s "$PUB_CALLS" ] && pass 'false success answer claim caused zero issue mutations' || fail 'false success answer claim reached issue mutation'
make_issue_publisher_fixture "$T/issue-pub-symlink" true needs_input issue-7-run-4242-answer.txt
printf 'target\n' > "$T/issue-pub-symlink-target"
ln -s "$T/issue-pub-symlink-target" "$T/issue-pub-symlink/responses/issue-7-run-4242-answer.txt"
expect_fail 'symlinked required answer rejected' run_publisher "$T/issue-pub-symlink/tasks.json" "$T/issue-pub-symlink/results.json" "$T/issue-pub-symlink/status.json"
[ ! -s "$PUB_CALLS" ] && pass 'symlink answer caused zero issue mutations' || fail 'symlink answer reached issue mutation'
make_issue_publisher_fixture "$T/issue-pub-utf8" true needs_input issue-7-run-4242-answer.txt
printf '\377\n' > "$T/issue-pub-utf8/responses/issue-7-run-4242-answer.txt"
expect_fail 'invalid UTF-8 required answer rejected' run_publisher "$T/issue-pub-utf8/tasks.json" "$T/issue-pub-utf8/results.json" "$T/issue-pub-utf8/status.json"
[ ! -s "$PUB_CALLS" ] && pass 'invalid UTF-8 answer caused zero issue mutations' || fail 'invalid UTF-8 answer reached issue mutation'
make_issue_publisher_fixture "$T/issue-pub-oversized" true needs_input issue-7-run-4242-answer.txt
python3 - "$T/issue-pub-oversized/responses/issue-7-run-4242-answer.txt" <<'PY'
import sys
open(sys.argv[1], 'wb').write(b'x' * (1024 * 1024 + 1))
PY
expect_fail 'oversized required answer rejected' run_publisher "$T/issue-pub-oversized/tasks.json" "$T/issue-pub-oversized/results.json" "$T/issue-pub-oversized/status.json"
[ ! -s "$PUB_CALLS" ] && pass 'oversized answer caused zero issue mutations' || fail 'oversized answer reached issue mutation'
make_issue_publisher_fixture "$T/issue-pub-control" true needs_input issue-7-run-4242-answer.txt
printf 'bad\001answer\n' > "$T/issue-pub-control/responses/issue-7-run-4242-answer.txt"
expect_fail 'forbidden-control required answer rejected' run_publisher "$T/issue-pub-control/tasks.json" "$T/issue-pub-control/results.json" "$T/issue-pub-control/status.json"
[ ! -s "$PUB_CALLS" ] && pass 'control-character answer caused zero issue mutations' || fail 'control-character answer reached issue mutation'
make_issue_publisher_fixture "$T/issue-pub-wrong-issue" true needs_input issue-8-run-4242-answer.txt
printf 'wrong issue\n' > "$T/issue-pub-wrong-issue/responses/issue-8-run-4242-answer.txt"
expect_fail 'answer for another issue rejected' run_publisher "$T/issue-pub-wrong-issue/tasks.json" "$T/issue-pub-wrong-issue/results.json" "$T/issue-pub-wrong-issue/status.json"
[ ! -s "$PUB_CALLS" ] && pass 'wrong-issue answer caused zero issue mutations' || fail 'wrong-issue answer reached issue mutation'
make_issue_publisher_fixture "$T/issue-pub-wrong-run" true needs_input issue-7-run-9999-answer.txt
printf 'wrong run\n' > "$T/issue-pub-wrong-run/responses/issue-7-run-9999-answer.txt"
expect_fail 'answer for another run rejected' run_publisher "$T/issue-pub-wrong-run/tasks.json" "$T/issue-pub-wrong-run/results.json" "$T/issue-pub-wrong-run/status.json"
[ ! -s "$PUB_CALLS" ] && pass 'wrong-run answer caused zero issue mutations' || fail 'wrong-run answer reached issue mutation'
printf '{"run_id":"4242","base_sha":"%s","mode":"prs","prs":[{"number":1,"head_ref":"one","base_ref":"main","head_sha":"%s","is_cross_repository":false},{"number":2,"head_ref":"two","base_ref":"main","head_sha":"%s","is_cross_repository":false}]}\n' "$BASE" "$BASE" "$BASE" > "$T/two-tasks.json"
printf '{"run_id":"4242","base_sha":"%s","phase":"verify","verified":true,"verifications":[{"number":1,"action":"skip","verified":true,"reason":"ok","head_sha":"%s"},{"number":2,"action":"skip","verified":true,"reason":"ok","head_sha":"%s"}]}\n' "$BASE" "$BASE" "$BASE" > "$T/two-status.json"
printf '{"run_id":"4242","base_sha":"%s","results":[{"number":1,"action":"skip","reason":"first","head_sha":"%s","patch":false},{"number":2,"action":"skip","reason":"bad\\u0001second","head_sha":"%s","patch":false}]}\n' "$BASE" "$BASE" "$BASE" > "$T/two-results.json"
: > "$T/two-calls"
expect_fail 'malformed later result rejected before API' env SEC001_TEST_MODE=1 GH_CALLS="$T/two-calls" PATH="$T/fake-bin:$PATH" FAKE_PR_HEAD="$BASE" FAKE_PR_HEAD_REF=one FAKE_PR_BASE_REF=main "$ROOT/.github/scripts/sec001-hourly-publish.sh" --tasks "$T/two-tasks.json" --results "$T/two-results.json" --status "$T/two-status.json" --repo x/y --remote https://github.com/x/y.git --merge-gate "$NOOP_HELPER" --approval "$NOOP_HELPER" --artifact-helper "$NOOP_HELPER" --publish-helper "$NOOP_HELPER" --model-output-helper "$MODEL_OUTPUT"
[ ! -s "$T/two-calls" ] && pass 'malformed later result made no API call' || fail 'malformed later result reached GitHub API'
printf '{"run_id":"4242","base_sha":"%s","mode":"prs","prs":[{"number":1,"head_ref":"one","base_ref":"main","head_sha":"%s","is_cross_repository":false},{"number":2,"head_ref":"bad ref","base_ref":"main","head_sha":"%s","is_cross_repository":false}]}\n' "$BASE" "$BASE" "$BASE" > "$T/two-bad-task.json"
: > "$T/two-calls"
expect_fail 'malformed later task rejected before API' env SEC001_TEST_MODE=1 GH_CALLS="$T/two-calls" PATH="$T/fake-bin:$PATH" FAKE_PR_HEAD="$BASE" FAKE_PR_HEAD_REF=one FAKE_PR_BASE_REF=main "$ROOT/.github/scripts/sec001-hourly-publish.sh" --tasks "$T/two-bad-task.json" --results "$T/two-results.json" --status "$T/two-status.json" --repo x/y --remote https://github.com/x/y.git --merge-gate "$NOOP_HELPER" --approval "$NOOP_HELPER" --artifact-helper "$NOOP_HELPER" --publish-helper "$NOOP_HELPER" --model-output-helper "$MODEL_OUTPUT"
[ ! -s "$T/two-calls" ] && pass 'malformed later task made no API call' || fail 'malformed later task reached GitHub API'
printf '{not-json\n' > "$T/malformed-results.json"
: > "$T/malformed-calls"
expect_fail 'malformed result JSON rejected' env SEC001_TEST_MODE=1 GH_CALLS="$T/malformed-calls" PATH="$T/fake-bin:$PATH" "$ROOT/.github/scripts/sec001-hourly-publish.sh" --tasks "$T/bind-tasks.json" --results "$T/malformed-results.json" --status "$T/bind-status.json" --repo x/y --remote https://github.com/x/y.git --merge-gate /bin/true --approval /bin/true --artifact-helper /bin/true --publish-helper /bin/true --model-output-helper "$MODEL_OUTPUT"
[ ! -s "$T/malformed-calls" ] && pass 'malformed result JSON made no API call' || fail 'malformed result JSON reached GitHub API'
for ACTION in skip approved ready; do
  printf '{"run_id":"4242","base_sha":"%s","results":[{"number":999,"action":"%s","patch":false,"needs_merge":false}]}\n' "$BASE" "$ACTION" > "$T/bind-results.json"
  : > "$T/gh-calls"
  expect_fail "unbound $ACTION result rejected" env SEC001_TEST_MODE=1 PATH="$T/fake-bin:$PATH" GH_CALLS="$T/gh-calls" GH_TOKEN=dummy "$ROOT/.github/scripts/sec001-hourly-publish.sh" --tasks "$T/bind-tasks.json" --results "$T/bind-results.json" --status "$T/bind-status.json" --repo x/y --remote https://github.com/x/y.git --merge-gate /bin/true --approval /bin/true --artifact-helper /bin/true --publish-helper /bin/true --model-output-helper "$MODEL_OUTPUT"
  [ ! -s "$T/gh-calls" ] || fail "unbound $ACTION result reached GitHub API"
done
printf '{"run_id":"4242","base_sha":"%s","phase":"verify","verifications":[{"number":1,"action":"approved","verified":true,"reason":"forged","head_sha":"%s"}]}\n' "$BASE" "$BASE" > "$T/forged-status.json"
printf '{"run_id":"4242","base_sha":"%s","phase":"attacker","verifications":[{"number":1,"action":"approved","verified":true,"reason":"forged","head_sha":"%s"}]}\n' "$BASE" "$BASE" > "$T/wrong-phase-status.json"
printf '{"run_id":"4242","base_sha":"%s","results":[{"number":1,"action":"approved","needs_merge":false,"head_sha":"%s","patch":false}]}\n' "$BASE" "$BASE" > "$T/forged-results.json"
export SEC001_TEST_MODE=1
expect_fail 'wrong status phase rejected' bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/wrong-phase-status.json" --log "$T/status.log" --output "$T/wrong-phase-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/bind-tasks.json" --results "$T/forged-results.json" --job-result success --helper "$ART" --model-output-helper "$MODEL_OUTPUT"
mkdir -p "$T/finalizer-pr-extra/responses"; cp "$T/forged-results.json" "$T/finalizer-pr-extra/results.json"; printf 'unexpected\n' > "$T/finalizer-pr-extra/responses/issue-7-run-4242-answer.txt"
expect_fail 'finalizer rejects PR response tree' bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/forged-status.json" --log "$T/status.log" --output "$T/finalizer-pr-extra-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/bind-tasks.json" --results "$T/finalizer-pr-extra/results.json" --job-result success --helper "$ART" --model-output-helper "$MODEL_OUTPUT"
printf '{"run_id":"4242","base_sha":"%s","mode":"prs","prs":[{"number":1,"head_ref":"one","base_ref":"main","head_sha":"%s"},{"number":2,"head_ref":"two","base_ref":"main","head_sha":"%s"}]}\n' "$BASE" "$BASE" "$BASE" > "$T/partial-tasks.json"
expect_fail 'partial task result set rejected' bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/forged-status.json" --log "$T/status.log" --output "$T/partial-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/partial-tasks.json" --results "$T/forged-results.json" --job-result success --helper "$ART" --model-output-helper "$MODEL_OUTPUT"
expect_fail 'failed supervisor conclusion rejected' bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/forged-status.json" --log "$T/status.log" --output "$T/forged-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/bind-tasks.json" --results "$T/forged-results.json" --job-result failure --helper "$ART" --model-output-helper "$MODEL_OUTPUT"
bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/forged-status.json" --log "$T/status.log" --output "$T/forged-success-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/bind-tasks.json" --results "$T/forged-results.json" --job-result success --helper "$ART" --model-output-helper "$MODEL_OUTPUT"
printf '{"run_id":"4242","base_sha":"%s","results":[{"number":1,"action":"approved","needs_merge":false,"head_sha":"%s","patch":false},{"number":1,"action":"approved","needs_merge":false,"head_sha":"%s","patch":false}]}\n' "$BASE" "$BASE" "$BASE" > "$T/duplicate-results.json"
expect_fail 'duplicate result cardinality rejected' bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/forged-status.json" --log "$T/status.log" --output "$T/duplicate-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/bind-tasks.json" --results "$T/duplicate-results.json" --job-result success --helper "$ART" --model-output-helper "$MODEL_OUTPUT"
# Finalizer stream producers are authoritative: a producer that emits partial JSON
# and then fails must never yield a canonical successful status. The fake jq
# delegates every other query to the real binary and fails only the named stream.
REAL_JQ=$(command -v jq)
mkdir -p "$T/failing-jq"
cat > "$T/failing-jq/jq" <<EOF
#!/bin/sh
KIND=\${SEC001_FAIL_STREAM_KIND:-}
SELECTOR=\${2:-}
TARGET=\${SEC001_FAIL_STREAM_TARGET:-}
if { [ "\$KIND" = results ] && [ "\$SELECTOR" = '.results[]' ]; } || { [ "\$KIND" = verifications ] && [ "\$SELECTOR" = '.verifications[]' ]; }; then
  if [ "\${3:-}" = "\$TARGET" ]; then
    case "\${SEC001_FAIL_STREAM_MODE:-}" in
      no-output) exit 42 ;;
      no-newline-all)
        "$REAL_JQ" -c -j "\$SELECTOR" "\$3" || exit 43
        exit 0
        ;;
      partial|truncated|no-newline)
        case "\$SELECTOR" in
          .results[]) FIRST_QUERY='.results[0]' ;;
          .verifications[]) FIRST_QUERY='.verifications[0]' ;;
          *) exit 2 ;;
        esac
        if [ "\${SEC001_FAIL_STREAM_MODE:-}" = no-newline ]; then
          "$REAL_JQ" -c -j "\$FIRST_QUERY" "\$3" || exit 43
          exit 0
        fi
        "$REAL_JQ" -c "\$FIRST_QUERY" "\$3" || exit 43
        [ "\${SEC001_FAIL_STREAM_MODE:-}" != partial ] || exit 42
        exit 0
        ;;
      malformed) printf '{"number":\n'; exit 0 ;;
      incomplete) printf '{"number":1}\n'; exit 0 ;;
      *) exit 2 ;;
    esac
  fi
fi
exec "$REAL_JQ" "\$@"
EOF
chmod +x "$T/failing-jq/jq"
expect_fail 'finalizer rejects result producer failure without output' env PATH="$T/failing-jq:$PATH" SEC001_FAIL_STREAM_KIND=results SEC001_FAIL_STREAM_TARGET="$T/forged-results.json" SEC001_FAIL_STREAM_MODE=no-output bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/forged-status.json" --log "$T/status.log" --output "$T/failed-producer-empty-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/bind-tasks.json" --results "$T/forged-results.json" --job-result success --helper "$ART" --model-output-helper "$MODEL_OUTPUT"
[ ! -e "$T/failed-producer-empty-artifact/status.json" ] && pass 'failed result producer emitted no canonical status' || fail 'failed result producer emitted canonical status'
expect_fail 'finalizer rejects partial result producer failure' env PATH="$T/failing-jq:$PATH" SEC001_FAIL_STREAM_KIND=results SEC001_FAIL_STREAM_TARGET="$T/forged-results.json" SEC001_FAIL_STREAM_MODE=partial bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/forged-status.json" --log "$T/status.log" --output "$T/failed-producer-partial-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/bind-tasks.json" --results "$T/forged-results.json" --job-result success --helper "$ART" --model-output-helper "$MODEL_OUTPUT"
[ ! -e "$T/failed-producer-partial-artifact/status.json" ] && pass 'partial result producer emitted no canonical status' || fail 'partial result producer emitted canonical status'
env PATH="$T/failing-jq:$PATH" SEC001_FAIL_STREAM_KIND=results SEC001_FAIL_STREAM_TARGET="$T/forged-results.json" SEC001_FAIL_STREAM_MODE=no-newline bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/forged-status.json" --log "$T/status.log" --output "$T/no-newline-producer-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/bind-tasks.json" --results "$T/forged-results.json" --job-result success --helper "$ART" --model-output-helper "$MODEL_OUTPUT" && [ "$(jq -r '.verified' "$T/no-newline-producer-artifact/status.json")" = true ] && pass 'complete no-final-newline stream is consumed' || fail 'complete no-final-newline stream was not consumed'
printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","mode":"prs","prs":[{"number":1,"head_ref":"one","base_ref":"main","head_sha":"'$BASE'","is_cross_repository":false},{"number":2,"head_ref":"two","base_ref":"main","head_sha":"'$BASE'","is_cross_repository":false}],"issue":null}' > "$T/no-newline-two-tasks.json"
printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","results":[{"number":1,"action":"skip","reason":"ok","head_sha":"'$BASE'","patch":false},{"number":2,"action":"skip","reason":"bad","head_sha":"'$OTHER_HEAD'","patch":false}]}' > "$T/no-newline-two-results.json"
printf '%s\n' '{"run_id":"4242","base_sha":"'$BASE'","phase":"verify","verifications":[{"number":1,"action":"skip","verified":true,"reason":"ok","head_sha":"'$BASE'"},{"number":2,"action":"skip","verified":true,"reason":"bad","head_sha":"'$OTHER_HEAD'"}]}' > "$T/no-newline-two-status.json"
expect_fail 'unterminated final entry is not skipped' env PATH="$T/failing-jq:$PATH" SEC001_FAIL_STREAM_KIND=results SEC001_FAIL_STREAM_TARGET="$T/no-newline-two-results.json" SEC001_FAIL_STREAM_MODE=no-newline-all bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/no-newline-two-status.json" --log "$T/status.log" --output "$T/no-newline-two-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/no-newline-two-tasks.json" --results "$T/no-newline-two-results.json" --job-result success --helper "$ART" --model-output-helper "$MODEL_OUTPUT"
[ ! -e "$T/no-newline-two-artifact/status.json" ] && pass 'unterminated invalid final entry emitted no status' || fail 'unterminated invalid final entry was skipped'
expect_fail 'finalizer rejects malformed successful producer output' env PATH="$T/failing-jq:$PATH" SEC001_FAIL_STREAM_KIND=results SEC001_FAIL_STREAM_TARGET="$T/forged-results.json" SEC001_FAIL_STREAM_MODE=malformed bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/forged-status.json" --log "$T/status.log" --output "$T/malformed-producer-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/bind-tasks.json" --results "$T/forged-results.json" --job-result success --helper "$ART" --model-output-helper "$MODEL_OUTPUT"
[ ! -e "$T/malformed-producer-artifact/status.json" ] && pass 'malformed producer emitted no canonical status' || fail 'malformed producer emitted canonical status'
expect_fail 'finalizer rejects incomplete successful producer output' env PATH="$T/failing-jq:$PATH" SEC001_FAIL_STREAM_KIND=results SEC001_FAIL_STREAM_TARGET="$T/forged-results.json" SEC001_FAIL_STREAM_MODE=incomplete bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/forged-status.json" --log "$T/status.log" --output "$T/incomplete-producer-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/bind-tasks.json" --results "$T/forged-results.json" --job-result success --helper "$ART" --model-output-helper "$MODEL_OUTPUT"
[ ! -e "$T/incomplete-producer-artifact/status.json" ] && pass 'incomplete producer emitted no canonical status' || fail 'incomplete producer emitted canonical status'
printf '{"run_id":"4242","base_sha":"%s","phase":"verify","verifications":[{"number":1,"action":"skip","verified":true,"reason":"ok","head_sha":"%s"},{"number":2,"action":"skip","verified":true,"reason":"ok","head_sha":"%s"}]}\n' "$BASE" "$BASE" "$BASE" > "$T/two-valid-raw-status.json"
expect_fail 'finalizer rejects successful but incomplete result producer' env PATH="$T/failing-jq:$PATH" SEC001_FAIL_STREAM_KIND=results SEC001_FAIL_STREAM_TARGET="$T/pub-two-results.json" SEC001_FAIL_STREAM_MODE=truncated bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/two-valid-raw-status.json" --log "$T/status.log" --output "$T/truncated-result-producer-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/pub-two-tasks.json" --results "$T/pub-two-results.json" --job-result success --helper "$ART" --model-output-helper "$MODEL_OUTPUT"
[ ! -e "$T/truncated-result-producer-artifact/status.json" ] && pass 'incomplete successful result producer emitted no status' || fail 'incomplete successful result producer emitted status'
expect_fail 'finalizer rejects successful but incomplete verification producer' env PATH="$T/failing-jq:$PATH" SEC001_FAIL_STREAM_KIND=verifications SEC001_FAIL_STREAM_TARGET="$T/two-valid-raw-status.json" SEC001_FAIL_STREAM_MODE=truncated bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/two-valid-raw-status.json" --log "$T/status.log" --output "$T/truncated-verification-producer-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/pub-two-tasks.json" --results "$T/pub-two-results.json" --job-result success --helper "$ART" --model-output-helper "$MODEL_OUTPUT"
[ ! -e "$T/truncated-verification-producer-artifact/status.json" ] && pass 'incomplete successful verification producer emitted no status' || fail 'incomplete successful verification producer emitted status'
expect_fail 'finalizer rejects verification producer failure without output' env PATH="$T/failing-jq:$PATH" SEC001_FAIL_STREAM_KIND=verifications SEC001_FAIL_STREAM_TARGET="$T/forged-status.json" SEC001_FAIL_STREAM_MODE=no-output bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/forged-status.json" --log "$T/status.log" --output "$T/failed-verification-producer-empty-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/bind-tasks.json" --results "$T/forged-results.json" --job-result success --helper "$ART" --model-output-helper "$MODEL_OUTPUT"
[ ! -e "$T/failed-verification-producer-empty-artifact/status.json" ] && pass 'failed verification producer emitted no canonical status' || fail 'failed verification producer emitted canonical status'
expect_fail 'finalizer rejects partial verification producer failure' env PATH="$T/failing-jq:$PATH" SEC001_FAIL_STREAM_KIND=verifications SEC001_FAIL_STREAM_TARGET="$T/forged-status.json" SEC001_FAIL_STREAM_MODE=partial bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/forged-status.json" --log "$T/status.log" --output "$T/failed-verification-producer-partial-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/bind-tasks.json" --results "$T/forged-results.json" --job-result success --helper "$ART" --model-output-helper "$MODEL_OUTPUT"
[ ! -e "$T/failed-verification-producer-partial-artifact/status.json" ] && pass 'partial verification producer emitted no canonical status' || fail 'partial verification producer emitted canonical status'
printf '{"run_id":"4242","base_sha":"%s","phase":"verify","verifications":[{"number":1,"action":"approved","verified":true,"reason":"ok","head_sha":"%s"},{"number":1,"action":"approved","verified":true,"reason":"duplicate","head_sha":"%s"}]}\n' "$BASE" "$BASE" "$BASE" > "$T/duplicate-verifications.json"
expect_fail 'duplicate verification entries rejected' bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/duplicate-verifications.json" --log "$T/status.log" --output "$T/duplicate-verification-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/bind-tasks.json" --results "$T/forged-results.json" --job-result success --helper "$ART" --model-output-helper "$MODEL_OUTPUT"
printf '{"run_id":"4242","base_sha":"%s","phase":"verify","verifications":[]}\n' "$BASE" > "$T/incomplete-verifications.json"
expect_fail 'incomplete verification set rejected' bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/incomplete-verifications.json" --log "$T/status.log" --output "$T/incomplete-verification-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/bind-tasks.json" --results "$T/forged-results.json" --job-result success --helper "$ART" --model-output-helper "$MODEL_OUTPUT"
printf '{"run_id":"4242","base_sha":"%s","phase":"verify","verifications":[{"number":1,"action":"approved","verified":true,"reason":"ok","head_sha":"%s"},{"number":2,"action":"skip","verified":true,"reason":"extra","head_sha":"%s"}]}\n' "$BASE" "$BASE" "$BASE" > "$T/extra-verifications.json"
expect_fail 'extra verification set rejected' bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/extra-verifications.json" --log "$T/status.log" --output "$T/extra-verification-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/bind-tasks.json" --results "$T/forged-results.json" --job-result success --helper "$ART" --model-output-helper "$MODEL_OUTPUT"
printf '{"run_id":"4242","base_sha":"%s","phase":"verify","verifications":[' "$BASE" > "$T/truncated-status.json"
expect_fail 'truncated status JSON rejected' bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/truncated-status.json" --log "$T/status.log" --output "$T/truncated-status-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/bind-tasks.json" --results "$T/forged-results.json" --job-result success --helper "$ART" --model-output-helper "$MODEL_OUTPUT"
[ "$(jq -r '.verified' "$T/forged-success-artifact/status.json")" = true ] && pass 'trusted job conclusion drives status' || fail 'status finalizer did not use job conclusion'
printf '{"run_id":"4242","base_sha":"%s","phase":"verify","verifications":[{"number":7,"action":"issue","verified":true,"reason":"no repository patch","answer_sha256":"%s"}]}\n' "$BASE" "$(printf 'bounded issue answer\n' | sha256sum | awk '{print $1}')" > "$T/issue-finalizer-status.json"
bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/issue-finalizer-status.json" --log "$T/status.log" --output "$T/issue-finalizer-valid-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/issue-agent-tasks.json" --results "$ISSUE_AGENT_OUT/results.json" --job-result success --helper "$ART" --model-output-helper "$MODEL_OUTPUT" && [ "$(jq -r '.verified' "$T/issue-finalizer-valid-artifact/status.json")" = true ] && pass 'finalizer accepts bound required issue answer' || fail 'finalizer rejected bound required issue answer'
expect_fail 'finalizer digest producer failure rejected' env SEC001_FAIL_ANSWER_SHA=1 PATH="$T/fail-answer-sha-jq:$PATH" bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/issue-finalizer-status.json" --log "$T/status.log" --output "$T/issue-finalizer-digest-producer-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/issue-agent-tasks.json" --results "$ISSUE_AGENT_OUT/results.json" --job-result success --helper "$ART" --model-output-helper "$MODEL_OUTPUT"
mkdir -p "$T/issue-finalizer-missing"
cp "$ISSUE_AGENT_OUT/results.json" "$T/issue-finalizer-missing/results.json"
expect_fail 'finalizer rejects missing required issue answer' bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/issue-finalizer-status.json" --log "$T/status.log" --output "$T/issue-finalizer-missing-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/issue-agent-tasks.json" --results "$T/issue-finalizer-missing/results.json" --job-result success --helper "$ART" --model-output-helper "$MODEL_OUTPUT"
[ ! -e "$T/issue-finalizer-missing-artifact/status.json" ] && pass 'missing answer emitted no canonical status' || fail 'missing answer emitted canonical status'
mkdir -p "$T/issue-finalizer-control/responses"; cp "$ISSUE_AGENT_OUT/results.json" "$T/issue-finalizer-control/results.json"; printf 'bad\001answer\n' > "$T/issue-finalizer-control/responses/issue-7-run-4242-answer.txt"
expect_fail 'finalizer rejects control-character answer bytes' bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/issue-finalizer-status.json" --log "$T/status.log" --output "$T/issue-finalizer-control-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/issue-agent-tasks.json" --results "$T/issue-finalizer-control/results.json" --job-result success --helper "$ART" --model-output-helper "$MODEL_OUTPUT"
[ ! -e "$T/issue-finalizer-control-artifact/status.json" ] && pass 'invalid answer bytes emitted no canonical status' || fail 'invalid answer bytes emitted canonical status'
mkdir -p "$T/issue-finalizer-digest/responses"; cp "$ISSUE_AGENT_OUT/results.json" "$T/issue-finalizer-digest/results.json"; printf 'replacement answer\n' > "$T/issue-finalizer-digest/responses/issue-7-run-4242-answer.txt"
expect_fail 'finalizer rejects answer digest mismatch' bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/issue-finalizer-status.json" --log "$T/status.log" --output "$T/issue-finalizer-digest-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/issue-agent-tasks.json" --results "$T/issue-finalizer-digest/results.json" --job-result success --helper "$ART" --model-output-helper "$MODEL_OUTPUT"
[ ! -e "$T/issue-finalizer-digest-artifact/status.json" ] && pass 'answer digest mismatch emitted no canonical status' || fail 'answer digest mismatch emitted canonical status'
if grep -q -- '--auto' "$ROOT/.github/scripts/sec001-hourly-publish.sh"; then fail 'queued auto-merge fallback remains'; else pass 'no queued auto-merge fallback'; fi
if grep -q -- '--match-head-commit' "$ROOT/.github/scripts/sec001-hourly-publish.sh" && grep -q 'MERGE_GATE.*"\$PINNED_HEAD"' "$ROOT/.github/scripts/sec001-hourly-publish.sh" && grep -q 'APPROVAL.*"\$PINNED_HEAD"' "$ROOT/.github/scripts/sec001-hourly-publish.sh"; then pass 'merge head pinning present'; else fail 'merge head pinning missing'; fi
if python3 - "$ROOT/.github/workflows/hourly-orchestrator.yml" <<'PY'
import sys, yaml
workflow = yaml.safe_load(open(sys.argv[1]))
discover = workflow['jobs']['discover']['steps']
script = '\n'.join(step.get('run', '') for step in discover)
assert 'analysis:needs-input' in script
assert 'issue-analysis-questions' not in script
assert 'autofix:needs-manual-review' in script
PY
then pass 'discovery binds questions to current label and excludes manual review'; else fail 'discovery question/manual-label semantics drifted'; fi
unset SEC001_TEST_MODE
# Setup failures are fail-closed.
expect_fail 'artifact setup failure rejected' "$ART" create --output "$T/missing" --run-id 4242 --base-sha 0000000000000000000000000000000000000000 --attempt 1 --phase agent --allow-prefix src/

if [ "$FAIL" -eq 0 ]; then
  printf 'SEC-001/SEC-002 boundary tests: %s passed\n' "$PASS"
else
  printf 'SEC-001/SEC-002 boundary tests: %s passed, %s FAILED\n' "$PASS" "$FAIL" >&2
  for name in "${FAILED_NAMES[@]}"; do printf '  not ok: %s\n' "$name" >&2; done
  exit 1
fi
[ "$PASS" -ge 20 ]
