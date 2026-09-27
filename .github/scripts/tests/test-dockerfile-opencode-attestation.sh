#!/usr/bin/env bash
#
# test-dockerfile-opencode-attestation.sh — regression matrix for the
# build-time attestation in docker/Dockerfile.
#
# The Dockerfile is not covered by the unit suite, so this script asserts both
# halves of the trust path in isolation:
#
#   1. STATIC  — the Dockerfile still verifies the downloaded archive against a
#      literal pinned digest, still emits the attestation, still copies it into
#      the runtime stage, and still leaves it root-owned/read-only while
#      re-verifying the copied binary against it.
#   2. FUNCTIONAL — the builder's RUN block is extracted verbatim from the
#      Dockerfile (only the install prefix is redirected into a temp root, and
#      `curl` is stubbed) and actually executed against fixture archives. This
#      is what makes the test non-vacuous: a corrupted archive must make the
#      block FAIL, and a good archive must yield an attestation whose
#      binarySha256 is the digest of the EXTRACTED BINARY, not of the archive.
#
# Case 2c additionally cross-checks the attestation path in the Dockerfile
# against DEFAULT_ATTESTATION_PATH in lib/src/utils/attestation.ts, so the two
# cannot drift apart without a red build.
#
# Usage:
#   bash .github/scripts/tests/test-dockerfile-opencode-attestation.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
DOCKERFILE="${DOCKERFILE:-${REPO_ROOT}/docker/Dockerfile}"
ATTESTATION_TS="${REPO_ROOT}/lib/src/utils/attestation.ts"

PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); echo "ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }

assert_contains() { # $1=label $2=file $3=extended-regex
  if grep -Eq -- "$3" "$2"; then ok "$1"; else bad "$1 (no match for /$3/ in $2)"; fi
}

assert_not_contains() { # $1=label $2=file $3=extended-regex
  if grep -Eq -- "$3" "$2"; then bad "$1 (unexpected match for /$3/ in $2)"; else ok "$1"; fi
}

WORK="${TMPDIR:-/tmp}/dockerfile-attest-$$"
cleanup() { chmod -R u+rwX "$WORK" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT
mkdir -p "$WORK"

# --- 1. STATIC: the Dockerfile text ---------------------------------------

assert_contains "archive is verified with sha256sum -c -" "$DOCKERFILE" \
  'sha256sum -c -'
assert_contains "the verified path is the downloaded archive" "$DOCKERFILE" \
  'sha256sum -c -.*opencode\.tar\.gz|OPENCODE_SHA256.*opencode\.tar\.gz.*sha256sum -c'
assert_contains "the binary is extracted to /usr/local/bin" "$DOCKERFILE" \
  'tar -xzf .*opencode\.tar\.gz -C /usr/local/bin/'
assert_contains "the attestation is written to the well-known path" "$DOCKERFILE" \
  '/usr/local/share/opencode/attestation\.json'
assert_contains "the attestation binds the EXTRACTED BINARY's digest" "$DOCKERFILE" \
  'BINARY_SHA256=\$\(sha256sum /usr/local/bin/opencode'
# The jq invocation spans several lines, so match against a flattened copy.
FLAT="$(tr '\n' ' ' < "$DOCKERFILE")"
if printf '%s' "$FLAT" | grep -Eq 'jq -n .*--arg binarySha256'; then
  ok "the attestation is produced with jq -n (not string concatenation)"
else
  bad "the attestation is not produced with jq -n --arg binarySha256"
fi
if printf '%s' "$FLAT" | grep -Eq '\{version: \$version, binarySha256: \$binarySha256, source: \$source\}'; then
  ok "the attestation names its source"
else
  bad "the attestation does not name its source"
fi
assert_contains "the attestation is copied into the runtime stage" "$DOCKERFILE" \
  'COPY --from=builder /usr/local/share/opencode/attestation\.json'
assert_contains "the attestation is left read-only in the runtime image" "$DOCKERFILE" \
  'chmod 0444 /usr/local/share/opencode/attestation\.json'
# KILLS "chmod 0777 the directory": the FILE mode alone is not the
# control -- a group- or world-writable parent lets the runtime user
# unlink and replace the record while leaving the file's own mode intact.
assert_contains "the attestation directory is pinned root-owned 0755" "$DOCKERFILE" \
  'chmod 0755 /usr/local/share/opencode'
assert_contains "the runtime stage re-verifies the copied binary against the record" "$DOCKERFILE" \
  "sha256sum /usr/local/bin/opencode"

# KILLS "drop the archive checksum step, attestation is enough": the archive
# pin must remain, otherwise a swapped archive yields a self-consistent
# attestation of a malicious binary.
assert_not_contains "the archive pin was not replaced by a self-computed digest" \
  "$DOCKERFILE" 'OPENCODE_SHA256=.*\$\(sha256sum /tmp/opencode'

# KILLS "let the runtime user rewrite the record it is checked against": the
# chown of the binary must not extend to the attestation.
assert_contains "the binary is owned by the unprivileged runtime user" "$DOCKERFILE" \
  'chown -R reviewer:reviewer /app /usr/local/bin/opencode'
if grep -Eq 'chown[^\\]*attestation\.json' "$DOCKERFILE"; then
  bad "the attestation must stay root-owned (found a chown of attestation.json)"
else
  ok "the attestation stays root-owned"
fi

# KILLS "drift the two sides of the contract": the Dockerfile path and the lib
# default must be the same string.
if [ -f "$ATTESTATION_TS" ]; then
  lib_path="$(sed -n "s/.*DEFAULT_ATTESTATION_PATH = '\([^']*\)'.*/\1/p" "$ATTESTATION_TS" | head -n1)"
  if [ -n "$lib_path" ] && grep -Fq "$lib_path" "$DOCKERFILE"; then
    ok "Dockerfile path matches DEFAULT_ATTESTATION_PATH (${lib_path})"
  else
    bad "Dockerfile attestation path does not match lib DEFAULT_ATTESTATION_PATH ('${lib_path}')"
  fi
else
  bad "missing ${ATTESTATION_TS}"
fi

# --- 2. FUNCTIONAL: run the builder's RUN block --------------------------
#
# Extract the `RUN set -eux; \` block that downloads opencode, un-escape its
# line continuations, and redirect the install prefix into the temp root. The
# control flow, the checksum comparison and the jq invocation are the
# Dockerfile's own text, not a re-implementation of it.

extract_run_block() {
  awk '
    /^RUN set -eux; \\$/ { buf = $0; inblock = 1; next }
    inblock {
      buf = buf "\n" $0
      if ($0 !~ /\\$/) { if (buf ~ /opencode\.tar\.gz/) { print buf; exit } inblock = 0 }
    }
  ' "$DOCKERFILE"
}

RUN_BLOCK="$(extract_run_block)"
if [ -z "$RUN_BLOCK" ]; then
  bad "could not extract the builder RUN block from $DOCKERFILE"
  echo "---"
  echo "pass=$PASS fail=$FAIL"
  exit 1
fi

# Fixture "binary" that reports a version, so the block's `opencode --version`
# probe is genuinely exercised.
mkdir -p "$WORK/fixtures"
cat > "$WORK/fixtures/opencode" <<'BIN_EOF'
#!/bin/sh
echo "opencode v1.18.15"
BIN_EOF
chmod +x "$WORK/fixtures/opencode"

# The archive must hash to whatever pin the Dockerfile itself declares for this
# host's arch, so parse the pin out rather than duplicating the digest here.
HOST_ARCH="$(uname -m)"
if [ "$HOST_ARCH" = "aarch64" ]; then STUB_ARCH="linux-arm64"; else STUB_ARCH="linux-x64"; fi
PIN="$(sed -n "/OPENCODE_ARCH=\"${STUB_ARCH}\"; \\\\/ {n; s/.*OPENCODE_SHA256=\"\([0-9a-f]\{64\}\)\".*/\1/p;}" "$DOCKERFILE")"
if printf '%s' "$PIN" | grep -Eq '^[0-9a-f]{64}$'; then
  ok "archive pin is a literal 64-hex constant for ${STUB_ARCH}"
else
  bad "no literal 64-hex archive pin found for ${STUB_ARCH} (got '${PIN}')"
fi

ARCHIVE="$WORK/opencode.tar.gz"
tar -czf "$ARCHIVE" -C "$WORK/fixtures" opencode
ARCHIVE_SHA="$(sha256sum "$ARCHIVE" | cut -d' ' -f1)"

# `curl` stub: the GitHub API call yields the release JSON jq reads; the asset
# download yields the fixture archive named by $STUB_ASSET. POSIX sh only.
mkdir -p "$WORK/stub"
cat > "$WORK/stub/curl" <<'STUB_EOF'
#!/bin/sh
# Minimal curl stub for the Dockerfile opencode-install block.
last=""
for arg in "$@"; do
  case "$arg" in
    *api.github.com*)
      printf '{"assets":[{"name":"opencode-%s.tar.gz","browser_download_url":"https://example.invalid/asset/opencode.tar.gz"}]}' \
        "${STUB_ARCH:-linux-x64}"
      exit 0 ;;
    -*) continue ;;
    *) last="$arg" ;;
  esac
done
case "$last" in
  *opencode.tar.gz) cp "${STUB_ASSET:?}" "$last" ;;
  *) exit 1 ;;
esac
STUB_EOF
chmod +x "$WORK/stub/curl"

# Materialise the block against a temp install root. The ONLY edits are the
# absolute install/archive prefixes (so the unprivileged test runner can write
# them) and, for 2a, the archive pin. The comparison, the tar extraction, the
# `opencode --version` probe, the jq call and the self-check are the
# Dockerfile's own text under `set -eux`.
materialize() { # $1=root [$2=pin-to-force]
  local root="$1" pin="${2:-}"
  mkdir -p "$root/bin" "$root/share/opencode"
  # The block is one logical `RUN` line: join the `\`-continuations, drop the
  # `RUN` keyword, then redirect only the absolute install/archive prefixes
  # (the unprivileged test runner cannot write /usr/local). For 2a the pinned
  # archive digest is also swapped for the fixture's real digest, so the
  # `sha256sum -c -` comparison is genuinely exercised rather than skipped.
  printf '%s\n' "$RUN_BLOCK" \
    | awk '{ l = (p != "" ? p " " $0 : $0)
             if (l ~ /\\$/) { sub(/\\$/, "", l); p = l } else { print l; p = "" } }' \
    | sed -e 's/^RUN //' \
          -e "s#/tmp/opencode\.tar\.gz#${root}/opencode.tar.gz#g" \
          -e "s#/usr/local/share/opencode#${root}/share/opencode#g" \
          -e "s#-C /usr/local/bin/#-C ${root}/bin/#g" \
          -e "s#/usr/local/bin/opencode#${root}/bin/opencode#g" \
          ${pin:+-e "s#OPENCODE_SHA256=\"[0-9a-f]\{64\}\"#OPENCODE_SHA256=\"${pin}\"#g"} \
    > "$root/run-block.sh"
  # Supply the build ARG the block interpolates, and put the (redirected) bin
  # dir on PATH the way /usr/local/bin is on PATH inside the image. The block
  # runs under `set -eux`, and `e`+`u`+`x` means nounset is ON, so the ARG
  # must be exported into the child, not merely set in this shell.
  printf 'export PATH=%s\n' "$root/bin:\$PATH" > "$root/env.sh"
  printf 'export OPENCODE_VERSION=%s\n' "${ARG_VERSION:-v1.18.15}" >> "$root/env.sh"
}

# --- 2a. matching archive => attestation bound to the extracted binary -----
GOOD="$WORK/good"
materialize "$GOOD" "$ARCHIVE_SHA"
( export PATH="$GOOD/bin:$WORK/stub:$PATH"; . "$GOOD/env.sh"
  STUB_ARCH="$STUB_ARCH" STUB_ASSET="$ARCHIVE" sh "$GOOD/run-block.sh" ) >"$GOOD/out.log" 2>&1
rc=$?
if [ $rc -eq 0 ]; then ok "2a matching archive: install block succeeds"; else bad "2a matching archive: install block failed (rc=$rc)"; sed -n '1,25p' "$GOOD/out.log"; fi

ATT="$GOOD/share/opencode/attestation.json"
if [ -f "$ATT" ]; then
  ok "2a the attestation file exists"
  A_SHA="$(jq -r '.binarySha256 // empty' "$ATT")"
  A_VER="$(jq -r '.version // empty' "$ATT")"
  A_SRC="$(jq -r '.source // empty' "$ATT")"
  BIN_SHA=""
  if [ -f "$GOOD/bin/opencode" ]; then
    BIN_SHA="$(sha256sum "$GOOD/bin/opencode" | cut -d' ' -f1)"
  else
    bad "2a the install block produced no binary to attest"
  fi
  # Guard against the all-empty comparison passing vacuously.
  if [ -z "$A_SHA" ] || [ -z "$BIN_SHA" ]; then
    bad "2a empty digest(s) (attestation='${A_SHA}' binary='${BIN_SHA}') — assertion would be vacuous"
  elif [ "$A_SHA" = "$BIN_SHA" ]; then
    ok "2a binarySha256 is the digest of the EXTRACTED BINARY"
  else
    bad "2a binarySha256 (${A_SHA}) != extracted binary digest (${BIN_SHA})"
  fi
  if [ -n "$A_SHA" ] && [ "$A_SHA" != "$ARCHIVE_SHA" ]; then
    ok "2a binarySha256 is not the archive digest (it really binds the binary)"
  else
    bad "2a binarySha256 equals the ARCHIVE digest — the attestation is not binding the binary"
  fi
  if [ "$A_VER" = "1.18.15" ]; then ok "2a version comes from the installed binary's --version"; else bad "2a version is '${A_VER}', expected 1.18.15"; fi
  if [ "$A_SRC" = "dockerfile-build" ]; then ok "2a source is dockerfile-build"; else bad "2a source is '${A_SRC}'"; fi
  if printf '%s' "$A_SHA" | grep -Eq '^[0-9a-f]{64}$'; then
    ok "2a binarySha256 is a bare 64-char lowercase hex digest (parseable by lib)"
  else
    bad "2a binarySha256 '${A_SHA}' is not a bare 64-char hex digest"
  fi
else
  bad "2a no attestation was written"
fi

# --- 2b. tampered archive must FAIL the build, with no attestation ---------
BAD="$WORK/bad"
TAMPERED="$WORK/tampered.tar.gz"
cp "$ARCHIVE" "$TAMPERED"
# Flip one byte in the compressed payload: same filename, different bytes.
printf 'X' | dd of="$TAMPERED" bs=1 seek=64 conv=notrunc status=none
materialize "$BAD"
( export PATH="$BAD/bin:$WORK/stub:$PATH"; . "$BAD/env.sh"
  STUB_ARCH="$STUB_ARCH" STUB_ASSET="$TAMPERED" sh "$BAD/run-block.sh" ) >"$BAD/out.log" 2>&1
rc=$?
if [ $rc -ne 0 ]; then ok "2b tampered archive: install block FAILS the build"; else bad "2b tampered archive was accepted (rc=0) — the archive pin is not enforced"; fi
if grep -Eq 'WARNING: computed checksum|FAILED' "$BAD/out.log"; then
  ok "2b the failure comes from the sha256sum -c - step"
else
  bad "2b the failure did not come from sha256sum -c -"
fi
if [ -f "$BAD/share/opencode/attestation.json" ]; then
  bad "2b an attestation was written for a rejected archive"
else
  ok "2b no attestation is written when the archive check fails"
fi

# --- 2c. CI actually runs this script --------------------------------------
CI="${REPO_ROOT}/.github/workflows/ci.yml"
if [ -f "$CI" ]; then
  if grep -Eq 'bash \.github/scripts/tests/test-dockerfile-opencode-attestation\.sh' "$CI"; then
    ok "2c ci.yml runs this script"
  else
    bad "2c ci.yml does NOT run this script"
  fi
else
  bad "missing ${CI}"
fi

echo "---"
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
