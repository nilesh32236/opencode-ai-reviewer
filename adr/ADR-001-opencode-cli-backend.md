# ADR-001: Use the OpenCode CLI as the LLM backend

- **Status:** Accepted
- **Date:** 2026-07-01
- **Deciders:** maintainers

## Context

The reviewer must call large language models across multiple providers
(OpenCode default, OpenAI, Anthropic, Gemini, and OpenAI-compatible endpoints).
The design questions were: (a) call provider HTTP APIs directly, (b) build a
custom agent runtime, or (c) delegate to an external CLI that already handles
provider abstraction, configuration, tooling, and streaming.

Direct API calls would couple the codebase to each provider's request/response
schema, auth, and rate-limit semantics. A custom agent runtime is a large,
error-prone surface (retries, tool calling, streaming, budget). The OpenCode CLI
already solves provider routing, model selection, prompt tooling, and CI-mode
permission handling, so delegating keeps the reviewer focused on orchestration.

## Decision

Use the OpenCode CLI as the review/analysis backend, invoked as a subprocess
with an injected environment.

Evidence in code:
- `lib/src/opencode.ts:232-246` — CI-native design via `OPENCODE_CONFIG_CONTENT`.
- `lib/src/opencode.ts:248-264` — `--auto` flag for CI permission approval.
- `lib/src/opencode.ts:349-399` — Multi-provider API key forwarding (OpenAI,
  Anthropic, Gemini).
- `lib/src/opencode.ts:334-342` — Subprocess spawning with a sandboxed env.
- `lib/src/opencode.ts:410-477` — Timeout handling (SIGTERM then SIGKILL).
- `lib/src/engine.ts:214` — Model routing delegated to OpenCode.

## Consequences

Positive: one integration point for providers; free resilience (retries,
timeouts) and streaming; models are swappable via config without code changes.
Negative: a runtime dependency on the `opencode` binary being installed;
process-spawn overhead per invocation; version drift between the CLI and the
repo must be managed (checksum-pinned release in CI/docker).

## Compliance

New model integrations must route through `lib/src/opencode.ts` rather than
calling provider HTTP APIs directly. The action's `setup-opencode` step and the
Docker image pin the binary and verify its checksum.
