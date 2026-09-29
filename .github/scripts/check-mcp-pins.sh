#!/usr/bin/env bash
#
# check-mcp-pins.sh — warn-only verification that the runtime MCP server pins
# in `MCP_PACKAGE_VERSIONS` (lib/src/mcp/servers.ts) match `pnpm-lock.yaml`.
#
# TIERED: `drift` FAILS the build, `npx-only` stays a notice.
# Rationale: an npx-fetched server package with no lockfile entry is a
# documented, intentional exception and must never block CI. Drift is different:
# the package IS in the lockfile, so the pin and the lock are simply disagreeing
# about which audited artifact is in use. That was silently tolerated until it
# went unnoticed long enough for the pin and the lock to sit two patch releases
# apart (issue #918) -- the version under test was not the version that runs.
# A genuine supply-chain signal should not cost build stability.
#
# Override with CHECK_MCP_PINS_WARN_ONLY=true where a temporary drift is known
# and being tracked.
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

if [ "${CHECK_MCP_PINS_WARN_ONLY:-false}" = "true" ]; then
  echo "check-mcp-pins: done (drift=${drift}, npx-only=${npx_only}) — CHECK_MCP_PINS_WARN_ONLY=true, not failing"
  exit 0
fi

echo "check-mcp-pins: done (drift=${drift}, npx-only=${npx_only})"
if [ "$drift" -gt 0 ]; then
  echo "::error::check-mcp-pins: ${drift} pin(s) disagree with pnpm-lock. Align MCP_PACKAGE_VERSIONS with the lockfile (or bump the dependency to the pinned version), or set CHECK_MCP_PINS_WARN_ONLY=true if the drift is known and tracked."
  exit 1
fi
exit 0
