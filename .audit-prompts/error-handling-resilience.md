# Audit: Error Handling & Resilience

You are auditing the **OpenCode AI Reviewer** codebase for error propagation, crash resilience, API rate-limiting handling, and robust database operations.

Scan the target directories recursively (`lib/src`, `action/src`, `app/src`). Output findings to `.audit-output.jsonl`.

## What to Check

### Asynchronous Flow Error Handling
- **Async catch blocks**: Ensure all asynchronous function calls, especially those interacting with the GitHub API or SQLite database, are wrapped in `try/catch` blocks or have `.catch()` handlers.
- **Graceful degradation**: Verify that if a non-critical subsystem fails (e.g. MCP connection or posting a review reaction), it does not crash the entire review/fix run.
- **Event subscriber isolation**: Subscribers registered on the EventBus should be isolated — a failure in one subscriber must not prevent others from executing.

### Network Requests & Retries
- **Retry loops**: Look at functions calling external APIs (e.g. setupOpenCode downloading binaries). Ensure they have retry mechanisms with backoff to handle transient network errors.
- **Rate limiting**: Check how GitHub API rate limits (HTTP 403/429) are detected and handled (such as waiting with exponential backoff, jitter, and warning logs).
- **Retry utility usage**: Where possible, use the shared `withRetry()` utility from `lib/src/utils/retry.ts` instead of implementing ad-hoc retry loops.
- **Timeout handling**: Long-running operations (e.g., OpenCode CLI execution) should have configurable timeouts to prevent hangs.

### Database Resilience (SQLite)
- **DB Connection lifecycle**: Verify that `better-sqlite3` database connections are closed properly (e.g. in `finally` blocks).
- **WAL mode & Locking**: Ensure SQLite is configured in WAL (Write-Ahead Logging) mode to prevent write locks during concurrent operations (especially relevant when the Probot App processes multiple events simultaneously).
- **Transaction safety**: Read-then-write database operations (e.g., `recordPattern`, `incrementAndCheckMetaReviewInterval`) should be wrapped in `db.transaction()` to prevent race conditions.
- **Prepared statements**: All SQL queries should use prepared statements (parameterized queries) to prevent SQL injection and improve performance.

### Error Logging & Observability
- **Structured logging**: Errors should include context (event type, PR number, file path) to aid debugging.
- **Warning vs Error**: Distinguish between recoverable issues (`core.warning`) and fatal failures (`core.setFailed` / `core.error`).
- **Sensitive data**: Error messages must not leak tokens, secrets, or API keys in logs or GitHub output.

## Output Format

Write findings to the output file in JSON Lines format:

```jsonl
{"type":"summary","text":"Audited {target_dir}. Found X issues."}
{"type":"issue","severity":"critical|important|minor","file":"relative/path","line":42,"message":"What the issue is","suggestion":"How to fix it","inline":false}
```

## Severity Guide

- **critical**: Unhandled promise rejections that can terminate the Action/App process, unparameterized database queries leading to lock hangs, or infinite loop bugs.
- **important**: Silently ignored API failures, missing retry backoffs on large downloads, or not closing database connections in error paths.
- **minor**: Missing warnings/logs for handled failures, verbose error messages containing raw debug traces.
