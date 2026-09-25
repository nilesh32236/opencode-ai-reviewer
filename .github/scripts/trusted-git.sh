#!/usr/bin/env bash
#
# Execute one git operation with ephemeral GitHub authentication and no
# repository-controlled hooks. This is only for trusted workflow steps; it is
# not a general-purpose sandbox and must never be invoked by agent code.
#
# Usage:
#   GH_TOKEN=... bash .github/scripts/trusted-git.sh push --no-verify origin main

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "Usage: GH_TOKEN=... $0 <git-command> [args...]" >&2
  exit 2
fi
if [ -z "${GH_TOKEN:-}" ]; then
  echo "Refusing trusted git operation: GH_TOKEN is not set." >&2
  exit 2
fi
if ! command -v git >/dev/null 2>&1; then
  echo "Refusing trusted git operation: git is not available." >&2
  exit 2
fi

ASKPASS_DIR="$(mktemp -d /tmp/trusted-git-askpass.XXXXXX)"
cleanup() {
  rm -rf "$ASKPASS_DIR"
}
trap cleanup EXIT INT TERM

cat > "$ASKPASS_DIR/askpass.sh" <<'ASKPASS_EOF'
#!/usr/bin/env sh
case "$1" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *Password*) printf '%s\n' "${GH_TOKEN:?GH_TOKEN is required for trusted git auth}" ;;
esac
ASKPASS_EOF
chmod 700 "$ASKPASS_DIR/askpass.sh"

# `core.hooksPath` is command-local and prevents a branch-controlled hook from
# running in a credential-bearing step. Callers should also pass --no-verify
# for push/commit operations as defense in depth.
GIT_ASKPASS="$ASKPASS_DIR/askpass.sh" \
GIT_TERMINAL_PROMPT=0 \
GIT_CONFIG_NOSYSTEM=1 \
GIT_CONFIG_SYSTEM=/dev/null \
GIT_CONFIG_GLOBAL=/dev/null \
  git -c core.hooksPath=/dev/null "$@"
