#!/usr/bin/env bash
# Finalize a verification result in a fresh, no-secret job. This script never
# runs repository-controlled gates; it validates the raw result against the
# discovered task/result manifests and creates the canonical status artifact.
set -euo pipefail
RAW=''; LOG=''; OUTPUT=''; RUN_ID=''; BASE_SHA=''; PHASE=''; TASKS=''; RESULTS=''; HELPER=''; JOB_RESULT=''
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
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$RAW" ] && [ -n "$LOG" ] && [ -n "$OUTPUT" ] && [ -n "$RUN_ID" ] && [ -n "$BASE_SHA" ] && [ -n "$PHASE" ] && [ -n "$HELPER" ] && [ "$JOB_RESULT" = success ] || { echo 'missing/invalid finalizer arguments' >&2; exit 2; }
[ -f "$RAW" ] && [ ! -L "$RAW" ] && [ -f "$LOG" ] && [ ! -L "$LOG" ] || { echo 'raw status/log is missing or symlinked' >&2; exit 1; }
jq -e --arg run "$RUN_ID" --arg base "$BASE_SHA" 'type == "object" and .run_id == $run and .base_sha == $base and ((.verifications | type == "array") or (.verified | type == "boolean"))' "$RAW" >/dev/null || { echo 'raw status identity/schema mismatch' >&2; exit 1; }
if [ -n "$TASKS" ] || [ -n "$RESULTS" ]; then
  [ -n "$TASKS" ] && [ -n "$RESULTS" ] || { echo 'tasks and results must be supplied together' >&2; exit 1; }
  jq -e --arg run "$RUN_ID" --arg base "$BASE_SHA" '.run_id == $run and .base_sha == $base' "$TASKS" >/dev/null || { echo 'task manifest run/base mismatch' >&2; exit 1; }
  jq -e --arg run "$RUN_ID" --arg base "$BASE_SHA" '.run_id == $run and .base_sha == $base' "$RESULTS" >/dev/null || { echo 'agent result run/base mismatch' >&2; exit 1; }
  jq -e '.verifications | type == "array"' "$RAW" >/dev/null || { echo 'hourly raw status must contain verifications' >&2; exit 1; }
  [ "$(jq '.results | length' "$RESULTS")" -le 100 ] && [ "$(jq '.verifications | length' "$RAW")" -le 100 ] || { echo 'verification result count exceeds limit' >&2; exit 1; }
  [ "$(jq '[.results[].number] | length == (unique | length)' "$RESULTS")" = true ] || { echo 'duplicate result numbers' >&2; exit 1; }
  EXPECTED=$(jq -c '[.results[] | .number] | sort' "$RESULTS")
  ACTUAL=$(jq -c '[.verifications[].number] | sort' "$RAW")
  [ "$EXPECTED" = "$ACTUAL" ] || { echo 'verification numbers are not bound to agent results' >&2; exit 1; }
  [ "$(jq '[.verifications[].number] | length == (unique | length)' "$RAW")" = true ] || { echo 'duplicate verification numbers' >&2; exit 1; }
  while IFS= read -r result; do
    number=$(jq -r '.number' <<<"$result")
    action=$(jq -r '.action' <<<"$result")
    if [ "$action" = issue ]; then
      [ "$(jq -r '.issue.number // empty' "$TASKS")" = "$number" ] || { echo 'issue result/task mismatch' >&2; exit 1; }
    else
      task=$(jq -c --argjson n "$number" '.prs[] | select(.number == $n)' "$TASKS")
      [ -n "$task" ] || { echo "unknown PR result #$number" >&2; exit 1; }
    fi
    verification=$(jq -c --argjson n "$number" '.verifications[] | select(.number == $n)' "$RAW")
    [ -n "$verification" ] || { echo "missing verification #$number" >&2; exit 1; }
    jq -e --arg action "$action" '(.number|type=="number") and (.verified|type=="boolean") and (.action|type=="string") and (.reason|type=="string") and ((.head_sha == null) or (.head_sha|test("^[0-9a-f]{40}$")))' <<<"$verification" >/dev/null || { echo "invalid verification schema for #$number" >&2; exit 1; }
    [ "$(jq -r '.action' <<<"$verification")" = "$action" ] || { echo "verification action mismatch for #$number" >&2; exit 1; }
    if [ "$(jq -r '.patch // false' <<<"$result")" = true ]; then
      expected_head=$(jq -r '.head_sha' <<<"$task")
      actual_head=$(jq -r '.head_sha' <<<"$verification")
      [ "$expected_head" = "$actual_head" ] || { echo "verification head mismatch for #$number" >&2; exit 1; }
    fi
  done < <(jq -c '.results[]' "$RESULTS")
  if [ "$(jq '[.verifications[] | select(.verified == false)] | length' "$RAW")" -ne 0 ]; then
    echo 'a successful supervisor job must not contain failed verification entries' >&2
    exit 1
  fi
  VERIFIED=true
else
  [ "$(jq -r '.verified' "$RAW")" = true ] || { echo 'raw status is inconsistent with successful supervisor job' >&2; exit 1; }
  VERIFIED=true
fi
# JOB_RESULT is supplied by GitHub's job conclusion, not by repository code.
# The raw payload is only cross-checked; it is never the source of truth.
CANONICAL_RAW=$(mktemp)
jq --argjson verified "$VERIFIED" '. + {verified:$verified}' "$RAW" > "$CANONICAL_RAW"
bash "$HELPER" status --output "$OUTPUT" --run-id "$RUN_ID" --base-sha "$BASE_SHA" --phase "$PHASE" --verified "$VERIFIED" --log "$LOG" --status-file "$CANONICAL_RAW"
rm -f "$CANONICAL_RAW"
bash "$HELPER" validate-status --artifact "$OUTPUT" --expected-run-id "$RUN_ID" --expected-base-sha "$BASE_SHA" --expected-phase "$PHASE"
