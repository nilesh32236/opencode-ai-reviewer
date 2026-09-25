#!/usr/bin/env bash
# Execute candidate-controlled verification commands outside the supervisor's
# trust domain. Normal mode snapshots the patched tree once, then gives each
# gate a fresh root-created copy; a prior gate cannot poison a later gate.
set -euo pipefail
DIRECT=0
if [ "${1:-}" = --direct ]; then DIRECT=1; shift; fi
WORKDIR="${1:-}"
[ -n "$WORKDIR" ] && [ -d "$WORKDIR" ] && [ ! -L "$WORKDIR" ] || { echo 'usage: sec001-run-gates.sh [--direct] WORKDIR COMMAND [ARG...]' >&2; exit 2; }
shift
[ "$#" -gt 0 ] || { echo 'missing gate command' >&2; exit 2; }
VERIFY_USER=sec001-verify
VERIFY_HOME=$(sudo mktemp -d /tmp/sec001-verify-home.XXXXXX)
cleanup() { sudo rm -rf -- "$VERIFY_HOME"; }
trap cleanup EXIT
if ! id "$VERIFY_USER" >/dev/null 2>&1; then sudo useradd --system --create-home --shell /bin/bash "$VERIFY_USER" >/dev/null; fi
sudo chown "$VERIFY_USER":"$VERIFY_USER" "$VERIFY_HOME"
sudo chmod 0700 "$VERIFY_HOME"
WORK_KEY=$(printf '%s' "$WORKDIR" | sha256sum | awk '{print $1}')
INODE_STATE="/var/tmp/sec001-gate-inode-${VERIFY_USER}-${WORK_KEY}"
CURRENT_INODE=$(stat -c '%d:%i' "$WORKDIR")
if sudo test -f "$INODE_STATE"; then
  EXPECTED_INODE=$(sudo cat "$INODE_STATE")
  [ "$CURRENT_INODE" = "$EXPECTED_INODE" ] || { echo 'candidate gate worktree was replaced between commands' >&2; exit 1; }
else
  printf '%s\n' "$CURRENT_INODE" | sudo tee "$INODE_STATE" >/dev/null
  sudo chmod 0600 "$INODE_STATE"
fi
if [ "$DIRECT" -eq 1 ]; then
  sudo chown -R "$VERIFY_USER":"$VERIFY_USER" "$WORKDIR"
  exec sudo -u "$VERIFY_USER" -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$VERIFY_HOME" CI=true LANG=C LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0 /bin/bash -c 'cd "$1"; shift; exec "$@"' _ "$WORKDIR" "$@"
fi
SNAPSHOT="/opt/sec001-snapshot-${VERIFY_USER}-${WORK_KEY}"
if ! sudo test -f "$SNAPSHOT/.sec001-complete"; then
  sudo rm -rf -- "$SNAPSHOT"
  sudo install -d -o root -g root -m 0711 "$(dirname "$SNAPSHOT")"
  sudo cp -a "$WORKDIR" "$SNAPSHOT"
  sudo touch "$SNAPSHOT/.sec001-complete"
  sudo chown -R root:root "$SNAPSHOT"
  sudo chmod -R a-w "$SNAPSHOT"
fi
RUN_DIR=$(sudo mktemp -d /opt/sec001-gate-run.XXXXXX)
sudo chown -R "$VERIFY_USER":"$VERIFY_USER" "$RUN_DIR"
sudo cp -a "$SNAPSHOT"/. "$RUN_DIR"/
sudo chown -R "$VERIFY_USER":"$VERIFY_USER" "$RUN_DIR"
sudo chmod -R u+rwX "$RUN_DIR"
set +e
sudo -u "$VERIFY_USER" -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$VERIFY_HOME" CI=true LANG=C LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0 /bin/bash -c 'cd "$1"; shift; exec "$@"' _ "$RUN_DIR" "$@"
RC=$?
set -e
sudo rm -rf -- "$RUN_DIR"
exit "$RC"
