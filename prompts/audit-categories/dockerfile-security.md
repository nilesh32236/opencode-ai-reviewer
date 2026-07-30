# Audit: Dockerfile Security

You are auditing Dockerfiles for container security misconfigurations. Focus on common pitfalls that lead to privilege escalation, image bloat, and supply-chain risks.

> **Reachability Context:** After this audit, a lightweight reachability analysis will run on each finding. Findings flagged in code that is not reachable from an HTTP handler, CLI entry point, message consumer, or other user-input source will be automatically tagged as `theoreticalRisk: true`. You should still report all potential vulnerabilities — the reachability pass will handle classification.

## What to Check

Scan files matching `Dockerfile` or `*.dockerfile`.

### Root User
- `USER root` directive or no `USER` directive at all (containers should run as non-root)
- Missing `USER` before the `ENTRYPOINT`/`CMD`

### Multi-Stage Builds
- Single-stage builds that could be optimized into multi-stage builds
- Build artifacts and source code carried into the final image unnecessarily

### Excessive Layers
- Too many `RUN` commands that could be consolidated
- Each `RUN` adds a layer; prefer `RUN` chaining with `&&`

### Hardcoded Secrets
- Passwords, API keys, tokens, or private keys in `ENV` or `ARG` instructions
- Sensitive values that should use Docker secrets or build-time secrets (`--secret`)

### Base Image Tags
- Using `:latest` tag (non-deterministic builds)
- Not pinning base image versions (e.g., `FROM node` instead of `FROM node:20.11.0-slim`)
- Using images with known vulnerabilities

### HEALTHCHECK
- Missing `HEALTHCHECK` instruction for long-running services

## Output Format

Write findings to the output file in JSON Lines format:

```jsonl
{"type":"summary","text":"Audited {target_dir}. Found X issues."}
{"type":"issue","severity":"critical|important|minor","file":"relative/path","line":42,"message":"What the issue is","suggestion":"How to fix it","inline":false}
```
Note: Findings will be post-processed for reachability — you do not need to include `theoreticalRisk` or `entryPointPath` in your output. Focus on correctly identifying the misconfiguration and its location.

## Severity Guide

- **critical**: Hardcoded secrets, running as root in production image, unpinned base image with known vulns
- **important**: Missing HEALTHCHECK, no USER directive, single-stage build carrying build deps
- **minor**: Excessive layers, using `:latest` tag, missing version pin on minor/patch
