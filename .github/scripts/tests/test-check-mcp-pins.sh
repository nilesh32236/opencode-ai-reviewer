#!/usr/bin/env bash
#
# test-check-mcp-pins.sh — behavioural tests for the MCP pin tiers.
#
# The bug this exists for: `drift` was treated exactly like a documented
# `npx-only` exception, so a real supply-chain disagreement between
# MCP_PACKAGE_VERSIONS and pnpm-lock.yaml sat on `main` unnoticed for long
# enough that the version under test was not the version that runs (#918).
#
# These tests build real (servers.ts, pnpm-lock.yaml) pairs in a temp dir and
# run the REAL script against them, so the tiering is exercised rather than
# grepped for.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TARGET="$REPO_ROOT/.github/scripts/check-mcp-pins.sh"

pass=0
fail=0
ok() { pass=$((pass + 1)); printf '  ok  %s\n' "$1"; }
no() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }

# run_case <pin-version> <lock-version|absent> [warn-only]
# Builds a fixture and echoes the script's exit code.
run_case() {
  local pin="$1" lock="$2" warn="${3:-false}" dir rc
  dir="$(mktemp -d)"
  mkdir -p "$dir/.github/scripts" "$dir/lib/src/mcp"
  cp "$TARGET" "$dir/.github/scripts/check-mcp-pins.sh"
  {
    echo "export const MCP_PACKAGE_VERSIONS: Readonly<Record<string, string>> = {"
    echo "  '@upstash/context7-mcp': '${pin}',"
    echo "};"
  } > "$dir/lib/src/mcp/servers.ts"
  if [ "$lock" != "absent" ]; then
    {
      echo "packages:"
      echo "  '@upstash/context7-mcp@${lock}':"
      echo "    resolution: {integrity: sha512-abc}"
    } > "$dir/pnpm-lock.yaml"
  else
    echo "packages: {}" > "$dir/pnpm-lock.yaml"
  fi
  CHECK_MCP_PINS_WARN_ONLY="$warn" bash "$dir/.github/scripts/check-mcp-pins.sh" >/dev/null 2>&1
  rc=$?
  rm -rf "$dir"
  printf '%s' "$rc"
}

echo "check-mcp-pins tiering"

if [ "$(run_case 3.2.5 3.2.5)" = "0" ]; then
  ok "matching pin and lock passes"
else
  no "matching pin and lock should pass"
fi

if [ "$(run_case 3.2.5 3.2.3)" = "1" ]; then
  ok "DRIFT FAILS the build (the #918 regression)"
else
  no "drift must fail; it was silent until the pin and lock diverged"
fi

if [ "$(run_case 3.2.5 absent)" = "0" ]; then
  ok "npx-only package stays a notice and does not block"
else
  no "npx-only is a documented exception and must not fail CI"
fi

if [ "$(run_case 3.2.5 3.2.3 true)" = "0" ]; then
  ok "CHECK_MCP_PINS_WARN_ONLY=true downgrades drift to a warning"
else
  no "warn-only override should let a tracked drift through"
fi

echo
printf 'passed: %d  failed: %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
