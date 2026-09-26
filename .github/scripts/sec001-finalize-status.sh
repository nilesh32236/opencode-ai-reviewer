#!/usr/bin/env bash
# Finalize a verification result in a fresh, no-secret job. This script never
# runs repository-controlled gates; it validates the raw result against the
# discovered task/result manifests and creates the canonical status artifact.
set -euo pipefail
RAW=''; LOG=''; OUTPUT=''; RUN_ID=''; BASE_SHA=''; PHASE=''; TASKS=''; RESULTS=''; HELPER=''; JOB_RESULT=''; MODEL_OUTPUT_HELPER=''
RESULTS_STREAM=''; VERIFICATIONS_STREAM=''; CANONICAL_RAW=''; RESPONSES_LIST=''
cleanup() {
  [ -z "$RESULTS_STREAM" ] || rm -f -- "$RESULTS_STREAM"
  [ -z "$VERIFICATIONS_STREAM" ] || rm -f -- "$VERIFICATIONS_STREAM"
  [ -z "$RESPONSES_LIST" ] || rm -f -- "$RESPONSES_LIST"
  [ -z "$CANONICAL_RAW" ] || rm -f -- "$CANONICAL_RAW"
}
trap cleanup EXIT
while [ "$#" -gt 0 ]; do
  case "$1" in
    --raw) RAW="${2:-}"; shift 2 ;;
    --log) LOG="${2:-}"; shift 2 ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    --run-id) RUN_ID="${2:-}"; shift 2 ;;
    --base-sha) BASE_SHA="${2:-}"; shift 2 ;;
    --phase) PHASE="${2:-}"; shift 2 ;;
    --tasks) TASKS="${2:-}"; shift 2 ;;
    --results) RESULTS="${2:-}"; shift 2 ;;
    --helper) HELPER="${2:-}"; shift 2 ;;
    --job-result) JOB_RESULT="${2:-}"; shift 2 ;;
    --model-output-helper) MODEL_OUTPUT_HELPER="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$RAW" ] && [ -n "$LOG" ] && [ -n "$OUTPUT" ] && [ -n "$RUN_ID" ] && [ -n "$BASE_SHA" ] && [ -n "$PHASE" ] && [ -n "$HELPER" ] && [ "$JOB_RESULT" = success ] || { echo 'missing/invalid finalizer arguments' >&2; exit 2; }
[ -f "$RAW" ] && [ ! -L "$RAW" ] && [ -f "$LOG" ] && [ ! -L "$LOG" ] || { echo 'raw status/log is missing or symlinked' >&2; exit 1; }
jq -e --arg run "$RUN_ID" --arg base "$BASE_SHA" --arg phase "$PHASE" 'type == "object" and .run_id == $run and .base_sha == $base and .phase == $phase and ((.verifications | type == "array") or (.verified | type == "boolean"))' "$RAW" >/dev/null || { echo 'raw status identity/schema mismatch' >&2; exit 1; }
if [ -n "$TASKS" ] || [ -n "$RESULTS" ]; then
  [ -n "$TASKS" ] && [ -n "$RESULTS" ] || { echo 'tasks and results must be supplied together' >&2; exit 1; }
  [ -f "$TASKS" ] && [ ! -L "$TASKS" ] && [ -f "$RESULTS" ] && [ ! -L "$RESULTS" ] || { echo 'task/result manifests are missing or symlinked' >&2; exit 1; }
  [ -n "$MODEL_OUTPUT_HELPER" ] && [ -x "$MODEL_OUTPUT_HELPER" ] || { echo 'hourly finalizer requires the model output helper' >&2; exit 1; }
  if [ "${SEC001_TEST_MODE:-}" != 1 ]; then
    [ "$(/usr/bin/stat -c '%u:%a' "$MODEL_OUTPUT_HELPER")" = '0:555' ] || { echo 'model output helper is not root-owned 0555' >&2; exit 1; }
  fi
  run_model_output() {
    /usr/bin/env -i BASH_ENV=/dev/null PATH=/usr/local/bin:/usr/bin:/bin /bin/bash --noprofile --norc "$MODEL_OUTPUT_HELPER" "$@"
  }
  jq -e --arg run "$RUN_ID" --arg base "$BASE_SHA" --arg phase "$PHASE" '
    type == "object" and (keys == ["base_sha", "phase", "run_id", "verifications"]) and
    .run_id == $run and .base_sha == $base and .phase == $phase and
    (.verifications | type == "array")
  ' "$RAW" >/dev/null || { echo 'hourly raw status schema/identity mismatch' >&2; exit 1; }
  jq -e --arg run "$RUN_ID" --arg base "$BASE_SHA" '
    type == "object" and (keys == ["base_sha", "issue", "mode", "prs", "run_id"]) and
    .run_id == $run and .base_sha == $base and
    (
      (.mode == "prs" and all(.prs[]; type == "object" and (keys - ["base_ref", "head_ref", "head_sha", "is_cross_repository", "labels", "mergeable", "number", "title"] | length == 0) and ((has("title") | not) or (.title | type == "string" and length <= 1000)) and ((has("mergeable") | not) or (.mergeable == "MERGEABLE" or .mergeable == "CONFLICTING" or .mergeable == "UNKNOWN")) and ((has("labels") | not) or (.labels | type == "array" and all(.[]; type == "string"))) and (.number | type == "number" and . >= 1 and . == floor) and (.head_sha | type == "string" and test("^[0-9a-f]{40}$")))) or
      (.mode == "issues" and (.prs == []) and (.issue | type == "object") and ((.issue | keys) - ["body", "comments", "has_questions", "labels", "number", "title", "updated_at"] | length == 0) and ((.issue | has("title") | not) or (.issue.title | type == "string" and length <= 1000)) and ((.issue | has("body") | not) or (.issue.body | type == "string")) and ((.issue | has("comments") | not) or (.issue.comments | type == "array")) and ((.issue | has("labels") | not) or (.issue.labels | type == "array" and all(.[]; type == "object" and (.name | type == "string")))) and (.issue.number | type == "number" and . >= 1 and . == floor) and (.issue.updated_at | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$")))
    )
  ' "$TASKS" >/dev/null || { echo 'task manifest schema/identity mismatch' >&2; exit 1; }
  jq -e --arg run "$RUN_ID" --arg base "$BASE_SHA" '
    type == "object" and (keys == ["base_sha", "results", "run_id"]) and
    .run_id == $run and .base_sha == $base and (.results | type == "array")
  ' "$RESULTS" >/dev/null || { echo 'agent result schema/identity mismatch' >&2; exit 1; }
  jq -e '.verifications | type == "array"' "$RAW" >/dev/null || { echo 'hourly raw status must contain verifications' >&2; exit 1; }
  RESULTS_COUNT=$(jq -r '.results | length' "$RESULTS") || { echo 'result count lookup failed' >&2; exit 1; }
  VERIFICATIONS_COUNT=$(jq -r '.verifications | length' "$RAW") || { echo 'verification count lookup failed' >&2; exit 1; }
  [ "$RESULTS_COUNT" -le 100 ] && [ "$VERIFICATIONS_COUNT" -le 100 ] || { echo 'verification result count exceeds limit' >&2; exit 1; }
  # Materialize every producer stream and require successful producer exit
  # before consuming any entry. A process that emits valid partial JSON and
  # then fails is not a successful producer, even if the partial rows look usable.
  RESULTS_STREAM=$(mktemp)
  if ! jq -ce '.results[]' "$RESULTS" > "$RESULTS_STREAM"; then
    echo 'agent result stream producer failed' >&2
    exit 1
  fi
  VERIFICATIONS_STREAM=$(mktemp)
  if ! jq -ce '.verifications[]' "$RAW" > "$VERIFICATIONS_STREAM"; then
    echo 'verification stream producer failed' >&2
    exit 1
  fi
  [ -s "$RESULTS_STREAM" ] && [ -s "$VERIFICATIONS_STREAM" ] || { echo 'materialized verification stream is empty' >&2; exit 1; }
  # Bash read loops ignore a final unterminated line. Normalize the trusted JSONL
  # stream boundary before validating and consuming every materialized entry.
  printf '\n' >> "$RESULTS_STREAM"
  printf '\n' >> "$VERIFICATIONS_STREAM"
  jq -s -e --slurpfile source "$RESULTS" '. == $source[0].results' "$RESULTS_STREAM" >/dev/null || { echo 'materialized agent result stream is incomplete or malformed' >&2; exit 1; }
  jq -s -e --slurpfile source "$RAW" '. == $source[0].verifications' "$VERIFICATIONS_STREAM" >/dev/null || { echo 'materialized verification stream is incomplete or malformed' >&2; exit 1; }
  RESULTS_UNIQUE=$(jq -r '[.results[].number] | length == (unique | length)' "$RESULTS") || { echo 'result uniqueness lookup failed' >&2; exit 1; }
  [ "$RESULTS_UNIQUE" = true ] || { echo 'duplicate result numbers' >&2; exit 1; }
  TASK_PR_COUNT=$(jq -r '.prs // [] | length' "$TASKS") || { echo 'task count lookup failed' >&2; exit 1; }
  [ "$TASK_PR_COUNT" -le 100 ] || { echo 'task count exceeds limit' >&2; exit 1; }
  TASK_PRS_UNIQUE=$(jq -r '[.prs[]?.number] | length == (unique | length)' "$TASKS") || { echo 'task uniqueness lookup failed' >&2; exit 1; }
  [ "$TASK_PRS_UNIQUE" = true ] || { echo 'duplicate task PR numbers' >&2; exit 1; }
  MODE=$(jq -r '.mode' "$TASKS")
  if [ "$MODE" = prs ]; then
    response_dir="$(dirname "$RESULTS")/responses"
    [ ! -L "$response_dir" ] || { echo 'PR response directory is a symlink' >&2; exit 1; }
    if [ -e "$response_dir" ]; then
      [ -d "$response_dir" ] || { echo 'PR response path is not a directory' >&2; exit 1; }
      RESPONSES_LIST=$(mktemp)
      if ! find "$response_dir" -mindepth 1 -maxdepth 1 -print -quit > "$RESPONSES_LIST"; then
        echo 'PR response tree could not be enumerated' >&2
        exit 1
      fi
      if [ -s "$RESPONSES_LIST" ]; then
        echo 'PR results must not contain an issue response tree' >&2
        exit 1
      fi
    fi
  fi
  case "$MODE" in
    prs)
      EXPECTED=$(jq -c '[.prs[].number] | sort' "$TASKS")
      ;;
    issues)
      EXPECTED=$(jq -c '[.issue.number] | sort' "$TASKS")
      ISSUE_RESULT_COUNT=$(jq -r '.results | length' "$RESULTS") || { echo 'issue result count lookup failed' >&2; exit 1; }
      [ "$ISSUE_RESULT_COUNT" -eq 1 ] || { echo 'issue mode must contain exactly one result' >&2; exit 1; }
      ;;
    *) echo 'invalid task mode' >&2; exit 1 ;;
  esac
  RESULT_NUMBERS=$(jq -c '[.results[] | .number] | sort' "$RESULTS")
  [ "$EXPECTED" = "$RESULT_NUMBERS" ] || { echo 'result numbers are not bound to the complete task set' >&2; exit 1; }
  ACTUAL=$(jq -c '[.verifications[].number] | sort' "$RAW")
  [ "$RESULT_NUMBERS" = "$ACTUAL" ] || { echo 'verification numbers are not bound to agent results' >&2; exit 1; }
  VERIFICATIONS_UNIQUE=$(jq -r '[.verifications[].number] | length == (unique | length)' "$RAW") || { echo 'verification uniqueness lookup failed' >&2; exit 1; }
  [ "$VERIFICATIONS_UNIQUE" = true ] || { echo 'duplicate verification numbers' >&2; exit 1; }
  while IFS= read -r result; do
    [ -n "$result" ] || continue
    number=$(jq -er '.number | select(type == "number" and . >= 1 and . == floor)' <<<"$result") || { echo 'invalid result number' >&2; exit 1; }
    action=$(jq -r '.action' <<<"$result")
    if [ "$MODE" = issues ]; then
      jq -e '
        (keys == ["action", "answer_file", "choice", "has_questions", "number", "patch"]) and
        .action == "issue" and .patch == false and (.has_questions | type == "boolean") and
        (.choice == "ready" or .choice == "needs_input" or .choice == "spam" or .choice == "unknown") and
        (.answer_file == null or (.answer_file | type == "string"))
      ' <<<"$result" >/dev/null || { echo 'invalid issue result schema' >&2; exit 1; }
      task=$(jq -c '.issue' "$TASKS")
      task_issue_number=$(jq -er '.number' <<<"$task") || { echo 'issue task number lookup failed' >&2; exit 1; }
      [ "$task_issue_number" = "$number" ] || { echo 'issue result/task mismatch' >&2; exit 1; }
      verification=$(jq -c --argjson n "$number" '.verifications[] | select(.number == $n)' "$RAW") || { echo 'issue verification lookup failed' >&2; exit 1; }
      task_has_questions=$(jq -er '.has_questions | if type == "boolean" then (if . then "true" else "false" end) else error("invalid has_questions") end' <<<"$task") || exit 1
      result_has_questions=$(jq -r '.has_questions' <<<"$result")
      [ "$task_has_questions" = "$result_has_questions" ] || { echo 'issue answer requirement mismatch' >&2; exit 1; }
      response_dir="$(dirname "$RESULTS")/responses"
      response_path="$response_dir/issue-$number-run-$RUN_ID-answer.txt"
      [ ! -L "$response_dir" ] || { echo 'agent response directory is a symlink' >&2; exit 1; }
      RESPONSES_LIST=$(mktemp)
      if [ -e "$response_dir" ]; then
        [ -d "$response_dir" ] || { echo 'agent response path is not a directory' >&2; exit 1; }
        if ! find "$response_dir" -mindepth 1 -maxdepth 1 -print0 > "$RESPONSES_LIST"; then
          echo 'agent response directory could not be enumerated' >&2
          exit 1
        fi
      else
        : > "$RESPONSES_LIST"
      fi
      response_count=0
      while IFS= read -r -d '' response; do
        [ -f "$response" ] && [ ! -L "$response" ] || { echo 'issue response entry is not a regular non-symlink file' >&2; exit 1; }
        [ "$(basename -- "$response")" = "issue-$number-run-$RUN_ID-answer.txt" ] || { echo 'unexpected issue response filename' >&2; exit 1; }
        response_count=$((response_count + 1))
      done < "$RESPONSES_LIST"
      if [ "$task_has_questions" = true ]; then
        [ "$response_count" -eq 1 ] || { echo 'required issue answer is missing or duplicated' >&2; exit 1; }
        result_answer_file=$(jq -er '.answer_file' <<<"$result") || { echo 'issue answer filename lookup failed' >&2; exit 1; }
        [ "$result_answer_file" = "issue-$number-run-$RUN_ID-answer.txt" ] || { echo 'issue answer filename is not run/task bound' >&2; exit 1; }
        [ -f "$response_path" ] && [ ! -L "$response_path" ] || { echo 'required issue answer is missing or symlinked' >&2; exit 1; }
        run_model_output answer "$response_path" >/dev/null || { echo 'required issue answer failed bounded validation' >&2; exit 1; }
        verified_answer_sha=$(sha256sum "$response_path" | awk '{print $1}')
        verification_answer_sha=$(jq -er '.answer_sha256' <<<"$verification") || { echo 'verification answer digest lookup failed' >&2; exit 1; }
        [ "$verification_answer_sha" = "$verified_answer_sha" ] || { echo 'issue answer digest does not match verification' >&2; exit 1; }
      else
        result_answer_file=$(jq -r '.answer_file' <<<"$result") || { echo 'issue answer filename lookup failed' >&2; exit 1; }
        [ "$result_answer_file" = null ] || { echo 'unexpected answer binding without questions' >&2; exit 1; }
        [ "$response_count" -eq 0 ] || { echo 'unexpected issue answer without questions' >&2; exit 1; }
        verification_answer_sha=$(jq -r '.answer_sha256' <<<"$verification") || { echo 'verification answer digest lookup failed' >&2; exit 1; }
        [ "$verification_answer_sha" = null ] || { echo 'unexpected answer digest without questions' >&2; exit 1; }
      fi
      jq -e '(keys == ["action", "answer_sha256", "number", "reason", "verified"]) and .number == '"$number"' and .action == "issue" and (.verified | type == "boolean") and (.answer_sha256 == null or (.answer_sha256 | type == "string" and test("^[0-9a-f]{64}$"))) and (.reason | type == "string" and length > 0 and length <= 2000)' <<<"$verification" >/dev/null || { echo 'invalid issue verification schema' >&2; exit 1; }
    else
      case "$action" in
        skip)
          jq -e '(keys == ["action", "head_sha", "number", "patch", "reason"]) and .action == "skip" and .patch == false and (.reason | type == "string" and length > 0 and length <= 2000)' <<<"$result" >/dev/null || { echo 'invalid skip result schema' >&2; exit 1; }
          ;;
        approved|ready)
          jq -e '(keys == ["action", "head_sha", "needs_merge", "number", "patch"]) and (.needs_merge | type == "boolean") and (.patch | type == "boolean") and (.patch == false or .needs_merge == true)' <<<"$result" >/dev/null || { echo 'invalid PR result schema' >&2; exit 1; }
          ;;
        *) echo 'invalid PR result action' >&2; exit 1 ;;
      esac
      task=$(jq -c --argjson n "$number" '.prs[] | select(.number == $n)' "$TASKS")
      [ -n "$task" ] || { echo "unknown PR result #$number" >&2; exit 1; }
      expected_head=$(jq -er '.head_sha' <<<"$task") || { echo "task head lookup failed for #$number" >&2; exit 1; }
      [[ "$expected_head" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid task head for #$number" >&2; exit 1; }
      result_head=$(jq -er '.head_sha' <<<"$result") || { echo "result head lookup failed for #$number" >&2; exit 1; }
      [ "$result_head" = "$expected_head" ] || { echo "result head mismatch for #$number" >&2; exit 1; }
      verification=$(jq -c --argjson n "$number" '.verifications[] | select(.number == $n)' "$RAW") || { echo "verification lookup failed for #$number" >&2; exit 1; }
      jq -e --arg action "$action" --arg head "$expected_head" '(keys == ["action", "head_sha", "number", "reason", "verified"]) and .action == $action and .head_sha == $head and (.verified | type == "boolean") and (.reason | type == "string" and length > 0 and length <= 2000)' <<<"$verification" >/dev/null || { echo "invalid PR verification schema for #$number" >&2; exit 1; }
    fi
    if [ "$MODE" = prs ]; then
      verification_action=$(jq -er '.action' <<<"$verification") || { echo "verification action lookup failed for #$number" >&2; exit 1; }
      [ "$verification_action" = "$action" ] || { echo "verification action mismatch for #$number" >&2; exit 1; }
    fi
  done < "$RESULTS_STREAM"
  FAILED_VERIFICATION_COUNT=$(jq -r '[.verifications[] | select(.verified == false)] | length' "$RAW") || { echo 'failed verification count lookup failed' >&2; exit 1; }
  if [ "$FAILED_VERIFICATION_COUNT" -ne 0 ]; then
    echo 'a successful supervisor job must not contain failed verification entries' >&2
    exit 1
  fi
  VERIFIED=true
else
  RAW_VERIFIED=$(jq -er '.verified' "$RAW") || { echo 'raw status verification lookup failed' >&2; exit 1; }
  [ "$RAW_VERIFIED" = true ] || { echo 'raw status is inconsistent with successful supervisor job' >&2; exit 1; }
  VERIFIED=true
fi
# JOB_RESULT is supplied by GitHub's job conclusion, not by repository code.
# The raw payload is only cross-checked; it is never the source of truth.
CANONICAL_RAW=$(mktemp)
jq --argjson verified "$VERIFIED" --arg phase "$PHASE" '. + {phase:$phase,verified:$verified}' "$RAW" > "$CANONICAL_RAW"
bash "$HELPER" status --output "$OUTPUT" --run-id "$RUN_ID" --base-sha "$BASE_SHA" --phase "$PHASE" --verified "$VERIFIED" --log "$LOG" --status-file "$CANONICAL_RAW"
bash "$HELPER" validate-status --artifact "$OUTPUT" --expected-run-id "$RUN_ID" --expected-base-sha "$BASE_SHA" --expected-phase "$PHASE"
