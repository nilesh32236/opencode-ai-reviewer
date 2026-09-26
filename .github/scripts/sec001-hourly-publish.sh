#!/usr/bin/env bash
# GitHub-token-only hourly publisher. It consumes only validated metadata,
# calls the existing main-branch merge gates, and never runs model or package
# commands. A conflict-resolution patch is published as a commit on the PR's
# own head branch, bounded by the path policy, the artifact digest and a
# --force-with-lease push; it is never merged, and no further mutation of that
# PR follows in this run. The result loop continues with the remaining entries,
# each independently re-checked against its own pinned head.
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
require_live_pr_head() {
  local number="$1" expected_head="$2" expected_ref="$3" current=''
  local state='' current_ref='' cross_repository='' base_ref=''
  current=$(gh pr view "$number" --repo "$REPO" --json state,headRefOid,headRefName,isCrossRepository,baseRefName --jq '[.state, .headRefOid, .headRefName, .isCrossRepository, .baseRefName] | @tsv') || {
    echo "PR #$number live state could not be established" >&2
    return 1
  }
  IFS=$'\t' read -r state current current_ref cross_repository base_ref <<<"$current"
  [ "$state" = OPEN ] || { echo "PR #$number is not open" >&2; return 1; }
  [ "$base_ref" = main ] || { echo "PR #$number base branch changed" >&2; return 1; }
  [ "$cross_repository" = false ] || { echo "PR #$number head is cross-repository" >&2; return 1; }
  [ "$current_ref" = "$expected_ref" ] || { echo "PR #$number live head ref changed" >&2; return 1; }
  [[ "$current" =~ ^[0-9a-f]{40}$ ]] || { echo "PR #$number live head is invalid" >&2; return 1; }
  [ "$current" = "$expected_head" ] || { echo "PR #$number live head changed or does not match the verified artifact" >&2; return 1; }
  local excluded=''
  excluded=$(gh pr view "$number" --repo "$REPO" --json labels --jq 'any(.labels[]?; .name == "autofix:skipped" or .name == "autofix:needs-manual-review")') || {
    echo "PR #$number live exclusion labels could not be established" >&2
    return 1
  }
  [ "$excluded" = false ] || { echo "PR #$number is excluded from autonomous publication" >&2; return 1; }
}

require_live_skip_label() {
  local number="$1" expected_head="$2" expected_ref="$3" current='' state='' head='' ref='' cross='' base='' skipped=''
  current=$(gh pr view "$number" --repo "$REPO" --json state,headRefOid,headRefName,isCrossRepository,baseRefName,labels --jq '[.state, .headRefOid, .headRefName, .isCrossRepository, .baseRefName, any(.labels[]?; .name == "autofix:skipped")] | @tsv') || return 1
  IFS=$'\t' read -r state head ref cross base skipped <<<"$current"
  [ "$state" = OPEN ] && [ "$head" = "$expected_head" ] && [ "$ref" = "$expected_ref" ] && [ "$cross" = false ] && [ "$base" = main ] && [ "$skipped" = true ]
}

github_login() {
  local login=''
  if login=$(gh api user --jq .login 2>/dev/null); then
    [ -n "$login" ] || return 1
  elif login=$(gh api /app --jq .slug 2>/dev/null); then
    [ -n "$login" ] || return 1
    case "$login" in *'[bot]') ;; *) login="${login}[bot]" ;; esac
  elif [ "${MARKER_BOT_LOGIN:-}" = 'github-actions[bot]' ]; then
    login='github-actions[bot]'
  else
    return 1
  fi
  printf '%s\n' "$login"
}

pr_head_marker_exists() {
  local number="$1" head_sha="$2" marker result='' bot=''
  bot=$(github_login) || return 2
  marker="sec001-deferred-pr-$number-head-$head_sha"
  local comments=''
  comments=$(gh pr view "$number" --repo "$REPO" --json comments) || return 2
  result=$(printf '%s' "$comments" | jq -r --arg bot "$bot" --arg marker "$marker" 'any(.comments[]?; ((.author.login // "") == $bot) and ((.body // "") | startswith("<!--" + $marker + "-->")))') || return 2
  [ "$result" = true ]
}

read_live_issue_state() {
  gh issue view "$1" --repo "$REPO" --json state,updatedAt,labels --jq '[.state, .updatedAt, ([.labels[].name] | index("analysis:needs-input") != null)] | @tsv'
}

issue_content_fingerprint() {
  # Match the trusted-fix handoff fingerprint exactly: a concurrent retitle or
  # reassignment is as much a concurrent mutation as a body/comment edit.
  local number="$1" content
  content=$(gh issue view "$number" --repo "$REPO" --json title,body,comments,assignees,state) || return 1
  printf '%s' "$content" | sha256sum | awk '{print $1}'
}

issue_answer_marker_exists() {
  local number="$1" marker result='' bot=''
  bot=$(github_login) || return 2
  marker="sec001-issue-answer-issue-$number-run-$TASK_RUN_ID"
  local comments=''
  comments=$(gh issue view "$number" --repo "$REPO" --json comments) || return 2
  result=$(printf '%s' "$comments" | jq -r --arg bot "$bot" --arg marker "$marker" 'any(.comments[]?; ((.author.login // "") == $bot) and ((.body // "") | startswith("<!--" + $marker + "-->")))') || return 2
  [ "$result" = true ]
}

require_live_issue_not_excluded() {
  local number="$1" excluded=''
  excluded=$(gh issue view "$number" --repo "$REPO" --json labels --jq 'any(.labels[]?; .name == "autofix:skipped" or .name == "autofix:completed" or .name == "autofix:needs-manual-review")') || {
    echo "Issue #$number live exclusion labels could not be established" >&2
    return 1
  }
  [ "$excluded" = false ] || { echo "Issue #$number is excluded from autonomous publication" >&2; return 1; }
}

require_live_issue_state() {
  local number="$1" expected_updated="$2" expected_pending="$3" current=''
  local state='' updated_at='' pending=''
  current=$(read_live_issue_state "$number") || { echo "Issue #$number live state could not be established" >&2; return 1; }
  IFS=$'\t' read -r state updated_at pending <<<"$current"
  [ "$state" = OPEN ] || { echo "Issue #$number is not open" >&2; return 1; }
  [ "$updated_at" = "$expected_updated" ] || { echo "Issue #$number changed after discovery" >&2; return 1; }
  [ "$pending" = "$expected_pending" ] || { echo "Issue #$number question state changed after discovery" >&2; return 1; }
  require_live_issue_not_excluded "$number"
}

require_live_issue_open() {
  local number="$1" current='' state='' updated_at='' pending=''
  current=$(read_live_issue_state "$number") || { echo "Issue #$number live state could not be established" >&2; return 1; }
  IFS=$'\t' read -r state updated_at pending <<<"$current"
  [ "$state" = OPEN ] || { echo "Issue #$number is not open" >&2; return 1; }
  require_live_issue_not_excluded "$number"
}

remove_pending_label_conditionally() {
  # GitHub's REST API does not implement If-Match on PATCH /issues/{n}: a
  # deliberately wrong validator still returns 200 (verified by live probe), and
  # the ETag it returns is weak (W/"..."), which RFC 9110 forbids for If-Match.
  # A full-label-set PATCH is therefore an unconditional replace that can
  # silently drop a label a human added in the same window — including
  # autofix:skipped / autofix:completed / autofix:needs-manual-review.
  # Remove exactly the one label instead: a single-label removal can never
  # clobber a concurrent addition, which is the same additive reasoning that
  # restore_pending_label uses to put the label back.
  local number="$1" labels_before='' labels_after=''
  labels_before=$(gh api "repos/$REPO/issues/$number" --jq '[.labels[].name] | sort') || return 1
  jq -e 'index("analysis:needs-input") != null' <<<"$labels_before" >/dev/null || {
    echo "Issue #$number pending label is already absent; no removal was needed" >&2
    return 1
  }
  gh issue edit "$number" --repo "$REPO" --remove-label analysis:needs-input >/dev/null || return 1
  labels_after=$(gh api "repos/$REPO/issues/$number" --jq '[.labels[].name] | sort') || return 1
  # The removal must be observable and must not have taken anything else with it.
  jq -e 'index("analysis:needs-input") == null' <<<"$labels_after" >/dev/null || return 1
  local expected='' actual=''
  expected=$(jq -cS --argjson before "$labels_before" '$before - ["analysis:needs-input"]' <<<"null") || return 1
  actual=$(jq -cS --argjson after "$labels_after" '$after' <<<"null") || return 1
  if [ "$actual" != "$expected" ]; then
    # A concurrent human label change landed in the same window. Restore every
    # label that was present before minus the pending marker so the run cannot
    # have silently overridden an exclusion, then fail closed.
    # Iterate rather than word-splitting: an unquoted $(...) does NOT get
    # quote removal, so `jq @sh` output would arrive with literal quotes and
    # any label containing whitespace would be split into extra argv entries.
    local restore_label
    while IFS= read -r restore_label; do
      [ -n "$restore_label" ] || continue
      gh issue edit "$number" --repo "$REPO" --add-label "$restore_label" >/dev/null 2>&1 || true
    done < <(jq -r '.[]' <<<"$expected")
    echo "Issue #$number label set changed during pending-label removal; restored and failing closed" >&2
    return 1
  fi
}

restore_pending_label() {
  local number="$1"
  if ! gh issue edit "$number" --repo "$REPO" --add-label analysis:needs-input 2>/dev/null; then
    echo "Issue #$number pending-label rollback failed" >&2
    return 1
  fi
  local restored=''
  restored=$(read_live_issue_state "$number") || { echo "Issue #$number pending-label rollback could not be verified" >&2; return 1; }
  local state pending updated
  IFS=$'\t' read -r state updated pending <<<"$restored"
  [ "$state" = OPEN ] && [ "$pending" = true ] || { echo "Issue #$number pending-label rollback was not observable" >&2; return 1; }
}
fail_after_pending_mutation() {
  local number="$1" current='' state='' updated='' pending='' rolled_back=0
  if current=$(read_live_issue_state "$number"); then
    IFS=$'\t' read -r state updated pending <<<"$current"
    if [ "$state" = OPEN ] && [ "$pending" = true ]; then
      echo "Issue #$number pending label is already present; no rollback mutation was needed" >&2
      return 1
    fi
    if [ "$state" = OPEN ] && [ "$pending" = false ]; then
      if restore_pending_label "$number"; then rolled_back=1; fi
    elif [ "$state" != OPEN ]; then
      # A closed issue cannot carry the pending marker; a human must reopen it.
      echo "Issue #$number is ${state:-in an unknown state} and no longer accepts the pending label; manual recovery is required" >&2
    fi
  else
    if restore_pending_label "$number"; then rolled_back=1; fi
  fi
  if [ "$rolled_back" -ne 1 ]; then
    echo "Issue #$number pending-label rollback could not be confirmed; the question may require a human to reopen or re-apply analysis:needs-input" >&2
  fi
  return 1
}

require_live_issue_pending() {
  local number="$1" current='' state='' updated_at='' pending=''
  current=$(read_live_issue_state "$number") || { echo "Issue #$number live state could not be established" >&2; return 1; }
  IFS=$'\t' read -r state updated_at pending <<<"$current"
  [ "$state" = OPEN ] && [ "$pending" = true ] || { echo "Issue #$number is no longer pending questions" >&2; return 1; }
  require_live_issue_not_excluded "$number"
}

[ -f "$TASKS" ] && [ ! -L "$TASKS" ] || { echo 'task manifest is missing or symlinked' >&2; exit 1; }
[ -f "$RESULTS" ] && [ ! -L "$RESULTS" ] || { echo 'agent results are missing or symlinked' >&2; exit 1; }
[ -f "$STATUS" ] && [ ! -L "$STATUS" ] || { echo 'verification status is missing or symlinked' >&2; exit 1; }
export GIT_NO_REPLACE_OBJECTS=1 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 BASH_ENV=/dev/null
umask 077
TMP_ROOT=$(mktemp -d)
cleanup() { rm -rf -- "$TMP_ROOT"; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

TASK_RUN_ID=$(jq -er '.run_id | select(type == "string" and test("^[0-9]+$"))' "$TASKS") || { echo 'task run_id is invalid' >&2; exit 1; }
TASK_BASE_SHA=$(jq -er '.base_sha | select(type == "string" and test("^[0-9a-f]{40}$"))' "$TASKS") || { echo 'task base_sha is invalid' >&2; exit 1; }
jq -e --arg run "$TASK_RUN_ID" --arg base "$TASK_BASE_SHA" '
  def positive_integer: type == "number" and . >= 1 and . == floor;
  type == "object" and
  (keys == ["base_sha", "issue", "mode", "prs", "run_id"]) and
  .run_id == $run and .base_sha == $base and
  (
    (
      .mode == "prs" and .issue == null and (.prs | type == "array") and
      (.prs | length) > 0 and (.prs | length) <= 100 and
      all(.prs[];
        type == "object" and
        (keys - ["base_ref", "head_ref", "head_sha", "is_cross_repository", "labels", "mergeable", "number", "title"] | length == 0) and
        ((has("title") | not) or (.title | type == "string" and length <= 1000)) and
        ((has("mergeable") | not) or (.mergeable == "MERGEABLE" or .mergeable == "CONFLICTING" or .mergeable == "UNKNOWN")) and
        ((has("labels") | not) or (.labels | type == "array" and all(.[]; type == "string"))) and
        (.number | positive_integer) and
        (.head_ref | type == "string" and length > 0 and length <= 255) and
        (.base_ref | type == "string" and length > 0 and length <= 255) and
        (.head_sha | type == "string" and test("^[0-9a-f]{40}$")) and
        (.is_cross_repository | type == "boolean")
      ) and
      ([.prs[].number] | length == (unique | length))
    ) or
    (
      .mode == "issues" and (.prs == []) and (.issue | type == "object") and
      ((.issue | keys) - ["body", "comments", "has_questions", "labels", "number", "title", "updated_at"] | length == 0) and
      ((.issue | has("title") | not) or (.issue.title | type == "string" and length <= 1000)) and
      ((.issue | has("body") | not) or (.issue.body | type == "string")) and
      ((.issue | has("comments") | not) or (.issue.comments | type == "array")) and
      ((.issue | has("labels") | not) or (.issue.labels | type == "array" and all(.[]; type == "object" and (.name | type == "string")))) and
      (.issue.number | positive_integer) and (.issue.has_questions | type == "boolean") and
      (.issue.updated_at | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"))
    )
  )
' "$TASKS" >/dev/null || { echo 'task manifest schema is invalid' >&2; exit 1; }
MODE=$(jq -er '.mode' "$TASKS") || { echo 'task mode lookup failed' >&2; exit 1; }

jq -e --arg run "$TASK_RUN_ID" --arg base "$TASK_BASE_SHA" --arg mode "$MODE" --slurpfile tasks "$TASKS" '
  def positive_integer: type == "number" and . >= 1 and . == floor;
  def pr_result:
    (
      .action == "skip" and
      (keys == ["action", "head_sha", "number", "patch", "reason"]) and
      (.number | positive_integer) and
      (.head_sha | type == "string" and test("^[0-9a-f]{40}$")) and
      (.patch == false) and
      (.reason | type == "string" and length > 0 and length <= 2000)
    ) or
    (
      (.action == "approved" or .action == "ready") and
      (keys == ["action", "head_sha", "needs_merge", "number", "patch"]) and
      (.number | positive_integer) and
      (.head_sha | type == "string" and test("^[0-9a-f]{40}$")) and
      (.needs_merge | type == "boolean") and (.patch | type == "boolean") and
      (.patch == false or .needs_merge == true)
    );
  def issue_result:
    .action == "issue" and
    (keys == ["action", "answer_file", "choice", "has_questions", "number", "patch"]) and
    (.number | positive_integer) and
    (.choice == "ready" or .choice == "needs_input" or .choice == "spam" or .choice == "unknown") and
    (.has_questions | type == "boolean") and (.patch == false) and
    (.answer_file == null or (.answer_file | type == "string"));
  type == "object" and (keys == ["base_sha", "results", "run_id"]) and
  .run_id == $run and .base_sha == $base and
  (.results | type == "array") and (.results | length) > 0 and (.results | length) <= 100 and
  all(.results[]; if $mode == "prs" then pr_result else issue_result end) and
  ([.results[].number] | length == (unique | length)) and
  (
    [.results[].number] | sort == (
      if $mode == "prs" then [$tasks[0].prs[].number] | sort else [$tasks[0].issue.number] | sort end
    )
  )
' "$RESULTS" >/dev/null || { echo 'agent result schema is not bound to the task set' >&2; exit 1; }

jq -e --arg run "$TASK_RUN_ID" --arg base "$TASK_BASE_SHA" --arg mode "$MODE" --slurpfile results "$RESULTS" '
  def positive_integer: type == "number" and . >= 1 and . == floor;
  def pr_verification:
    (keys == ["action", "head_sha", "number", "reason", "verified"]) and
    (.number | positive_integer) and
    (.action == "skip" or .action == "approved" or .action == "ready") and
    (.verified == true) and
    (.head_sha | type == "string" and test("^[0-9a-f]{40}$")) and
    (.reason | type == "string" and length > 0 and length <= 2000);
  def issue_verification:
    (keys == ["action", "answer_sha256", "number", "reason", "verified"]) and
    (.number | positive_integer) and .action == "issue" and .verified == true and
    (.answer_sha256 == null or (.answer_sha256 | type == "string" and test("^[0-9a-f]{64}$"))) and
    (.reason | type == "string" and length > 0 and length <= 2000);
  type == "object" and
  (keys == ["base_sha", "phase", "run_id", "verifications", "verified"]) and
  .run_id == $run and .base_sha == $base and .phase == "verify" and .verified == true and
  (.verifications | type == "array") and (.verifications | length) > 0 and (.verifications | length) <= 100 and
  all(.verifications[]; if $mode == "prs" then pr_verification else issue_verification end) and
  ([.verifications[].number] | length == (unique | length)) and
  ([.verifications[].number] | sort == ([$results[0].results[].number] | sort))
' "$STATUS" >/dev/null || { echo 'canonical verification status schema or cardinality is invalid' >&2; exit 1; }

RESULTS_STREAM=$(mktemp "$TMP_ROOT/results.XXXXXX")
if ! jq -ce '.results[]' "$RESULTS" > "$RESULTS_STREAM"; then
  echo 'agent result stream producer failed during publish preflight' >&2
  exit 1
fi
VERIFICATIONS_STREAM=$(mktemp "$TMP_ROOT/verifications.XXXXXX")
if ! jq -ce '.verifications[]' "$STATUS" > "$VERIFICATIONS_STREAM"; then
  echo 'verification stream producer failed during publish preflight' >&2
  exit 1
fi
[ -s "$RESULTS_STREAM" ] && [ -s "$VERIFICATIONS_STREAM" ] || { echo 'publish preflight stream is empty' >&2; exit 1; }
printf '\n' >> "$RESULTS_STREAM"
printf '\n' >> "$VERIFICATIONS_STREAM"
jq -s -e --slurpfile source "$RESULTS" '. == $source[0].results' "$RESULTS_STREAM" >/dev/null || { echo 'materialized publish result stream is incomplete or malformed' >&2; exit 1; }
jq -s -e --slurpfile source "$STATUS" '. == $source[0].verifications' "$VERIFICATIONS_STREAM" >/dev/null || { echo 'materialized publish verification stream is incomplete or malformed' >&2; exit 1; }

PLAN_ROOT=$(mktemp -d "$TMP_ROOT/plan.XXXXXX")
RESPONSES_DIR="$(dirname "$RESULTS")/responses"
[ ! -L "$RESPONSES_DIR" ] || { echo 'agent response directory is a symlink' >&2; exit 1; }
RESPONSES_LIST=$(mktemp "$TMP_ROOT/responses.XXXXXX")
if [ -e "$RESPONSES_DIR" ]; then
  [ -d "$RESPONSES_DIR" ] || { echo 'agent response path is not a directory' >&2; exit 1; }
  if ! find "$RESPONSES_DIR" -mindepth 1 -maxdepth 1 -print0 > "$RESPONSES_LIST"; then
    echo 'agent response directory could not be enumerated' >&2
    exit 1
  fi
else
  : > "$RESPONSES_LIST"
fi
EXPECTED_RESPONSE=''
if [ "$MODE" = issues ]; then
  ISSUE_NUMBER=$(jq -er '.issue.number | select(type == "number" and . >= 1 and . == floor)' "$TASKS") || { echo 'issue number lookup failed' >&2; exit 1; }
  HAS_QUESTIONS=$(jq -er '.issue.has_questions | if type == "boolean" then (if . then "true" else "false" end) else error("has_questions must be boolean") end' "$TASKS") || { echo 'issue question flag lookup failed' >&2; exit 1; }
  if [ "$HAS_QUESTIONS" = true ]; then
    EXPECTED_RESPONSE="issue-$ISSUE_NUMBER-run-$TASK_RUN_ID-answer.txt"
  fi
fi
RESPONSE_COUNT=0
while IFS= read -r -d '' response; do
  [ -f "$response" ] && [ ! -L "$response" ] || { echo 'response tree contains a non-regular or symlinked entry' >&2; exit 1; }
  response_name=$(basename -- "$response")
  [ -n "$EXPECTED_RESPONSE" ] && [ "$response_name" = "$EXPECTED_RESPONSE" ] || { echo 'response filename is not bound to the discovered run and issue' >&2; exit 1; }
  RESPONSE_COUNT=$((RESPONSE_COUNT + 1))
done < "$RESPONSES_LIST"

# Preflight the complete batch. No GitHub mutation is permitted until every
# result, verification, live PR head, response, patch, and comment is valid.
while IFS= read -r result; do
  [ -n "$result" ] || continue
  number=$(jq -er '.number | select(type == "number" and . >= 1 and . == floor)' <<<"$result") || { echo "invalid result number for publication" >&2; exit 1; }
  action=$(jq -er '.action' <<<"$result") || { echo "result action lookup failed" >&2; exit 1; }
  verification=$(jq -c --argjson n "$number" '.verifications[] | select(.number == $n)' "$STATUS") || { echo "verification lookup failed for #$number" >&2; exit 1; }
  [ -n "$verification" ] || { echo "missing verification for result #$number" >&2; exit 1; }
  verification_action=$(jq -er '.action' <<<"$verification") || { echo "verification action lookup failed for #$number" >&2; exit 1; }
  [ "$verification_action" = "$action" ] || { echo "verification action mismatch for #$number" >&2; exit 1; }
  if [ "$MODE" = issues ]; then
    task=$(jq -c '.issue' "$TASKS")
    task_issue_number=$(jq -er '.number' <<<"$task") || { echo 'issue task number lookup failed' >&2; exit 1; }
    [ "$task_issue_number" = "$number" ] || { echo 'issue result is not bound to the discovered issue' >&2; exit 1; }
    issue_updated_at=$(jq -er '.updated_at' <<<"$task") || { echo 'issue updated_at lookup failed' >&2; exit 1; }
    result_has_questions=$(jq -r '.has_questions' <<<"$result")
    task_has_questions=$(jq -r '.has_questions' <<<"$task")
    [ "$result_has_questions" = "$task_has_questions" ] || { echo 'issue answer requirement mismatch' >&2; exit 1; }
    if [ "$task_has_questions" = true ]; then
      [ "$RESPONSE_COUNT" -eq 1 ] || { echo 'required issue answer is missing or duplicated' >&2; exit 1; }
      result_answer_file=$(jq -er '.answer_file' <<<"$result") || { echo 'issue answer filename lookup failed' >&2; exit 1; }
      [ "$result_answer_file" = "$EXPECTED_RESPONSE" ] || { echo 'issue answer result is not bound to the expected run/task file' >&2; exit 1; }
      response="$RESPONSES_DIR/$EXPECTED_RESPONSE"
      [ -f "$response" ] && [ ! -L "$response" ] || { echo 'required issue answer is missing or symlinked' >&2; exit 1; }
      run_model_output answer "$response" "$PLAN_ROOT/issue-$number-answer.txt" >/dev/null || { echo 'required issue answer failed bounded validation' >&2; exit 1; }
      response_sha=$(sha256sum "$response" | awk '{print $1}')
      verification_answer_sha=$(jq -er '.answer_sha256' <<<"$verification") || { echo 'verification answer digest lookup failed' >&2; exit 1; }
      [ "$verification_answer_sha" = "$response_sha" ] || { echo 'issue answer digest does not match verification' >&2; exit 1; }
      {
        printf '<!--sec001-issue-answer-issue-%s-run-%s-->\n\n' "$number" "$TASK_RUN_ID"
        printf '%s\n\n' '🤖 **AI Answer to Pending Questions:**'
        cat "$PLAN_ROOT/issue-$number-answer.txt"
      } > "$PLAN_ROOT/issue-$number-comment.md"
      run_model_output text "$PLAN_ROOT/issue-$number-comment.md" >/dev/null || { echo 'assembled issue comment failed bounded validation' >&2; exit 1; }
    else
      result_answer_file=$(jq -r '.answer_file' <<<"$result") || { echo 'issue answer filename lookup failed' >&2; exit 1; }
      [ "$result_answer_file" = null ] || { echo 'unexpected answer binding for issue without questions' >&2; exit 1; }
      [ "$RESPONSE_COUNT" -eq 0 ] || { echo 'unexpected issue answer for issue without questions' >&2; exit 1; }
      verification_answer_sha=$(jq -r '.answer_sha256' <<<"$verification") || { echo 'verification answer digest lookup failed' >&2; exit 1; }
      [ "$verification_answer_sha" = null ] || { echo 'unexpected answer digest without questions' >&2; exit 1; }
    fi
    if ! require_live_issue_state "$number" "$issue_updated_at" "$task_has_questions"; then
      exit 1
    fi
    continue
  fi

  task=$(jq -c --argjson n "$number" '.prs[] | select(.number == $n)' "$TASKS") || { echo "task lookup failed for #$number" >&2; exit 1; }
  [ -n "$task" ] || { echo "result references unknown PR #$number" >&2; exit 1; }
  head_ref=$(jq -er '.head_ref' <<<"$task") || { echo "head ref lookup failed for #$number" >&2; exit 1; }
  task_head=$(jq -er '.head_sha' <<<"$task") || { echo "task head lookup failed for #$number" >&2; exit 1; }
  result_head=$(jq -er '.head_sha' <<<"$result") || { echo "result head lookup failed for #$number" >&2; exit 1; }
  verification_head=$(jq -er '.head_sha' <<<"$verification") || { echo "verification head lookup failed for #$number" >&2; exit 1; }
  git check-ref-format --branch "$head_ref" >/dev/null 2>&1 || { echo "invalid PR head ref for #$number" >&2; exit 1; }
  [ "$head_ref" != main ] && [ "$head_ref" != refs/heads/main ] || { echo "PR #$number uses a protected base ref as its head" >&2; exit 1; }
  [[ "$task_head" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid task head SHA for #$number" >&2; exit 1; }
  [ "$result_head" = "$task_head" ] || { echo "result head mismatch for #$number" >&2; exit 1; }
  [ "$verification_head" = "$task_head" ] || { echo "verification head mismatch for #$number" >&2; exit 1; }
  is_cross_repository=$(jq -er '.is_cross_repository | if type == "boolean" then (if . then "true" else "false" end) else error("is_cross_repository must be boolean") end' <<<"$task") || { echo "repository binding lookup failed for #$number" >&2; exit 1; }
  base_ref=$(jq -er '.base_ref' <<<"$task") || { echo "base ref lookup failed for #$number" >&2; exit 1; }
  if [ "$is_cross_repository" = true ] || [ "$base_ref" != main ]; then
    [ "$action" = skip ] || { echo 'ineligible PR result must be a no-op skip' >&2; exit 1; }
  fi
  patch=$(jq -er '.patch | if type == "boolean" then (if . then "true" else "false" end) else error("patch must be boolean") end' <<<"$result") || { echo "patch flag lookup failed for #$number" >&2; exit 1; }
  if [ "$patch" = true ]; then
    PATCH_DIR="$(dirname "$RESULTS")/patches/pr-$number"
    bash "$ARTIFACT_HELPER" validate-package --artifact "$PATCH_DIR" --expected-run-id "$TASK_RUN_ID" --expected-base-sha "$task_head" --expected-attempt 1 --expected-phase conflict --allow-prefix lib/ --allow-prefix action/ --allow-prefix app/ --allow-prefix cli/ --allow-prefix platform/ --allow-prefix docs/ --allow-prefix tests/
  fi
  if [ "$action" = skip ] && [ "$is_cross_repository" = false ] && [ "$base_ref" = main ]; then
    comment="$PLAN_ROOT/pr-$number-comment.md"
    printf '<!--sec001-deferred-pr-%s-head-%s-->\n\n' "$number" "$task_head" > "$comment"
    printf 'ℹ️ Hourly orchestration deferred this PR to manual review: ' >> "$comment"
    jq -r '.reason' <<<"$result" >> "$comment"
    run_model_output text "$comment" >/dev/null || { echo 'deferred PR comment failed bounded validation' >&2; exit 1; }
  fi
  if [ "$is_cross_repository" = false ] && [ "$base_ref" = main ]; then
    if ! require_live_pr_head "$number" "$task_head" "$head_ref"; then
      exit 1
    fi
  fi
done < "$RESULTS_STREAM"

ISSUE_READY_FILE="$PWD/issue-ready.json"
ISSUE_READY_JSON='[]'
while IFS= read -r result; do
  [ -n "$result" ] || continue
  number=$(jq -er '.number | select(type == "number" and . >= 1 and . == floor)' <<<"$result") || { echo "invalid result number for publication" >&2; exit 1; }
  action=$(jq -er '.action' <<<"$result") || { echo "result action lookup failed" >&2; exit 1; }
  if [ "$MODE" = issues ]; then
    choice=$(jq -er '.choice' <<<"$result") || { echo 'issue choice lookup failed' >&2; exit 1; }
    has_questions=$(jq -er '.has_questions | if type == "boolean" then (if . then "true" else "false" end) else error("has_questions must be boolean") end' <<<"$result") || { echo 'issue question flag lookup failed' >&2; exit 1; }
    issue_updated_at=$(jq -er '.issue.updated_at' "$TASKS") || { echo 'issue updated_at lookup failed' >&2; exit 1; }
    if ! require_live_issue_state "$number" "$issue_updated_at" "$has_questions"; then
      exit 1
    fi
    issue_mutated=false
    issue_current_updated_at=$issue_updated_at
    issue_current_pending=$has_questions
    if [ "$has_questions" = true ]; then
      issue_marker_state=0
      issue_answer_marker_exists "$number" || issue_marker_state=$?
      case "$issue_marker_state" in
        0)
          existing_state=$(read_live_issue_state "$number") || { echo "Issue #$number marker state could not be established" >&2; exit 1; }
          IFS=$'\t' read -r existing_issue_state issue_current_updated_at issue_current_pending <<<"$existing_state"
          [ "$existing_issue_state" = OPEN ] || { echo "Issue #$number closed while reconciling marker" >&2; exit 1; }
          if [ "$issue_current_pending" = true ]; then
            require_live_issue_not_excluded "$number" || exit 1
            marker_content_before=$(issue_content_fingerprint "$number") || { echo "Issue #$number marker content could not be established" >&2; exit 1; }
            marker_pre_label_updated_at=$issue_current_updated_at
            issue_mutated=true
            if ! remove_pending_label_conditionally "$number"; then
              echo "Issue #$number marker exists but pending-label removal failed" >&2
              fail_after_pending_mutation "$number"
            fi
            post_label_state=$(read_live_issue_state "$number") || fail_after_pending_mutation "$number"
            IFS=$'\t' read -r post_label_issue_state issue_current_updated_at issue_current_pending <<<"$post_label_state"
            [ "$post_label_issue_state" = OPEN ] && [ "$issue_current_pending" = false ] || fail_after_pending_mutation "$number"
            [ "$issue_current_updated_at" != "$marker_pre_label_updated_at" ] || fail_after_pending_mutation "$number"
            marker_content_after=$(issue_content_fingerprint "$number") || fail_after_pending_mutation "$number"
            [ "$marker_content_after" = "$marker_content_before" ] || fail_after_pending_mutation "$number"
          fi
          ;;
        1)
          if ! require_live_issue_state "$number" "$issue_updated_at" "$has_questions"; then exit 1; fi
          if ! gh issue comment "$number" --repo "$REPO" --body-file "$PLAN_ROOT/issue-$number-comment.md"; then
            echo "Issue #$number answer comment failed; needs-input label was not removed" >&2
            exit 1
          fi
          issue_mutated=true
          post_comment_state=$(read_live_issue_state "$number") || { echo "Issue #$number post-comment state could not be established" >&2; exit 1; }
          IFS=$'\t' read -r post_state post_updated_at post_pending <<<"$post_comment_state"
          answer_content_before_label=$(issue_content_fingerprint "$number") || { echo "Issue #$number answer content could not be established" >&2; exit 1; }
          [ "$post_state" = OPEN ] && [ "$post_pending" = true ] || { echo "Issue #$number stopped being pending after the answer comment" >&2; exit 1; }
          if ! require_live_issue_state "$number" "$post_updated_at" true; then
            echo "Issue #$number changed before pending-label removal" >&2
            exit 1
          fi
          answer_pre_label_updated_at=$post_updated_at
          if ! remove_pending_label_conditionally "$number"; then
            echo "Issue #$number answer posted but needs-input label removal failed" >&2
            fail_after_pending_mutation "$number"
          fi
          post_label_state=$(read_live_issue_state "$number") || fail_after_pending_mutation "$number"
          IFS=$'\t' read -r post_label_issue_state issue_current_updated_at issue_current_pending <<<"$post_label_state"
          [ "$post_label_issue_state" = OPEN ] && [ "$issue_current_pending" = false ] || fail_after_pending_mutation "$number"
          require_live_issue_state "$number" "$issue_current_updated_at" false || fail_after_pending_mutation "$number"
          [ "$issue_current_updated_at" != "$answer_pre_label_updated_at" ] || fail_after_pending_mutation "$number"
          answer_content_after=$(issue_content_fingerprint "$number") || fail_after_pending_mutation "$number"
          [ "$answer_content_after" = "$answer_content_before_label" ] || fail_after_pending_mutation "$number"
          ;;
        *) echo "Issue #$number answer marker state could not be established" >&2; exit 1 ;;
      esac
    fi
    if [ "$choice" = spam ]; then
      if ! require_live_issue_state "$number" "$issue_current_updated_at" "$issue_current_pending"; then exit 1; fi
      spam_content_before=$(issue_content_fingerprint "$number") || { echo "Issue #$number spam content could not be established" >&2; exit 1; }
      if ! gh issue edit "$number" --repo "$REPO" --add-label autofix:skipped; then
        echo "Issue #$number spam label update failed" >&2
        exit 1
      fi
      post_spam_state=$(read_live_issue_state "$number") || { echo "Issue #$number post-spam state could not be established" >&2; exit 1; }
      IFS=$'\t' read -r post_spam_issue_state post_spam_updated_at post_spam_pending <<<"$post_spam_state"
      [ "$post_spam_issue_state" = OPEN ] && [ "$post_spam_pending" = "$issue_current_pending" ] || { echo "Issue #$number changed after spam label update" >&2; exit 1; }
      [ "$post_spam_updated_at" != "$issue_current_updated_at" ] || { echo "Issue #$number spam label update did not advance state" >&2; exit 1; }
      spam_content_after=$(issue_content_fingerprint "$number") || { echo "Issue #$number spam content could not be re-read" >&2; exit 1; }
      [ "$spam_content_after" = "$spam_content_before" ] || { echo "Issue #$number changed during spam label update" >&2; exit 1; }
      issue_current_updated_at=$post_spam_updated_at
    fi
    if [ "$choice" = ready ]; then
      handoff_updated_at=$issue_current_updated_at
      if ! require_live_issue_state "$number" "$issue_current_updated_at" "$issue_current_pending"; then
        echo "Issue #$number changed before trusted handoff" >&2
        exit 1
      fi
      ISSUE_READY_JSON=$(jq -c --argjson n "$number" --arg updated_at "$handoff_updated_at" '. + [{number:$n,updated_at:$updated_at}]' <<<"$ISSUE_READY_JSON")
    fi
    continue
  fi

  task=$(jq -c --argjson n "$number" '.prs[] | select(.number == $n)' "$TASKS") || { echo "task lookup failed for #$number" >&2; exit 1; }
  [ -n "$task" ] || { echo "result references unknown PR #$number" >&2; exit 1; }
  head_ref=$(jq -er '.head_ref' <<<"$task") || { echo "head ref lookup failed for #$number" >&2; exit 1; }
  task_head=$(jq -er '.head_sha' <<<"$task") || { echo "task head lookup failed for #$number" >&2; exit 1; }
  is_cross_repository=$(jq -er '.is_cross_repository | if type == "boolean" then (if . then "true" else "false" end) else error("is_cross_repository must be boolean") end' <<<"$task") || { echo "repository binding lookup failed for #$number" >&2; exit 1; }
  base_ref=$(jq -er '.base_ref' <<<"$task") || { echo "base ref lookup failed for #$number" >&2; exit 1; }
  if [ "$is_cross_repository" = true ] || [ "$base_ref" != main ]; then
    continue
  fi
  if [ "$action" = skip ]; then
    if ! require_live_pr_head "$number" "$task_head" "$head_ref"; then exit 1; fi
    marker_state=0
    pr_head_marker_exists "$number" "$task_head" || marker_state=$?
    case "$marker_state" in
      0) echo "PR #$number already has a deferred marker for head $task_head" ;;
      1)
        if ! require_live_pr_head "$number" "$task_head" "$head_ref"; then exit 1; fi
        if ! gh pr comment "$number" --repo "$REPO" --body-file "$PLAN_ROOT/pr-$number-comment.md"; then
          echo "PR #$number deferred comment failed" >&2
          exit 1
        fi
        ;;
      *) echo "PR #$number deferred marker state could not be established" >&2; exit 1 ;;
    esac
    if ! require_live_pr_head "$number" "$task_head" "$head_ref"; then
      echo "PR #$number changed before skip label mutation" >&2
      exit 1
    fi
    if ! gh pr edit "$number" --repo "$REPO" --add-label autofix:skipped; then
      echo "PR #$number skip label update failed" >&2
      exit 1
    fi
    if ! require_live_skip_label "$number" "$task_head" "$head_ref"; then
      echo "PR #$number skip label/head postcondition failed" >&2
      exit 1
    fi
    pr_head_marker_exists "$number" "$task_head" || { echo "PR #$number skip marker could not be verified" >&2; exit 1; }
    require_live_skip_label "$number" "$task_head" "$head_ref" || { echo "PR #$number changed after skip marker verification" >&2; exit 1; }
    echo "PR #$number marked skipped; a human must remove autofix:skipped to retry"
    continue
  fi

  needs_merge=$(jq -r '.needs_merge' <<<"$result")
  patch=$(jq -er '.patch | if type == "boolean" then (if . then "true" else "false" end) else error("patch must be boolean") end' <<<"$result") || { echo "patch flag lookup failed for #$number" >&2; exit 1; }
  if [ "$patch" = true ]; then
    if ! require_live_pr_head "$number" "$task_head" "$head_ref"; then exit 1; fi
    PATCH_DIR="$(dirname "$RESULTS")/patches/pr-$number"
    bash "$ARTIFACT_HELPER" validate-package --artifact "$PATCH_DIR" --expected-run-id "$TASK_RUN_ID" --expected-base-sha "$task_head" --expected-attempt 1 --expected-phase conflict --allow-prefix lib/ --allow-prefix action/ --allow-prefix app/ --allow-prefix cli/ --allow-prefix platform/ --allow-prefix docs/ --allow-prefix tests/
    PATCH_STAGE="$TMP_ROOT/pr-$number-patch.diff"
    cp -- "$PATCH_DIR/patch.diff" "$PATCH_STAGE"
    EXPECTED_PATCH_SHA=$(jq -r '.sha256' "$PATCH_DIR/metadata.json")
    ACTUAL_PATCH_SHA=$(sha256sum "$PATCH_STAGE" | awk '{print $1}')
    [ "$ACTUAL_PATCH_SHA" = "$EXPECTED_PATCH_SHA" ] || { echo "PR #$number staged patch checksum mismatch" >&2; exit 1; }
    if ! require_live_pr_head "$number" "$task_head" "$head_ref"; then
      echo "PR #$number live head/label contract changed before patch publication" >&2
      exit 1
    fi
    bash "$PUBLISH_HELPER" --patch "$PATCH_STAGE" --base-sha "$task_head" --branch "$head_ref" --remote "$REMOTE" --repo "$REPO" --source-ref "$head_ref" --message "fix: publish isolated conflict resolution for PR #$number"
    echo "PR #$number head-changing publication completed; remaining mutations wait for a fresh verified head"
    continue
  fi
  if [ "$needs_merge" = true ]; then
    echo "PR #$number needs main but has no verified patch; no automatic merge or label mutation was attempted"
    continue
  fi

  # pull_request-triggered ai-review runs use the synthetic <pr>/merge head
  # branch; accept either that merge ref or the pinned head SHA.
  # Ask the API to filter by status rather than filtering a page client-side:
  # `gh run list --status` takes a single value, so query each non-terminal
  # status separately. Filtering a combined page would fail open once more
  # than `--limit` completed runs pushed an in-flight review off the page.
  # The value set is exactly the non-terminal statuses `gh run list --status`
  # accepts; `pending` is NOT a valid value and would abort the query.
  ACTIVE_REVIEW=false
  for run_status in queued in_progress requested waiting action_required; do
    if ! RUN_LIST=$(gh run list --workflow ai-review.yml --repo "$REPO" --status "$run_status" --limit 100 --json headBranch,headSha,status); then
      echo "PR #$number active-review state could not be established" >&2
      exit 1
    fi
    MATCH=$(printf '%s' "$RUN_LIST" | jq -r --arg head "$task_head" --arg merge "$number/merge" 'any(.[]; (.headSha == $head) or (.headBranch == $merge))') || {
      echo "PR #$number active-review response was malformed" >&2
      exit 1
    }
    case "$MATCH" in
      true) ACTIVE_REVIEW=true; break ;;
      false) ;;
      *) echo "PR #$number active-review response was invalid" >&2; exit 1 ;;
    esac
  done
  if [ "$ACTIVE_REVIEW" = true ]; then
    echo "Merge deferred for PR #$number: autofix review loop is still active"
    continue
  fi
  PINNED_HEAD=$task_head
  if ! require_live_pr_head "$number" "$PINNED_HEAD" "$head_ref"; then exit 1; fi
  if ! GATE_ATTEMPTS=20 GATE_SLEEP=60 bash "$MERGE_GATE" "$number" "$REPO" "$PINNED_HEAD"; then
    echo "Merge deferred for PR #$number: green-check gate denied" >&2
    continue
  fi
  if ! require_live_pr_head "$number" "$PINNED_HEAD" "$head_ref"; then exit 1; fi
  if ! bash "$APPROVAL" "$number" "$REPO" "$PINNED_HEAD"; then
    echo "Merge deferred for PR #$number: human approval missing"
    continue
  fi
  if ! GATE_ATTEMPTS=1 GATE_SLEEP=1 bash "$MERGE_GATE" "$number" "$REPO" "$PINNED_HEAD"; then
    echo "Merge deferred for PR #$number: checks changed while approval was verified" >&2
    continue
  fi
  if ! require_live_pr_head "$number" "$PINNED_HEAD" "$head_ref"; then exit 1; fi
  if ! bash "$APPROVAL" "$number" "$REPO" "$PINNED_HEAD"; then
    echo "Merge deferred for PR #$number: human approval changed"
    continue
  fi
  if ! require_live_pr_head "$number" "$PINNED_HEAD" "$head_ref"; then exit 1; fi
  if ! gh pr merge "$number" --repo "$REPO" --squash --delete-branch --match-head-commit "$PINNED_HEAD" 2>/dev/null; then
    echo "Immediate merge failed for PR #$number; no queued auto-merge fallback exists." >&2
    exit 1
  fi
done < "$RESULTS_STREAM"
printf '%s\n' "$ISSUE_READY_JSON" | run_model_output write "$ISSUE_READY_FILE"
