#!/usr/bin/env bash
# Trusted verification supervisor. This file is copied root-owned/read-only
# before candidate code runs. Candidate commands execute under sec001-verify;
# the supervisor alone records their aggregate exit status and writes the
# diagnostic raw result consumed by a later fresh finalizer.
set -euo pipefail
[ "$#" -eq 7 ] || { echo 'usage: sec001-supervisor.sh WORKDIR RUN_ID BASE_SHA PHASE STATUS_DIR GATE_RUNNER GITHUB_OUTPUT' >&2; exit 2; }
WORKDIR="$1"; RUN_ID="$2"; BASE_SHA="$3"; PHASE="$4"; STATUS_DIR="$5"; GATE_RUNNER="$6"; OUTPUT_FILE="$7"
[ -d "$WORKDIR" ] && [ -x "$GATE_RUNNER" ] && [ -n "$OUTPUT_FILE" ] || { echo 'invalid supervisor arguments' >&2; exit 2; }
case "$BASE_SHA" in [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;; *) echo 'invalid base SHA' >&2; exit 2 ;; esac
case "$PHASE" in verify-initial|verify-final) ;; *) echo 'invalid verification phase' >&2; exit 2 ;; esac
[ ! -e "$STATUS_DIR" ] && [ ! -L "$STATUS_DIR" ] || { echo 'status directory already exists or is a symlink' >&2; exit 1; }
mkdir "$STATUS_DIR"
LOG="$STATUS_DIR/verification.log"
: > "$LOG"
RC=0
"$GATE_RUNNER" --direct "$WORKDIR" pnpm install --frozen-lockfile >>"$LOG" 2>&1 || RC=1
for command in build typecheck test lint doc:check; do
  "$GATE_RUNNER" "$WORKDIR" pnpm "$command" >>"$LOG" 2>&1 || RC=1
done
if [ "$RC" -eq 0 ]; then VERIFIED=true; else VERIFIED=false; fi
jq -n --arg run "$RUN_ID" --arg base "$BASE_SHA" --arg phase "$PHASE" --argjson verified "$VERIFIED" '{run_id:$run,base_sha:$base,phase:$phase,verified:$verified}' > "$STATUS_DIR/status.json"
printf 'verified=%s\n' "$VERIFIED" >> "$OUTPUT_FILE"
exit "$RC"
