#!/usr/bin/env bash
# GitHub-token-only hourly publisher. It consumes only validated metadata,
# calls the existing main-branch merge gates, and never runs model or package
# commands. Conflict-resolution patches are held for manual review rather than
# being merged from an unverifiable synthetic merge.
set -euo pipefail

TASKS=''; RESULTS=''; STATUS=''; REPO=''; REMOTE=''; MERGE_GATE=''; APPROVAL=''; ARTIFACT_HELPER=''; PUBLISH_HELPER=''
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
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$TASKS" ] && [ -n "$RESULTS" ] && [ -n "$STATUS" ] && [ -n "$REPO" ] && [ -n "$REMOTE" ] && [ -n "$MERGE_GATE" ] && [ -n "$APPROVAL" ] && [ -n "$ARTIFACT_HELPER" ] && [ -n "$PUBLISH_HELPER" ] || { echo 'missing hourly publish arguments' >&2; exit 2; }
[ -f "$TASKS" ] && [ -f "$RESULTS" ] && [ -f "$STATUS" ] || { echo 'hourly publish input is missing' >&2; exit 1; }
export GIT_NO_REPLACE_OBJECTS=1 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 BASH_ENV=/dev/null

ISSUE_READY_FILE="$PWD/issue-ready.json"
ISSUE_READY_JSON='[]'
RESPONSES_DIR="$(dirname "$RESULTS")/responses"
while IFS= read -r result; do
  [ -n "$result" ] || continue
  number=$(jq -r '.number' <<<"$result")
  case "$number" in ''|*[!0-9]*) echo 'invalid PR/issue number in agent result' >&2; exit 1 ;; esac
  action=$(jq -r '.action' <<<"$result")
  task=$(jq -c --argjson number "$number" '.prs[] | select(.number == $number)' "$TASKS")
  if [ "$action" = 'issue' ]; then
    choice=$(jq -r '.choice' <<<"$result")
    if [ -f "$RESPONSES_DIR/issue-$number-answer.txt" ]; then
      gh issue comment "$number" --repo "$REPO" --body "🤖 **AI Answer to Pending Questions:**\n\n$(cat "$RESPONSES_DIR/issue-$number-answer.txt")" || true
      gh issue edit "$number" --repo "$REPO" --remove-label analysis:needs-input 2>/dev/null || true
    fi
    if [ "$choice" = spam ]; then gh issue edit "$number" --repo "$REPO" --add-label autofix:skipped || true; fi
    if [ "$choice" = ready ]; then ISSUE_READY_JSON=$(jq -c --argjson n "$number" '. + [{number:$n}]' <<<"$ISSUE_READY_JSON"); fi
    continue
  fi
  if [ "$action" = skip ]; then
    gh pr edit "$number" --repo "$REPO" --add-label autofix:skipped || true
    gh pr comment "$number" --repo "$REPO" --body "ℹ️ Hourly orchestration deferred this PR to manual review: $(jq -r '.reason // "no high-confidence result"' <<<"$result")" || true
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
    bash "$ARTIFACT_HELPER" validate --artifact "$PATCH_DIR" --expected-run-id "$(jq -r '.run_id' "$TASKS")" --expected-base-sha "$head_sha" --expected-attempt 1 --expected-phase conflict --allow-prefix lib/ --allow-prefix action/ --allow-prefix app/ --allow-prefix cli/ --allow-prefix platform/ --allow-prefix docs/ --allow-prefix tests/ --allow-prefix package.json --allow-prefix pnpm-lock.yaml
    bash "$PUBLISH_HELPER" --patch "$PATCH_DIR/patch.diff" --base-sha "$head_sha" --branch "$head_ref" --remote "$REMOTE" --source-ref "$head_ref" --message "fix: publish isolated conflict resolution for PR #$number"
  elif [ "$needs_merge" = true ]; then
    bash "$PUBLISH_HELPER" --base-sha "$head_sha" --branch "$head_ref" --remote "$REMOTE" --source-ref "$head_ref" --merge-ref main --message "chore: merge main into PR #$number [autofix]"
  fi
  if [ "$action" = approved ]; then gh pr edit "$number" --repo "$REPO" --add-label autofix:ready || true; fi
  if gh run list --workflow ai-review.yml --repo "$REPO" --branch "$head_ref" --limit 1 --json status --jq '.[].status' 2>/dev/null | grep -Eq '^(in_progress|queued)$'; then
    echo "Merge deferred for PR #$number: autofix review loop is still active"
    continue
  fi
  if ! GATE_ATTEMPTS=20 GATE_SLEEP=60 bash "$MERGE_GATE" "$number" "$REPO"; then echo "Merge deferred for PR #$number: green-check gate denied"; continue; fi
  if ! bash "$APPROVAL" "$number" "$REPO"; then echo "Merge deferred for PR #$number: human approval missing"; continue; fi
  gh pr merge "$number" --repo "$REPO" --squash --delete-branch 2>/dev/null || gh pr merge "$number" --repo "$REPO" --squash --delete-branch --auto || echo "Merge failed for PR #$number"
done < <(jq -c '.results[]' "$RESULTS")
printf '%s\n' "$ISSUE_READY_JSON" > "$ISSUE_READY_FILE"
chmod 0644 "$ISSUE_READY_FILE"
