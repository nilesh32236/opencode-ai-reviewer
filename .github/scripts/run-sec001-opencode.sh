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
PROVIDER_KEY_FILE="${SEC001_PROVIDER_KEY_FILE:-}"
CONTEXT7_KEY_FILE="${SEC001_CONTEXT7_KEY_FILE:-}"
cleanup() { rm -f -- "$PROVIDER_KEY_FILE" "$CONTEXT7_KEY_FILE" 2>/dev/null || true; }
trap cleanup EXIT
if [ -n "${SEC001_PROVIDER_KEY_FILE:-}" ]; then
  [ -f "$SEC001_PROVIDER_KEY_FILE" ] && [ ! -L "$SEC001_PROVIDER_KEY_FILE" ] || { echo "SEC-001: provider credential file is missing or symlinked" >&2; exit 2; }
  [ "$(wc -c < "$SEC001_PROVIDER_KEY_FILE")" -le 8192 ] || { echo "SEC-001: provider credential file exceeds size limit" >&2; exit 2; }
  KEY_VALUE=$(cat "$SEC001_PROVIDER_KEY_FILE")
  rm -f -- "$SEC001_PROVIDER_KEY_FILE"
else
  KEY_VALUE="${!KEY_NAME:-}"
fi
[ -n "$KEY_VALUE" ] || { echo "SEC-001: required provider credential $KEY_NAME is missing" >&2; exit 2; }
CONTEXT7_VALUE="${CONTEXT7_API_KEY:-}"
unset GH_TOKEN GITHUB_TOKEN GH_PAT GITLAB_TOKEN GITHUB_ENV GITHUB_PATH BASH_ENV OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY OPENCODE_API_KEY CONTEXT7_API_KEY
OPENCODE_BIN=/usr/local/bin/opencode
if [ -n "${SEC001_OPENCODE_BIN:-}" ]; then
  [ "${SEC001_TEST_MODE:-}" = 1 ] || { echo 'SEC-001: binary override is test-only' >&2; exit 2; }
  OPENCODE_BIN="$SEC001_OPENCODE_BIN"
fi
[ -x "$OPENCODE_BIN" ] || { echo 'SEC-001: verified OpenCode binary is missing' >&2; exit 2; }
PROMPT=$(cat "$PROMPT_FILE")
CLEAN_HOME=''
STAGE_DIR=''
cleanup() {
  rm -f -- "$PROVIDER_KEY_FILE" "$CONTEXT7_KEY_FILE" 2>/dev/null || true
  [ -z "$CLEAN_HOME" ] || rm -rf "$CLEAN_HOME" 2>/dev/null || true
  [ -z "$STAGE_DIR" ] || rm -rf "$STAGE_DIR" 2>/dev/null || true
  return 0
}
# Arm the cleanup that covers CLEAN_HOME/STAGE_DIR before creating them, so a
# signal in the mktemp window cannot orphan them.
trap cleanup EXIT
CLEAN_HOME=$(mktemp -d)
STAGE_DIR=$(mktemp -d)
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
case "$MODEL" in
  opencode/*)
    if [ -n "${SEC001_CONTEXT7_KEY_FILE:-}" ]; then
      [ -f "$SEC001_CONTEXT7_KEY_FILE" ] && [ ! -L "$SEC001_CONTEXT7_KEY_FILE" ] || { echo "SEC-001: Context7 credential file is missing or symlinked" >&2; exit 2; }
      [ "$(wc -c < "$SEC001_CONTEXT7_KEY_FILE")" -le 8192 ] || { echo "SEC-001: Context7 credential file exceeds size limit" >&2; exit 2; }
      CONTEXT7_VALUE=$(cat "$SEC001_CONTEXT7_KEY_FILE")
      rm -f -- "$SEC001_CONTEXT7_KEY_FILE"
      [ -n "$CONTEXT7_VALUE" ] && ENV_ARGS+=("CONTEXT7_API_KEY=$CONTEXT7_VALUE")
    elif [ -n "${CONTEXT7_VALUE:-}" ]; then
      ENV_ARGS+=("CONTEXT7_API_KEY=$CONTEXT7_VALUE")
    fi
    ;;
esac
ENV_FILE="$STAGE_DIR/environment"
umask 077
: > "$ENV_FILE"
for assignment in "${ENV_ARGS[@]}"; do
  case "${assignment#*=}" in *$'\n'*|*$'\r'*) echo 'SEC-001: credential contains a forbidden line break' >&2; exit 2 ;; esac
  printf '%s=%s\n' "${assignment%%=*}" "${assignment#*=}" >> "$ENV_FILE"
done
# The parent job contains only the selected provider/Context7 values. env -i
# ensures no future step-level GH/GITHUB/GITLAB token or writable Actions path
# variable is inherited by OpenCode or its tool subprocesses. The private
# stage and file quota also cover direct callers outside the hourly agent.
MODEL_STDOUT="$STAGE_DIR/stdout"
MODEL_STDERR="$STAGE_DIR/stderr"
(
  ulimit -f 1024
  /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$CLEAN_HOME" LANG=C LC_ALL=C CI=true SEC001_ENV_FILE="$ENV_FILE" /usr/bin/setsid /usr/bin/timeout --kill-after=5s 10m /usr/bin/python3 -I -c 'import os,sys; p=os.environ["SEC001_ENV_FILE"]; parent=os.path.dirname(p); name=os.path.basename(p); pf=os.open(parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|getattr(os,"O_CLOEXEC",0)); fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|getattr(os,"O_CLOEXEC",0),dir_fd=pf); raw=os.read(fd,1024*1024); os.close(fd); os.unlink(name,dir_fd=pf); os.close(pf); e={k.decode("utf-8"):v.decode("utf-8") for k,v in (line.split(b"=",1) for line in raw.splitlines())}; os.execve(sys.argv[1], [sys.argv[1],"run","--auto","--model",sys.argv[2],sys.argv[3]], e)' "$OPENCODE_BIN" "$MODEL" "$PROMPT" < /dev/null > "$MODEL_STDOUT" 2> "$MODEL_STDERR" &
  child=$!
  if wait "$child"; then rc=0; else rc=$?; fi
  kill -TERM -- "-$child" 2>/dev/null || true
  kill -KILL -- "-$child" 2>/dev/null || true
  cat "$MODEL_STDOUT"
  cat "$MODEL_STDERR" >&2
  exit "$rc"
)
