# Audit: Error Handling & Resilience

You are auditing error handling and system resilience patterns. Focus on error boundaries, graceful degradation, and recovery mechanisms.

## What to Check

### Error Boundaries & Propagation
- Errors caught at appropriate layers (not silently swallowed)
- Re-thrown errors preserve original context and stack traces
- Asynchronous error handling (Promise rejections, try/catch in async functions)
- Global uncaught exception / unhandled rejection handlers

### Graceful Degradation
- Non-critical subsystems fail independently without crashing the main flow
- Fallback values or defaults when external services are unavailable
- Feature flags or toggles for optional capabilities
- Circuit breaker patterns for repeated external calls

### Retry & Backoff
- Transient failures (network, 429, 5xx) retried with exponential backoff
- Retry attempts limited with a max cap (no infinite retries)
- Jitter applied to retry delays to avoid thundering herd
- Operations time out after a reasonable duration
- Server-provided `Retry-After` hints honored (header or `retryAfterSeconds`), clamped to a max
- Retry predicates fail fast on deterministic errors (4xx, integrity/checksum errors) — never retry what cannot succeed
- Non-idempotent operations (POST) retried only on 429/rate-limit, never blindly on 5xx

### Cancellation & Timeouts
- Long-running operations accept and thread `AbortSignal` through every async layer
- Combined cancellation sources composed with `AbortSignal.any()` (outer cancel + per-attempt timeout), not hand-rolled listener chains
- Timeout aborts distinguishable from deliberate cancels (`TimeoutError` vs `AbortError` via abort `reason`)
- Already-aborted signals checked before starting work (`throwIfAborted`), not just between retries

### Self-Healing Guardrails
- Autonomous remediation bounded: max ~3 attempts per run, then escalate to a human with the trail attached
- Fixes scoped to recoverable classes (transient infra, lint drift, lockfile mismatch) — never auto-patch critical paths (auth, payments, migrations) without review
- Every auto-fix leaves an auditable trail: original failure, patch applied, verification result
- Verification re-runs the same gates that failed (never a weakened subset); uncertain classification is a stop condition, not a guess

### Logging & Observability
- Errors logged with sufficient context (operation, input, error message)
- Sensitive data (tokens, secrets, PII) sanitized from logs
- Log levels used appropriately (error for failures, warn for degradation)
- Structured logging for machine parsing

### Transaction Safety
- Database read-then-write operations wrapped in transactions
- Partial writes rolled back on failure
- Connection failures handled with reconnection or fallback
- Prepared statements used to prevent SQL injection

## Output Format

Write findings to the output file in JSON Lines format:

```jsonl
{"type":"summary","text":"Audited {target_dir}. Found X issues."}
{"type":"issue","severity":"critical|important|minor","file":"relative/path","line":42,"message":"What the issue is","suggestion":"How to fix it","inline":false}
```

## Severity Guide

- **critical**: Silent error swallow, missing transaction rollback, unhandled promise rejection, secrets in logs
- **important**: Missing retry on transient failure, insufficient error context, no fallback for degraded mode
- **minor**: Suboptimal log level, missing jitter on retry, overly broad catch
