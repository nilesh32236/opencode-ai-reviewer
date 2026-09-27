# OpenCode AI Reviewer — multi-stage build.
#
# Stage 1 (builder) compiles the workspace and fetches the pinned `opencode`
# CLI; only the compiled output, production dependencies, and the
# checksum-verified binary are copied into the slim runtime stage (stage 2).
# The final image carries no source, tests, or dev tooling, and runs as a
# non-root user.
#
# Both stages pin the base image to an exact Node patch release + digest so
# builds are reproducible.
# Maintainer: verify tag↔digest before changing the pin with:
#   docker buildx imagetools inspect node:24.21.0-bookworm-slim

# Stage 1 — build-time toolchain & compiled artifacts
FROM node:24.21.0-bookworm-slim@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7 AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git jq python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10.8.0

# Pin a specific opencode release and verify the downloaded archive against
# its published SHA256 before extraction, so a tampered or drifting artifact
# fails the build instead of shipping silently.
#
# Once the archive is verified, record a build-time attestation binding the
# *extracted binary's* SHA-256 (not the archive's — that is already checked
# above, and only the binary is what runs) plus its version. At runtime
# `resolveOpenCodePath()`/`setupOpenCode()` re-hash the binary on disk and
# compare against this record, which is what lets the strict checksum gate
# (`require_opencode_checksum`, now fail-closed by default in lib) accept
# this image's PATH binary instead of rejecting every pre-installed binary.
# Without it, flipping that default would break every /setup run in this
# image. `lib/tests/opencode-attestation.test.ts` covers the runtime side;
# `.github/scripts/tests/test-dockerfile-opencode-attestation.sh` covers this
# side (the Dockerfile is not exercised by unit tests).
ARG OPENCODE_VERSION=v1.18.15
RUN set -eux; \
  ARCH="$(uname -m)"; \
  if [ "$ARCH" = "aarch64" ]; then \
    OPENCODE_ARCH="linux-arm64"; \
    OPENCODE_SHA256="500611819ff88916b185649990505a9be76ad13ca5bb4b9323e5abdd39b1c6fb"; \
  else \
    OPENCODE_ARCH="linux-x64"; \
    OPENCODE_SHA256="d842e0e8c622c672a481b7dc6f0329009b64db96b2ba6041e56f4f93f0293b1c"; \
  fi; \
  RELEASE_URL="https://api.github.com/repos/anomalyco/opencode/releases/tags/${OPENCODE_VERSION}"; \
  DOWNLOAD_URL=$(curl -fsSL "$RELEASE_URL" | jq -r ".assets[] | select(.name == \"opencode-${OPENCODE_ARCH}.tar.gz\") | .browser_download_url"); \
  curl -fsSL "$DOWNLOAD_URL" -o /tmp/opencode.tar.gz; \
  echo "${OPENCODE_SHA256}  /tmp/opencode.tar.gz" | sha256sum -c -; \
  tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin/; \
  chmod +x /usr/local/bin/opencode; \
  rm /tmp/opencode.tar.gz; \
  BINARY_SHA256=$(sha256sum /usr/local/bin/opencode | cut -d" " -f1); \
  INSTALLED_VERSION=$(opencode --version | tr -d '\r' | head -n1 | sed 's/^[^0-9]*//'); \
  test -n "$INSTALLED_VERSION"; \
  mkdir -p /usr/local/share/opencode; \
  jq -n --arg version "$INSTALLED_VERSION" \
        --arg binarySha256 "$BINARY_SHA256" \
        --arg source "dockerfile-build" \
        '{version: $version, binarySha256: $binarySha256, source: $source}' \
    > /usr/local/share/opencode/attestation.json; \
  test "$(jq -r '.binarySha256' /usr/local/share/opencode/attestation.json)" = "$BINARY_SHA256"; \
  cat /usr/local/share/opencode/attestation.json

WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY lib/package.json ./lib/
COPY action/package.json ./action/
COPY app/package.json ./app/
COPY cli/package.json ./cli/

RUN pnpm install --frozen-lockfile

COPY . .

# Only the app and its lib dependency are needed in the container; skip the
# action (memory-hungry ncc --minify bundle) and cli packages entirely.
RUN pnpm --filter @opencode-pr-agent/lib --filter @opencode-pr-agent/app build

# Stage 2 — slim runtime with compiled output and production deps only
FROM node:24.21.0-bookworm-slim@sha256:5cbc7caba8c2c0f0bca675d1b61b9f2857e1cf1853c6164ee9dd409501a936e7 AS runtime

ENV NODE_ENV=production

# Build tools are only needed to compile better-sqlite3 during the prod
# install below; they are purged afterwards so no compilers ship in the image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git jq python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10.8.0

WORKDIR /app

# Install only production dependencies into a fresh, self-contained pnpm
# virtual store (workspace symlinks resolve to the copied dist below).
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY lib/package.json ./lib/
COPY action/package.json ./action/
COPY app/package.json ./app/
COPY cli/package.json ./cli/

RUN pnpm install --frozen-lockfile --prod \
    && apt-get purge -y python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy only the compiled JS + the pinned, checksum-verified CLI binary and the
# build-time attestation recorded alongside it.
COPY --from=builder /app/lib/dist ./lib/dist
COPY --from=builder /app/app/dist ./app/dist
COPY --from=builder /usr/local/bin/opencode /usr/local/bin/opencode
COPY --from=builder /usr/local/share/opencode/attestation.json /usr/local/share/opencode/attestation.json

COPY docker/validate-env.sh ./docker/validate-env.sh

RUN chmod +x docker/validate-env.sh \
    # The FILE mode alone is not the control: a world-writable parent
    # # directory would let the runtime user unlink and replace the record.
    # Pin the directory root-owned 0755 as well, and assert both in
    # # .github/scripts/tests/test-dockerfile-opencode-attestation.sh.
    && chown root:root /usr/local/share/opencode \
    && chmod 0755 /usr/local/share/opencode \
    # The FILE is already root-owned via COPY; only its mode is set here.
    && chmod 0444 /usr/local/share/opencode/attestation.json \
    && useradd --create-home --uid 10001 reviewer \
    && mkdir -p /app/app/.opencode \
    && chown -R reviewer:reviewer /app /usr/local/bin/opencode

# The attestation stays root-owned and read-only (0444) on purpose: the binary
# it describes is deliberately writable by `reviewer`, so post-build tampering
# of the binary is caught by the runtime digest re-check, while the record of
# what the build installed cannot be rewritten by the process being checked.
# Re-verify here too — a stale or truncated copy fails the image build.
RUN set -eux; \
  test "$(sha256sum /usr/local/bin/opencode | cut -d' ' -f1)" \
    = "$(jq -r '.binarySha256' /usr/local/share/opencode/attestation.json)"

# Drop privileges: the app never needs root once the image is assembled.
USER reviewer

CMD ["./docker/validate-env.sh"]