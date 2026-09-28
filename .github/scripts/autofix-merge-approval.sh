#!/usr/bin/env bash
#
# autofix-merge-approval.sh — shared human-approval gate for autofix merges.
#
# Shell port of the `isMergeAuthorized` contract
# (lib/src/utils/merge-approval.ts, REF-005): `autofix:ready` is an advisory
# AI/CI signal only and must never authorize a merge. Autonomous merges
# additionally require the dedicated `autofix:merge-approved` label applied
# by an explicit human actor, bound to the current head SHA.
#
# The approver is discovered from live PR state via `gh` (no event context
# needed, so schedule-driven callers work too):
#   1. PR must be open and unmerged.
#   2. PR must carry exactly `autofix:merge-approved` (case-insensitive;
#      `autofix:ready`, `autofix:approved` and lookalikes never count), and
#      must NOT carry a forbidden destructive-fix label (`autofix:approved`,
#      `autofix-approve`, `autofix-approved`).
#   3. The actor who most recently applied `autofix:merge-approved` (issues
#      events API) must be a non-bot User.
#   4. That actor must have a privileged association (OWNER when they own
#      the repo, MEMBER when they hold active org membership, COLLABORATOR
#      when they hold privileged collaborator permission) AND privileged
#      collaborator permission (admin/maintain/write, resolved via the API
#      immediately before merge).
#   5. The approval must postdate the current head: any push newer than the
#      latest approval-label event invalidates the approval (head move
#      invalidates; re-approval required after every push).
#
# Callers: .github/workflows/ai-review.yml (auto-merge site) and
# .github/workflows/hourly-orchestrator.yml (ready-label merge site +
# inline-review merge site). All three merge sites call this immediately
# before `gh pr merge`, right after the green-checks gate.
#
# Usage:
#   .github/scripts/autofix-merge-approval.sh <PR_NUMBER> [REPO] [EXPECTED_HEAD_SHA]
#
#   PR_NUMBER  pull request number (required)
#   REPO       owner/repo (default: $GITHUB_REPOSITORY)
#
# Exit codes:
#   0 = approved — caller may merge.
#   1 = denied — a ::warning:: annotation is printed; the caller must NOT
#       merge (hourly retries later) and must stay exit 0 itself.
#   2 = usage/environment error (missing args, gh/jq unavailable).
set -euo pipefail

PR_NUMBER="${1:-}"
REPO="${2:-${GITHUB_REPOSITORY:-}}"
EXPECTED_SHA="${3:-}"

if [ -z "$PR_NUMBER" ]; then
  echo "::error::autofix-merge-approval: usage: $0 <PR_NUMBER> [REPO]" >&2
  exit 2
fi
if [ -z "$REPO" ]; then
  echo "::error::autofix-merge-approval: REPO not given and GITHUB_REPOSITORY is unset" >&2
  exit 2
fi
command -v gh >/dev/null 2>&1 || { echo "::error::autofix-merge-approval: gh CLI not found" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "::error::autofix-merge-approval: jq not found" >&2; exit 2; }

APPROVAL_LABEL="autofix:merge-approved"
# Destructive-fix approvals that must NEVER authorize a merge, even
# alongside the merge-approval label (mirrors MERGE_FORBIDDEN_LABELS).
FORBIDDEN_LABELS="autofix:approved autofix-approve autofix-approved autofix:needs-manual-review autofix:skipped autofix:completed"

deny() {
  echo "::warning::Autofix PR merge blocked — PR #${PR_NUMBER}: $1"
  exit 1
}

normalize_timestamp() {
  local value="$1"
  [[ "$value" =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(\.[0-9]+)?Z$ ]] || return 1
  printf '%sZ\n' "${BASH_REMATCH[1]}"
}

# --- 1. Live PR state: open/unmerged, labels, head SHA, commit dates. ---
PR_JSON="$(gh pr view "$PR_NUMBER" --repo "$REPO" --json state,labels,headRefOid,headRefName,baseRefName,isCrossRepository,commits,updatedAt)" \
  || deny "could not fetch PR state; will retry on a later run."
STATE="$(printf '%s' "$PR_JSON" | jq -r '.state // empty')"
case "$STATE" in
  OPEN) ;;
  MERGED) deny "PR is already merged." ;;
  *) deny "PR is not open (state ${STATE:-unknown}); will retry on a later run." ;;
esac
HEAD_SHA="$(printf '%s' "$PR_JSON" | jq -r '.headRefOid // empty')"
HEAD_REF_NAME="$(printf '%s' "$PR_JSON" | jq -r '.headRefName // empty')"
BASE_REF_NAME="$(printf '%s' "$PR_JSON" | jq -r '.baseRefName // empty')"
IS_CROSS_REPOSITORY="$(printf '%s' "$PR_JSON" | jq -r 'if .isCrossRepository == false then "false" elif .isCrossRepository == true then "true" else "" end')"
PR_UPDATED_AT="$(printf '%s' "$PR_JSON" | jq -r '.updatedAt // empty')"
if [ -z "$HEAD_SHA" ]; then
  deny "could not resolve head SHA; will retry on a later run."
fi
[ -n "$HEAD_REF_NAME" ] && [ "$HEAD_REF_NAME" != main ] && [ "$HEAD_REF_NAME" != refs/heads/main ] && [ "$BASE_REF_NAME" = main ] && [ "$IS_CROSS_REPOSITORY" = false ] || deny "PR head/base repository binding is not eligible for autonomous merge."
if [ -n "$EXPECTED_SHA" ]; then
  [[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] || deny "invalid expected head SHA; will retry on a later run."
  [ "$HEAD_SHA" = "$EXPECTED_SHA" ] || deny "head moved from expected SHA $EXPECTED_SHA to $HEAD_SHA; re-approval required."
fi

LABELS_NORM="$(printf '%s' "$PR_JSON" | jq -r '[.labels[] | (if type == "object" then (.name // "") else . end | tostring | ascii_downcase | gsub("^\\s+|\\s+$";""))] | join("\n")')"
HAS_APPROVAL=""
HAS_FORBIDDEN=""
while IFS= read -r name; do
  [ -n "$name" ] || continue
  if [ "$name" = "$APPROVAL_LABEL" ]; then HAS_APPROVAL=1; fi
  case " $FORBIDDEN_LABELS " in
    *" $name "*) HAS_FORBIDDEN="$name" ;;
  esac
done <<< "$LABELS_NORM"
if [ -n "$HAS_FORBIDDEN" ]; then
  deny "forbidden label \`${HAS_FORBIDDEN}\` present — destructive-fix approvals never authorize a merge."
fi
if [ -z "$HAS_APPROVAL" ]; then
  deny "missing required label \`${APPROVAL_LABEL}\` — \`autofix:ready\` is advisory only; a human must apply \`${APPROVAL_LABEL}\`."
fi

# --- 2. Approver discovery: who most recently applied the label. ---
OWNER="${REPO%%/*}"
APPROVAL_EVENT="$(gh api "repos/${REPO}/issues/${PR_NUMBER}/events" --paginate \
  --jq "[.[] | select(.event == \"labeled\" and ((.label.name // \"\" | ascii_downcase) == \"${APPROVAL_LABEL}\"))] | max_by(.created_at) | {login: (.actor.login // empty), type: (.actor.type // empty), created_at: (.created_at // empty), commit_id: (.commit_id // "")}")" \
  || deny "could not read label events; will retry on a later run."
APPROVER_LOGIN="$(printf '%s' "$APPROVAL_EVENT" | jq -r '.login // empty')"
APPROVER_TYPE="$(printf '%s' "$APPROVAL_EVENT" | jq -r '.type // empty')"
APPROVED_AT="$(printf '%s' "$APPROVAL_EVENT" | jq -r '.created_at // empty')"
APPROVED_HEAD="$(printf '%s' "$APPROVAL_EVENT" | jq -r '.commit_id // empty')"
if [ -z "$APPROVER_LOGIN" ] || [ -z "$APPROVED_AT" ]; then
  deny "no \`${APPROVAL_LABEL}\` labeling event found — cannot verify a human approver."
fi
[ -n "$PR_UPDATED_AT" ] || deny "PR update time could not be established for approval binding."
PR_UPDATED_AT_NORM="$(normalize_timestamp "$PR_UPDATED_AT")" || deny "PR update time is not a valid ISO-8601 UTC timestamp."
APPROVED_AT_NORM="$(normalize_timestamp "$APPROVED_AT")" || deny "approval event time is not a valid ISO-8601 UTC timestamp."
# A later comment/label edit can advance PR updatedAt without changing the
# approved head; head-SHA and commit-date binding below remain authoritative.
if [ -n "$APPROVED_HEAD" ] && [ "$APPROVED_HEAD" != "$HEAD_SHA" ]; then deny "approval event head does not match the current PR head; re-approval required."; fi
case "${APPROVER_LOGIN,,}" in
  *"[bot]")
    deny "bot sender \`${APPROVER_LOGIN}\` cannot authorize a merge."
    ;;
esac
if [ -z "$APPROVER_TYPE" ]; then
  deny "missing approver account type — cannot verify human actor."
fi
if [ "${APPROVER_TYPE,,}" = "bot" ]; then
  deny "bot sender type cannot authorize a merge."
fi

# --- 3. Privileged association (OWNER/MEMBER; COLLABORATOR in step 4). ---
# OWNER (repo owner) and MEMBER (active org membership) resolve by
# identity. Any other actor can only qualify as an outside COLLABORATOR,
# which still requires privileged collaborator permission — recorded in
# step 4 once permission verifies.
ASSOCIATION="NONE"
if [ "${APPROVER_LOGIN,,}" = "${OWNER,,}" ]; then
  ASSOCIATION="OWNER"
elif [ "$(gh api "orgs/${OWNER}/memberships/${APPROVER_LOGIN}" --jq '.state // empty' 2>/dev/null || true)" = "active" ]; then
  ASSOCIATION="MEMBER"
fi

# --- 4. Privileged repository permission (admin/maintain/write). ---
# Resolved via the API immediately before merge; lookup failures and
# absent values fail closed (mirrors isMergeAuthorized).
PERMISSION="$(gh api "repos/${REPO}/collaborators/${APPROVER_LOGIN}/permission" --jq '.permission // empty' 2>/dev/null || true)"
if [ -z "$PERMISSION" ]; then
  deny "could not resolve repository permission for \`${APPROVER_LOGIN}\` — failing closed; will retry on a later run."
fi
PERMISSION_NORM="$(printf '%s' "$PERMISSION" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
case "$PERMISSION_NORM" in
  admin|maintain|write) ;;
  *) deny "unprivileged actor \`${APPROVER_LOGIN}\` (association ${ASSOCIATION}, permission \`${PERMISSION}\`) — requires OWNER/MEMBER/COLLABORATOR with admin/maintain/write." ;;
esac
if [ "$ASSOCIATION" = "NONE" ]; then
  ASSOCIATION="COLLABORATOR"
fi

# --- 5. Head-SHA binding: any push newer than the approval invalidates it. ---
HEAD_MAX_DATE="$(printf '%s' "$PR_JSON" | jq -r '[.commits[]? | (.pushedDate // .committedDate // empty)] | map(select(. != "")) | max // empty')"
if [ -z "$HEAD_MAX_DATE" ]; then
  deny "could not resolve head commit dates — cannot verify approval target."
fi
HEAD_MAX_DATE_NORM="$(normalize_timestamp "$HEAD_MAX_DATE")" || deny "head commit date is not a valid ISO-8601 UTC timestamp."
# ISO-8601 UTC timestamps compare lexicographically after fractional-second normalization.
if ! [[ "$HEAD_MAX_DATE_NORM" < "$APPROVED_AT_NORM" ]]; then
  deny "stale approval (\`${APPROVAL_LABEL}\` applied ${APPROVED_AT}, head moved ${HEAD_MAX_DATE}) — re-approval required after every push."
fi

# Re-read every mutable authorization input after the event/permission lookups.
# A label removal/re-add, head move, closure, or permission change during those
# network calls must not be converted into a successful merge authorization.
FINAL_PR_JSON="$(gh pr view "$PR_NUMBER" --repo "$REPO" --json state,labels,headRefOid,headRefName,baseRefName,isCrossRepository,commits,updatedAt)" \
  || deny "could not re-read PR approval state; will retry on a later run."
FINAL_STATE="$(printf '%s' "$FINAL_PR_JSON" | jq -r '.state // empty')"
FINAL_HEAD="$(printf '%s' "$FINAL_PR_JSON" | jq -r '.headRefOid // empty')"
FINAL_HEAD_REF="$(printf '%s' "$FINAL_PR_JSON" | jq -r '.headRefName // empty')"
FINAL_BASE_REF="$(printf '%s' "$FINAL_PR_JSON" | jq -r '.baseRefName // empty')"
FINAL_CROSS_REPOSITORY="$(printf '%s' "$FINAL_PR_JSON" | jq -r 'if .isCrossRepository == false then "false" elif .isCrossRepository == true then "true" else "" end')"
FINAL_UPDATED_AT="$(printf '%s' "$FINAL_PR_JSON" | jq -r '.updatedAt // empty')"
[ "$FINAL_STATE" = OPEN ] || deny "PR state changed while approval was being verified."
[ "$FINAL_HEAD" = "$HEAD_SHA" ] || deny "head changed while approval was being verified."
[ "$FINAL_HEAD_REF" = "$HEAD_REF_NAME" ] || deny "head ref changed while approval was being verified."
[ "$FINAL_BASE_REF" = main ] && [ "$FINAL_CROSS_REPOSITORY" = false ] || deny "PR base/repository binding changed while approval was being verified."
FINAL_UPDATED_AT_NORM="$(normalize_timestamp "$FINAL_UPDATED_AT")" || deny "final PR update time is not a valid ISO-8601 UTC timestamp."
[ "$FINAL_UPDATED_AT_NORM" = "$PR_UPDATED_AT_NORM" ] || deny "PR changed while approval was being verified."
FINAL_LABELS="$(printf '%s' "$FINAL_PR_JSON" | jq -r '[.labels[] | (if type == "object" then (.name // "") else . end | tostring | ascii_downcase | gsub("^\\s+|\\s+$";""))] | join("\n")')"
grep -Fxq "$APPROVAL_LABEL" <<<"$FINAL_LABELS" || deny "approval label was removed while authorization was being verified."
if grep -Eiq '^(autofix:approved|autofix-approve|autofix-approved|autofix:needs-manual-review|autofix:skipped|autofix:completed)$' <<<"$FINAL_LABELS"; then
  deny "forbidden destructive-fix label appeared while authorization was being verified."
fi
FINAL_APPROVAL_EVENT="$(gh api "repos/${REPO}/issues/${PR_NUMBER}/events" --paginate \
  --jq "[.[] | select(.event == \"labeled\" and ((.label.name // \"\" | ascii_downcase) == \"${APPROVAL_LABEL}\"))] | max_by(.created_at) | {login: (.actor.login // empty), type: (.actor.type // empty), created_at: (.created_at // empty), commit_id: (.commit_id // "")}")" \
  || deny "could not re-read approval events; will retry on a later run."
[ "$FINAL_APPROVAL_EVENT" = "$APPROVAL_EVENT" ] || deny "approval event changed while authorization was being verified."
FINAL_APPROVED_HEAD="$(printf '%s' "$FINAL_APPROVAL_EVENT" | jq -r '.commit_id // empty')"
if [ -n "$FINAL_APPROVED_HEAD" ] && [ "$FINAL_APPROVED_HEAD" != "$HEAD_SHA" ]; then deny "final approval event is not bound to the current head."; fi
FINAL_PERMISSION="$(gh api "repos/${REPO}/collaborators/${APPROVER_LOGIN}/permission" --jq '.permission // empty' 2>/dev/null || true)"
FINAL_PERMISSION_NORM="$(printf '%s' "$FINAL_PERMISSION" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
[ "$FINAL_PERMISSION_NORM" = "$PERMISSION_NORM" ] || deny "approver permission changed while authorization was being verified."
if [ "$ASSOCIATION" = MEMBER ]; then
  [ "$(gh api "orgs/${OWNER}/memberships/${APPROVER_LOGIN}" --jq '.state // empty' 2>/dev/null || true)" = active ] \
    || deny "approver organization membership changed while authorization was being verified."
fi

echo "Merge approval verified: \`${APPROVAL_LABEL}\` by ${APPROVER_LOGIN} (${ASSOCIATION}/${PERMISSION_NORM}) on head ${HEAD_SHA:0:7} for PR #${PR_NUMBER}."
