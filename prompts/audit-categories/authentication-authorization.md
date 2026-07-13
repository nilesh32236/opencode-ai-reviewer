# Audit: Authentication & Authorization

You are auditing authentication and authorization patterns. Focus on token handling, route protection, and access control.

## What to Check

### Token Storage & Handling
- JWT stored securely (HttpOnly cookies preferred)
- Token expiry checked before requests
- Refresh token rotation implemented
- No tokens in localStorage or URLs

### Auth Context & Provider
- Loading state handled before rendering protected content
- No race conditions between auth check and route mount
- Auth state cleared properly on logout
- No auth state leaks to client-side

### Route Protection
- Protected routes enforced (server-side or client-side guards)
- Role-based access control consistent across all routes
- No direct URL access bypasses auth
- Public routes correctly identified

### Security
- No PII in logs, URLs, or client-side code
- Rate limiting on auth endpoints
- CSRF protection
- Secure cookie flags (HttpOnly, Secure, SameSite)

## Output Format

Write findings to the output file in JSON Lines format:

```jsonl
{"type":"summary","text":"Audited {target_dir}. Found X issues."}
{"type":"issue","severity":"critical|important|minor","file":"relative/path","line":42,"message":"What the issue is","suggestion":"How to fix it","inline":false}
```

## Severity Guide

- **critical**: Auth bypass, token leak, privilege escalation, session hijack
- **important**: Missing route protection, weak token handling, insufficient validation
- **minor**: Inefficient patterns, missing error feedback