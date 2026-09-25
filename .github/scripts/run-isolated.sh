#!/usr/bin/env bash
#
# Run one repository-controlled command with a minimal, non-secret environment.
# This is a workflow boundary: callers may have GitHub/provider credentials in
# their parent environment, but the child command receives only the safe
# variables listed below. The command is still untrusted code; this helper is
# not a sandbox.
#
# Usage:
#   bash .github/scripts/run-isolated.sh pnpm build
#   bash .github/scripts/run-isolated.sh bash -c 'printf "%s\n" "$PATH"'

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 <command> [args...]" >&2
  exit 2
fi

if [ -z "${PATH:-}" ]; then
  echo "Refusing isolated command: PATH is not set." >&2
  exit 2
fi

# Never reuse the runner's HOME: it may contain OpenCode auth files, npm auth
# files, or other credentials that would defeat the environment allowlist.
ISOLATED_HOME="$(mktemp -d /tmp/opencode-isolated.XXXXXX)"
cleanup() {
  rm -rf "$ISOLATED_HOME"
}
trap cleanup EXIT INT TERM

mkdir -p "$ISOLATED_HOME/config" "$ISOLATED_HOME/cache" "$ISOLATED_HOME/data"

ENV_ARGS=(
  "PATH=$PATH"
  "HOME=$ISOLATED_HOME"
  "XDG_CONFIG_HOME=$ISOLATED_HOME/config"
  "XDG_CACHE_HOME=$ISOLATED_HOME/cache"
  "XDG_DATA_HOME=$ISOLATED_HOME/data"
  # Keep the runner's conventional /tmp safe-root semantics. A private TMPDIR
  # changes path-validation behavior in existing self-heal tests and tools.
  "TMPDIR=/tmp"
  "GIT_CONFIG_NOSYSTEM=1"
  "GIT_CONFIG_SYSTEM=/dev/null"
  "GIT_CONFIG_GLOBAL=/dev/null"
  "GIT_TERMINAL_PROMPT=0"
)

copy_safe() {
  local name="$1"
  if [[ -v "$name" ]]; then
    ENV_ARGS+=("$name=${!name}")
  fi
}

# Runtime/tool settings that are non-secret and commonly required by pnpm,
# Node, and test runners. Deliberately omit proxy variables and NODE_OPTIONS:
# either can carry credentials or inject code into a child process.
for name in USER LOGNAME LANG LC_ALL LC_CTYPE TERM CI NODE_ENV FORCE_COLOR NO_COLOR; do
  copy_safe "$name"
done

# Copy only the small, non-secret tool paths needed by pnpm/corepack. Do not
# copy arbitrary NPM_CONFIG_* values: a registry URL or config-file path can
# contain credentials even when its variable name looks harmless.
while IFS='=' read -r key value; do
  case "$key" in
    NPM_CONFIG_CACHE|NPM_CONFIG_PREFIX|PNPM_HOME|COREPACK_HOME)
      ENV_ARGS+=("$key=$value")
      ;;
  esac
done < <(env)

# `env -i` is the actual boundary. The child cannot inherit a secret merely
# because the parent workflow step had one mapped into its environment.
exec env -i "${ENV_ARGS[@]}" "$@"
