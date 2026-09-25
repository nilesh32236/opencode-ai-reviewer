#!/usr/bin/env bash
# GitHub-token-only hourly publisher. It consumes only validated metadata,
# calls the existing main-branch merge gates, and never runs model or package
# commands. Conflict-resolution patches are held for manual review rather than
# being merged from an unverifiable synthetic merge.
set -euo pipefail

TASKS=''; RESULTS=''; STATUS=''; REPO=''; REMOTE=''; MERGE_GATE=''; APPROVAL=''; ARTIFACT_HELPER=''; PUBLISH_HELPER=''; MODEL_OUTPUT_HELPER=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tasks) TASKS="${2:-}"; shift 2 ;;
    --results) RESULTS="${2:-}"; shift 2 ;;
    --status) STATUS="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --remote) REMOTE="${2:-}"; shift 2 ;;
    --merge-gate) MERGE_GATE="${2:-}"; shift 2 ;;
    --approval) APPROVAL="${2:-}"; shift 2 ;;
    --artifact-helper) ARTIFACT_HELPER="${2:-}"; shift 2 ;;
    --publish-helper) PUBLISH_HELPER="${2:-}"; shift 2 ;;
    --model-output-helper) MODEL_OUTPUT_HELPER="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$TASKS" ] && [ -n "$RESULTS" ] && [ -n "$STATUS" ] && [ -n "$REPO" ] && [ -n "$REMOTE" ] && [ -n "$MERGE_GATE" ] && [ -n "$APPROVAL" ] && [ -n "$ARTIFACT_HELPER" ] && [ -n "$PUBLISH_HELPER" ] && [ -n "$MODEL_OUTPUT_HELPER" ] || { echo 'missing hourly publish arguments' >&2; exit 2; }
[ "$REMOTE" = "https://github.com/$REPO.git" ] || { echo 'hourly remote is not bound to the trusted repository' >&2; exit 2; }
[ -x "$MODEL_OUTPUT_HELPER" ] || { echo 'model output helper is missing or not executable' >&2; exit 1; }
if [ "${SEC001_TEST_MODE:-}" != 1 ]; then
  [ "$(/usr/bin/stat -c '%u:%a' "$MODEL_OUTPUT_HELPER")" = '0:555' ] || { echo 'model output helper is not root-owned 0555' >&2; exit 1; }
fi
run_model_output() {
  /usr/bin/env -i BASH_ENV=/dev/null PATH=/usr/local/bin:/usr/bin:/bin /bin/bash --noprofile --norc "$MODEL_OUTPUT_HELPER" "$@"
}
[ -f "$TASKS" ] && [ -f "$RESULTS" ] && [ -f "$STATUS" ] || { echo 'hourly publish input is missing' >&2; exit 1; }
[ "$(jq -r '.verified' "$STATUS")" = true ] || { echo 'canonical verification status is not true' >&2; exit 1; }
export GIT_NO_REPLACE_OBJECTS=1 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 BASH_ENV=/dev/null
umask 077
TMP_ROOT=$(mktemp -d)
trap 'rm -rf -- "$TMP_ROOT"' EXIT INT TERM

ISSUE_READY_FILE="$PWD/issue-ready.json"
ISSUE_READY_JSON='[]'
RESPONSES_DIR="$(dirname "$RESULTS")/responses"
[ ! -L "$RESPONSES_DIR" ] || { echo 'agent response directory is a symlink' >&2; exit 1; }
MODE=$(jq -r '.mode' "$TASKS")
case "$MODE" in prs|issues) ;; *) echo 'invalid task mode' >&2; exit 1 ;; esac
[ "$(jq '.prs // [] | length' "$TASKS")" -le 100 ] && [ "$(jq '.results | length' "$RESULTS")" -le 100 ] && [ "$(jq '.verifications | length' "$STATUS")" -le 100 ] || { echo 'hourly result/status count exceeds limit' >&2; exit 1; }
if [ -d "$RESPONSES_DIR" ]; then
  while IFS= read -r response; do
    [ -f "$response" ] && [ ! -L "$response" ] || { echo 'response tree contains a non-regular or symlinked file' >&2; exit 1; }
    response_name=$(basename "$response")
    [[ "$response_name" =~ ^issue-[0-9]+-answer\.txt$ ]] || { echo 'unexpected response filename' >&2; exit 1; }
    response_number=${response_name#issue-}; response_number=${response_number%-answer.txt}
    if [ "$MODE" = issues ]; then [ "$response_number" = "$(jq -r '.issue.number' "$TASKS")" ] || { echo 'response is not bound to discovered issue' >&2; exit 1; }
    else jq -e --argjson n "$response_number" '.prs[] | select(.number == $n)' "$TASKS" >/dev/null || { echo 'response is not bound to a discovered PR' >&2; exit 1; }; fi
    run_model_output text "$response" >/dev/null || { echo 'response text failed bounded validation' >&2; exit 1; }
  done < <(find "$RESPONSES_DIR" -mindepth 1 -maxdepth 1 -print)
fi
if [ "$MODE" = issues ]; then
  [ "$(jq '.results | length' "$RESULTS")" -eq 1 ] || { echo 'issue mode must contain exactly one result' >&2; exit 1; }
else
  EXPECTED_NUMBERS=$(jq -c '[.prs[].number] | sort' "$TASKS")
  ACTUAL_NUMBERS=$(jq -c '[.results[].number] | sort' "$RESULTS")
  [ "$EXPECTED_NUMBERS" = "$ACTUAL_NUMBERS" ] || { echo 'PR result cardinality/numbers do not match tasks' >&2; exit 1; }
fi
RESULTS_STREAM=$(mktemp "$TMP_ROOT/results.XXXXXX")
jq -ce '.results[]' "$RESULTS" > "$RESULTS_STREAM"
while IFS= read -r result; do
  [ -n "$result" ] || continue
  jq -e 'type == "object" and (.number | type == "number" and . >= 1 and . == floor) and (.action | type == "string") and (.patch // false | type == "boolean") and (.needs_merge // false | type == "boolean")' <<<"$result" >/dev/null || { echo 'malformed agent result' >&2; exit 1; }
  number=$(jq -r '.number' <<<"$result")
  action=$(jq -r '.action' <<<"$result")
  if [ "$MODE" = issues ]; then
    [ "$action" = issue ] || { echo 'PR result received for issue task mode' >&2; exit 1; }
    choice=$(jq -r '.choice // empty' <<<"$result")
    case "$choice" in ready|needs_input|spam|unknown) ;; *) echo 'invalid issue triage choice' >&2; exit 1 ;; esac
  else
    case "$action" in skip|approved|ready) ;; *) echo 'invalid PR result action' >&2; exit 1 ;; esac
  fi
  if [ "$action" = skip ]; then
    PREFLIGHT_FILE=$(mktemp "$TMP_ROOT/preflight.XXXXXX")
    printf 'ℹ️ Hourly orchestration deferred this PR to manual review: ' > "$PREFLIGHT_FILE"
    jq -r '.reason // "no high-confidence result"' <<<"$result" >> "$PREFLIGHT_FILE"
    run_model_output text "$PREFLIGHT_FILE" >/dev/null || { echo 'deferred PR comment failed bounded validation' >&2; exit 1; }
  fi
done < "$RESULTS_STREAM"
while IFS= read -r result; do
  [ -n "$result" ] || continue
  number=$(jq -r '.number' <<<"$result")
  case "$number" in ''|*[!0-9]*) echo 'invalid PR/issue number in agent result' >&2; exit 1 ;; esac
  action=$(jq -r '.action' <<<"$result")
  if [ "$MODE" = issues ]; then
    [ "$action" = issue ] || { echo 'PR result received for issue task mode' >&2; exit 1; }
    ISSUE_NUMBER=$(jq -r '.issue.number // empty' "$TASKS")
    [ "$ISSUE_NUMBER" = "$number" ] || { echo 'issue result is not bound to the discovered issue' >&2; exit 1; }
    task=''
  else
    [ "$action" != issue ] || { echo 'issue result received for PR task mode' >&2; exit 1; }
    task=$(jq -c --argjson number "$number" '.prs[] | select(.number == $number)' "$TASKS")
    [ -n "$task" ] || { echo "agent result references unknown PR #$number" >&2; exit 1; }
  fi
  if [ "$action" = 'issue' ]; then
    choice=$(jq -r '.choice' <<<"$result")
    case "$choice" in ready|needs_input|spam|unknown) ;; *) echo 'invalid issue triage choice' >&2; exit 1 ;; esac
    RESPONSE_FILE="$RESPONSES_DIR/issue-$number-answer.txt"
    if [ -e "$RESPONSE_FILE" ] || [ -L "$RESPONSE_FILE" ]; then
      [ -f "$RESPONSE_FILE" ] && [ ! -L "$RESPONSE_FILE" ] || { echo 'issue response path is missing, symlinked, or unsafe' >&2; exit 1; }
    fi
    if [ -f "$RESPONSE_FILE" ] && [ ! -L "$RESPONSE_FILE" ]; then
      if validated_response=$(run_model_output text "$RESPONSE_FILE" 2>/dev/null); then
        COMMENT_FILE="$TMP_ROOT/issue-$number-comment.md"
        {
          printf '%s\n\n' '🤖 **AI Answer to Pending Questions:**'
          printf '%s\n' "$validated_response"
        } > "$COMMENT_FILE"
        run_model_output text "$COMMENT_FILE" >/dev/null || { echo 'issue comment text failed bounded validation' >&2; exit 1; }
        gh issue comment "$number" --repo "$REPO" --body-file "$COMMENT_FILE" || true
        gh issue edit "$number" --repo "$REPO" --remove-label analysis:needs-input 2>/dev/null || true
      fi
    fi
    if [ "$choice" = spam ]; then gh issue edit "$number" --repo "$REPO" --add-label autofix:skipped || true; fi
    if [ "$choice" = ready ]; then ISSUE_READY_JSON=$(jq -c --argjson n "$number" '. + [{number:$n}]' <<<"$ISSUE_READY_JSON"); fi
    continue
  fi
  if [ "$action" = skip ]; then
    COMMENT_FILE="$TMP_ROOT/pr-$number-comment.md"
    printf 'ℹ️ Hourly orchestration deferred this PR to manual review: ' > "$COMMENT_FILE"
    jq -r '.reason // "no high-confidence result"' <<<"$result" >> "$COMMENT_FILE"
    run_model_output text "$COMMENT_FILE" >/dev/null || { echo 'deferred PR comment failed bounded validation' >&2; exit 1; }
    gh pr edit "$number" --repo "$REPO" --add-label autofix:skipped || true
    gh pr comment "$number" --repo "$REPO" --body-file "$COMMENT_FILE" || true
    continue
  fi
  [ "$action" = approved ] || [ "$action" = ready ] || continue
  verified=$(jq -r --argjson number "$number" '.verifications[] | select(.number == $number) | .verified' "$STATUS")
  [ "$verified" = true ] || { gh pr edit "$number" --repo "$REPO" --add-label autofix:needs-manual-review || true; continue; }
  needs_merge=$(jq -r '.needs_merge // false' <<<"$result")
  patch=$(jq -r '.patch // false' <<<"$result")
  head_ref=$(jq -r '.head_ref' <<<"$task")
  head_sha=$(jq -r '.head_sha' <<<"$task")
  git check-ref-format --branch "$head_ref" >/dev/null 2>&1 || { echo "invalid PR head ref for #$number" >&2; exit 1; }
  [[ "$head_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid PR head SHA for #$number" >&2; exit 1; }
  if [ "$patch" = true ] && [ "$needs_merge" = true ]; then
    gh pr edit "$number" --repo "$REPO" --add-label autofix:needs-manual-review || true
    gh pr comment "$number" --repo "$REPO" --body '⚠️ Conflict resolution was isolated and verified, but automatic publication is held for manual review because the trusted publisher will not synthesize a merge from an untrusted patch.' || true
    continue
  fi
  if [ "$patch" = true ]; then
    PATCH_DIR="$(dirname "$RESULTS")/patches/pr-$number"
    bash "$ARTIFACT_HELPER" validate --artifact "$PATCH_DIR" --expected-run-id "$(jq -r '.run_id' "$TASKS")" --expected-base-sha "$head_sha" --expected-attempt 1 --expected-phase conflict --allow-prefix lib/ --allow-prefix action/ --allow-prefix app/ --allow-prefix cli/ --allow-prefix platform/ --allow-prefix docs/ --allow-prefix tests/
    bash "$PUBLISH_HELPER" --patch "$PATCH_DIR/patch.diff" --base-sha "$head_sha" --branch "$head_ref" --remote "$REMOTE" --repo "$REPO" --source-ref "$head_ref" --message "fix: publish isolated conflict resolution for PR #$number"
  elif [ "$needs_merge" = true ]; then
    bash "$PUBLISH_HELPER" --base-sha "$head_sha" --branch "$head_ref" --remote "$REMOTE" --repo "$REPO" --source-ref "$head_ref" --merge-ref main --merge-sha "$(jq -r '.base_sha' "$TASKS")" --message "chore: merge main into PR #$number [autofix]"
  fi
  if [ "$action" = approved ]; then gh pr edit "$number" --repo "$REPO" --add-label autofix:ready || true; fi
  if gh run list --workflow ai-review.yml --repo "$REPO" --branch "$head_ref" --limit 1 --json status --jq '.[].status' 2>/dev/null | grep -Eq '^(in_progress|queued)$'; then
    echo "Merge deferred for PR #$number: autofix review loop is still active"
    continue
  fi
  PINNED_HEAD=$(gh pr view "$number" --repo "$REPO" --json headRefOid --jq .headRefOid)
  [[ "$PINNED_HEAD" =~ ^[0-9a-f]{40}$ ]] || { echo "Merge deferred for PR #$number: invalid current head" >&2; continue; }
  if ! GATE_ATTEMPTS=20 GATE_SLEEP=60 bash "$MERGE_GATE" "$number" "$REPO" "$PINNED_HEAD"; then echo "Merge deferred for PR #$number: green-check gate denied"; continue; fi
  if ! bash "$APPROVAL" "$number" "$REPO" "$PINNED_HEAD"; then echo "Merge deferred for PR #$number: human approval missing"; continue; fi
  FINAL_HEAD=$(gh pr view "$number" --repo "$REPO" --json headRefOid --jq .headRefOid)
  [ "$FINAL_HEAD" = "$PINNED_HEAD" ] || { echo "Merge deferred for PR #$number: head changed after approval" >&2; continue; }
  if ! gh pr merge "$number" --repo "$REPO" --squash --delete-branch --match-head-commit "$PINNED_HEAD" 2>/dev/null; then
    echo "Immediate merge failed for PR #$number; deferring until the next run (no queued auto-merge)." >&2
  fi
done < "$RESULTS_STREAM"
printf '%s\n' "$ISSUE_READY_JSON" > "$ISSUE_READY_FILE"
chmod 0644 "$ISSUE_READY_FILE"
