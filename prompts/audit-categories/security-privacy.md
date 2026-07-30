# Audit: Security & Privacy

You are auditing for security vulnerabilities and privacy issues. Focus on common attack vectors and data exposure risks.

> **Reachability Context:** After this audit, a lightweight reachability analysis will run on each finding. Findings flagged in code that is not reachable from an HTTP handler, CLI entry point, message consumer, or other user-input source will be automatically tagged as `theoretical_risk: true`. You should still report all potential vulnerabilities — the reachability pass will handle classification.

## What to Check

### XSS & Injection
- User content rendered without sanitization
- `dangerouslySetInnerHTML` usage
- SQL injection via raw queries
- Command injection

### PII & Data Exposure
- PII in logs, console.error, or browser dev tools
- User data in URL params or query strings
- Error responses leaking internal details
- Excessive data in API responses

### Authentication & Session
- Tokens stored securely
- Session management correct
- Password handling (hashing, no plaintext)
- OAuth/OpenID configuration

### API Security
- Rate limiting on sensitive endpoints
- CORS configured correctly
- Input validation on all endpoints
- File upload validation

### Dependencies
- Known vulnerabilities in dependencies
- Outdated packages with security fixes

## Output Format

Write findings to the output file in JSON Lines format:

```jsonl
{"type":"summary","text":"Audited {target_dir}. Found X issues."}
{"type":"issue","severity":"critical|important|minor","file":"relative/path","line":42,"message":"What the issue is","suggestion":"How to fix it","inline":false}
```

Note: Findings will be post-processed for reachability — you do not need to include `theoreticalRisk` or `entryPointPath` in your output. Focus on correctly identifying the vulnerability and its location.

## Severity Guide

- **critical**: PII leak, XSS vector, missing auth, hardcoded secrets, SQL injection
- **important**: Broad CSP, console.log with data, missing sanitization, exposed errors
- **minor**: Non-blocking config issues, missing headers