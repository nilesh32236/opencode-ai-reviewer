FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y \
  curl git jq \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10.8.0

RUN ARCH=$(uname -m) && \
  if [ "$ARCH" = "aarch64" ]; then ARCH="linux-arm64"; else ARCH="linux-x64"; fi && \
  RELEASE_URL="https://api.github.com/repos/anomalyco/opencode/releases/latest" && \
  DOWNLOAD_URL=$(curl -fsSL "$RELEASE_URL" | jq -r ".assets[] | select(.name == \"opencode-${ARCH}.tar.gz\") | .browser_download_url") && \
  curl -fsSL "$DOWNLOAD_URL" -o /tmp/opencode.tar.gz && \
  tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin/ && \
  chmod +x /usr/local/bin/opencode && \
  rm /tmp/opencode.tar.gz && \
  opencode --version 2>&1 || true

WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY lib/package.json ./lib/
COPY action/package.json ./action/
COPY app/package.json ./app/

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

CMD ["pnpm", "test"]
