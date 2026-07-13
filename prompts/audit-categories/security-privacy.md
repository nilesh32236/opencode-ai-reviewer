# Audit: Security & Privacy

You are auditing for security vulnerabilities and privacy issues. Focus on common attack vectors and data exposure risks.

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

## Severity Guide

- **critical**: PII leak, XSS vector, missing auth, hardcoded secrets, SQL injection
- **important**: Broad CSP, console.log with data, missing sanitization, exposed errors
- **minor**: Non-blocking config issues, missing headers