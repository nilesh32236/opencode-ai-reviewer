#!/usr/bin/env bash
# Verify every patch emitted by the hourly provider-only job on a fresh,
# secret-free checkout. No GitHub token is read or required.
set -euo pipefail

INPUT=''; OUTPUT=''; BASE_SHA=''; RUN_ID=''; REMOTE=''; ARTIFACT_HELPER=''; GATE_RUNNER=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --input) INPUT="${2:-}"; shift 2 ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    --base-sha) BASE_SHA="${2:-}"; shift 2 ;;
    --run-id) RUN_ID="${2:-}"; shift 2 ;;
    --remote) REMOTE="${2:-}"; shift 2 ;;
    --artifact-helper) ARTIFACT_HELPER="${2:-}"; shift 2 ;;
    --gate-runner) GATE_RUNNER="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$INPUT" ] && [ -n "$OUTPUT" ] && [ -n "$BASE_SHA" ] && [ -n "$RUN_ID" ] && [ -n "$REMOTE" ] && [ -n "$ARTIFACT_HELPER" ] && [ -n "$GATE_RUNNER" ] || { echo 'missing hourly verifier arguments' >&2; exit 2; }
[ -f "$INPUT/results.json" ] || { echo 'agent results are missing' >&2; exit 1; }
export PATH=/usr/local/bin:/usr/bin:/bin
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_NO_REPLACE_OBJECTS=1 GIT_OPTIONAL_LOCKS=0
while IFS='=' read -r _sec001_git_env _; do
  case "$_sec001_git_env" in
    GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS|GIT_CONFIG_KEY_*|GIT_CONFIG_VALUE_*|GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_COMMON_DIR|GIT_REPLACE_REF_BASE) unset "$_sec001_git_env" || true ;;
  esac
done < <(env)
git_secure() { /usr/bin/git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.untrackedCache=false "$@"; }
if [ "${SEC001_TEST_MODE:-}" = 1 ]; then
  GATE_PARENT=$(mktemp -d)
  chmod 0711 "$GATE_PARENT"
else
  GATE_PARENT=$(sudo mktemp -d /opt/sec001-work.XXXXXX)
  sudo chmod 0711 "$GATE_PARENT"
fi
work=''
RESULTS_STREAM=''
trap 'rm -f -- "${RESULTS_STREAM:-}"; if [ "${SEC001_TEST_MODE:-}" = 1 ]; then rm -rf -- "$GATE_PARENT"; else sudo rm -rf -- "$GATE_PARENT"; fi' EXIT
mkdir -p "$OUTPUT"
LOG="$OUTPUT/verification.log"; : > "$LOG"
VERIFICATIONS='[]'
add_verification() { VERIFICATIONS=$(jq -c --argjson item "$1" '. + [$item]' <<<"$VERIFICATIONS"); }
jq -e '.results | type == "array" and length > 0' "$INPUT/results.json" >/dev/null
RESULTS_STREAM=$(mktemp)
jq -c '.results[]' "$INPUT/results.json" > "$RESULTS_STREAM"

while IFS= read -r result; do
  [ -n "$result" ] || continue
  number=$(jq -r '.number' <<<"$result")
  case "$number" in ''|*[!0-9]*) echo 'invalid result number' >&2; exit 1 ;; esac
  action=$(jq -r '.action' <<<"$result")
  case "$action" in issue|skip|approved|ready) ;; *) echo 'invalid result action' >&2; exit 1 ;; esac
  if [ "$action" = 'issue' ] || [ "$(jq -r '.patch' <<<"$result")" != true ]; then
    add_verification "$(jq -n --argjson number "$number" --arg action "$action" '{number:$number,action:$action,verified:true,reason:"no repository patch"}')"
    continue
  fi
  patch_dir="$INPUT/patches/pr-$number"
  [ -d "$patch_dir" ] || { add_verification "$(jq -n --argjson number "$number" --arg action "$action" '{number:$number,action:$action,verified:false,reason:"patch artifact missing"}')"; continue; }
  head_sha=$(jq -r '.base_sha' "$patch_dir/metadata.json" 2>/dev/null || true)
  [ -n "$head_sha" ] && [ "$head_sha" != null ] || { add_verification "$(jq -n --argjson number "$number" --arg action "$action" '{number:$number,action:$action,verified:false,reason:"patch base missing"}')"; continue; }
  work="$GATE_PARENT/pr-$number"
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
    sudo rm -f "/var/tmp/sec001-gate-inode-sec001-verify-${WORK_KEY}"
    sudo rm -rf "/opt/sec001-snapshot-sec001-verify-${WORK_KEY}"
  fi
  if [ "$RC" -eq 0 ]; then VERIFIED=true; REASON='all isolated gates passed'; else VERIFIED=false; REASON='isolated gate or patch validation failed'; fi
  result_action=$(jq -r '.action' <<< "$result")
  if [ "$(jq -r '.patch // false' <<< "$result")" = true ]; then
    add_verification "$(jq -n --argjson number "$number" --argjson verified "$VERIFIED" --arg head_sha "$head_sha" --arg action "$result_action" --arg reason "$REASON" '{number:$number,action:$action,verified:$verified,head_sha:$head_sha,reason:$reason}')"
  else
    add_verification "$(jq -n --argjson number "$number" --argjson verified "$VERIFIED" --arg action "$result_action" --arg reason "$REASON" '{number:$number,action:$action,verified:$verified,reason:$reason}')"
  fi
done < "$RESULTS_STREAM"

jq -n --arg run_id "$RUN_ID" --arg base_sha "$BASE_SHA" --argjson verifications "$VERIFICATIONS" '{run_id:$run_id,base_sha:$base_sha,phase:"verify",verifications:$verifications}' > "$OUTPUT/status.json"
if [ "$(jq '[.verifications[] | select(.verified == false)] | length' "$OUTPUT/status.json")" -eq 0 ]; then ALL=true; else ALL=false; fi
bash "$ARTIFACT_HELPER" status --output "$OUTPUT/status-artifact" --run-id "$RUN_ID" --base-sha "$BASE_SHA" --phase verify --verified "$ALL" --log "$LOG" --status-file "$OUTPUT/status.json"
printf 'all_verified=%s\n' "$ALL" > "$OUTPUT/result.env"
chmod 0644 "$OUTPUT/status.json" "$OUTPUT/result.env"
if [ "$ALL" = true ]; then exit 0; else exit 1; fi
