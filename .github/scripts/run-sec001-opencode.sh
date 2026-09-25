#!/usr/bin/env bash
# Run one model invocation in an isolated agent job. The caller supplies only
# the provider credential required by the selected model; this helper never
# adds credentials and never runs repository scripts.
set -euo pipefail
PROMPT_FILE="${1:-}"
MODEL="${2:-}"
[ -f "$PROMPT_FILE" ] && [ -n "$MODEL" ] || { echo 'usage: run-sec001-opencode.sh PROMPT MODEL' >&2; exit 2; }
exec timeout 10m opencode run --auto --model "$MODEL" "$(cat "$PROMPT_FILE")" < /dev/null
