#!/usr/bin/env bash
# Publish one already-validated SEC-001 patch from a fresh trusted clone.
# This script never reads the caller's repository config and never executes
# package scripts, OpenCode, hooks, or other repository-controlled programs.
set -euo pipefail

usage() { echo "Usage: $0 --patch FILE --base-sha SHA --branch BRANCH --remote URL [--source-ref REF] [--merge-ref REF] [--message TEXT]" >&2; exit 2; }
PATCH=''; BASE_SHA=''; BRANCH=''; REMOTE=''; SOURCE_REF='main'; MERGE_REF=''; MESSAGE='chore(security): publish isolated workflow change'
while [ "$#" -gt 0 ]; do
  case "$1" in
    --patch) PATCH="${2:-}"; shift 2 ;;
    --base-sha) BASE_SHA="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --remote) REMOTE="${2:-}"; shift 2 ;;
    --source-ref) SOURCE_REF="${2:-}"; shift 2 ;;
    --merge-ref) MERGE_REF="${2:-}"; shift 2 ;;
    --message) MESSAGE="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$BASE_SHA" ] && [ -n "$BRANCH" ] && [ -n "$REMOTE" ] || usage
if [ -n "$PATCH" ]; then
  [ -f "$PATCH" ] || { echo 'SEC-001 publish: patch is missing' >&2; exit 1; }
else
  [ -n "$MERGE_REF" ] || { echo 'SEC-001 publish: either a patch or merge ref is required' >&2; exit 1; }
fi
git check-ref-format --branch "$BRANCH" >/dev/null 2>&1 || { echo 'SEC-001 publish: invalid branch' >&2; exit 1; }
git check-ref-format --branch "$SOURCE_REF" >/dev/null 2>&1 || { echo 'SEC-001 publish: invalid source ref' >&2; exit 1; }
case "$REMOTE" in
  https://github.com/*) ;;
  file://*) [ "${SEC001_TEST_MODE:-}" = '1' ] || { echo 'SEC-001 publish: non-GitHub remotes are test-only' >&2; exit 1; } ;;
  *) echo 'SEC-001 publish: only the explicit GitHub HTTPS remote is allowed' >&2; exit 1 ;;
esac
[ -n "${GH_TOKEN:-}" ] || { echo 'SEC-001 publish: GH_TOKEN is required only for the push phase' >&2; exit 1; }

TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT
WORKTREE="$TMP_ROOT/worktree"
ASKPASS="$TMP_ROOT/askpass.sh"

# No system/global config, replacement objects, prompts, hooks, or caller Git
# state is visible to the fresh clone or the commit/push operations.
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_SYSTEM=/dev/null
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_NO_REPLACE_OBJECTS=1
export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS="$ASKPASS"
cat > "$ASKPASS" <<'EOF'
#!/bin/sh
case "$1" in
  *sername*) printf '%s\n' 'x-access-token' ;;
  *) printf '%s\n' "$GH_TOKEN" ;;
esac
EOF
chmod 700 "$ASKPASS"

git -c core.hooksPath=/dev/null -c core.fsmonitor=false clone --no-tags --depth=1 --branch "$SOURCE_REF" "$REMOTE" "$WORKTREE" >/dev/null
[ "$(git -C "$WORKTREE" rev-parse HEAD)" = "$BASE_SHA" ] || { echo 'SEC-001 publish: source head changed; refusing publish' >&2; exit 1; }
if [ -n "$MERGE_REF" ]; then
  if [ -f "$WORKTREE/.git/shallow" ]; then git -C "$WORKTREE" fetch --unshallow --no-tags origin "$MERGE_REF" >/dev/null; else git -C "$WORKTREE" fetch --no-tags origin "$MERGE_REF" >/dev/null; fi
  git -C "$WORKTREE" merge --no-commit --no-ff FETCH_HEAD >/dev/null
fi
if [ -n "$PATCH" ]; then
  git -C "$WORKTREE" apply --check --index --binary "$PATCH"
  git -C "$WORKTREE" apply --index --binary "$PATCH"
fi
if git -C "$WORKTREE" diff --cached --name-only | grep -E '(^|/)(\.git|.*\.(env|pem|key|p12|pfx|crt|cer))$' >/dev/null 2>&1; then
  echo 'SEC-001 publish: forbidden path in patch' >&2
  exit 1
fi
if git -C "$WORKTREE" diff --cached --summary | grep -E 'mode 120000' >/dev/null 2>&1; then
  echo 'SEC-001 publish: symlink changes are forbidden' >&2
  exit 1
fi
# The summary is an agent output, not part of the published change.
if [ -f "$WORKTREE/.improvement-summary.md" ]; then
  rm -f "$WORKTREE/.improvement-summary.md"
  git -C "$WORKTREE" add -u -- .improvement-summary.md
fi
git -C "$WORKTREE" diff --cached --check
COMMIT_DATE="$(git -C "$WORKTREE" show -s --format=%aI "$BASE_SHA")"
GIT_AUTHOR_DATE="$COMMIT_DATE" GIT_COMMITTER_DATE="$COMMIT_DATE" git -C "$WORKTREE" -c user.name='opencode-ai-reviewer[bot]' -c user.email='opencode-ai-reviewer[bot]@users.noreply.github.com' commit --no-verify -m "$MESSAGE" >/dev/null
HEAD_SHA=$(git -C "$WORKTREE" rev-parse HEAD)
EXISTING=$(git ls-remote "$REMOTE" "refs/heads/$BRANCH" | awk 'NR==1 {print $1}')
case "$EXISTING" in
  "$HEAD_SHA") printf '{"branch":"%s","head_sha":"%s","base_sha":"%s","idempotent":true}\n' "$BRANCH" "$HEAD_SHA" "$BASE_SHA"; exit 0 ;;
  '') LEASE="--force-with-lease=refs/heads/$BRANCH:" ;;
  "$BASE_SHA") LEASE="--force-with-lease=refs/heads/$BRANCH:$BASE_SHA" ;;
  *) echo "SEC-001 publish: branch $BRANCH moved to unexpected head ${EXISTING:-unknown}" >&2; exit 1 ;;
esac
# The URL is explicit, so a poisoned local remote/credential helper is never
# consulted. --no-verify is intentional: hooks are not an authorization path.
git -C "$WORKTREE" -c core.hooksPath=/dev/null -c core.fsmonitor=false -c credential.helper= push "$REMOTE" "HEAD:refs/heads/$BRANCH" "$LEASE" --no-verify >/dev/null
printf '{"branch":"%s","head_sha":"%s","base_sha":"%s"}\n' "$BRANCH" "$HEAD_SHA" "$BASE_SHA"
