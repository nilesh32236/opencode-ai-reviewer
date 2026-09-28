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
VERIFY_HOME=''
SNAPSHOT=''
RUN_DIR=''
INODE_STATE=''
CHILD_PGID=''
ABORTED=0
cleanup() {
  local status=$?
  if [ -n "$CHILD_PGID" ]; then
    sudo /bin/kill -KILL -- "-$CHILD_PGID" >/dev/null 2>&1 || true
  fi
  [ -z "$RUN_DIR" ] || sudo rm -rf -- "$RUN_DIR" >/dev/null 2>&1 || true
  # Any non-zero exit invalidates the gate's cached snapshot and inode binding,
  # so a failed or aborted gate can never be laundered by a later run.
  if [ "$status" -ne 0 ] || [ "$ABORTED" -eq 1 ]; then
    [ -z "$INODE_STATE" ] || sudo rm -f -- "$INODE_STATE" >/dev/null 2>&1 || true
    [ -z "$SNAPSHOT" ] || sudo rm -rf -- "$SNAPSHOT" >/dev/null 2>&1 || true
  fi
  [ -z "$VERIFY_HOME" ] || sudo rm -rf -- "$VERIFY_HOME" >/dev/null 2>&1 || true
  return "$status"
}
trap cleanup EXIT
VERIFY_HOME=$(sudo mktemp -d /tmp/sec001-verify-home.XXXXXX)
trap 'ABORTED=1; exit 129' HUP
trap 'ABORTED=1; exit 130' INT
trap 'ABORTED=1; exit 143' TERM
run_gate_command() {
  local workdir="$1"; shift
  local child rc=0
  /usr/bin/setsid /usr/bin/sudo -u "$VERIFY_USER" -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$VERIFY_HOME" CI=true LANG=C LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0 /bin/bash -c 'cd "$1"; shift; exec "$@"' _ "$workdir" "$@" &
  child=$!
  CHILD_PGID=$child
  if wait "$child"; then rc=0; else rc=$?; fi
  sudo /bin/kill -TERM -- "-$child" 2>/dev/null || true
  sudo /bin/kill -KILL -- "-$child" 2>/dev/null || true
  return "$rc"
}
if ! id "$VERIFY_USER" >/dev/null 2>&1; then sudo useradd --system --create-home --shell /bin/bash "$VERIFY_USER" >/dev/null; fi
sudo chown "$VERIFY_USER":"$VERIFY_USER" "$VERIFY_HOME"
sudo chmod 0700 "$VERIFY_HOME"
WORK_KEY=$(printf '%s' "$WORKDIR" | sha256sum | awk '{print $1}')
STATE_ROOT=/var/lib/sec001
if ! sudo test -d "$STATE_ROOT"; then sudo install -d -o root -g root -m 0700 "$STATE_ROOT"; fi
[ "$(sudo stat -c '%U' "$STATE_ROOT")" = root ] || { echo 'gate state root is not root-owned' >&2; exit 1; }
INODE_STATE="$STATE_ROOT/gate-inode-${VERIFY_USER}-${WORK_KEY}"
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
  set +e
  run_gate_command "$WORKDIR" "$@"
  RC=$?
  set -e
  [ "$RC" -eq 0 ] || ABORTED=1
  exit "$RC"
fi
SNAPSHOT="/opt/sec001-snapshot-${VERIFY_USER}-${WORK_KEY}"
if ! sudo test -f "$SNAPSHOT/.sec001-complete"; then
  sudo rm -rf -- "$SNAPSHOT"
  sudo test -d /opt || { echo 'snapshot root /opt is unavailable' >&2; exit 1; }
  [ "$(sudo stat -c '%U' /opt)" = root ] || { echo 'snapshot root /opt is not root-owned' >&2; exit 1; }
  sudo cp -a "$WORKDIR" "$SNAPSHOT"
  # Harden BEFORE writing the marker: the marker's only meaning is "this
  # snapshot is root-owned and read-only", so it must be the last thing done.
  # A crash mid-way leaves an unmarked snapshot, which the next run rebuilds.
  sudo chown -R root:root "$SNAPSHOT"
  sudo chmod -R a-w "$SNAPSHOT"
  sudo touch "$SNAPSHOT/.sec001-complete"
  sudo chown root:root "$SNAPSHOT/.sec001-complete"
  sudo chmod a-w "$SNAPSHOT/.sec001-complete"
fi
RUN_DIR=$(sudo mktemp -d /opt/sec001-gate-run.XXXXXX)
sudo chown -R "$VERIFY_USER":"$VERIFY_USER" "$RUN_DIR"
sudo cp -a "$SNAPSHOT"/. "$RUN_DIR"/
sudo chown -R "$VERIFY_USER":"$VERIFY_USER" "$RUN_DIR"
sudo chmod -R u+rwX "$RUN_DIR"
set +e
run_gate_command "$RUN_DIR" "$@"
RC=$?
set -e
[ "$RC" -eq 0 ] || ABORTED=1
sudo rm -rf -- "$RUN_DIR"
exit "$RC"
