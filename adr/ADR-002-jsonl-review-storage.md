# ADR-002: Store intermediate review output as JSONL

- **Status:** Accepted
- **Date:** 2026-07-01
- **Deciders:** maintainers

## Context

The review engine needs a way for the LLM to emit structured findings (issues,
strengths, verdict) that the orchestrator can parse and merge across batches.
Options considered: a single JSON array file, a hosted database, or
newline-delimited JSON (JSONL).

A single JSON file fails when one malformed line corrupts the whole parse. A
hosted database is overkill for transient batch output and adds deployment
friction. LLMs naturally produce line-delimited JSON incrementally, and each
line can be validated in isolation so one bad line degrades only that finding.

## Decision

Use JSONL for intermediate review storage: the LLM writes one JSON object per
line to a `.jsonl` file, and the parser reads incrementally with per-line error
isolation.

Evidence in code:
- `lib/src/prompts/builder.ts:726-751` — Prompt instructs the LLM to write JSONL.
- `lib/src/jsonl-parser.ts:34-119` — Streaming parse with line-level error isolation.
- `lib/src/jsonl-parser.ts:74-119` — Per-line try/catch; bad lines do not break the parse.
- `lib/src/types/index.ts:493-494` — `ReviewResult` tracks a `failedLines` count.
- `lib/src/prompts/builder.ts:200-202,750` — LLMs naturally produce line-delimited JSON.

## Consequences

Positive: resilient to malformed model output; simple to append/stream; easy to
debug (cat a file). Negative: not queryable like a database; two-pass format
(write then parse); the parser must be strict about line shapes to avoid
accidental concatenation.

## Compliance

All intermediate LLM outputs in the review/audit/fix pipeline use JSONL files
under `.opencode/`. New consumers parse via `parseJsonlFile` rather than ad-hoc
`JSON.parse` of the whole file.
