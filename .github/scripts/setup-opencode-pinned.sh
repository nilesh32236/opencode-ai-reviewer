#!/usr/bin/env bash
# Install the campaign-pinned OpenCode CLI without a GitHub token.
# The agent jobs must not receive repository or GitHub credentials merely to
# download the model binary. The archive is pinned and checksum-verified.
set -euo pipefail

EXPECTED_VERSION='v1.18.31'
VERSION="${OPENCODE_VERSION:-$EXPECTED_VERSION}"
if [ "$VERSION" != "$EXPECTED_VERSION" ]; then
  echo "SEC-001: refusing unpinned OpenCode version '$VERSION' (expected $EXPECTED_VERSION)" >&2
  exit 2
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH='linux-x64'; CHECKSUM='e9312be75ed803b7415fc2aeabda1f4fe938912a39673762dc0c38c0e11ebde4' ;;
  aarch64|arm64) ARCH='linux-arm64'; CHECKSUM='d4e332f46b227448582c0d9fc75f6f826dfe95c9f751bc2011fc4d937a042be6' ;;
  *) echo "SEC-001: unsupported runner architecture: $(uname -m)" >&2; exit 2 ;;
esac

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
ARCHIVE="$TMP_DIR/opencode.tar.gz"
URL="https://github.com/anomalyco/opencode/releases/download/${VERSION}/opencode-${ARCH}.tar.gz"

curl --fail --silent --show-error --location --retry 3 --proto '=https' --tlsv1.2 \
  "$URL" --output "$ARCHIVE"
printf '%s  %s\n' "$CHECKSUM" "$ARCHIVE" | sha256sum --check --status

mkdir -p "$TMP_DIR/extracted"
tar --extract --gzip --file "$ARCHIVE" --directory "$TMP_DIR/extracted"
if [ ! -f "$TMP_DIR/extracted/opencode" ]; then
  echo "SEC-001: pinned archive did not contain an opencode binary" >&2
  exit 1
fi
install -m 0755 "$TMP_DIR/extracted/opencode" /usr/local/bin/opencode
opencode --version
