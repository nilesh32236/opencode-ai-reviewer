#!/usr/bin/env bash
# Process the read-only hourly task manifest in an isolated, provider-only job.
# It never receives a GitHub token and emits decisions/patches for a separate
# no-secret verifier and GitHub-token-only publisher.
set -euo pipefail
umask 077

TASKS=''; OUTPUT=''; REPO=''; BASE_SHA=''; MODEL=''; OPENCODE_WRAPPER=''; ARTIFACT_HELPER=''; MODEL_OUTPUT_HELPER=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tasks) TASKS="${2:-}"; shift 2 ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --base-sha) BASE_SHA="${2:-}"; shift 2 ;;
    --model) MODEL="${2:-}"; shift 2 ;;
    --opencode-wrapper) OPENCODE_WRAPPER="${2:-}"; shift 2 ;;
    --artifact-helper) ARTIFACT_HELPER="${2:-}"; shift 2 ;;
    --model-output-helper) MODEL_OUTPUT_HELPER="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$TASKS" ] && [ -n "$OUTPUT" ] && [ -n "$REPO" ] && [ -n "$BASE_SHA" ] && [ -n "$MODEL" ] && [ -n "$OPENCODE_WRAPPER" ] && [ -n "$ARTIFACT_HELPER" ] && [ -n "$MODEL_OUTPUT_HELPER" ] || { echo 'missing hourly agent arguments' >&2; exit 2; }
[ -f "$TASKS" ] && [ ! -L "$TASKS" ] || { echo 'tasks artifact is missing or symlinked' >&2; exit 1; }
RUN_ID=$(jq -er '.run_id | select(type == "string" and test("^[0-9]+$"))' "$TASKS") || { echo 'task run_id is missing or invalid' >&2; exit 1; }
[ -x "$MODEL_OUTPUT_HELPER" ] || { echo 'model output helper is missing or not executable' >&2; exit 1; }
AGENT_TMP_ROOT=$(mktemp -d)
cleanup() { rm -rf -- "$AGENT_TMP_ROOT"; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
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
mkdir -p "$OUTPUT/patches" "$OUTPUT/responses"
RESULTS='[]'
REMOTE="https://github.com/$REPO.git"
MODEL_PROVIDER="${MODEL%%/*}"
case "$MODEL_PROVIDER" in opencode|openai|anthropic|google|gemini) ;; *) echo "unsupported model provider" >&2; exit 1 ;; esac
if [ -n "${SEC001_PROVIDER_KEY_FILE:-}" ]; then
  [ -f "$SEC001_PROVIDER_KEY_FILE" ] && [ ! -L "$SEC001_PROVIDER_KEY_FILE" ] || { echo 'provider credential file is missing or symlinked' >&2; exit 1; }
  [ "$(wc -c < "$SEC001_PROVIDER_KEY_FILE")" -le 8192 ] || { echo 'provider credential file exceeds size limit' >&2; exit 1; }
  PROVIDER_VALUE=$(cat "$SEC001_PROVIDER_KEY_FILE")
  rm -f -- "$SEC001_PROVIDER_KEY_FILE"
  case "$MODEL_PROVIDER" in
    opencode) PROVIDER_KEY_NAME=OPENCODE_API_KEY ;;
    openai) PROVIDER_KEY_NAME=OPENAI_API_KEY ;;
    anthropic) PROVIDER_KEY_NAME=ANTHROPIC_API_KEY ;;
    google|gemini) PROVIDER_KEY_NAME=GEMINI_API_KEY ;;
  esac
  export "$PROVIDER_KEY_NAME=$PROVIDER_VALUE"
  unset SEC001_PROVIDER_KEY_FILE PROVIDER_VALUE
fi
if [ "$MODEL_PROVIDER" = opencode ] && [ -n "${SEC001_CONTEXT7_KEY_FILE:-}" ]; then
  [ -f "$SEC001_CONTEXT7_KEY_FILE" ] && [ ! -L "$SEC001_CONTEXT7_KEY_FILE" ] || { echo 'Context7 credential file is missing or symlinked' >&2; exit 1; }
  [ "$(wc -c < "$SEC001_CONTEXT7_KEY_FILE")" -le 8192 ] || { echo 'Context7 credential file exceeds size limit' >&2; exit 1; }
  CONTEXT7_PROVIDER_VALUE=$(cat "$SEC001_CONTEXT7_KEY_FILE")
  rm -f -- "$SEC001_CONTEXT7_KEY_FILE"
  export CONTEXT7_API_KEY="$CONTEXT7_PROVIDER_VALUE"
  unset SEC001_CONTEXT7_KEY_FILE CONTEXT7_PROVIDER_VALUE
elif [ "$MODEL_PROVIDER" != opencode ] && [ -n "${SEC001_CONTEXT7_KEY_FILE:-}" ]; then
  [ -f "$SEC001_CONTEXT7_KEY_FILE" ] && [ ! -L "$SEC001_CONTEXT7_KEY_FILE" ] || { echo 'Context7 credential file is missing or symlinked' >&2; exit 1; }
  [ "$(wc -c < "$SEC001_CONTEXT7_KEY_FILE")" -le 8192 ] || { echo 'Context7 credential file exceeds size limit' >&2; exit 1; }
  [ ! -s "$SEC001_CONTEXT7_KEY_FILE" ] || { echo 'Context7 credential is not valid for this provider' >&2; exit 1; }
  rm -f -- "$SEC001_CONTEXT7_KEY_FILE"
  unset SEC001_CONTEXT7_KEY_FILE
fi

run_model() {
  local prompt="$1" output="$2" staging=''
  staging=$(mktemp "$AGENT_TMP_ROOT/model-output.XXXXXX") || return 1
  # Keep diagnostics out of the model-output contract; stderr is not published.
  # The inherited file-size limit bounds the producer's stdout file, and the
  # trusted helper validates it before it can influence a result. The file-size
  # limit is inherited by provider/tool subprocesses and fails closed on
  # overflow before a model can consume unbounded runner disk. Stage privately,
  # then install through the hardened no-follow model-output writer so a
  # concurrent writer cannot replace an output path during publication.
  if ! (
    ulimit -f 1024
    /usr/bin/setsid /usr/bin/timeout --kill-after=5s 10m /bin/bash "$OPENCODE_WRAPPER" "$prompt" "$MODEL" > "$staging" 2>/dev/null &
    model_pid=$!
    set +e
    wait "$model_pid"
    model_rc=$?
    set -e
    kill -TERM -- "-$model_pid" 2>/dev/null || true
    kill -KILL -- "-$model_pid" 2>/dev/null || true
    exit "$model_rc"
  ); then
    rm -f -- "$staging"
    return 1
  fi
  if ! run_model_output write "$output" < "$staging"; then
    rm -f -- "$staging"
    return 1
  fi
  rm -f -- "$staging"
}

add_result() {
  local result="$1"
  RESULTS=$(jq -c --argjson item "$result" '. + [$item]' <<<"$RESULTS")
}

MODE=$(jq -er '.mode' "$TASKS") || { echo 'task mode lookup failed' >&2; exit 1; }
if [ "$MODE" = 'prs' ]; then
  jq -e '.prs | type == "array"' "$TASKS" >/dev/null
  TASKS_STREAM="$AGENT_TMP_ROOT/tasks.stream"
  if ! jq -c '.prs[]' "$TASKS" > "$TASKS_STREAM"; then
    echo 'task stream producer failed' >&2
    exit 1
  fi
  [ -s "$TASKS_STREAM" ] || { echo 'task stream is empty' >&2; exit 1; }
  printf '\n' >> "$TASKS_STREAM"
  jq -s -e --slurpfile source "$TASKS" '. == $source[0].prs' "$TASKS_STREAM" >/dev/null || { echo 'task stream is incomplete or malformed' >&2; exit 1; }
  while IFS= read -r task; do
    [ -n "$task" ] || continue
    number=$(jq -er '.number | select(type == "number" and . >= 1 and . == floor)' <<<"$task") || { echo 'PR task number is invalid' >&2; exit 1; }
    head_ref=$(jq -er '.head_ref' <<<"$task") || { echo 'PR task head ref is invalid' >&2; exit 1; }
    head_sha=$(jq -er '.head_sha' <<<"$task") || { echo 'PR task head SHA is invalid' >&2; exit 1; }
    base_ref=$(jq -er '.base_ref' <<<"$task") || { echo 'PR task base ref is invalid' >&2; exit 1; }
    title=$(jq -r '.title // ""' <<<"$task") || { echo 'PR task title lookup failed' >&2; exit 1; }
    mergeable=$(jq -r '.mergeable // "UNKNOWN"' <<<"$task") || { echo 'PR task mergeability lookup failed' >&2; exit 1; }
    labels=$(jq -r '(.labels // []) | map(if type == "object" then (.name // "") else tostring end) | join("\n")' <<<"$task") || { echo 'PR task labels lookup failed' >&2; exit 1; }
    is_cross_repository=$(jq -er '.is_cross_repository | if type == "boolean" then (if . then "true" else "false" end) else error("is_cross_repository must be boolean") end' <<<"$task") || { add_result "$(jq -n --argjson number "$number" --arg head_sha "$head_sha" --arg reason 'invalid task repository binding' '{number:$number,action:"skip",reason:$reason,head_sha:$head_sha,patch:false}')"; continue; }
    if [ "$is_cross_repository" = true ] || [ "$base_ref" != main ] || [ "$head_ref" = main ] || ! git_secure check-ref-format --branch "$head_ref" >/dev/null 2>&1; then
      add_result "$(jq -n --argjson number "$number" --arg head_sha "$head_sha" --arg reason 'invalid or cross-repository head' '{number:$number,action:"skip",reason:$reason,head_sha:$head_sha,patch:false}')"
      continue
    fi
    work=$(mktemp -d "$AGENT_TMP_ROOT/work.XXXXXX")
    git_secure -C "$work" init -q
    git_secure -C "$work" remote add origin "$REMOTE"
    git_secure -C "$work" -c core.hooksPath=/dev/null -c core.fsmonitor=false fetch --no-tags --depth=1 origin "$head_ref" >/dev/null 2>&1 || { add_result "$(jq -n --argjson number "$number" --arg head_sha "$head_sha" --arg reason 'head fetch failed' '{number:$number,action:"skip",reason:$reason,head_sha:$head_sha,patch:false}')"; continue; }
    fetched=$(git_secure -C "$work" rev-parse FETCH_HEAD)
    [ "$fetched" = "$head_sha" ] || { add_result "$(jq -n --argjson number "$number" --arg head_sha "$head_sha" --arg reason 'head moved' '{number:$number,action:"skip",reason:$reason,head_sha:$head_sha,patch:false}')"; continue; }
    git_secure -C "$work" checkout -q -B candidate "$head_sha"
    needs_merge=false; patch_dir=''
    if [ "$mergeable" = 'DIRTY' ] || ! git_secure -C "$work" merge-base --is-ancestor "$BASE_SHA" "$head_sha" 2>/dev/null; then
      needs_merge=true
      git_secure -C "$work" fetch --no-tags --depth=1 origin main >/dev/null 2>&1 || true
      if ! git_secure -C "$work" merge --no-commit --no-ff FETCH_HEAD >/dev/null 2>&1; then
        safe_ref=$(printf '%s' "$head_ref" | tr -d '`' | tr '\n\r' '  ' | head -c 200)
        {
          printf '%s\n' 'Resolve merge conflicts between the PR head and main in this temporary checkout.'
          printf '%s\n' 'Do not run git commit or push. Remove conflict markers, preserve strict TypeScript/ESM rules, and leave all resolutions in the working tree.'
          printf 'PR head: %s\n' "$safe_ref"
        } > "$work/conflict-prompt.txt"
        if ! run_model "$work/conflict-prompt.txt" "$work/conflict-output.txt"; then
          git_secure -C "$work" merge --abort >/dev/null 2>&1 || true
          add_result "$(jq -n --argjson number "$number" --arg head_sha "$head_sha" --arg reason 'conflict model failed' '{number:$number,action:"skip",reason:$reason,head_sha:$head_sha,patch:false}')"
          continue
        fi
        git_secure -C "$work" add -A
        patch_dir="$OUTPUT/patches/pr-$number"
        (cd "$work" && bash "$ARTIFACT_HELPER" create --output "$patch_dir" --run-id "$RUN_ID" --base-sha "$head_sha" --attempt 1 --phase conflict --allow-prefix lib/ --allow-prefix action/ --allow-prefix app/ --allow-prefix cli/ --allow-prefix platform/ --allow-prefix docs/ --allow-prefix tests/)
      fi
    fi
    if printf '%s\n' "$labels" | grep -Fxq 'autofix:ready'; then
      add_result "$(jq -n --argjson number "$number" --arg head_sha "$head_sha" --argjson needs_merge "$needs_merge" --arg patch "${patch_dir:-}" '{number:$number,action:"ready",needs_merge:$needs_merge,head_sha:$head_sha,patch:($patch != "")}')"
      continue
    fi
    safe_title=$(printf '%s' "$title" | tr -d '`' | tr '\n\r' '  ' | head -c 200)
    {
      printf 'Review PR #%s titled "%s" in the temporary checkout. Do not commit or push.\n' "$number" "$safe_title"
      printf '%s\n' 'Return the final line as JSON: {"approved":true,"confidence":"high","reason":"..."} or {"approved":false,"confidence":"low","reason":"..."}.'
    } > "$work/review-prompt.txt"
    if ! run_model "$work/review-prompt.txt" "$work/review-output.txt"; then
      add_result "$(jq -n --argjson number "$number" --arg head_sha "$head_sha" --arg reason 'review model failed' '{number:$number,action:"skip",reason:$reason,head_sha:$head_sha,patch:false}')"
      continue
    fi
    if decision=$(run_model_output approval "$work/review-output.txt" 2>/dev/null) && jq -e '.approved == true and .confidence == "high"' <<<"$decision" >/dev/null 2>&1; then
      add_result "$(jq -n --argjson number "$number" --arg head_sha "$head_sha" --argjson needs_merge "$needs_merge" --arg patch "${patch_dir:-}" '{number:$number,action:"approved",needs_merge:$needs_merge,head_sha:$head_sha,patch:($patch != "")}')"
    else
      add_result "$(jq -n --argjson number "$number" --arg head_sha "$head_sha" --arg reason 'not high-confidence approved' '{number:$number,action:"skip",reason:$reason,head_sha:$head_sha,patch:false}')"
    fi
  done < "$TASKS_STREAM"
else
  jq -e '.issue | type == "object"' "$TASKS" >/dev/null
  issue=$(jq -c '.issue' "$TASKS")
  number=$(jq -er '.number | select(type == "number" and . >= 1 and . == floor)' <<<"$issue") || { echo 'issue number is invalid' >&2; exit 1; }
  title=$(jq -r '.title // ""' <<<"$issue") || { echo 'issue title lookup failed' >&2; exit 1; }
  body=$(jq -r '.body // ""' <<<"$issue") || { echo 'issue body lookup failed' >&2; exit 1; }
  comments=$(jq -r '(.comments // []) | map(.body // "") | join("\n")' <<<"$issue") || { echo 'issue comments lookup failed' >&2; exit 1; }
  work=$(mktemp -d "$AGENT_TMP_ROOT/work.XXXXXX")
  has_questions=$(jq -er '.has_questions | if type == "boolean" then (if . then "true" else "false" end) else error("has_questions must be boolean") end' <<<"$issue") || { echo 'issue has_questions must be boolean' >&2; exit 1; }
  answer_file=''
  if [ "$has_questions" = true ]; then
    answer_file="issue-$number-run-$RUN_ID-answer.txt"
    {
      printf 'Answer the pending questions for issue #%s, titled "%s", using the issue body and comments.\n' "$number" "$title"
      printf '%s\n' 'Return only the answer text. Do not access credentials or run git operations.'
      printf 'Body: %s\nComments: %s\n' "$body" "$comments"
    } > "$work/answer-prompt.txt"
    if ! run_model "$work/answer-prompt.txt" "$work/answer.txt"; then
      echo "issue $number answer model failed" >&2
      exit 1
    fi
    if ! run_model_output answer "$work/answer.txt" "$OUTPUT/responses/$answer_file"; then
      echo "issue $number answer failed required output validation" >&2
      exit 1
    fi
  fi
  {
    printf 'Classify issue #%s as exactly one of: ready, needs_input, spam.\n' "$number"
    printf 'Return only one word on the final line. Title: %s\nBody: %s\n' "$title" "$body"
  } > "$work/triage-prompt.txt"
  choice=unknown
  if run_model "$work/triage-prompt.txt" "$work/triage.txt"; then
    choice=$(run_model_output triage "$work/triage.txt" 2>/dev/null || printf 'unknown\n')
  fi
  [ -n "$choice" ] || choice=unknown
  add_result "$(jq -n --argjson number "$number" --arg choice "$choice" --argjson has_questions "$has_questions" --arg answer_file "$answer_file" '{number:$number,action:"issue",choice:$choice,has_questions:$has_questions,answer_file:(if $has_questions then $answer_file else null end),patch:false}')"
fi

jq -n --arg run_id "$RUN_ID" --arg base_sha "$BASE_SHA" --argjson results "$RESULTS" '{run_id:$run_id,base_sha:$base_sha,results:$results}' | run_model_output write "$OUTPUT/results.json"
