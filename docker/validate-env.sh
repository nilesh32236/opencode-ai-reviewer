#!/bin/bash
# docker/validate-env.sh — Validate required environment variables before the
# app starts, then hand off to the real entry point.
#
# Hard-fails when no GitHub credential is configured; warns about missing AI
# provider keys (the default opencode/* model needs none). Kept as a shell
# script so broken configs fail fast before Node boots.
#
# Mirrors lib/src/setup/engine.ts checkSecrets(): a GITHUB_TOKEN takes
# precedence, so the GitHub App credential (APP_ID + private key) is only
# required when no token is present.
set -euo pipefail

# The webhook server (probot run) always requires a GitHub App credential
# (APP_ID + private key). The handlers additionally read GITHUB_TOKEN for their
# GitHub API calls, so App mode needs both APP_ID/private key AND GITHUB_TOKEN.
if [ -z "${APP_ID:-}" ]; then
  echo "ERROR: APP_ID must be set (GitHub App mode)." >&2
  echo "  Copy .env.example to .env and set APP_ID (plus PRIVATE_KEY_PATH and GITHUB_TOKEN)." >&2
  exit 1
fi

if [ -z "${PRIVATE_KEY:-}" ] && [ -z "${APP_PRIVATE_KEY:-}" ] && [ -z "${PRIVATE_KEY_PATH:-}" ]; then
  echo "ERROR: APP_ID is set but no private key was found." >&2
  echo "  Set PRIVATE_KEY_PATH (or PRIVATE_KEY / APP_PRIVATE_KEY) for the GitHub App." >&2
  exit 1
fi
if [ -n "${PRIVATE_KEY_PATH:-}" ] && [ ! -f "${PRIVATE_KEY_PATH}" ]; then
  echo "ERROR: PRIVATE_KEY_PATH \"${PRIVATE_KEY_PATH}\" does not exist inside the container." >&2
  echo "  Mount the .pem file into the container and point PRIVATE_KEY_PATH at it." >&2
  exit 1
fi
if [ -z "${WEBHOOK_SECRET:-}" ]; then
  echo "ERROR: WEBHOOK_SECRET is not set — GitHub will reject webhooks without it." >&2
  echo "  Set WEBHOOK_SECRET in .env." >&2
  exit 1
fi
if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "ERROR: GITHUB_TOKEN is not set — the app's GitHub API calls will fail with 401." >&2
  echo "  Set GITHUB_TOKEN in .env (fine-grained PAT with contents/issues/pull-requests write)." >&2
  exit 1
fi

if [ -z "${OPENAI_API_KEY:-}" ] && [ -z "${INPUT_OPENAI_API_KEY:-}" ] && \
   [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${INPUT_ANTHROPIC_API_KEY:-}" ] && \
   [ -z "${GEMINI_API_KEY:-}" ] && [ -z "${INPUT_GEMINI_API_KEY:-}" ] && \
   [ -z "${OPENCODE_API_KEY:-}" ] && [ -z "${INPUT_OPENCODE_API_KEY:-}" ]; then
  echo "WARNING: No AI provider API key is set." >&2
  echo "  Set at least one of OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENCODE_API_KEY" >&2
  echo "  (unnecessary when using a default opencode/* model)." >&2
fi

exec pnpm --filter app start
