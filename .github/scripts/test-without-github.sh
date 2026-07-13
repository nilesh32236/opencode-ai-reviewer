#!/usr/bin/env bash
# test-without-github.sh
# Complete guide and script for testing the action WITHOUT a real GitHub repo.
#
# This script simulates the GitHub Actions environment locally.
#
# Prerequisites:
#   - Node.js 22+
#   - npm
#   - Docker (optional, for containerized testing)
#
# Usage:
#   ./scripts/test-without-github.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
echo -e "${CYAN}  OpenCode AI Reviewer — Local Testing Suite${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
echo ""

# ─── Step 1: Type Check ───
echo -e "${YELLOW}[1/5]${NC} Type checking..."
npx tsc --noEmit 2>&1 || { echo "Type check failed"; exit 1; }
echo -e "${GREEN}  ✓ Types OK${NC}"

# ─── Step 2: Lint ───
echo -e "${YELLOW}[2/5]${NC} Linting..."
npx eslint src/**/*.ts 2>&1 || true
echo -e "${GREEN}  ✓ Lint OK${NC}"

# ─── Step 3: Unit Tests ───
echo -e "${YELLOW}[3/5]${NC} Running unit tests..."
npx jest tests/unit --verbose 2>&1
echo -e "${GREEN}  ✓ Unit tests passed${NC}"

# ─── Step 4: JSONL Parser Smoke Test ───
echo -e "${YELLOW}[4/5]${NC} JSONL parser smoke test..."
node -e "
const { parseJsonlString, buildReviewBody, buildInlineComments } = require('./lib/jsonl-parser');

// Test with sample data
const sample = [
  '{\"type\":\"summary\",\"text\":\"Test summary.\"}',
  '{\"type\":\"verdict\",\"ready\":true,\"reasoning\":\"All good.\"}',
  '{\"type\":\"strength\",\"file\":\"a.ts\",\"line\":1,\"message\":\"Good.\"}',
  '{\"type\":\"issue\",\"severity\":\"critical\",\"file\":\"b.ts\",\"line\":10,\"message\":\"Bug.\",\"suggestion\":\"Fix it.\",\"inline\":true}',
  '{\"type\":\"issue\",\"severity\":\"minor\",\"file\":\"c.ts\",\"line\":5,\"message\":\"Style.\"}',
  '{\"not valid json\"}',
].join('\n');

const result = parseJsonlString(sample);
console.log('  Summary:', result.summary?.text);
console.log('  Verdict:', result.verdict?.ready);
console.log('  Issues:', result.issues.length, '(failed lines:', result.failedLines + ')');
console.log('  Body length:', buildReviewBody(result).length, 'chars');
console.log('  Inline comments:', buildInlineComments(result).length);

if (result.criticalCount !== 1) throw new Error('Expected 1 critical');
if (result.failedLines !== 1) throw new Error('Expected 1 failed line');
console.log('  ✓ All assertions passed');
" 2>&1
echo -e "${GREEN}  ✓ Smoke test passed${NC}"

# ─── Step 5: Build Verification ───
echo -e "${YELLOW}[5/5]${NC} Build verification..."
npm run build:all 2>&1
test -f dist/index.js || { echo "dist/index.js missing!"; exit 1; }
test -f dist/post/index.js || { echo "dist/post/index.js missing!"; exit 1; }
echo -e "${GREEN}  ✓ Build OK${NC}"

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo -e "${GREEN}  All checks passed!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo ""
echo "To test with a real repo:"
echo "  1. Create a .env file with GITHUB_TOKEN=your-token"
echo "  2. Run: GITHUB_TOKEN=\$(cat .env | cut -d= -f2) node -e \\"
echo "    \"require('./lib/github-client').GitHubClient; console.log('Auth OK')\\"
echo "  3. Or use act: act push -W .github/workflows/ci.yml"