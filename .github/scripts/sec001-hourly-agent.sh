#!/usr/bin/env bash
# Process the read-only hourly task manifest in an isolated, provider-only job.
# It never receives a GitHub token and emits decisions/patches for a separate
# no-secret verifier and GitHub-token-only publisher.
set -euo pipefail

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
[ -f "$TASKS" ] || { echo 'tasks artifact is missing' >&2; exit 1; }
[ -x "$MODEL_OUTPUT_HELPER" ] || { echo 'model output helper is missing or not executable' >&2; exit 1; }
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

run_model() {
  local prompt="$1" output="$2"
  # Keep diagnostics out of the model-output contract; stderr is not published
  # and cannot inject approval JSON or unbounded response text.
  timeout 10m bash "$OPENCODE_WRAPPER" "$prompt" "$MODEL" > "$output" 2>/dev/null
}

add_result() {
  local result="$1"
  RESULTS=$(jq -c --argjson item "$result" '. + [$item]' <<<"$RESULTS")
}

if [ "$(jq -r '.mode' "$TASKS")" = 'prs' ]; then
  while IFS= read -r task; do
    [ -n "$task" ] || continue
    number=$(jq -r '.number' <<<"$task")
    head_ref=$(jq -r '.head_ref' <<<"$task")
    head_sha=$(jq -r '.head_sha' <<<"$task")
    title=$(jq -r '.title' <<<"$task")
    mergeable=$(jq -r '.mergeable' <<<"$task")
    labels=$(jq -r '.labels | join("\n")' <<<"$task")
    if [ "$(jq -r '.is_cross_repository' <<<"$task")" = true ] || ! git_secure check-ref-format --branch "$head_ref" >/dev/null 2>&1; then
      add_result "$(jq -n --argjson number "$number" --arg reason 'invalid or cross-repository head' '{number:$number,action:"skip",reason:$reason,patch:false}')"
      continue
    fi
    work=$(mktemp -d)
    git_secure -C "$work" init -q
    git_secure -C "$work" remote add origin "$REMOTE"
    git_secure -C "$work" -c core.hooksPath=/dev/null -c core.fsmonitor=false fetch --no-tags --depth=1 origin "$head_ref" >/dev/null 2>&1 || { add_result "$(jq -n --argjson number "$number" --arg reason 'head fetch failed' '{number:$number,action:"skip",reason:$reason,patch:false}')"; continue; }
    fetched=$(git_secure -C "$work" rev-parse FETCH_HEAD)
    [ "$fetched" = "$head_sha" ] || { add_result "$(jq -n --argjson number "$number" --arg reason 'head moved' '{number:$number,action:"skip",reason:$reason,patch:false}')"; continue; }
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
          add_result "$(jq -n --argjson number "$number" --arg reason 'conflict model failed' '{number:$number,action:"skip",reason:$reason,patch:false}')"
          continue
        fi
        git_secure -C "$work" add -A
        patch_dir="$OUTPUT/patches/pr-$number"
        (cd "$work" && bash "$ARTIFACT_HELPER" create --output "$patch_dir" --run-id "$(jq -r '.run_id' "$TASKS")" --base-sha "$head_sha" --attempt 1 --phase conflict --allow-prefix lib/ --allow-prefix action/ --allow-prefix app/ --allow-prefix cli/ --allow-prefix platform/ --allow-prefix docs/ --allow-prefix tests/)
      fi
    fi
    if printf '%s\n' "$labels" | grep -Fxq 'autofix:ready'; then
      add_result "$(jq -n --argjson number "$number" --argjson needs_merge "$needs_merge" --arg patch "${patch_dir:-}" '{number:$number,action:"ready",needs_merge:$needs_merge,patch:($patch != "")}')"
      continue
    fi
    safe_title=$(printf '%s' "$title" | tr -d '`' | tr '\n\r' '  ' | head -c 200)
    {
      printf 'Review PR #%s titled "%s" in the temporary checkout. Do not commit or push.\n' "$number" "$safe_title"
      printf '%s\n' 'Return the final line as JSON: {"approved":true,"confidence":"high","reason":"..."} or {"approved":false,"confidence":"low","reason":"..."}.'
    } > "$work/review-prompt.txt"
    if ! run_model "$work/review-prompt.txt" "$work/review-output.txt"; then
      add_result "$(jq -n --argjson number "$number" --arg reason 'review model failed' '{number:$number,action:"skip",reason:$reason,patch:false}')"
      continue
    fi
    if bash "$MODEL_OUTPUT_HELPER" approval "$work/review-output.txt" > "$work/review-decision.json" 2>/dev/null && jq -e '.approved == true and .confidence == "high"' "$work/review-decision.json" >/dev/null 2>&1; then
      add_result "$(jq -n --argjson number "$number" --argjson needs_merge "$needs_merge" --arg patch "${patch_dir:-}" '{number:$number,action:"approved",needs_merge:$needs_merge,patch:($patch != "")}')"
    else
      add_result "$(jq -n --argjson number "$number" --arg reason 'not high-confidence approved' '{number:$number,action:"skip",reason:$reason,patch:false}')"
    fi
  done < <(jq -c '.prs[]' "$TASKS")
else
  issue=$(jq -c '.issue' "$TASKS")
  number=$(jq -r '.number' <<<"$issue")
  title=$(jq -r '.title' <<<"$issue")
  body=$(jq -r '.body // ""' <<<"$issue")
  comments=$(jq -r '(.comments // []) | map(.body // "") | join("\n")' <<<"$issue")
  work=$(mktemp -d)
  if [ "$(jq -r '.has_questions' <<<"$issue")" = true ]; then
    {
      printf 'Answer the pending questions for issue #%s, titled "%s", using the issue body and comments.\n' "$number" "$title"
      printf '%s\n' 'Return only the answer text. Do not access credentials or run git operations.'
      printf 'Body: %s\nComments: %s\n' "$body" "$comments"
    } > "$work/answer-prompt.txt"
    if run_model "$work/answer-prompt.txt" "$work/answer.txt" && bash "$MODEL_OUTPUT_HELPER" text "$work/answer.txt" >/dev/null; then cp "$work/answer.txt" "$OUTPUT/responses/issue-$number-answer.txt"; fi
  fi
  {
    printf 'Classify issue #%s as exactly one of: ready, needs_input, spam.\n' "$number"
    printf 'Return only one word on the final line. Title: %s\nBody: %s\n' "$title" "$body"
  } > "$work/triage-prompt.txt"
  choice=unknown
  if run_model "$work/triage-prompt.txt" "$work/triage.txt"; then choice=$(tail -20 "$work/triage.txt" | grep -E '^(ready|needs_input|spam)$' | tail -1 || true); fi
  [ -n "$choice" ] || choice=unknown
  add_result "$(jq -n --argjson number "$number" --arg choice "$choice" --argjson has_questions "$(jq -r '.has_questions' <<<"$issue")" '{number:$number,action:"issue",choice:$choice,has_questions:$has_questions,patch:false}')"
fi

jq -n --arg run_id "$(jq -r '.run_id' "$TASKS")" --arg base_sha "$BASE_SHA" --argjson results "$RESULTS" '{run_id:$run_id,base_sha:$base_sha,results:$results}' > "$OUTPUT/results.json"
chmod 0644 "$OUTPUT/results.json"
