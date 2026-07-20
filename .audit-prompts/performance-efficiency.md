# Audit: Performance & Efficiency

You are auditing the **OpenCode AI Reviewer** codebase for performance bottlenecks, inefficient patterns, and resource usage concerns.

Analyze the provided target directory for these issues.

## What to Check

### Database Performance (SQLite)

Look for these patterns in `lib/src/learning/`:

**Bad — N+1 in a loop:**
```ts
for (const f of findings) {
  await db.run('INSERT INTO ... VALUES (?)', [f]);  // N+1
}
```
**Good — batch insert in a transaction:**
```ts
await db.transaction(async () => {
  const placeholders = findings.map(() => '(?)').join(',');
  const values = findings.flatMap(f => [f]);
  await db.run(`INSERT INTO ... VALUES ${placeholders}`, values);
});
```

- **Query efficiency**: Check for N+1 query patterns — e.g., looping over results and issuing individual queries instead of using a single bulk query.
- **Batch operations**: Prefer batch INSERT/UPDATE operations inside a transaction (`recordFindings`, `recordFeedbackBatch` do this correctly). Row-by-row operations for bulk data are an **important** finding.
- **Index usage**: Verify that frequently queried columns (e.g., `pr_number`, `finding_id`, `pattern_key`) have indexes to avoid full table scans. Check `schema.ts` for index definitions.
- **Connection reuse**: Ensure the database connection is opened once and reused rather than creating new connections per operation. The `LearningStore` constructor in `store.ts` should open the connection once.

### Prepared Statement Caching
- **Statement reuse**: The `SqliteAdapter` in `db.ts` caches prepared statements in an LRU (max 100). Check that the cache is effective — frequently-run queries should hit the cache rather than re-preparing.
- **Cache eviction**: Verify the LRU eviction strategy doesn't thrash — if more than 100 unique SQL strings are used, frequently-used statements could be evicted. Consider increasing or making configurable.

### API Call Efficiency
- **Pagination**: Large data fetches (e.g., listing all PRs, comments, or labels) should use pagination to avoid truncated results and slowdowns. Check `action/src/review.ts` and GitHub API helpers.
- **Batch vs sequential**: Prefer `Promise.all()` for independent API calls rather than sequential `await` calls. Check for places where independent fetches are chained instead of parallelized.
- **Caching**: Repeated API calls for the same data (e.g., fetching the same PR details multiple times) should be cached or memoized. Check `context7-mcp` client calls.
- **HTTP connection reuse**: Ensure HTTP connections are reused rather than creating new connections per request.

### Memory & CPU
- **Large payloads**: Reading large files or JSONL outputs should use streaming or line-by-line parsing (`jsonl-parser.ts`) rather than loading everything into memory at once.
- **Unnecessary computation**: Avoid repeated computations (e.g., re-parsing the same config or re-tokenizing the same strings) by caching results.
- **String concatenation**: Use array join patterns instead of repeated string concatenation in loops.

### Concurrency & Async
- **Unbounded concurrency**: Using `Promise.all()` on large arrays without concurrency limits can overwhelm system resources. Use batching or throttling. Check `pattern-detector.ts` for concurrent clustering operations.
- **Blocking operations**: Avoid synchronous file I/O or CPU-heavy operations inside async functions without offloading. The JSON database fallback (`json-db.ts`) uses synchronous operations by design — check if this is appropriate for the context.

## Severity Guide

- **critical**: N+1 database queries, unbounded memory growth, missing pagination on large list endpoints, synchronous I/O in hot paths (non-JSON-DB contexts).
- **important**: Batch operations that could be optimized, missing indexes on query columns, redundant API calls, inefficient string building in loops, prepared statement cache thrashing.
- **minor**: Minor query optimization opportunities, single-use queries that could be cached, unused imports increasing bundle size, node count of concurrent Promise.all operations not documented.
