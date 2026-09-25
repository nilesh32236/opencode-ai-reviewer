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
FORBIDDEN_LABELS="autofix:approved autofix-approve autofix-approved"

deny() {
  echo "::warning::Autofix PR merge blocked — PR #${PR_NUMBER}: $1"
  exit 1
}

# --- 1. Live PR state: open/unmerged, labels, head SHA, commit dates. ---
PR_JSON="$(gh pr view "$PR_NUMBER" --repo "$REPO" --json state,labels,headRefOid,commits)" \
  || deny "could not fetch PR state; will retry on a later run."
STATE="$(printf '%s' "$PR_JSON" | jq -r '.state // empty')"
case "$STATE" in
  OPEN) ;;
  MERGED) deny "PR is already merged." ;;
  *) deny "PR is not open (state ${STATE:-unknown}); will retry on a later run." ;;
esac
HEAD_SHA="$(printf '%s' "$PR_JSON" | jq -r '.headRefOid // empty')"
if [ -z "$HEAD_SHA" ]; then
  deny "could not resolve head SHA; will retry on a later run."
fi
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
  --jq "[.[] | select(.event == \"labeled\" and ((.label.name // \"\" | ascii_downcase) == \"${APPROVAL_LABEL}\"))] | max_by(.created_at) | {login: (.actor.login // empty), type: (.actor.type // empty), created_at: (.created_at // empty)}")" \
  || deny "could not read label events; will retry on a later run."
APPROVER_LOGIN="$(printf '%s' "$APPROVAL_EVENT" | jq -r '.login // empty')"
APPROVER_TYPE="$(printf '%s' "$APPROVAL_EVENT" | jq -r '.type // empty')"
APPROVED_AT="$(printf '%s' "$APPROVAL_EVENT" | jq -r '.created_at // empty')"
if [ -z "$APPROVER_LOGIN" ] || [ -z "$APPROVED_AT" ]; then
  deny "no \`${APPROVAL_LABEL}\` labeling event found — cannot verify a human approver."
fi
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
# ISO-8601 UTC timestamps compare lexicographically.
if [[ "$HEAD_MAX_DATE" > "$APPROVED_AT" ]]; then
  deny "stale approval (\`${APPROVAL_LABEL}\` applied ${APPROVED_AT}, head moved ${HEAD_MAX_DATE}) — re-approval required after every push."
fi

echo "Merge approval verified: \`${APPROVAL_LABEL}\` by ${APPROVER_LOGIN} (${ASSOCIATION}/${PERMISSION_NORM}) on head ${HEAD_SHA:0:7} for PR #${PR_NUMBER}."
