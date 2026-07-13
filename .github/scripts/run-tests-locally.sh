#!/usr/bin/env bash
# run-tests-locally.sh
# Run the action locally WITHOUT GitHub Actions runtime.
# Uses mock data and simulates the GitHub event context.
#
# Usage:
#   ./scripts/run-tests-locally.sh [mode]
#   Modes: unit, integration, all (default: all)
#
# Prerequisites:
#   - Node.js 22+
#   - npm

set -euo pipefail

MODE="${1:-all}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "=== OpenCode AI Reviewer — Local Test Runner ==="
echo ""

# Install dependencies
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm ci
  echo ""
fi

case "$MODE" in
  unit)
    echo "── Running unit tests ──"
    npx jest tests/unit --verbose --coverage
    ;;

  integration)
    echo "── Running integration tests ──"
    npx jest tests/integration --verbose --runInBand
    ;;

  all)
    echo "── Running all tests ──"
    npx jest --verbose --coverage
    ;;

  *)
    echo "Unknown mode: $MODE"
    echo "Usage: $0 [unit|integration|all]"
    exit 1
    ;;
esac

echo ""
echo "=== Tests complete ==="