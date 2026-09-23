#!/usr/bin/env bash
#
# workflow-health.sh — watchdog sweep for failed workflow runs.
#
# Detects failed runs of the repo's automation workflows, classifies the
# cause, and files (or refreshes) one GitHub issue per failure fingerprint.
# Flaky infra failures are retried automatically (capped); everything else
# is reported for humans or the /fix loop. Recovered workflows close their
# health issue automatically (self-heal closure).
#
# DEDUP DESIGN (do not weaken): concurrent failures must never produce twin
# issues. Guarantees, in order:
#   1. The workflow runs under a single concurrency group
#      (`workflow-health`, cancel-in-progress: false), so simultaneous
#      failures are handled serially, never in parallel.
#   2. Every failure maps to a stable fingerprint
#      sha256(workflow|job|step|normalized-signature); numbers, SHAs,
#      timestamps and durations are stripped before hashing so reruns of the
#      same breakage share one fingerprint.
#   3. The handler re-checks for an open issue carrying the fingerprint
#      immediately before creating (searches the
#      `<!-- health-fingerprint: … -->` marker, not titles).
#   4. Repeat failures append a throttled "still failing" comment (one per
#      6h max) instead of opening.
#
# SECRET HYGIENE: log tails are ANSI-stripped, secret-pattern redacted and
# truncated BEFORE they touch an issue body. Never dump env or full logs.
#
# Usage:
#   DRY_RUN=true  SINCE_HOURS=2  TARGET_RUN_ID=  ./workflow-health.sh
#   TARGET_RUN_ID=<run-id> ./workflow-health.sh   # targeted (workflow_run event)
#
# Env:
#   GH_TOKEN (or GITHUB_TOKEN) must be set; REPO defaults to this repo.
#   DRY_RUN=true prints the plan and changes nothing (no issues, no reruns).
set -euo pipefail

REPO="${GITHUB_REPOSITORY:-nilesh32236/opencode-ai-reviewer}"
DRY_RUN="${DRY_RUN:-true}"
SINCE_HOURS="${SINCE_HOURS:-2}"
TARGET_RUN_ID="${TARGET_RUN_ID:-}"
HEALTH_LABEL="workflow-health"

# Workflows in scope for health tracking.
SCOPE_WORKFLOWS="CI|CodeQL|AI Multi-Agent Review|Daily Scheduled Audit|Upstream Ecosystem Monitor|Hourly Autonomous Orchestrator|Workflow Health"

log() { printf '[health] %s\n' "$*"; }
dry() { printf '[health:dry-run] %s\n' "$*"; }

# --- secret-safe log scrubbing -------------------------------------------
# Mirrors the spirit of lib sanitizeString for the patterns that appear in
# CI logs. Deliberately conservative: redact first, ask never.
scrub_logs() {
  sed -e 's/\x1b\[[0-9;]*m//g' \
    -e 's/\(ghp\|github_pat\|gho\|ghs\|ghu\|ghr\)_[A-Za-z0-9_-]\{10,\}/[REDACTED_GITHUB_TOKEN]/g' \
    -e 's/sk-[A-Za-z0-9-]\{10,\}/[REDACTED_KEY]/g' \
    -e 's/sk-ant-[A-Za-z0-9_-]\{10,\}/[REDACTED_KEY]/g' \
    -e 's/\(Bearer \)[A-Za-z0-9._\/+=~-]\{8,\}/\1[REDACTED]/gI' \
    -e 's/x-access-token:[^@ ]\+@/x-access-token:[REDACTED]@/g' \
    -e 's/\([A-Za-z_]*\(TOKEN\|SECRET\|PASSWORD\|PASSWD\|PRIVATE_KEY\)[A-Za-z_]*\)[=:" ][^ &'"'"'"]\+/\1=[REDACTED]/gI' \
  | tail -n 40 | cut -c1-3000
}

# Normalize a failure signature so reruns hash identically.
normalize_sig() {
  tr 'A-Z' 'a-z' \
    | sed -e 's/[0-9a-f]\{40\}/<sha>/g' -e 's/[0-9a-f]\{7,8\}\b/<sha>/g' \
      -e 's/[0-9]\+/N/g' -e 's/[[:space:]][[:space:]]*/ /g' \
    | cut -c1-300
}

fingerprint() {
  printf '%s|%s|%s|%s' "$1" "$2" "$3" "$4" | sha256sum | cut -d' ' -f1
}

# --- classification --------------------------------------------------------
# Prints one of: noise | flake-infra | action-bug | test-fail
classify() {
  local step="$1" logtail="$2"
  local hay
  hay="$(printf '%s\n%s' "$step" "$logtail" | tr 'A-Z' 'a-z')"
  case "$hay" in
    *coderabbit*|*cancelled*|*"to have the pull request merged"*)
      printf 'noise' ;;
    *src\ refspec*does\ not\ match\ any*|*better-sqlite3*|*no\ meaningful\ content*)
      printf 'action-bug' ;;
    *rate\ limit*|*econnreset*|*etimedout*|*fetch\ failed*|*connection\ refused*|*connection\ reset*|*timed\ out\ after*|*free\ tier*|*provider*error*|*runner*lost*|*runner*offline*|*service\ unavailable*|*bad\ gateway*|*no\ space\ left*)
      printf 'flake-infra' ;;
    *)
      printf 'test-fail' ;;
  esac
}

short_sig_for_title() {
  printf '%s' "$1" | tr '\n' ' ' | sed -e 's/[[:space:]][[:space:]]*/ /g' | cut -c1-80
}

# --- GitHub helpers ----------------------------------------------------------
find_open_issue() {
  local fp="$1" out
  # `gh search issues` (not the /search/issues API path, which 404s for some
  # token scopes); fingerprint matched client-side to avoid query-quoting
  # pitfalls. Numeric guard: any API garbage must not read as an issue.
  out="$(gh search issues --repo "$REPO" --label "$HEALTH_LABEL" --state open \
    --json number,body --jq --arg fp "health-fingerprint: ${fp}" \
    '[.[] | select(.body | contains($fp)) | .number] | first // empty' 2>/dev/null || true)"
  if [[ "$out" =~ ^[0-9]+$ ]]; then printf '%s' "$out"; fi
}

last_health_comment_at() {
  local issue="$1"
  gh api "repos/${REPO}/issues/${issue}/comments?per_page=100" \
    --jq '[.[] | select(.body | contains("<!-- health-update -->")) | .created_at] | max // empty' 2>/dev/null || true
}

hours_since() {
  local ts="$1"
  if [ -z "$ts" ]; then printf '999'; return; fi
  local then now
  then="$(date -d "$ts" +%s 2>/dev/null || date -j -f '%Y-%m-%dT%H:%M:%SZ' "$ts" +%s 2>/dev/null || echo 0)"
  now="$(date +%s)"
  printf '%s' "$(( (now - then) / 3600 ))"
}

ensure_labels() {
  for label in "$HEALTH_LABEL" "health:flake" "health:action-bug" "health:test-fail"; do
    gh label create "$label" --repo "$REPO" --color "d876e3" \
      --description "Managed by workflow-health watchdog" 2>/dev/null || true
  done
}

# --- per-run handling ----------------------------------------------------------
handle_failed_run() {
  local run_id="$1" workflow="$2" branch="$3" title="$4"
  log "failed run $run_id ($workflow @ $branch): $title"

  local jobs_json failed_jobs
  jobs_json="$(gh api "repos/${REPO}/actions/runs/${run_id}/jobs?per_page=50" 2>/dev/null || echo '{}')"
  failed_jobs="$(printf '%s' "$jobs_json" | jq -r '.jobs[]? | select(.conclusion=="failure") | "\(.id)|\(.name)"')"

  if [ -z "$failed_jobs" ]; then
    log "run $run_id: no failed jobs visible (stale logs?) — skipping"
    return 0
  fi

  while IFS='|' read -r job_id job_name; do
    [ -n "$job_id" ] || continue
    local failed_steps logtail
    failed_steps="$(printf '%s' "$jobs_json" | jq -r --arg jid "$job_id" '.jobs[] | select((.id|tostring)==$jid) | .steps[]? | select(.conclusion=="failure") | .name' | head -n 5 | tr '\n' ';')"
    [ -n "$failed_steps" ] || failed_steps="$job_name"
    logtail="$(gh run view "$run_id" --repo "$REPO" --job "$job_id" --log-failed 2>/dev/null | scrub_logs || true)"
    local sig class fp short existing
    sig="$(printf '%s' "$logtail" | grep -viE '^\s*(✓|✔|passed|ok)' | grep -viE 'warning' | tail -n 5 | normalize_sig)"
    [ -n "$sig" ] || sig="$(printf '%s' "$failed_steps" | normalize_sig)"
    class="$(classify "$failed_steps" "$logtail")"
    if [ "$class" = "noise" ]; then
      log "run $run_id job $job_name: classified noise — ignoring"
      continue
    fi
    fp="$(fingerprint "$workflow" "$job_name" "$failed_steps" "$sig")"
    short="$(short_sig_for_title "$failed_steps")"
    log "run $run_id job $job_name: class=$class fp=${fp:0:12}… step=$failed_steps"

    existing="$(find_open_issue "$fp")"
    if [ -n "$existing" ]; then
      local last_at age
      last_at="$(last_health_comment_at "$existing")"
      age="$(hours_since "$last_at")"
      if [ "$age" -ge 6 ]; then
        if [ "$DRY_RUN" = "true" ]; then
          dry "would comment still-failing on #$existing (last update ${age}h ago)"
        else
          gh api "repos/${REPO}/issues/${existing}/comments" -X POST \
            -f body="<!-- health-update -->

Still failing: [run $run_id]($GITHUB_SERVER_URL/${REPO}/actions/runs/$run_id) ($workflow @ \`$branch\`, job \`$job_name\`)." >/dev/null
          log "commented still-failing on #$existing"
        fi
      else
        log "#$existing already notified ${age}h ago — throttled"
      fi
      continue
    fi

    # Re-check immediately before creating (closes the check→create race
    # inside this serialized handler).
    existing="$(find_open_issue "$fp")"
    if [ -n "$existing" ]; then
      log "#$existing appeared during handling — skipping create"
      continue
    fi

    local run_url="${GITHUB_SERVER_URL:-https://github.com}/${REPO}/actions/runs/${run_id}"
    local body="<!-- health-fingerprint: ${fp} -->
<!-- health-workflow: ${workflow} -->
<!-- health-branch: ${branch} -->
<!-- health-update -->

## Workflow failure: $workflow / $job_name

- **Run:** [$run_id]($run_url) on \`$branch\`
- **Failed step(s):** \`$failed_steps\`
- **Class:** \`$class\`
- **Source issue/PR:** $title

### Redacted log tail

\`\`\`
$logtail
\`\`\`

### Suggested next step

$(case "$class" in
      flake-infra) printf 'Infra flake — safe to `gh run rerun %s --failed` (watchdog retries automatically, max 2).' "$run_id" ;;
      action-bug) printf 'Known action-bug signature — do NOT blindly rerun (it will fail identically). Fix the action source or add a signature.' ;;
      *) printf 'Deterministic failure — reproduce locally, fix, verify (build/typecheck/lint/test), push.' ;;
    esac)"

    if [ "$DRY_RUN" = "true" ]; then
      dry "would open: [health] $workflow/$job_name: $short"
      continue
    fi
    local new_issue_url new_issue
    # `gh issue create` prints the issue URL and supports no --jq/--json
    # output flags — the trailing path segment is the issue number.
    # Guarded: one filing failure must not abort the whole sweep under
    # `set -euo pipefail` (remaining jobs + close_recovered still run).
    new_issue_url="$(gh issue create --repo "$REPO" \
      --title "[health] ${workflow}/${job_name}: ${short}" \
      --label "$HEALTH_LABEL" --label "health:${class}" \
      --body "$body")" || {
      log "failed to open issue for $workflow/$job_name — continuing"
      continue
    }
    new_issue="${new_issue_url##*/}"
    new_issue="$(printf '%s' "$new_issue" | tr -d '[:space:]')"
    if [[ ! "$new_issue" =~ ^[0-9]+$ ]]; then new_issue="$new_issue_url"; fi
    log "opened #$new_issue for $workflow/$job_name ($class)"

    # Self-heal, allowlisted to flaky infra only, capped by attempt number.
    if [ "$class" = "flake-infra" ] && [ "$workflow" != "Workflow Health" ]; then
      local attempt
      attempt="$(gh api "repos/${REPO}/actions/runs/${run_id}" --jq '.run_attempt // 1' 2>/dev/null || echo 1)"
      if [ "${attempt:-1}" -lt 3 ]; then
        gh run rerun "$run_id" --repo "$REPO" --failed >/dev/null 2>&1 \
          && log "reran failed jobs of run $run_id (attempt $attempt)" \
          || log "rerun of $run_id refused — left for humans"
      else
        log "run $run_id already attempted ${attempt}x — no further auto-retry"
      fi
    fi
  done <<< "$failed_jobs"
}

# --- recovery sweep ------------------------------------------------------------
close_recovered() {
  local open_health
  open_health="$(gh issue list --repo "$REPO" --label "$HEALTH_LABEL" --state open --limit 50 --json number,body,updatedAt --jq '.[] | "\(.number)|\(.updatedAt)|\(.body | split("\n")[0:6] | join(" "))"')"
  [ -n "$open_health" ] || return 0
  while IFS='|' read -r issue updated wf branch; do
    [ -n "$issue" ] || continue
    wf="$(printf '%s' "$wf" | sed -n 's/.*health-workflow: \([^>]*\) -->.*/\1/p' | xargs || true)"
    branch="$(printf '%s' "$branch" | sed -n 's/.*health-branch: \([^>]*\) -->.*/\1/p' | xargs || true)"
    [ -n "$wf" ] && [ -n "$branch" ] || continue
    # Latest completed run of that workflow on that branch.
    local latest
    latest="$(gh run list --repo "$REPO" --workflow "$wf" --branch "$branch" --status completed --limit 1 --json conclusion,updatedAt --jq '.[0] | "\(.conclusion)|\(.updatedAt)"' 2>/dev/null || true)"
    local concl at
    concl="${latest%%|*}"; at="${latest##*|}"
    if [ "$concl" = "success" ] && [[ "$at" > "$updated" ]]; then
      if [ "$DRY_RUN" = "true" ]; then
        dry "would close #$issue ($wf @ $branch recovered)"
      else
        gh api "repos/${REPO}/issues/${issue}/comments" -X POST \
          -f body="<!-- health-update -->

✅ Recovered: \`$wf\` on \`$branch\` is green again — closing." >/dev/null
        gh issue close "$issue" --repo "$REPO" --reason completed >/dev/null
        log "closed recovered #$issue ($wf @ $branch)"
      fi
    fi
  done <<< "$open_health"
}

# --- main -----------------------------------------------------------------------
main() {
  ensure_labels
  if [ -n "$TARGET_RUN_ID" ]; then
    local meta
    meta="$(gh api "repos/${REPO}/actions/runs/${TARGET_RUN_ID}" --jq '"\(.name)|\(.head_branch)|\(.display_title)|\(.conclusion)"' 2>/dev/null || echo '')"
    if [ -z "$meta" ]; then log "target run $TARGET_RUN_ID not found"; return 0; fi
    local workflow branch rtitle concl
    workflow="${meta%%|*}"; rest="${meta#*|}"; branch="${rest%%|*}"; rest="${rest#*|}"; rtitle="${rest%%|*}"; concl="${rest##*|}"
    case "$workflow" in
      CI|CodeQL|AI\ Multi-Agent\ Review|Daily\ Scheduled\ Audit|Upstream\ Ecosystem\ Monitor|Hourly\ Autonomous\ Orchestrator|Workflow\ Health) ;;
      *) log "run $TARGET_RUN_ID workflow '$workflow' out of scope — skipping"; return 0 ;;
    esac
    if [ "$concl" = "failure" ]; then
      handle_failed_run "$TARGET_RUN_ID" "$workflow" "$branch" "$rtitle"
    else
      log "run $TARGET_RUN_ID concluded $concl — nothing to do"
    fi
    return 0
  fi

  local since cutoff
  cutoff="$(date -u -d "$SINCE_HOURS hours ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-"${SINCE_HOURS}"H +%Y-%m-%dT%H:%M:%SZ)"
  log "sweeping failures since $cutoff (dry_run=$DRY_RUN)"
  local runs
  runs="$(gh run list --repo "$REPO" --limit 100 \
    --json databaseId,name,headBranch,event,conclusion,status,updatedAt,displayTitle \
    | jq -r --arg cutoff "$cutoff" --arg scope "$SCOPE_WORKFLOWS" \
    '.[] | select(.conclusion=="failure" and .updatedAt >= $cutoff and (.name | test($scope))) | "\(.databaseId)|\(.name)|\(.headBranch)|\(.displayTitle)"')"
  if [ -z "$runs" ]; then
    log "no failed runs in scope — all quiet"
  else
    while IFS='|' read -r rid w br t; do
      [ -n "$rid" ] || continue
      handle_failed_run "$rid" "$w" "$br" "$t"
    done <<< "$runs"
  fi
  close_recovered
}

main "$@"
