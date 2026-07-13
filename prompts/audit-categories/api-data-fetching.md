# Audit: API & Data Fetching

You are auditing a web application. Focus on data fetching patterns, API integration, and query management.

## What to Check

### Query Patterns
- Query keys use consistent structure (arrays with constants, not inline strings)
- `staleTime` and `gcTime` configured appropriately per-query
- `enabled` option used for conditional queries
- `select` option used for data transformation
- `placeholderData` for paginated lists

### Mutation Patterns
- Optimistic updates with rollback on error
- Cache invalidation after mutations
- Error handling surfaced in UI (toasters, not just console)
- `isPending` state used for loading UI

### Error Handling
- Query `isError` state rendered as error UI
- Error boundaries for query errors
- Network errors handled gracefully

### Caching & Performance
- Query key factory pattern used consistently
- No unnecessary re-fetches for static data
- Offline behavior configured appropriately

## Output Format

Write findings to the output file in JSON Lines format:

```jsonl
{"type":"summary","text":"Audited {target_dir}. Found X issues."}
{"type":"issue","severity":"critical|important|minor","file":"relative/path","line":42,"message":"What the issue is","suggestion":"How to fix it","inline":false}
```

## Severity Guide

- **critical**: Stale/missing data leading to incorrect state, data leak
- **important**: Missing loading/error states, stale query keys, no cache invalidation
- **minor**: Inefficient refetch config, unused query options