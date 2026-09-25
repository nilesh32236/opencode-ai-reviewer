#!/usr/bin/env bash
#
# Regression matrix for .github/scripts/run-isolated.sh and the two workflows
# that execute repository-controlled verification commands.
#
# Usage:
#   bash .github/scripts/tests/test-workflow-secret-isolation.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ISOLATED="$REPO_ROOT/.github/scripts/run-isolated.sh"
TRUSTED_GIT="$REPO_ROOT/.github/scripts/trusted-git.sh"
HOURLY="$REPO_ROOT/.github/workflows/hourly-orchestrator.yml"
SELF_IMPROVEMENT="$REPO_ROOT/.github/workflows/self-improvement.yml"

PASS=0
FAIL=0

pass() {
  PASS=$((PASS + 1))
  echo "ok   $1"
}

fail() {
  FAIL=$((FAIL + 1))
  echo "FAIL $1"
  shift
  for line in "$@"; do
    echo "       $line"
  done
}

assert_absent() {
  local name="$1" output="$2"
  if printf '%s\n' "$output" | grep -Fq "$name="; then
    fail "secret absent: $name" "child environment contained $name"
  else
    pass "secret absent: $name"
  fi
}

assert_present() {
  local name="$1" output="$2"
  if printf '%s\n' "$output" | grep -Fq "$name="; then
    pass "safe variable present: $name"
  else
    fail "safe variable present: $name" "child environment did not contain $name"
  fi
}

# The parent deliberately contains every credential family. The helper must
# construct a new environment rather than merely reject the call.
CHILD_ENV="$({
  env \
    GITHUB_TOKEN=ghp_parent_secret \
    GH_TOKEN=gh_parent_secret \
    GIT_ASKPASS=/tmp/parent-askpass \
    OPENCODE_API_KEY=opencode_parent_secret \
    OPENAI_API_KEY=openai_parent_secret \
    ANTHROPIC_API_KEY=anthropic_parent_secret \
    GEMINI_API_KEY=gemini_parent_secret \
    NPM_CONFIG__AUTH=registry_parent_secret \
    NPM_CONFIG_HTTPS_PROXY=https://user:password@proxy.invalid \
    NPM_CONFIG_REGISTRY=https://user:password@registry.invalid \
    NPM_CONFIG_USERCONFIG=/tmp/parent-npmrc \
    NPM_CONFIG_CACHE=/tmp/pnpm-cache \
    CI=true \
    "$ISOLATED" bash -c 'env'
} 2>&1)"

for name in GITHUB_TOKEN GH_TOKEN GIT_ASKPASS OPENCODE_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY NPM_CONFIG__AUTH NPM_CONFIG_HTTPS_PROXY NPM_CONFIG_REGISTRY NPM_CONFIG_USERCONFIG; do
  assert_absent "$name" "$CHILD_ENV"
done
assert_present CI "$CHILD_ENV"
assert_present NPM_CONFIG_CACHE "$CHILD_ENV"
assert_present GIT_CONFIG_NOSYSTEM "$CHILD_ENV"
assert_present GIT_CONFIG_GLOBAL "$CHILD_ENV"
assert_present GIT_CONFIG_SYSTEM "$CHILD_ENV"
assert_present GIT_TERMINAL_PROMPT "$CHILD_ENV"

if printf '%s\n' "$CHILD_ENV" | grep -Eq '^HOME=/tmp/opencode-isolated\.[A-Za-z0-9]+$'; then
  pass "fresh isolated HOME"
else
  fail "fresh isolated HOME" "HOME was not replaced with the isolated temp directory"
fi

# Command failures must propagate; the helper must not turn a failed check into
# a success or hide the exit status.
set +e
env "$ISOLATED" bash -c 'exit 7' >/dev/null 2>&1
COMMAND_RC=$?
env "$ISOLATED" >/dev/null 2>&1
USAGE_RC=$?
env -i PATH= /bin/bash "$ISOLATED" bash -c 'env' >/dev/null 2>&1
EMPTY_PATH_RC=$?
set -e
if [ "$COMMAND_RC" -eq 7 ]; then
  pass "command exit propagation"
else
  fail "command exit propagation" "expected 7, got $COMMAND_RC"
fi
if [ "$USAGE_RC" -eq 2 ]; then
  pass "missing command fails closed"
else
  fail "missing command fails closed" "expected 2, got $USAGE_RC"
fi
if [ "$EMPTY_PATH_RC" -eq 2 ]; then
  pass "missing PATH fails closed"
else
  fail "missing PATH fails closed" "expected 2, got $EMPTY_PATH_RC"
fi

# Exercise the trusted git boundary against a local bare remote. A branch-owned
# pre-push hook must not run even though the operation has a GH_TOKEN present.
TRUSTED_TMP="$(mktemp -d /tmp/trusted-git-test.XXXXXX)"
trap 'rm -rf "$TRUSTED_TMP"' EXIT
mkdir -p "$TRUSTED_TMP/remote.git" "$TRUSTED_TMP/work/.git/hooks"
git init --bare -q "$TRUSTED_TMP/remote.git"
git init -q "$TRUSTED_TMP/work"
git -C "$TRUSTED_TMP/work" config user.name test
git -C "$TRUSTED_TMP/work" config user.email test@example.com
printf '%s\n' 'hook-ran' > "$TRUSTED_TMP/work/payload.txt"
git -C "$TRUSTED_TMP/work" add payload.txt
git -C "$TRUSTED_TMP/work" commit -q -m initial
cat > "$TRUSTED_TMP/work/.git/hooks/pre-push" <<'HOOK_EOF'
#!/usr/bin/env sh
touch "$(dirname "$0")/hook-ran"
exit 1
HOOK_EOF
chmod +x "$TRUSTED_TMP/work/.git/hooks/pre-push"
git -C "$TRUSTED_TMP/work" remote add origin "$TRUSTED_TMP/remote.git"
set +e
GH_TOKEN=test-token "$TRUSTED_GIT" -C "$TRUSTED_TMP/work" push --no-verify origin HEAD:refs/heads/main >/dev/null 2>&1
TRUSTED_PUSH_RC=$?
set -e
if [ "$TRUSTED_PUSH_RC" -eq 0 ] && [ ! -e "$TRUSTED_TMP/work/.git/hooks/hook-ran" ]; then
  pass "trusted git push disables repository hooks"
else
  fail "trusted git push disables repository hooks" "push rc=$TRUSTED_PUSH_RC hook=$([ -e "$TRUSTED_TMP/work/.git/hooks/hook-ran" ] && echo ran || echo absent)"
fi
set +e
"$TRUSTED_GIT" status >/dev/null 2>&1
TRUSTED_NO_TOKEN_RC=$?
set -e
if [ "$TRUSTED_NO_TOKEN_RC" -eq 2 ]; then
  pass "trusted git requires explicit token"
else
  fail "trusted git requires explicit token" "expected 2, got $TRUSTED_NO_TOKEN_RC"
fi

# The workflows must opt out of persisted checkout credentials and route their
# verification commands through the helper. These are deliberately textual
# checks so the regression does not depend on a YAML package being installed.
for workflow in "$HOURLY" "$SELF_IMPROVEMENT"; do
  name="$(basename "$workflow")"
  if grep -Fq 'persist-credentials: false' "$workflow"; then
    pass "$name disables persisted checkout credentials"
  else
    fail "$name disables persisted checkout credentials" "missing persist-credentials: false"
  fi
  if grep -Fq 'isolated pnpm build' "$workflow"; then
    pass "$name isolates pnpm build"
  else
    fail "$name isolates pnpm build" "missing isolated pnpm build"
  fi
  if grep -Fq 'isolated pnpm test' "$workflow"; then
    pass "$name isolates pnpm test"
  else
    fail "$name isolates pnpm test" "missing isolated pnpm test"
  fi
  if grep -Fq 'GITHUB_SHA:.github/scripts/trusted-git.sh' "$workflow" && \
     grep -Fq 'GITHUB_SHA:.github/scripts/run-isolated.sh' "$workflow" && \
     grep -Fq 'merge-base --is-ancestor' "$workflow" && \
     grep -Fq 'set -o pipefail' "$workflow"; then
    pass "$name sources trusted helpers from immutable event SHA"
  else
    fail "$name sources trusted helpers from immutable event SHA" "missing immutable helper pipeline"
  fi
  if grep -Fq 'core.hooksPath=/dev/null' "$workflow"; then
    pass "$name disables repository hooks"
  else
    fail "$name disables repository hooks" "missing core.hooksPath=/dev/null"
  fi
done

echo "---"
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
