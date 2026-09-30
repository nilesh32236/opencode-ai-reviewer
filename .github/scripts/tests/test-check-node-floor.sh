#!/usr/bin/env bash
# The node-floor guard (scripts/check-node-floor.mjs) refuses to build the
# committed action bundles on a Node below the declared floor. It shipped with
# NO test, and a guard that has never been executed is a guard nobody knows
# works -- which is the same "a check that cannot fail" class this repo keeps
# hitting. These cases pin both the enforcement and the fail-OPEN path.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
GUARD="$REPO_ROOT/scripts/check-node-floor.mjs"
pass=0
fail=0
RC=0
ok() { printf '    ok  %s\n' "$1"; pass=$((pass + 1)); }
no() { printf '    FAIL %s\n' "$1"; fail=$((fail + 1)); }

[ -f "$GUARD" ] || { echo "guard missing: $GUARD" >&2; exit 1; }

# Run the guard in an isolated tree with a chosen engines.node and a chosen
# process.versions.node. process.versions is read-only, so it is patched by a
# --import preload rather than by assigning to it inside the test.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

run_guard() { # run_guard <engines-node-spec> <pretend-node-version>
  local spec="$1" pretend="$2" d
  d="$(mktemp -d "$TMP/case.XXXXXX")"
  mkdir -p "$d/scripts"
  cp "$GUARD" "$d/scripts/check-node-floor.mjs"
  if [ -n "$spec" ]; then
    printf '{"engines":{"node":"%s"}}' "$spec" > "$d/package.json"
  else
    # No engines.node at all. Writing {"engines":{"node":}} here would be invalid
    # JSON and JSON.parse would throw, which tests the parser, not the guard.
    printf '{"name":"fixture","version":"0.0.0"}\n' > "$d/package.json"
  fi
  cat > "$d/preload.mjs" <<PRE
Object.defineProperty(process.versions, 'node', { value: '$pretend', configurable: true });
PRE
  # NOTE: the rc is returned in a global, never echoed into the output stream.
  # An earlier version did `out="$(run_guard ...)"` then `rc=$?`, which reads the
  # status of the ASSIGNMENT, not of the guard -- so every case passed on rc while
  # the real behaviour went unmeasured.
  local rc_file="$TMP/last_rc"
  ( cd "$d" && node --import ./preload.mjs scripts/check-node-floor.mjs > "$rc_file.out" 2>&1 )
  echo $? > "$rc_file"
  cat "$rc_file.out"
}

expect() { # expect <label> <expected-rc> <actual-rc>
  if [ "$2" = "$3" ]; then ok "$1 (rc=$3)"; else no "$1 (expected rc=$2, got $3)"; fi
}

echo
echo "  --- enforcement ---"
out="$(run_guard '>=24.21.0' 'v24.20.0')"
rc="$(cat "$TMP/last_rc")"
expect "below the floor refuses the build" 1 "$rc"
case "$out" in *"Refusing to build"*) ok "failure message says why" ;;
  *) no "failure message missing the explanation" ;; esac
case "$out" in *"24.21.0"*) ok "message names the required floor" ;;
  *) no "message does not name the required floor" ;; esac
case "$out" in *"24.20.0"*) ok "message names the running Node" ;;
  *) no "message does not name the running Node" ;; esac

out="$(run_guard '>=24.21.0' 'v24.21.0')"
rc="$(cat "$TMP/last_rc")"
expect "exactly at the floor is allowed" 0 "$rc"
out="$(run_guard '>=24.21.0' 'v24.21.3')"
rc="$(cat "$TMP/last_rc")"
expect "above the floor is allowed" 0 "$rc"
out="$(run_guard '>=24.21.0' 'v25.0.0')"
rc="$(cat "$TMP/last_rc")"
expect "a newer major is allowed" 0 "$rc"
out="$(run_guard '>=24.21.0' 'v22.14.0')"
rc="$(cat "$TMP/last_rc")"
expect "a much older major is refused" 1 "$rc"
out="$(run_guard '>=24.21.0' 'v24.9.99')"
rc="$(cat "$TMP/last_rc")"
expect "24.9.99 is below 24.21.0 and refused" 1 "$rc"

echo
echo "  --- fail-closed on an unparseable RUNNING version ---"
out="$(run_guard '>=24.21.0' 'garbage')"
rc="$(cat "$TMP/last_rc")"
expect "an unparseable running Node fails closed" 1 "$rc"

echo
echo "  --- documented fail-OPEN when no floor is declared ---"
# Pinned deliberately: with no parseable engines.node there is nothing to
# enforce, so the guard exits 0. This is a real behaviour, not an oversight --
# it is recorded here so a future change to it is a deliberate diff.
out="$(run_guard '' 'v1.0.0')"
rc="$(cat "$TMP/last_rc")"
expect "an empty engines.node is a no-op, not a crash" 0 "$rc"
out="$(run_guard 'lts/*' 'v1.0.0')"
rc="$(cat "$TMP/last_rc")"
expect "a non-version range such as lts/* is a no-op" 0 "$rc"

echo
printf 'passed: %d  failed: %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
