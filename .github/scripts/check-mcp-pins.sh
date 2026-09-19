#!/usr/bin/env bash
#
# check-mcp-pins.sh — warn-only verification that the runtime MCP server pins
# in `MCP_PACKAGE_VERSIONS` (lib/src/mcp/servers.ts) match `pnpm-lock.yaml`.
#
# WARN-ONLY BY DESIGN: always exits 0, never fails the build. Mismatches are
# reported as GitHub warning annotations so they are visible without blocking.
# Rationale: npx-fetched server packages (used at review runtime) should track
# the audited lockfile pins; drift (or an npx-only package with no lock entry)
# deserves attention but must not break CI.
#
# Tiers per pin:
#   pinned   — `<name>@<version>` snapshot exists in the lock. Silent.
#   drift    — package is in the lock but at another version. ::warning.
#   npx-only — package never appears in the lock (runtime npx fetch, e.g.
#              @modelcontextprotocol/server-github). ::notice (documented
#              exception, not a failure).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$REPO_ROOT/lib/src/mcp/servers.ts"
LOCK="$REPO_ROOT/pnpm-lock.yaml"

warn=0
drift=0
npx_only=0

pin_lines="$(grep -oE "'@[^']+': '[0-9][^']*'" "$SRC" || true)"
if [ -z "$pin_lines" ]; then
  echo "::warning::check-mcp-pins: no pins parsed from lib/src/mcp/servers.ts"
  exit 0
fi

while IFS= read -r line; do
  name="$(printf '%s' "$line" | cut -d"'" -f2)"
  version="$(printf '%s' "$line" | cut -d"'" -f4)"
  [ -n "$name" ] && [ -n "$version" ] || continue
  if grep -qF "'${name}@${version}':" "$LOCK"; then
    echo "pinned: ${name}@${version} matches pnpm-lock"
  elif grep -qF "'${name}@" "$LOCK"; then
    locked="$(grep -oE "'${name}@[^']+':" "$LOCK" | sort -u | paste -sd' ' - || true)"
    echo "::warning::check-mcp-pins: drift — MCP_PACKAGE_VERSIONS pins ${name}@${version} but pnpm-lock has ${locked} (align the pin or the dependency)"
    drift=$((drift + 1))
  else
    echo "::notice::check-mcp-pins: ${name}@${version} is npx-only (no pnpm-lock entry) — documented exception"
    npx_only=$((npx_only + 1))
  fi
done <<< "$pin_lines"

echo "check-mcp-pins: done (drift=${drift}, npx-only=${npx_only}) — warn-only, build unaffected"
exit 0
