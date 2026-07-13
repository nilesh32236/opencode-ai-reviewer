#!/usr/bin/env bash
# setup.sh — One-time project setup
# Usage: chmod +x scripts/setup.sh && ./scripts/setup.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
echo -e "${CYAN}  OpenCode AI Reviewer — Project Setup${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════${NC}"
echo ""

# Check Node.js
echo -e "${YELLOW}[1/5]${NC} Checking prerequisites..."
if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js is not installed. Install Node.js 20+ from https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "ERROR: Node.js 20+ required (found v$(node -v))"
  exit 1
fi
echo -e "  ${GREEN}Node.js $(node -v)${NC}"

if ! command -v npm &> /dev/null; then
  echo "ERROR: npm is not installed."
  exit 1
fi
echo -e "  ${GREEN}npm $(npm -v)${NC}"
echo ""

# Install dependencies
echo -e "${YELLOW}[2/5]${NC} Installing dependencies..."
npm ci
echo -e "  ${GREEN}Dependencies installed${NC}"
echo ""

# Build
echo -e "${YELLOW}[3/5]${NC} Building action..."
npm run build:all
echo -e "  ${GREEN}Build complete${NC}"
echo ""

# Run tests
echo -e "${YELLOW}[4/5]${NC} Running tests..."
npm run test:unit -- --verbose
echo -e "  ${GREEN}Tests passed${NC}"
echo ""

# Verify dist
echo -e "${YELLOW}[5/5]${NC} Verifying build artifacts..."
if [ -f "dist/index.js" ] && [ -f "dist/post/index.js" ]; then
  echo -e "  ${GREEN}dist/index.js${NC}"
  echo -e "  ${GREEN}dist/post/index.js${NC}"
else
  echo "ERROR: Build artifacts missing!"
  exit 1
fi
echo ""

echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Setup complete!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo ""
echo "Next steps:"
echo "  1. Test locally:     ./scripts/test-without-github.sh"
echo "  2. Create a repo:    git init && git add . && git commit -m 'init'"
echo "  3. Push to GitHub:   git remote add origin <repo-url> && git push -u origin main"
echo "  4. Release:          npm run release && git push --follow-tags"
echo ""
echo "To use in another repo:"
echo "  uses: <your-github-username>/opencode-ai-reviewer@v1"