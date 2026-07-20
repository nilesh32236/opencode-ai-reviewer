# Audit: Error Handling & Resilience

You are auditing the **OpenCode AI Reviewer** codebase for error propagation, crash resilience, API rate-limiting handling, and robust database operations.

Scan the target directories recursively (`lib/src`, `action/src`, `app/src`). Write findings to the output file `.opencode/audit-{category}.jsonl` in JSON Lines format.

## What to Check

### Asynchronous Flow Error Handling

Look for these patterns:

**Bad — catching without context:**
```ts
try { await riskyOp(); } catch (e) { console.warn('failed'); }
```
**Good — structured logging with context:**
```ts
try { await riskyOp(); } catch (e) { core.warning(`[${opName}] failed: ${e}`); }
```

- **Async catch blocks**: Ensure all asynchronous function calls, especially those interacting with the GitHub API or SQLite database, are wrapped in `try/catch` blocks or have `.catch()` handlers.
- **Graceful degradation**: Verify that if a non-critical subsystem fails (e.g. MCP connection or posting a review reaction), it does not crash the entire review/fix run. Prefer catching specific errors, logging with `core.warning`, and continuing.
- **Event subscriber isolation**: Subscribers registered on the EventBus should be isolated — a failure in one subscriber must not prevent others from executing. Check `feedback-subscriber.ts` and `app/src/index.ts` patterns.
- **AbortSignal propagation**: Operations accepting `AbortSignal` should check `signal.aborted` before starting work and respect cancellation mid-flight.

### Network Requests & Retries
- **Retry loops**: Look at functions calling external APIs (e.g. `setupOpenCode` downloading binaries, GitHub API calls). Ensure they have retry mechanisms with backoff to handle transient network errors.
- **Rate limiting**: Check how GitHub API rate limits (HTTP 403/429) are detected and handled (such as waiting with exponential backoff, jitter, and warning logs).
- **Retry utility usage**: Where possible, use the shared `withRetry()` utility from `lib/src/utils/retry.ts` instead of implementing ad-hoc retry loops.
- **Timeout handling**: Long-running operations (e.g., OpenCode CLI execution) should use `withRetryAndTimeout()` or configurable timeouts to prevent hangs.
- **Circuit breaker integration**: Check if frequently-failing API endpoints are wrapped with `CircuitBreaker` from `lib/src/utils/circuit-breaker.ts` to prevent cascading failures.

### Database Resilience (SQLite)
Look for these specific patterns in `lib/src/learning/`:

**Bad — bare queries without error handling:**
```ts
db.run('DELETE FROM findings WHERE pr_number = ?', [prNum]);
```
**Good — wrapped in transaction with context logging:**
```ts
db.transaction(async () => {
  await db.run('DELETE FROM feedback WHERE pr_number = ?', [prNum]);
  await db.run('DELETE FROM findings WHERE pr_number = ?', [prNum]);
});
```

- **DB Connection lifecycle**: Verify that `better-sqlite3` database connections are closed properly (e.g. in `finally` blocks). Check `store.ts`: the `close()` method should only be called once.
- **WAL mode & Locking**: Ensure SQLite is configured in WAL (Write-Ahead Logging) mode (via `db.pragma('journal_mode = WAL')`) to prevent write locks during concurrent operations (especially relevant when the Probot App processes multiple events simultaneously).
- **Transaction safety**: Read-then-write database operations (e.g., `recordPattern`, `incrementAndCheckMetaReviewInterval`) should be wrapped in `db.transaction()` to prevent race conditions. Sequential read+write outside a transaction is a bug.
- **Prepared statements**: All SQL queries should use prepared statements (parameterized `?` queries) to prevent SQL injection and improve performance. String interpolation in SQL is a **critical** finding.
- **Graceful fallback**: The database layer in `db.ts` falls back to JSON database when `better-sqlite3` fails to load. Verify this fallback path actually works end-to-end and does not lose data.

### Error Logging & Observability
- **Structured logging**: Errors should include context (event type, PR number, file path) to aid debugging. Use `core.warning()` for recoverable issues and `core.error()` / `core.setFailed()` for fatal ones.
- **Warning vs Error**: Distinguish between recoverable issues (`core.warning`) and fatal failures (`core.setFailed` / `core.error`).
- **Sensitive data**: Error messages must not leak tokens, secrets, or API keys in logs or GitHub output. Check `sanitizeDbError()` in `db.ts` is used consistently.

## Output Format

Write findings to the output file in JSON Lines format:

```jsonl
{"type":"summary","text":"Audited {target_dir}. Found X issues."}
{"type":"issue","severity":"critical|important|minor","file":"relative/path","line":42,"message":"What the issue is","suggestion":"How to fix it","inline":false}
```

## Severity Guide

- **critical**: Unhandled promise rejections that can terminate the Action/App process, string-interpolated SQL queries, unbounded retry loops without backoff, or infinite loop bugs.
- **important**: Silently ignored API failures (bare catch with no log), missing retry backoffs on large downloads, not closing database connections in error paths, missing AbortSignal checks.
- **minor**: Missing warnings/logs for handled failures, verbose error messages containing raw debug traces, unused catch bindings.
