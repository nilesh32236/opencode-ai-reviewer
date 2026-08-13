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

# Stage 1 — build-time toolchain & compiled artifacts
FROM node:22.11.0-bookworm-slim@sha256:f035ba7ffee18f67200e2eb8018e0f13c954ec16338f264940f701997e3c12da AS builder

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
FROM node:22.11.0-bookworm-slim@sha256:f035ba7ffee18f67200e2eb8018e0f13c954ec16338f264940f701997e3c12da AS runtime

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

# Copy only the compiled JS + the pinned, checksum-verified CLI binary.
COPY --from=builder /app/lib/dist ./lib/dist
COPY --from=builder /app/app/dist ./app/dist
COPY --from=builder /usr/local/bin/opencode /usr/local/bin/opencode

COPY docker/validate-env.sh ./docker/validate-env.sh

RUN chmod +x docker/validate-env.sh \
    && useradd --create-home --uid 10001 reviewer \
    && mkdir -p /app/app/.opencode \
    && chown -R reviewer:reviewer /app /usr/local/bin/opencode

# Drop privileges: the app never needs root once the image is assembled.
USER reviewer

CMD ["./docker/validate-env.sh"]