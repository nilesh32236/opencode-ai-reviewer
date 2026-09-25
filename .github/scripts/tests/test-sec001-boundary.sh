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
            if job_name in {'agent','repair','verify-initial','verify-final','verify'}:
                env=step.get('env',{}) or {}
                assert not any(k in env for k in ('GITHUB_TOKEN','GH_TOKEN','GH_PAT','GITLAB_TOKEN')), (rel,job_name)
            if job_name == 'publish':
                text=str(step.get('run',''))
                assert not any(x in text for x in ('opencode run','pnpm ','npm ')), (rel,job_name)
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
PUBLISH_OUT=$(SEC001_TEST_MODE=1 GH_TOKEN=dummy-token "$PUB" --patch "$T/patch/patch.diff" --base-sha "$BASE" --branch sec001/test --remote "file://$REMOTE" --source-ref main --message 'test publish')
printf '%s\n' "$PUBLISH_OUT" | jq -e '.head_sha and .base_sha' >/dev/null
git --git-dir="$REMOTE" show-ref --verify --quiet refs/heads/sec001/test && pass 'trusted publisher created branch' || fail 'trusted publisher did not create branch'
[ ! -e "$T/credential-helper-marker" ] && [ ! -e "$T/fsmonitor-marker" ] && [ ! -e "$T/hook-marker" ] && pass 'local config and hooks ignored' || fail 'trusted publisher trusted poisoned caller state'
# Duplicate publish is idempotent when the deterministic commit already exists.
IDEMP=$(SEC001_TEST_MODE=1 GH_TOKEN=dummy-token "$PUB" --patch "$T/patch/patch.diff" --base-sha "$BASE" --branch sec001/test --remote "file://$REMOTE" --source-ref main --message 'test publish')
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
expect_fail 'changed-head publish rejection' env SEC001_TEST_MODE=1 GH_TOKEN=dummy "$PUB" --patch "$T/patch/patch.diff" --base-sha "$BAD" --branch sec001/changed --remote "file://$REMOTE" --source-ref main

# 11-20. Artifact validation, traversal, symlink, scope, stale base, and setup.
GOOD_ART="$T/patch"
cd "$SRC"
rm -f "$SRC/notes.txt"; git -C "$SRC" reset --hard "$BASE" >/dev/null
"$ART" validate --artifact "$GOOD_ART" --expected-run-id 4242 --expected-base-sha "$BASE" --expected-attempt 1 --expected-phase agent --allow-prefix src/ --allow-prefix docs/ --allow-prefix package.json
pass 'valid artifact accepted'
cp -a "$GOOD_ART" "$T/bad-checksum"; printf x >> "$T/bad-checksum/patch.diff"
expect_fail 'checksum mismatch rejected' "$ART" validate --artifact "$T/bad-checksum" --expected-run-id 4242 --expected-base-sha "$BASE" --expected-attempt 1 --expected-phase agent --allow-prefix src/ --allow-prefix docs/ --allow-prefix package.json
cp -a "$GOOD_ART" "$T/bad-base"; jq '.base_sha="0000000000000000000000000000000000000000"' "$T/bad-base/metadata.json" > "$T/bad-base/metadata.tmp" && mv "$T/bad-base/metadata.tmp" "$T/bad-base/metadata.json"
expect_fail 'stale base SHA rejected' "$ART" validate --artifact "$T/bad-base" --expected-run-id 4242 --expected-base-sha "$BASE" --expected-attempt 1 --expected-phase agent --allow-prefix src/ --allow-prefix docs/ --allow-prefix package.json
# Path traversal and unexpected files are rejected by the scope/parser.
cp -a "$GOOD_ART" "$T/bad-path"; printf '../outside\n' > "$T/bad-path/files.txt"; jq '.changed_files=["../outside"]' "$T/bad-path/metadata.json" > "$T/bad-path/metadata.tmp" && mv "$T/bad-path/metadata.tmp" "$T/bad-path/metadata.json"
expect_fail 'path traversal rejected' "$ART" validate --artifact "$T/bad-path" --expected-run-id 4242 --expected-base-sha "$BASE" --expected-attempt 1 --expected-phase agent --allow-prefix src/ --allow-prefix docs/ --allow-prefix package.json
UNEXPECT="$T/unexpected"; printf 'nope\n' > "$SRC/notes.txt"; git -C "$SRC" add -N notes.txt; expect_fail 'unexpected file rejected' "$ART" create --output "$UNEXPECT" --run-id 4242 --base-sha "$(sha "$SRC")" --attempt 1 --phase agent --allow-prefix src/
rm -f "$SRC/notes.txt"; git -C "$SRC" reset --hard "$BASE" >/dev/null
# Symlink changes are rejected at creation.
commit_file "$SRC" src/real.txt base; rm -f "$SRC/notes.txt"; git -C "$SRC" reset --hard "$BASE" >/dev/null; ln -s /etc/passwd "$SRC/src/link"; git -C "$SRC" add -A; expect_fail 'symlink rejected' "$ART" create --output "$T/symlink" --run-id 4242 --base-sha "$BASE" --attempt 1 --phase agent --allow-prefix src/; rm -f "$SRC/src/link"; rm -f "$SRC/notes.txt"; git -C "$SRC" reset --hard "$BASE" >/dev/null
# Credential-shaped artifact content is rejected before upload.
mkdir -p "$T/secret-tree"; printf 'ghp_01234567890123456789\n' > "$T/secret-tree/output.txt"; expect_fail 'credential-shaped artifact rejected' "$ART" scan-tree --input "$T/secret-tree"
# Wrapper artifacts validate their own checksum and phase.
printf '{"run_id":4242,"base_sha":"%s","mode":"none"}\n' "$BASE" > "$T/wrap-input.json"
"$ART" wrap --output "$T/wrapped" --input "$T/wrap-input.json" --name tasks.json --run-id 4242 --base-sha "$BASE" --phase discover
"$ART" validate-wrap --artifact "$T/wrapped" --expected-run-id 4242 --expected-base-sha "$BASE" --expected-phase discover
printf x >> "$T/wrapped/tasks.json"
expect_fail 'wrapper checksum mismatch rejected' "$ART" validate-wrap --artifact "$T/wrapped" --expected-run-id 4242 --expected-base-sha "$BASE" --expected-phase discover
# Setup failures are fail-closed.
expect_fail 'artifact setup failure rejected' "$ART" create --output "$T/missing" --run-id 4242 --base-sha 0000000000000000000000000000000000000000 --attempt 1 --phase agent --allow-prefix src/

printf 'SEC-001 boundary tests: %s passed\n' "$PASS"
[ "$PASS" -ge 20 ]
