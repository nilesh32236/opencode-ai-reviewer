#!/usr/bin/env bash
# setup-opencode.sh
# Installs and configures OpenCode for use in GitHub Actions.
# Replaces the anomalyco/opencode/github@latest third-party action.
#
# Usage:
#   source setup-opencode.sh
#   # Then run: opencode run --model <model> --prompt "<prompt>"
#
# Environment:
#   GITHUB_TOKEN — required for GitHub API access
#   OPENCODE_VERSION — optional, defaults to "latest"

set -euo pipefail

OPENCODE_VERSION="${OPENCODE_VERSION:-latest}"

echo "::group::Setting up OpenCode ${OPENCODE_VERSION}"

# Determine arch
ARCH="linux-x64"
case "$(uname -m)" in
  aarch64|arm64) ARCH="linux-arm64" ;;
  x86_64|amd64)  ARCH="linux-x64" ;;
esac

# Download opencode binary from GitHub releases
echo "Downloading opencode ${OPENCODE_VERSION} (${ARCH})..."

if [ "$OPENCODE_VERSION" = "latest" ]; then
  RELEASE_URL="https://api.github.com/repos/anomalyco/opencode/releases/latest"
  DOWNLOAD_URL=$(curl -fsSL "$RELEASE_URL" | jq -r '.assets[] | select(.name == "opencode-'"${ARCH}"'.tar.gz") | .browser_download_url')
else
  RELEASE_URL="https://api.github.com/repos/anomalyco/opencode/releases/tags/${OPENCODE_VERSION}"
  DOWNLOAD_URL=$(curl -fsSL "$RELEASE_URL" | jq -r '.assets[] | select(.name == "opencode-'"${ARCH}"'.tar.gz") | .browser_download_url')
fi

if [ -z "$DOWNLOAD_URL" ] || [ "$DOWNLOAD_URL" = "null" ]; then
  echo "Error: Could not find opencode binary for ${ARCH}"
  exit 1
fi

echo "Downloading from: ${DOWNLOAD_URL}"
curl -fsSL "$DOWNLOAD_URL" -o /tmp/opencode.tar.gz
tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin/
chmod +x /usr/local/bin/opencode
rm /tmp/opencode.tar.gz

# Verify installation
opencode --version 2>&1 || true
echo "OpenCode installed at: $(which opencode)"

# Configure git for OpenCode
git config --global user.name "${GIT_USER_NAME:-nilesh32236}"
git config --global user.email "${GIT_USER_EMAIL:-nilesh32236@gmail.com}"

# Ensure .opencode directory exists
mkdir -p .opencode

echo "::endgroup::"
echo "OpenCode setup complete."
