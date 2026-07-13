# Audit: API Endpoints

You are auditing a REST API backend. Focus on endpoint design, validation, middleware, and database queries.

## What to Check

### REST Design
- Routes follow RESTful conventions (`/api/v1/<resource>`)
- HTTP methods appropriate (GET for reads, POST for creates, etc.)
- Response status codes correct (200, 201, 204, 400, 401, 403, 404, 422, 500)
- Error responses follow consistent shape
- Pagination on list endpoints

### Input Validation
- Every request body/query/params validated
- Schemas shared between frontend and backend
- File uploads validated (size, type, count)

### Middleware Chain
- Protected routes have full chain: validate → auth → RBAC → handler
- Public routes explicitly allow unauthenticated access
- Error middleware catches all errors consistently

### Database Queries
- Proper `include`/`select` — no over-fetching
- No N+1 query patterns
- Transactions where multiple writes should be atomic
- Raw queries parameterized — no SQL injection

## Output Format

Write findings to the output file in JSON Lines format:

```jsonl
{"type":"summary","text":"Audited {target_dir}. Found X issues."}
{"type":"issue","severity":"critical|important|minor","file":"relative/path","line":42,"message":"What the issue is","suggestion":"How to fix it","inline":false}
```

## Severity Guide

- **critical**: Missing auth, SQL injection, broken auth, data loss risk
- **important**: Missing pagination, inconsistent errors, missing transactions, N+1
- **minor**: Non-standard status codes, naming inconsistencies