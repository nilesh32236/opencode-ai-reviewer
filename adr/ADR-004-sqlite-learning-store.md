# ADR-004: Use SQLite for the learning store

- **Status:** Accepted
- **Date:** 2026-07-01
- **Deciders:** maintainers

## Context

The reviewer persists learning data (findings, feedback signals, quality
trends, suppression rules) and needs a zero-config, transactional store that
works in CI, locally, and in the Probot app. Options: PostgreSQL/MySQL, Redis,
plain filesystem, or SQLite.

SQLite needs no server, no credentials, and no deployment step — the database is
just `.opencode/learning.db`. It supports WAL mode and transactions for the
concurrency patterns the review pipeline needs, and a query-translation layer
lets the same repository logic run against PostgreSQL/MySQL for hosted
deployments.

## Decision

Use SQLite as the primary learning-store backend, with a JSON file fallback for
environments where native modules are unavailable, and a query-translation layer
that also supports PostgreSQL/MySQL.

Evidence in code:
- `lib/src/learning/db.ts:1891-1959` — Multi-backend with SQLite primary + JSON fallback.
- `lib/src/learning/db.ts:1936-1937` — WAL mode + busy timeout for concurrency.
- `lib/src/learning/db.ts:1018-1028,1068-1091` — Transaction support for atomic batch ops.
- `lib/src/learning/db.ts:924-972` — Prepared statement cache (LRU, max 300).
- `lib/src/learning/db.ts:114-150` — Query translation layer (SQLite -> PostgreSQL/MySQL).
- `lib/src/learning/json-db.ts:193-873` — Full JSON fallback implementation.
- `lib/src/learning/schema.ts:4-12` — Zero-config: DB is just `.opencode/learning.db`.

## Consequences

Positive: zero-config and embeddable; transactions and WAL give safe concurrent
writes; a translation layer keeps hosted options open. Negative: SQLite is
single-writer-ish (needs busy timeout under heavy concurrency); native
`better-sqlite3` adds a build dependency; very large stores need migration
paths to a server DB.

## Compliance

New persistence must go through `lib/src/learning/` repository abstractions
(`LearningRepository`) rather than direct SQL. Writes that read-then-write must
use transactions, and the store must keep working (JSON fallback) where native
modules cannot be installed.
