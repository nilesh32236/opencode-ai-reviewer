# Audit: Performance & Efficiency

You are auditing code for performance issues and resource efficiency. Focus on slow queries, memory usage, unnecessary work, and scalability concerns.

## What to Check

### Database & Query Performance
- N+1 query patterns in ORM or raw SQL queries
- Missing indexes on frequently queried columns
- Excessive data fetching (SELECT * when specific columns suffice)
- Large transactions held open longer than necessary
- Connection pool exhaustion (connections not released after use)

### Caching Strategy
- Repeated expensive computations cached appropriately
- Cache invalidation logic correct (stale data not served)
- Cache TTLs aligned with data freshness requirements
- Disk/memory cache bounded to prevent resource exhaustion

### Async & Concurrency
- Blocking operations in async paths (sync file I/O, sync network calls)
- Unbounded concurrent operations (missing concurrency limits)
- Promise chains that could run in parallel but run sequentially
- Event loop starvation from CPU-heavy synchronous work

### Bundle & Asset Efficiency
- Large dependencies imported in full when tree-shakable
- Dead or unused code eliminated
- Dynamic imports for code that isn't needed immediately
- Asset sizes reasonable and compressed

### Memory & Resource Management
- Streams or buffers properly drained and closed
- Event listeners removed after use (no listener leaks)
- Large objects released when no longer needed
- File handles and network connections closed in all code paths

## Output Format

Write findings to the output file in JSON Lines format:

```jsonl
{"type":"summary","text":"Audited {target_dir}. Found X issues."}
{"type":"issue","severity":"critical|important|minor","file":"relative/path","line":42,"message":"What the issue is","suggestion":"How to fix it","inline":false}
```

## Severity Guide

- **critical**: N+1 query, unbounded concurrency, blocking event loop, memory leak, connection pool exhaustion
- **important**: Missing cache for repeated work, parallelizable operations sequential, over-fetching data
- **minor**: Inefficient imports, missing index, slightly oversized bundles, unused variables
