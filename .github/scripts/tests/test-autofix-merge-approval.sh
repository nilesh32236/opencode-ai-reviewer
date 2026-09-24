#!/usr/bin/env bash
#
# test-autofix-merge-approval.sh — stubbed-`gh` regression matrix for
# .github/scripts/autofix-merge-approval.sh (DISC-001).
#
# A fake `gh` on PATH answers the exact call surface the approval script
# uses, with fixtures selected by $TEST_CASE. Each case asserts the
# script's exit code (0 = allow, 1 = deny, 2 = usage error) and that deny
# paths never merge (the script itself never merges; exit 1 + ::warning::
# is the whole deny contract).
#
# Usage:
#   bash .github/scripts/tests/test-autofix-merge-approval.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPROVAL_SCRIPT="${SCRIPT_DIR}/../autofix-merge-approval.sh"
REPO="acme/repo"

PASS=0
FAIL=0

# --- Stub `gh` -------------------------------------------------------------
# Fixture clock: head commit pushed 2026-09-24T06:00:00Z.
# Fresh approvals are stamped 2026-09-24T07:00:00Z (after the push);
# stale approvals 2026-09-24T05:00:00Z (before the push).
HEAD_DATE="2026-09-24T06:00:00Z"
FRESH_DATE="2026-09-24T07:00:00Z"
STALE_DATE="2026-09-24T05:00:00Z"

write_stub() {
  local bindir="$1"
  cat > "${bindir}/gh" << 'STUB_EOF'
#!/usr/bin/env bash
# Minimal gh stub for the approval-script matrix. Dispatches on the
# subcommand + URL witness; fixtures come from $TEST_CASE.
set -euo pipefail
HEAD_DATE="2026-09-24T06:00:00Z"
FRESH_DATE="2026-09-24T07:00:00Z"
STALE_DATE="2026-09-24T05:00:00Z"

pr_json() { # $1=labels-json $2=head-sha $3=commit-date
  printf '{"state":"%s","labels":%s,"headRefOid":"%s","commits":[{"oid":"%s","pushedDate":"%s","committedDate":"%s"}]}' \
    "${PR_STATE:-OPEN}" "$1" "$2" "$2" "$3" "$3"
}
events_json() { # $1=actor-login $2=actor-type $3=created-at (empty => no events)
  # Emulates `gh api --jq`: the script's filter reduces the events array
  # to one {login,type,created_at} object ({} when no labeling event).
  if [ -z "$3" ]; then echo '{}'; return; fi
  printf '{"login":"%s","type":"%s","created_at":"%s"}' "$1" "$2" "$3"
}

case "${TEST_CASE:-}" in
  allow)
    if [ "$1" = "pr" ]; then pr_json '[{"name":"autofix:ready"},{"name":"autofix:merge-approved"}]' "aaa111" "$HEAD_DATE"
    elif [[ "$*" == *"memberships"* ]]; then echo active
    elif [[ "$*" == *"permission"* ]]; then echo admin
    else events_json "acme" "User" "$FRESH_DATE"; fi ;;
  collaborator-allow)
    if [ "$1" = "pr" ]; then pr_json '[{"name":"autofix:merge-approved"}]' "aaa111" "$HEAD_DATE"
    elif [[ "$*" == *"memberships"* ]]; then echo "Not Found" >&2; exit 1
    elif [[ "$*" == *"permission"* ]]; then echo write
    else events_json "trusted-dev" "User" "$FRESH_DATE"; fi ;;
  missing-label)
    if [ "$1" = "pr" ]; then pr_json '[{"name":"autofix:ready"}]' "aaa111" "$HEAD_DATE"
    elif [[ "$*" == *"memberships"* ]]; then echo active
    elif [[ "$*" == *"permission"* ]]; then echo admin
    else echo '{}'; fi ;;
  forbidden-label)
    if [ "$1" = "pr" ]; then pr_json '[{"name":"autofix:merge-approved"},{"name":"autofix:approved"}]' "aaa111" "$HEAD_DATE"
    elif [[ "$*" == *"memberships"* ]]; then echo active
    elif [[ "$*" == *"permission"* ]]; then echo admin
    else events_json "acme" "User" "$FRESH_DATE"; fi ;;
  stale-head)
    if [ "$1" = "pr" ]; then pr_json '[{"name":"autofix:merge-approved"}]' "bbb222" "$HEAD_DATE"
    elif [[ "$*" == *"memberships"* ]]; then echo active
    elif [[ "$*" == *"permission"* ]]; then echo admin
    else events_json "acme" "User" "$STALE_DATE"; fi ;;
  bot-sender)
    if [ "$1" = "pr" ]; then pr_json '[{"name":"autofix:merge-approved"}]' "aaa111" "$HEAD_DATE"
    elif [[ "$*" == *"memberships"* ]]; then echo "Not Found" >&2; exit 1
    elif [[ "$*" == *"permission"* ]]; then echo admin
    else events_json "autofix-bot[bot]" "Bot" "$FRESH_DATE"; fi ;;
  weak-association)
    # Outsider: no org membership and read-only permission.
    if [ "$1" = "pr" ]; then pr_json '[{"name":"autofix:merge-approved"}]' "aaa111" "$HEAD_DATE"
    elif [[ "$*" == *"memberships"* ]]; then echo "Not Found" >&2; exit 1
    elif [[ "$*" == *"permission"* ]]; then echo read
    else events_json "random-user" "User" "$FRESH_DATE"; fi ;;
  low-permission)
    # Org member, but only read permission.
    if [ "$1" = "pr" ]; then pr_json '[{"name":"autofix:merge-approved"}]' "aaa111" "$HEAD_DATE"
    elif [[ "$*" == *"memberships"* ]]; then echo active
    elif [[ "$*" == *"permission"* ]]; then echo read
    else events_json "teammate" "User" "$FRESH_DATE"; fi ;;
  null-permission)
    # Permission lookup returns null -> fail closed even for the owner.
    if [ "$1" = "pr" ]; then pr_json '[{"name":"autofix:merge-approved"}]' "aaa111" "$HEAD_DATE"
    elif [[ "$*" == *"memberships"* ]]; then echo active
    elif [[ "$*" == *"permission"* ]]; then echo ""
    else events_json "acme" "User" "$FRESH_DATE"; fi ;;
  null-head)
    # Unresolvable head SHA -> fail closed.
    if [ "$1" = "pr" ]; then printf '{"state":"OPEN","labels":[{"name":"autofix:merge-approved"}],"headRefOid":null,"commits":[]}'
    elif [[ "$*" == *"memberships"* ]]; then echo active
    elif [[ "$*" == *"permission"* ]]; then echo admin
    else events_json "acme" "User" "$FRESH_DATE"; fi ;;
  *) echo "stub gh: unknown TEST_CASE '${TEST_CASE:-}' args: $*" >&2; exit 99 ;;
esac
STUB_EOF
  chmod +x "${bindir}/gh"
}

run_case() { # $1=name $2=expected-exit [$3=extra-env...]
  local name="$1" expected="$2"
  shift 2
  local out rc
  set +e
  out="$(env TEST_CASE="$name" PATH="${STUB_BIN}:$PATH" GITHUB_REPOSITORY="$REPO" bash "$APPROVAL_SCRIPT" 42 "$REPO" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" = "$expected" ]; then
    PASS=$((PASS + 1))
    echo "ok   $name (exit $rc)"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL $name: expected exit $expected, got $rc"
    printf '%s\n' "$out" | sed 's/^/       /'
  fi
}

STUB_BIN="$(mktemp -d)"
trap 'rm -rf "$STUB_BIN"' EXIT
write_stub "$STUB_BIN"

# Matrix: allow; missing label; forbidden label; stale head; bot sender;
# weak association; low permission; null permission fail-closed;
# null head fail-closed; collaborator allow.
run_case allow 0
run_case collaborator-allow 0
run_case missing-label 1
run_case forbidden-label 1
run_case stale-head 1
run_case bot-sender 1
run_case weak-association 1
run_case low-permission 1
run_case null-permission 1
run_case null-head 1

# Usage errors (exit 2, real gh not needed beyond PATH presence).
set +e
bash "$APPROVAL_SCRIPT" >/dev/null 2>&1
USAGE_RC=$?
env -u GITHUB_REPOSITORY PATH="${STUB_BIN}:$PATH" bash "$APPROVAL_SCRIPT" 42 >/dev/null 2>&1
NOREPO_RC=$?
set -e
if [ "$USAGE_RC" = "2" ]; then PASS=$((PASS + 1)); echo "ok   usage-no-args (exit 2)"; else FAIL=$((FAIL + 1)); echo "FAIL usage-no-args: expected 2, got $USAGE_RC"; fi
if [ "$NOREPO_RC" = "2" ]; then PASS=$((PASS + 1)); echo "ok   usage-no-repo (exit 2)"; else FAIL=$((FAIL + 1)); echo "FAIL usage-no-repo: expected 2, got $NOREPO_RC"; fi

echo "---"
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
