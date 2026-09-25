#!/usr/bin/env bash
# Run one model invocation with an explicit child allowlist. The wrapper is
# used only in provider-only agent jobs; it never forwards GitHub/runtime state
# or discovers a binary from an attacker-controlled PATH.
set -euo pipefail
PROMPT_FILE="${1:-}"
MODEL="${2:-}"
[ -f "$PROMPT_FILE" ] && [ -n "$MODEL" ] || { echo 'usage: run-sec001-opencode.sh PROMPT MODEL' >&2; exit 2; }
case "$MODEL" in
  opencode/*|openai/*|anthropic/*|google/*|gemini/*) ;;
  *) echo 'SEC-001: unsupported or unmapped model provider' >&2; exit 2 ;;
esac
case "$MODEL" in
  opencode/*) KEY_NAME=OPENCODE_API_KEY; KEY_VALUE="${OPENCODE_API_KEY:-}" ;;
  openai/*) KEY_NAME=OPENAI_API_KEY; KEY_VALUE="${OPENAI_API_KEY:-}" ;;
  anthropic/*) KEY_NAME=ANTHROPIC_API_KEY; KEY_VALUE="${ANTHROPIC_API_KEY:-}" ;;
  google/*|gemini/*) KEY_NAME=GEMINI_API_KEY; KEY_VALUE="${GEMINI_API_KEY:-}" ;;
esac
[ -n "$KEY_VALUE" ] || { echo "SEC-001: required provider credential $KEY_NAME is missing" >&2; exit 2; }
OPENCODE_BIN=/usr/local/bin/opencode
if [ -n "${SEC001_OPENCODE_BIN:-}" ]; then
  [ "${SEC001_TEST_MODE:-}" = 1 ] || { echo 'SEC-001: binary override is test-only' >&2; exit 2; }
  OPENCODE_BIN="$SEC001_OPENCODE_BIN"
fi
[ -x "$OPENCODE_BIN" ] || { echo 'SEC-001: verified OpenCode binary is missing' >&2; exit 2; }
PROMPT=$(cat "$PROMPT_FILE")
CLEAN_HOME=$(mktemp -d)
cleanup() { rm -rf "$CLEAN_HOME"; }
trap cleanup EXIT
ENV_ARGS=(
  "PATH=/usr/local/bin:/usr/bin:/bin"
  "HOME=$CLEAN_HOME"
  "XDG_CONFIG_HOME=$CLEAN_HOME/config"
  "XDG_CACHE_HOME=$CLEAN_HOME/cache"
  "XDG_DATA_HOME=$CLEAN_HOME/data"
  "TMPDIR=/tmp"
  "LANG=C"
  "LC_ALL=C"
  "CI=true"
  "GIT_CONFIG_NOSYSTEM=1"
  "GIT_CONFIG_SYSTEM=/dev/null"
  "GIT_CONFIG_GLOBAL=/dev/null"
  "GIT_NO_REPLACE_OBJECTS=1"
  "GIT_TERMINAL_PROMPT=0"
  "$KEY_NAME=$KEY_VALUE"
)
if [ -n "${CONTEXT7_API_KEY:-}" ]; then ENV_ARGS+=("CONTEXT7_API_KEY=$CONTEXT7_API_KEY"); fi
# The parent job contains only the selected provider/Context7 values. env -i
# ensures no future step-level GH/GITHUB/GITLAB token or writable Actions path
# variable is inherited by OpenCode or its tool subprocesses.
env -i "${ENV_ARGS[@]}" /usr/bin/timeout 10m "$OPENCODE_BIN" run --auto --model "$MODEL" "$PROMPT" < /dev/null
