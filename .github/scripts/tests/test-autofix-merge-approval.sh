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
  printf '{"state":"%s","labels":%s,"headRefOid":"%s","headRefName":"%s","baseRefName":"%s","isCrossRepository":%s,"updatedAt":"%s","commits":[{"oid":"%s","pushedDate":"%s","committedDate":"%s"}]}' \
    "${PR_STATE:-OPEN}" "$1" "$2" "${PR_HEAD_REF_NAME-feature}" "${PR_BASE_REF_NAME:-main}" "${PR_IS_CROSS:-false}" "$3" "$2" "$3" "$3"
}
events_json() { # $1=actor-login $2=actor-type $3=created-at [$4=head-sha]
  # Emulates `gh api --jq`: the script's filter reduces the events array
  # to one event object ({} when no labeling event).
  if [ -z "$3" ]; then echo '{}'; return; fi
  printf '{"login":"%s","type":"%s","created_at":"%s","commit_id":"%s"}' "$1" "$2" "$3" "${4:-}"
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
  cross-repo)
    export PR_IS_CROSS=true
    if [ "$1" = "pr" ]; then pr_json '[{"name":"autofix:merge-approved"}]' "aaa111" "$HEAD_DATE"
    elif [[ "$*" == *"memberships"* ]]; then echo active
    elif [[ "$*" == *"permission"* ]]; then echo admin
    else events_json "acme" "User" "$FRESH_DATE"; fi ;;
  non-main-base)
    export PR_BASE_REF_NAME=other
    if [ "$1" = "pr" ]; then pr_json '[{"name":"autofix:merge-approved"}]' "aaa111" "$HEAD_DATE"
    elif [[ "$*" == *"memberships"* ]]; then echo active
    elif [[ "$*" == *"permission"* ]]; then echo admin
    else events_json "acme" "User" "$FRESH_DATE"; fi ;;
  unresolvable-head-ref)
    export PR_HEAD_REF_NAME=''
    if [ "$1" = "pr" ]; then pr_json '[{"name":"autofix:merge-approved"}]' "aaa111" "$HEAD_DATE"
    elif [[ "$*" == *"memberships"* ]]; then echo active
    elif [[ "$*" == *"permission"* ]]; then echo admin
    else events_json "acme" "User" "$FRESH_DATE"; fi ;;
  bad-head-ref)
    export PR_HEAD_REF_NAME=main
    if [ "$1" = "pr" ]; then pr_json '[{"name":"autofix:merge-approved"}]' "aaa111" "$HEAD_DATE"
    elif [[ "$*" == *"memberships"* ]]; then echo active
    elif [[ "$*" == *"permission"* ]]; then echo admin
    else events_json "acme" "User" "$FRESH_DATE"; fi ;;
  post-approval-update)
    if [ "$1" = "pr" ]; then pr_json '[{"name":"autofix:merge-approved"}]' "aaa111" "2026-09-24T06:00:00Z"
    elif [[ "$*" == *"memberships"* ]]; then echo active
    elif [[ "$*" == *"permission"* ]]; then echo admin
    else events_json "acme" "User" "$FRESH_DATE"; fi ;;
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
  manual-review)
    if [ "$1" = "pr" ]; then pr_json '[{"name":"autofix:ready"},{"name":"autofix:merge-approved"},{"name":"autofix:needs-manual-review"}]' "aaa111" "$HEAD_DATE"
    elif [[ "$*" == *"memberships"* ]]; then echo active
    elif [[ "$*" == *"permission"* ]]; then echo admin
    else events_json "acme" "User" "$FRESH_DATE"; fi ;;
  skipped)
    if [ "$1" = "pr" ]; then pr_json '[{"name":"autofix:merge-approved"},{"name":"autofix:skipped"}]' "aaa111" "$HEAD_DATE"
    elif [[ "$*" == *"memberships"* ]]; then echo active
    elif [[ "$*" == *"permission"* ]]; then echo admin
    else events_json "acme" "User" "$FRESH_DATE"; fi ;;
  completed)
    if [ "$1" = "pr" ]; then pr_json '[{"name":"autofix:merge-approved"},{"name":"autofix:completed"}]' "aaa111" "$HEAD_DATE"
    elif [[ "$*" == *"memberships"* ]]; then echo active
    elif [[ "$*" == *"permission"* ]]; then echo admin
    else events_json "acme" "User" "$FRESH_DATE"; fi ;;
  same-second)
    if [ "$1" = "pr" ]; then pr_json '[{"name":"autofix:merge-approved"}]' "aaa111" "$FRESH_DATE"
    elif [[ "$*" == *"memberships"* ]]; then echo active
    elif [[ "$*" == *"permission"* ]]; then echo admin
    else events_json "acme" "User" "$FRESH_DATE"; fi ;;
  fractional-same-second)
    if [ "$1" = "pr" ]; then pr_json '[{"name":"autofix:merge-approved"}]' "aaa111" "2026-09-24T07:00:00.900Z"
    elif [[ "$*" == *"memberships"* ]]; then echo active
    elif [[ "$*" == *"permission"* ]]; then echo admin
    else events_json "acme" "User" "$FRESH_DATE"; fi ;;
  stale-event-head)
    if [ "$1" = "pr" ]; then pr_json '[{"name":"autofix:merge-approved"}]' "bbb222" "$HEAD_DATE"
    elif [[ "$*" == *"memberships"* ]]; then echo active
    elif [[ "$*" == *"permission"* ]]; then echo admin
    else events_json "acme" "User" "$FRESH_DATE" aaa111; fi ;;
  missing-event-head)
    if [ "$1" = "pr" ]; then pr_json '[{"name":"autofix:merge-approved"}]' "aaa111" "$HEAD_DATE"
    elif [[ "$*" == *"memberships"* ]]; then echo active
    elif [[ "$*" == *"permission"* ]]; then echo admin
    else printf '{"login":"acme","type":"User","created_at":"%s","commit_id":""}\n' "$FRESH_DATE"; fi ;;
  expected-sha-mismatch)
    if [ "$1" = "pr" ]; then pr_json '[{"name":"autofix:merge-approved"}]' "aaa111" "$HEAD_DATE"
    elif [[ "$*" == *"memberships"* ]]; then echo active
    elif [[ "$*" == *"permission"* ]]; then echo admin
    else events_json "acme" "User" "$FRESH_DATE"; fi ;;
  *) echo "stub gh: unknown TEST_CASE '${TEST_CASE:-}' args: $*" >&2; exit 99 ;;
esac
STUB_EOF
  chmod +x "${bindir}/gh"
}

write_mutating_stub() {
  local bindir="$1"
  cat > "${bindir}/gh" << 'STUB_EOF'
#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="${STUB_STATE_DIR:?}"
BASE_SHA="${STUB_BASE_SHA:?}"
HEAD_DATE="2026-09-24T06:00:00Z"
FRESH_DATE="2026-09-24T07:00:00Z"
OTHER_HEAD="bbbb2222222222222222222222222222222222"
count_call() {
  local key="$1" n
  n=$(cat "$STATE_DIR/$key" 2>/dev/null || printf '0')
  n=$((n + 1))
  printf '%s' "$n" > "$STATE_DIR/$key"
  printf '%s' "$n"
}
pr_json() {
  local state="$1" labels="$2" head="$3" updated="${4:-$HEAD_DATE}"
  printf '{"state":"%s","labels":%s,"headRefOid":"%s","headRefName":"feature","baseRefName":"main","isCrossRepository":false,"updatedAt":"%s","commits":[{"oid":"%s","pushedDate":"%s","committedDate":"%s"}]}' "$state" "$labels" "$head" "$updated" "$head" "$HEAD_DATE" "$HEAD_DATE"
}
events_json() { printf '{"login":"member","type":"User","created_at":"%s","commit_id":""}' "$FRESH_DATE"; }
if [ "${1:-}" = pr ] && [ "${2:-}" = view ]; then
  n=$(count_call pr)
  case "${TEST_CASE:-}" in
    final-state-closed) if [ "$n" -ge 2 ]; then pr_json CLOSED '[{"name":"autofix:merge-approved"}]' "$BASE_SHA"; else pr_json OPEN '[{"name":"autofix:merge-approved"}]' "$BASE_SHA"; fi ;;
    final-head-changed) if [ "$n" -ge 2 ]; then pr_json OPEN '[{"name":"autofix:merge-approved"}]' "$OTHER_HEAD"; else pr_json OPEN '[{"name":"autofix:merge-approved"}]' "$BASE_SHA"; fi ;;
    final-label-removed) if [ "$n" -ge 2 ]; then pr_json OPEN '[{"name":"autofix:ready"}]' "$BASE_SHA"; else pr_json OPEN '[{"name":"autofix:merge-approved"}]' "$BASE_SHA"; fi ;;
    final-updated-changed) if [ "$n" -ge 2 ]; then pr_json OPEN '[{"name":"autofix:merge-approved"}]' "$BASE_SHA" "2026-09-24T08:00:00Z"; else pr_json OPEN '[{"name":"autofix:merge-approved"}]' "$BASE_SHA"; fi ;;
    *) pr_json OPEN '[{"name":"autofix:merge-approved"}]' "$BASE_SHA" ;;
  esac
  exit 0
fi
if [ "${1:-}" = api ]; then
  case "$*" in
    *issues/*/events*) n=$(count_call events); if [ "${TEST_CASE:-}" = final-event-removed ] && [ "$n" -ge 2 ]; then printf '{}\n'; else events_json; fi; exit 0 ;;
    *memberships*) n=$(count_call membership); if [ "${TEST_CASE:-}" = final-membership-removed ] && [ "$n" -ge 2 ]; then printf 'Not Found\n' >&2; exit 1; fi; printf 'active\n'; exit 0 ;;
    *permission*) n=$(count_call permission); if [ "${TEST_CASE:-}" = final-permission-changed ] && [ "$n" -ge 2 ]; then printf 'read\n'; else printf 'admin\n'; fi; exit 0 ;;
  esac
fi
printf 'unexpected fake gh call: %s\n' "$*" >&2
exit 99
STUB_EOF
  chmod +x "${bindir}/gh"
}

run_mutating_case() {
  local name="$1" expected="$2" state_dir
  state_dir="$(mktemp -d)"
  set +e
  out=$(env TEST_CASE="$name" STUB_STATE_DIR="$state_dir" STUB_BASE_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" PATH="${MUTATING_BIN}:$PATH" GITHUB_REPOSITORY="$REPO" bash "$APPROVAL_SCRIPT" 42 "$REPO" 2>&1)
  rc=$?
  set -e
  rm -rf "$state_dir"
  if [ "$rc" = "$expected" ]; then PASS=$((PASS + 1)); echo "ok   $name (exit $rc)"; else FAIL=$((FAIL + 1)); echo "FAIL $name: expected exit $expected, got $rc"; printf '%s\n' "$out" | sed 's/^/       /'; fi
}

run_case() { # $1=name $2=expected-exit [$3=extra-env...]
  local name="$1" expected="$2"
  shift 2
  local out rc
  local -a args=(42 "$REPO")
  [ "$name" = expected-sha-mismatch ] && args+=(0000000000000000000000000000000000000000)
  set +e
  out="$(env TEST_CASE="$name" PATH="${STUB_BIN}:$PATH" GITHUB_REPOSITORY="$REPO" bash "$APPROVAL_SCRIPT" "${args[@]}" 2>&1)"
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
MUTATING_BIN="$(mktemp -d)"
trap 'rm -rf "$STUB_BIN" "$MUTATING_BIN"' EXIT
write_stub "$STUB_BIN"
write_mutating_stub "$MUTATING_BIN"

# Matrix: allow; missing label; forbidden label; stale head; bot sender;
# weak association; low permission; null permission fail-closed;
# null head fail-closed; collaborator allow.
run_case allow 0
run_case collaborator-allow 0
run_case cross-repo 1
run_case non-main-base 1
run_case bad-head-ref 1
run_case unresolvable-head-ref 1
run_case post-approval-update 0
run_case missing-label 1
run_case forbidden-label 1
run_case stale-head 1
run_case bot-sender 1
run_case weak-association 1
run_case low-permission 1
run_case null-permission 1
run_case null-head 1
run_case expected-sha-mismatch 1
run_case manual-review 1
run_case skipped 1
run_case completed 1
run_case same-second 1
run_case fractional-same-second 1
run_case stale-event-head 1
run_case missing-event-head 0

# Final re-read races: each mutable authorization input is changed only on
# the second observation, after the initial authorization lookup.
run_mutating_case final-state-closed 1
run_mutating_case final-head-changed 1
run_mutating_case final-label-removed 1
run_mutating_case final-event-removed 1
run_mutating_case final-membership-removed 1
run_mutating_case final-permission-changed 1
run_mutating_case final-updated-changed 1

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
