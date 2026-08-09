# ADR-003: Integrate tools via the Model Context Protocol (MCP)

- **Status:** Accepted
- **Date:** 2026-07-01
- **Deciders:** maintainers

## Context

The reviewer augments the LLM with external tools (library docs via Context7,
repository context, etc.). Options: direct function calling per provider,
custom plugins, webhooks, or the Model Context Protocol (MCP).

MCP is provider-agnostic and standardized, letting the same client work across
all supported models without per-provider tool-calling adapters. It is optional
in the engine: when unavailable or failing, the review degrades gracefully
instead of aborting.

## Decision

Integrate tools through MCP using the `@modelcontextprotocol/sdk`, with tool
access controlled by allowlist patterns and graceful degradation on failure.

Evidence in code:
- `lib/src/mcp/client.ts:51-73` — Dual transport: StdioClientTransport + SSEClientTransport.
- `lib/src/mcp/client.ts:183-184` — Tool-level access control via `allowedTools` patterns.
- `lib/src/mcp/client.ts:86-158` — Resilient connection handling with retry + graceful degradation.
- `lib/src/mcp/client.ts:223-276` — Documentation enrichment (Context7 for library docs).
- `lib/src/engine.ts:102-118` — MCP is optional and degrades gracefully on failure.
- `lib/package.json:18-19` — `@modelcontextprotocol/sdk` and `@upstash/context7-mcp` dependencies.

## Consequences

Positive: one tool abstraction across providers; composable servers; rich
context (docs, codebase) without prompt bloat. Negative: extra moving parts
(server lifecycle, transport); tool output must be validated before reaching the
model; more dependency surface.

## Compliance

New external tool integrations must be implemented as MCP servers and connected
through `lib/src/mcp/client.ts`. Tools must be gated by `allowedTools` and must
never be required for a review to complete.
