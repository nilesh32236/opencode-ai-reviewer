# Audit: Performance & Efficiency

You are auditing the **OpenCode AI Reviewer** codebase for performance bottlenecks, inefficient patterns, and resource usage concerns.

Scan the target directories recursively (`lib/src`, `action/src`, `app/src`). Output findings to `.audit-output.jsonl`.

## What to Check

### Database Performance (SQLite)
- **Query efficiency**: Check for N+1 query patterns — e.g., looping over results and issuing individual queries instead of using a single bulk query.
- **Batch operations**: Prefer batch INSERT/UPDATE operations inside a transaction over row-by-row operations for bulk data.
- **Index usage**: Verify that frequently queried columns (e.g., `pr_number`, `finding_id`, `pattern_key`) have indexes to avoid full table scans.
- **Connection reuse**: Ensure the database connection is opened once and reused rather than creating new connections per operation.

### API Call Efficiency
- **Pagination**: Large data fetches (e.g., listing all PRs, comments, or labels) should use pagination to avoid truncated results and slowdowns.
- **Batch vs sequential**: Prefer `Promise.all()` for independent API calls rather than sequential `await` calls.
- **Caching**: Repeated API calls for the same data (e.g., fetching the same PR details multiple times) should be cached or memoized.
- **HTTP connection reuse**: Ensure HTTP connections are reused rather than creating new connections per request.

### Memory & CPU
- **Large payloads**: Reading large files or JSONL outputs should use streaming or line-by-line parsing rather than loading everything into memory at once.
- **Unnecessary computation**: Avoid repeated computations (e.g., re-parsing the same config or re-tokenizing the same strings) by caching results.
- **String concatenation**: Use array join patterns instead of repeated string concatenation in loops.

### Concurrency & Async
- **Unbounded concurrency**: Using `Promise.all()` on large arrays without concurrency limits can overwhelm system resources. Use batching or throttling.
- **Blocking operations**: Avoid synchronous file I/O or CPU-heavy operations inside async functions without offloading.

## Output Format

Write findings to the output file in JSON Lines format:

```jsonl
{"type":"summary","text":"Audited {target_dir}. Found X performance issues."}
{"type":"issue","severity":"critical|important|minor","file":"relative/path","line":42,"message":"What the issue is","suggestion":"How to fix it","inline":false}
```

## Severity Guide

- **critical**: N+1 database queries, unbounded memory growth, missing pagination on large list endpoints, synchronous I/O in hot paths.
- **important**: Batch operations that could be optimized, missing indexes on query columns, redundant API calls, inefficient string building in loops.
- **minor**: Minor query optimization opportunities, single-use queries that could be cached, unused imports increasing bundle size.
