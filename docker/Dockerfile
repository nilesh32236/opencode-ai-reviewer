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
  mkdir -p /usr/local/share/opencode; \
  { echo "# opencode ${OPENCODE_VERSION} ${OPENCODE_ARCH}"; echo "# archive-sha256 ${OPENCODE_SHA256}"; sha256sum /usr/local/bin/opencode; } > /usr/local/share/opencode/install-digest; \
  cat /usr/local/share/opencode/install-digest; \
  opencode --version

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
# Keep the corepack-managed pnpm cache system-wide so the runtime `pnpm`
# shim resolves the pinned version offline (see validate-env.sh).
ENV COREPACK_HOME=/usr/local/share/corepack

WORKDIR /app

# Install only production dependencies into a fresh, self-contained pnpm
# virtual store (workspace symlinks resolve to the copied dist below).
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY lib/package.json ./lib/
COPY action/package.json ./action/
COPY app/package.json ./app/
COPY cli/package.json ./cli/

# Install, compile better-sqlite3, and purge the native toolchain in a SINGLE
# RUN: Docker layers are additive, so a separate purge step would leave the
# compilers in an earlier layer. Cache mounts keep apt fast without leaving
# package lists or archives in the image. Only `git` (invoked by
# app/src/utils/git.ts) and `ca-certificates` (TLS to GitHub/opencode) remain
# at runtime; curl/jq are builder-only. pnpm comes from corepack so the pinned
# version is integrity-checked against package.json's `packageManager` rather
# than installed with root-owned npm lifecycle scripts.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ git ca-certificates \
    && corepack enable \
    && corepack prepare pnpm@10.8.0 --activate \
    && pnpm install --frozen-lockfile --prod \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy only the compiled JS + the pinned, checksum-verified CLI binary
# (plus the build-time install-digest attestation so strict checksum
# enforcement can accept the pre-installed PATH binary at runtime).
COPY --from=builder /app/lib/dist ./lib/dist
COPY --from=builder /app/app/dist ./app/dist
COPY --from=builder /usr/local/bin/opencode /usr/local/bin/opencode
COPY --from=builder /usr/local/share/opencode/install-digest /usr/local/share/opencode/install-digest

COPY docker/validate-env.sh ./docker/validate-env.sh

RUN chmod +x docker/validate-env.sh \
    && useradd --create-home --uid 10001 reviewer \
    && mkdir -p /app/app/.opencode \
    && chown -R reviewer:reviewer /app /usr/local/bin/opencode /usr/local/share/opencode /usr/local/share/corepack

# Drop privileges: the app never needs root once the image is assembled.
USER reviewer

# Liveness probe against GET /health (Node's global fetch, since curl is no
# longer shipped). Forward HEALTH_AUTH_TOKEN when set because production
# probes require a bearer token. `/health` returns 200 for `ok` and
# `degraded`, 503 only when the process/components are unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const p=process.env.PORT||'3000';const o=process.env.HEALTH_AUTH_TOKEN?{headers:{Authorization:'Bearer '+process.env.HEALTH_AUTH_TOKEN}}:{};fetch('http://127.0.0.1:'+p+'/health',o).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["./docker/validate-env.sh"]