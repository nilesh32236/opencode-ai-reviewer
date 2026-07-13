#!/usr/bin/env bash
# post-or-update-comment.sh
# Posts a new comment or updates an existing one on a PR/issue.
# Uses an HTML marker to find existing comments.
#
# Usage:
#   post-or-update-comment.sh <repo> <issue-number> <marker> <body-file> <GH_TOKEN>
#
# Example:
#   post-or-update-comment.sh "owner/repo" 42 "<!-- opencode-review -->" /tmp/body.md "$GH_TOKEN"

set -euo pipefail

REPO="$1"
ISSUE_NUM="$2"
MARKER="$3"
BODY_FILE="$4"
GH_TOKEN="$5"

[ -f "$BODY_FILE" ] || { echo "Body file not found: $BODY_FILE"; exit 1; }

# Prepend marker to body so we can find this comment later
MARKED_BODY="${MARKER}

$(cat "$BODY_FILE")"

# Find existing comment with this marker
EXISTING_ID=$(gh api "repos/${REPO}/issues/${ISSUE_NUM}/comments" \
  --jq ".[] | select(.body | startswith(\"${MARKER}\")) | .id" | head -1)

if [ -n "$EXISTING_ID" ]; then
  jq -n --rawfile body <(echo "$MARKED_BODY") '{body: $body}' | \
    gh api "repos/${REPO}/issues/comments/${EXISTING_ID}" -X PATCH --input - --silent
  echo "Comment updated (id: ${EXISTING_ID})"
else
  jq -n --rawfile body <(echo "$MARKED_BODY") '{body: $body}' | \
    gh api "repos/${REPO}/issues/${ISSUE_NUM}/comments" --input - --silent
  echo "Comment posted"
fi
