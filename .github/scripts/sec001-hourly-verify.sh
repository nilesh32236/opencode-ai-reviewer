#!/usr/bin/env bash
# Verify every patch emitted by the hourly provider-only job on a fresh,
# secret-free checkout. No GitHub token is read or required.
set -euo pipefail

INPUT=''; OUTPUT=''; BASE_SHA=''; RUN_ID=''; REMOTE=''; ARTIFACT_HELPER=''; GATE_RUNNER=''; MODEL_OUTPUT_HELPER=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --input) INPUT="${2:-}"; shift 2 ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    --base-sha) BASE_SHA="${2:-}"; shift 2 ;;
    --run-id) RUN_ID="${2:-}"; shift 2 ;;
    --remote) REMOTE="${2:-}"; shift 2 ;;
    --artifact-helper) ARTIFACT_HELPER="${2:-}"; shift 2 ;;
    --gate-runner) GATE_RUNNER="${2:-}"; shift 2 ;;
    --model-output-helper) MODEL_OUTPUT_HELPER="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$INPUT" ] && [ -n "$OUTPUT" ] && [ -n "$BASE_SHA" ] && [ -n "$RUN_ID" ] && [ -n "$REMOTE" ] && [ -n "$ARTIFACT_HELPER" ] && [ -n "$GATE_RUNNER" ] && [ -n "$MODEL_OUTPUT_HELPER" ] || { echo 'missing hourly verifier arguments' >&2; exit 2; }
[ -f "$INPUT/results.json" ] && [ ! -L "$INPUT/results.json" ] || { echo 'agent results are missing or symlinked' >&2; exit 1; }
[ -x "$MODEL_OUTPUT_HELPER" ] || { echo 'model output helper is missing or not executable' >&2; exit 1; }
if [ "${SEC001_TEST_MODE:-}" != 1 ]; then
  [ "$(/usr/bin/stat -c '%u:%a' "$MODEL_OUTPUT_HELPER")" = '0:555' ] || { echo 'model output helper is not root-owned 0555' >&2; exit 1; }
fi
run_model_output() {
  /usr/bin/env -i BASH_ENV=/dev/null PATH=/usr/local/bin:/usr/bin:/bin /bin/bash --noprofile --norc "$MODEL_OUTPUT_HELPER" "$@"
}
export PATH=/usr/local/bin:/usr/bin:/bin
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_NO_REPLACE_OBJECTS=1 GIT_OPTIONAL_LOCKS=0
while IFS='=' read -r _sec001_git_env _; do
  case "$_sec001_git_env" in
    GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS|GIT_CONFIG_KEY_*|GIT_CONFIG_VALUE_*|GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_COMMON_DIR|GIT_REPLACE_REF_BASE) unset "$_sec001_git_env" || true ;;
  esac
done < <(env)
git_secure() { /usr/bin/git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.untrackedCache=false "$@"; }
work=''
GATE_PARENT=''
RESULTS_STREAM=''
RESPONSES_LIST=''
GATE_WORK_KEY=''
cleanup() {
  local status=$?
  rm -f -- "${RESULTS_STREAM:-}" "${RESPONSES_LIST:-}" 2>/dev/null || true
  if [ "${SEC001_TEST_MODE:-}" = 1 ]; then
    rm -rf -- "$GATE_PARENT" 2>/dev/null || true
  else
    sudo rm -rf -- "$GATE_PARENT" 2>/dev/null || true
    if [ -n "$GATE_WORK_KEY" ]; then
      sudo rm -f "/var/lib/sec001/gate-inode-sec001-verify-${GATE_WORK_KEY}" 2>/dev/null || true
      sudo rm -rf "/opt/sec001-snapshot-sec001-verify-${GATE_WORK_KEY}" 2>/dev/null || true
    fi
    # Every per-PR gate binding, not just the last one: GATE_WORK_KEY is
    # overwritten on each PR, so a single-key cleanup would leak N-1
    # root-owned inode-binding files for a batched run.
    sudo sh -c 'rm -f /var/lib/sec001/gate-inode-sec001-verify-* /opt/sec001-snapshot-sec001-verify-*' 2>/dev/null || true
  fi
  return "$status"
}
# Create the (root-owned, in production) gate work root only AFTER the exit
# trap is armed, so a failure in the mktemp/chmod window cannot leak it.
trap cleanup EXIT
if [ "${SEC001_TEST_MODE:-}" = 1 ]; then
  GATE_PARENT=$(mktemp -d)
  chmod 0711 "$GATE_PARENT"
else
  GATE_PARENT=$(sudo mktemp -d /opt/sec001-work.XXXXXX)
  sudo chmod 0711 "$GATE_PARENT"
fi
mkdir -p "$OUTPUT"
LOG="$OUTPUT/verification.log"; : > "$LOG"
VERIFICATIONS='[]'
add_verification() { VERIFICATIONS=$(jq -c --argjson item "$1" '. + [$item]' <<<"$VERIFICATIONS"); }
jq -e --arg run "$RUN_ID" --arg base "$BASE_SHA" '.run_id == $run and .base_sha == $base and (.results | type == "array" and length > 0)' "$INPUT/results.json" >/dev/null || { echo 'agent result run/base identity mismatch' >&2; exit 1; }
RESULTS_STREAM=$(mktemp)
if ! jq -ce '.results[]' "$INPUT/results.json" > "$RESULTS_STREAM"; then
  echo 'agent result stream producer failed' >&2
  exit 1
fi
[ -s "$RESULTS_STREAM" ] || { echo 'agent result stream is empty' >&2; exit 1; }
printf '\n' >> "$RESULTS_STREAM"
jq -s -e --slurpfile source "$INPUT/results.json" '. == $source[0].results' "$RESULTS_STREAM" >/dev/null || { echo 'agent result stream is incomplete or malformed' >&2; exit 1; }
RESPONSES_DIR="$INPUT/responses"
[ ! -L "$RESPONSES_DIR" ] || { echo 'agent response directory is a symlink' >&2; exit 1; }
RESPONSES_LIST=$(mktemp)
if [ -e "$RESPONSES_DIR" ]; then
  [ -d "$RESPONSES_DIR" ] || { echo 'agent response path is not a directory' >&2; exit 1; }
  if ! find "$RESPONSES_DIR" -mindepth 1 -maxdepth 1 -print0 > "$RESPONSES_LIST"; then
    echo 'agent response directory could not be enumerated' >&2
    exit 1
  fi
else
  : > "$RESPONSES_LIST"
fi
FIRST_RESULT_ACTION=$(jq -er '.results[0].action' "$INPUT/results.json") || { echo 'result action lookup failed' >&2; exit 1; }
if [ "$FIRST_RESULT_ACTION" != issue ] && [ -s "$RESPONSES_LIST" ]; then
  echo 'PR results must not contain an issue response tree' >&2
  exit 1
fi

while IFS= read -r result; do
  [ -n "$result" ] || continue
  number=$(jq -er '.number | select(type == "number" and . >= 1 and . == floor)' <<<"$result") || { echo 'invalid result number' >&2; exit 1; }
  action=$(jq -er '.action' <<<"$result") || { echo 'result action lookup failed' >&2; exit 1; }
  case "$action" in issue|skip|approved|ready) ;; *) echo 'invalid result action' >&2; exit 1 ;; esac
  result_head_sha=$(jq -r '.head_sha // empty' <<<"$result")
  if [ "$action" = 'issue' ]; then
    verified=false
    reason='invalid issue result or required answer'
    answer_sha256='null'
    if jq -e '
      (keys == ["action", "answer_file", "choice", "has_questions", "number", "patch"]) and
      (.number | type == "number" and . >= 1 and . == floor) and .action == "issue" and .patch == false and
      (.choice == "ready" or .choice == "needs_input" or .choice == "spam" or .choice == "unknown") and
      (.has_questions | type == "boolean") and
      (.answer_file == null or (.answer_file | type == "string"))
    ' <<<"$result" >/dev/null; then
      has_questions=$(jq -r '.has_questions' <<<"$result")
      expected_answer="issue-$number-run-$RUN_ID-answer.txt"
      answer_path="$INPUT/responses/$expected_answer"
      response_count=0
      while IFS= read -r -d '' response; do
        [ -f "$response" ] && [ ! -L "$response" ] || { echo 'issue response entry is not a regular non-symlink file' >&2; exit 1; }
        [ "$(basename -- "$response")" = "$expected_answer" ] || { echo 'unexpected issue response filename' >&2; exit 1; }
        response_count=$((response_count + 1))
      done < "$RESPONSES_LIST"
      if [ "$has_questions" = true ]; then
        result_answer_file=$(jq -r '.answer_file' <<<"$result") || { echo 'issue answer filename lookup failed' >&2; exit 1; }
        if [ "$response_count" -eq 1 ] && [ "$result_answer_file" = "$expected_answer" ] && [ -f "$answer_path" ] && [ ! -L "$answer_path" ] && run_model_output answer "$answer_path" >/dev/null; then
          verified=true
          reason='bounded required issue answer validated'
          answer_sha256=$(sha256sum "$answer_path" | awk '{print $1}')
        else
          reason='required issue answer missing or invalid'
        fi
      elif jq -e '.answer_file == null' <<<"$result" >/dev/null && [ "$response_count" -eq 0 ] && [ ! -e "$answer_path" ] && [ ! -L "$answer_path" ]; then
        verified=true
        reason='issue has no required answer'
      else
        reason='unexpected issue answer state'
      fi
    fi
    add_verification "$(jq -n --argjson number "$number" --arg action "$action" --argjson verified "$verified" --arg reason "$reason" --arg answer_sha256 "$answer_sha256" '{number:$number,action:$action,verified:$verified,reason:$reason,answer_sha256:(if $answer_sha256 == "null" then null else $answer_sha256 end)}')"
    continue
  fi
  case "$action" in
    skip)
      jq -e '(keys == ["action", "head_sha", "number", "patch", "reason"]) and (.number | type == "number" and . >= 1 and . == floor) and .action == "skip" and .patch == false and (.reason | type == "string" and length > 0 and length <= 2000)' <<<"$result" >/dev/null || { echo 'invalid skip result schema' >&2; exit 1; }
      ;;
    approved|ready)
      jq -e '(keys == ["action", "head_sha", "needs_merge", "number", "patch"]) and (.number | type == "number" and . >= 1 and . == floor) and (.needs_merge | type == "boolean") and (.patch | type == "boolean") and (.patch == false or .needs_merge == true)' <<<"$result" >/dev/null || { echo 'invalid PR result schema' >&2; exit 1; }
      ;;
  esac
  [[ "$result_head_sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'PR result head is missing or invalid' >&2; exit 1; }
  patch=$(jq -er '.patch | if type == "boolean" then (if . then "true" else "false" end) else error("patch must be boolean") end' <<<"$result") || { echo 'patch flag lookup failed' >&2; exit 1; }
  if [ "$patch" != true ]; then
    add_verification "$(jq -n --argjson number "$number" --arg action "$action" --arg head_sha "$result_head_sha" '{number:$number,action:$action,verified:true,head_sha:$head_sha,reason:"no repository patch"}')"
    continue
  fi
  patch_dir="$INPUT/patches/pr-$number"
  [ -d "$patch_dir" ] || { add_verification "$(jq -n --argjson number "$number" --arg action "$action" '{number:$number,action:$action,verified:false,reason:"patch artifact missing"}')"; continue; }
  head_sha=$(jq -er '.base_sha' "$patch_dir/metadata.json" 2>/dev/null) || { add_verification "$(jq -n --argjson number "$number" --arg action "$action" '{number:$number,action:$action,verified:false,reason:"patch metadata producer failed"}')"; continue; }
  [ -n "$head_sha" ] && [ "$head_sha" != null ] || { add_verification "$(jq -n --argjson number "$number" --arg action "$action" '{number:$number,action:$action,verified:false,reason:"patch base missing"}')"; continue; }
  if [[ ! "$head_sha" =~ ^[0-9a-f]{40}$ ]] || [ "$head_sha" != "$result_head_sha" ]; then
    add_verification "$(jq -n --argjson number "$number" --arg action "$action" --arg head_sha "$result_head_sha" '{number:$number,action:$action,verified:false,head_sha:$head_sha,reason:"patch base does not match result head"}')"
    continue
  fi
  work="$GATE_PARENT/pr-$number"
  GATE_WORK_KEY=$(printf '%s' "$work" | sha256sum | awk '{print $1}')
  if [ "${SEC001_TEST_MODE:-}" = 1 ]; then rm -rf "$work"; mkdir -p "$work"; else sudo rm -rf "$work"; sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0755 "$work"; fi
  if ! git_secure -C "$work" init -q || ! git_secure -C "$work" remote add origin "$REMOTE" || ! git_secure -C "$work" -c core.hooksPath=/dev/null -c core.fsmonitor=false fetch --no-tags --depth=1 origin "$head_sha" >/dev/null 2>&1 || ! git_secure -C "$work" checkout -q -B verify "$head_sha"; then
    echo "PR #$number: could not create isolated verification checkout" >> "$LOG"
    rm -rf "$work"
    add_verification "$(jq -n --argjson number "$number" --arg action "$action" '{number:$number,action:$action,verified:false,reason:"checkout failed"}')"
    continue
  fi
  RC=0
  if ! (cd "$work" && bash "$ARTIFACT_HELPER" apply --artifact "$patch_dir" --expected-run-id "$RUN_ID" --expected-base-sha "$head_sha" --expected-attempt 1 --expected-phase conflict --allow-prefix lib/ --allow-prefix action/ --allow-prefix app/ --allow-prefix cli/ --allow-prefix platform/ --allow-prefix docs/ --allow-prefix tests/) >>"$LOG" 2>&1; then RC=1; else
    if ! bash "$GATE_RUNNER" --direct "$work" pnpm install --frozen-lockfile >>"$LOG" 2>&1; then RC=1; else
      bash "$GATE_RUNNER" "$work" pnpm build >>"$LOG" 2>&1 || RC=1
      bash "$GATE_RUNNER" "$work" pnpm typecheck >>"$LOG" 2>&1 || RC=1
      bash "$GATE_RUNNER" "$work" pnpm test >>"$LOG" 2>&1 || RC=1
      bash "$GATE_RUNNER" "$work" pnpm lint >>"$LOG" 2>&1 || RC=1
      bash "$GATE_RUNNER" "$work" pnpm doc:check >>"$LOG" 2>&1 || RC=1
    fi
  fi
  if [ "${SEC001_TEST_MODE:-}" = 1 ]; then rm -rf "$work"; else sudo rm -rf "$work"; fi
  if [ "${SEC001_TEST_MODE:-}" != 1 ]; then
    WORK_KEY=$(printf '%s' "$work" | sha256sum | awk '{print $1}')
    sudo rm -f "/var/lib/sec001/gate-inode-sec001-verify-${WORK_KEY}"
    sudo rm -rf "/opt/sec001-snapshot-sec001-verify-${WORK_KEY}"
  fi
  if [ "$RC" -eq 0 ]; then VERIFIED=true; REASON='all isolated gates passed'; else VERIFIED=false; REASON='isolated gate or patch validation failed'; fi
  add_verification "$(jq -n --argjson number "$number" --argjson verified "$VERIFIED" --arg head_sha "$head_sha" --arg action "$action" --arg reason "$REASON" '{number:$number,action:$action,verified:$verified,head_sha:$head_sha,reason:$reason}')"
done < "$RESULTS_STREAM"

jq -n --arg run_id "$RUN_ID" --arg base_sha "$BASE_SHA" --argjson verifications "$VERIFICATIONS" '{run_id:$run_id,base_sha:$base_sha,phase:"verify",verifications:$verifications}' > "$OUTPUT/status.json"
FAILED_VERIFICATIONS=$(jq -r '[.verifications[] | select(.verified == false)] | length' "$OUTPUT/status.json") || { echo 'verification summary lookup failed' >&2; exit 1; }
if [ "$FAILED_VERIFICATIONS" -eq 0 ]; then ALL=true; else ALL=false; fi
bash "$ARTIFACT_HELPER" status --output "$OUTPUT/status-artifact" --run-id "$RUN_ID" --base-sha "$BASE_SHA" --phase verify --verified "$ALL" --log "$LOG" --status-file "$OUTPUT/status.json"
printf 'all_verified=%s\n' "$ALL" > "$OUTPUT/result.env"
chmod 0644 "$OUTPUT/status.json" "$OUTPUT/result.env"
if [ "$ALL" = true ]; then exit 0; else exit 1; fi
