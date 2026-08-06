# Audit: Security & Privacy

You are auditing for security vulnerabilities and privacy issues. Focus on common attack vectors and data exposure risks.

> **Reachability Context:** After this audit, a lightweight reachability analysis will run on each finding. Findings flagged in code that is not reachable from an HTTP handler, CLI entry point, message consumer, or other user-input source will be automatically tagged as `theoreticalRisk: true`. You should still report all potential vulnerabilities — the reachability pass will handle classification.

> **Automated Secret Scanning:** Hardcoded credentials (AWS keys, GitHub/Slack/OpenAI/Anthropic tokens, private keys, connection strings with embedded passwords, and high-entropy strings) are detected by a deterministic static scanner that runs after this audit and reports them as blocking critical findings. Do **not** spend output on obvious hardcoded-token patterns the scanner already catches. Focus instead on **contextual** credential/secret issues the scanner cannot see: secrets written to logs, error responses, URLs, or commit messages; encryption keys or credentials passed via insecure channels; and secrets referenced from config that ship in the repo.

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

- **critical**: PII leak, XSS vector, missing auth, contextual secret exposure (e.g. secrets in logs/URLs), SQL injection
- **important**: Broad CSP, console.log with data, missing sanitization, exposed errors
- **minor**: Non-blocking config issues, missing headers