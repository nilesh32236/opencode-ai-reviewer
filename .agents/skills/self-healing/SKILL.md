---
name: self-healing
description: Guidelines for implementing and maintaining self-healing CI/CD, error recovery, circuit breakers, and autonomous remediation in the OpenCode AI Reviewer codebase.
---

# Self-Healing Skill

Use this skill when improving error recovery, retry logic, circuit breakers, autonomous remediation, or CI/CD resilience in the OpenCode AI Reviewer workspace.

---

## 1. Self-Healing Architecture

The codebase implements several layers of self-healing:

| Layer | Component | File | Purpose |
|-------|-----------|------|---------|
| Retry | `withRetry` / `withRetryAndTimeout` | `lib/src/utils/retry.ts` | Exponential backoff with jitter, Retry-After honor, AbortSignal support |
| Circuit Breaker | `CircuitBreaker` | `lib/src/utils/circuit-breaker.ts` | Prevents cascading failures; trips OPEN after `failureThreshold`, probes in HALF_OPEN |
| Event Bus | `EventBus` | `lib/src/event-bus/bus.ts` | Isolated subscriber execution with timeout + per-subscriber circuit breakers |
| Rate Limiter | `RateLimiter` | `lib/src/utils/rate-limiter.ts` | Reservation-based concurrency control for LLM calls |
| Workflows | `hourly-orchestrator.yml`, `self-improvement.yml` | `.github/workflows/` | Autonomous PR/issue triage and codebase improvement |

---

## 2. Circuit Breaker Best Practices

### When to use

Wrap any repeated external call that can fail transiently (GitHub API, LLM, database).

```ts
import { CircuitBreaker, countHttpError } from './utils/circuit-breaker.js';

const breaker = new CircuitBreaker({
  failureThreshold: 5,
  successThreshold: 2,
  cooldownMs: 30000,
  jitterRatio: 0.2,          // 20% jitter prevents thundering-herd recovery
  name: 'GitHubHelper',
  shouldCountFailure: countHttpError, // 4xx (except 429) don't trip the circuit
  onOpen: (m) => logger.warn('Circuit OPEN', m),
  onHalfOpen: () => logger.info('Probing...'),
  onClose: () => logger.info('Circuit CLOSED — recovered'),
});
```

### Key rules

- **Use `countHttpError` for HTTP-backed breakers** — deterministic 4xx errors must not count toward the threshold.
- **Set `jitterRatio: 0.15–0.25`** when multiple breakers share a downstream (e.g., many repos hitting the same GitHub API). Without jitter, all breakers recover simultaneously and re-hammer the failing service.
- **Observe `getRemainingCooldownMs()`** for dashboards and to avoid busy-polling an OPEN circuit.
- **Use `getMetrics()`** for alerting: `tripCount` for failure rate, `callCount` for throughput, `lastFailureAt` for MTTR.

### State machine

```
CLOSED --(failureThreshold failures)--> OPEN --(cooldown + jitter)--> HALF_OPEN
  ^                                        |  --(successThreshold successes)--> CLOSED
  |                                        +--(any failure)--> OPEN
  +--(reset() or success in CLOSED)--------+
```

---

## 3. Retry Best Practices

```ts
import { withRetry, withRetryAndTimeout } from './utils/retry.js';

// Simple retry with exponential backoff + jitter + Retry-After honor
await withRetry(() => fetch(url), {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  retryableStatuses: [429, 500, 502, 503, 504],
  operationName: 'fetchPR',
  signal: abortSignal,
});

// Retry with per-attempt timeout
await withRetryAndTimeout(
  (signal) => fetch(url, { signal }),
  30000, // per-attempt timeout
  { maxRetries: 3, operationName: 'fetchPR' },
);
```

- **Idempotency matters**: `GitHubHelper.api()` only retries idempotent methods (GET/HEAD/PUT/DELETE) on 5xx; non-idempotent POST retries only on 429. Follow this pattern.
- **Honor Retry-After**: `withRetry` already parses `Retry-After` headers and `retryAfterSeconds` properties. Ensure errors carry `headers` or `retryAfterSeconds` when throwing.

---

## 4. EventBus Resilience

```ts
import { EventBus } from './event-bus/bus.js';

// Tunable concurrency and timeout — increase concurrency for I/O-bound
// subscribers, decrease timeout for latency-sensitive pipelines.
const bus = new EventBus({
  concurrency: 10,           // max parallel subscribers per event
  subscriberTimeoutMs: 600_000, // 10 min per subscriber
});

bus.register(mySubscriber);
await bus.publish(event);

// Observability
bus.getSubscriberHealth();          // per-subscriber failure counts
bus.getFailedSubscribers();         // only failing subscribers
bus.getSubscriberCircuitState(name); // CLOSED | OPEN | HALF_OPEN | null
```

- **Subscribers are isolated**: each runs with its own AbortSignal timeout and circuit breaker. A failing subscriber never blocks others.
- **Tune `concurrency` under load**: lower it when LLM-backed subscribers contend for tokens; raise it for lightweight subscribers.

---

## 5. Workflow Self-Healing Patterns

Based on 2026 best practices for autonomous CI/CD agents:

1. **Bounded retries**: Cap auto-remediation at 3 attempts per run; escalate to human after budget is spent.
2. **Confidence thresholds**: Only auto-apply fixes when confidence > 0.85; otherwise open a draft PR.
3. **Scope limiting**: Restrict auto-fix file modifications; never auto-patch critical paths (auth, payments) without human review.
4. **Auditable trail**: Every auto-fix must leave an auditable trail — original failure, patch, verification result.
5. **Cost guardrails**: Limit daily AI remediation runs (e.g., `MAX_DAILY_RUNS`) to prevent runaway costs.
6. **Least privilege**: Workflows declare `permissions: contents: read` and escalate only where needed (`contents: write` for auto-fix branches).
7. **`fail-fast: false`** in matrix strategies so all Node versions report independently — a failure on Node 24 must not hide a failure on Node 22.

---

## 6. Verification Checklist

After modifying any self-healing component:

1. `pnpm build` — must exit 0
2. `pnpm typecheck` — must exit 0
3. `pnpm test` — all tests must pass (especially `circuit-breaker` and `event-bus` suites)
4. `pnpm lint` — no errors

For workflow changes, validate YAML with `actionlint` or `gh workflow view` if available.

---

## 7. References

- `lib/src/utils/retry.ts` — retry with exponential backoff, jitter, Retry-After
- `lib/src/utils/circuit-breaker.ts` — circuit breaker with jitter, metrics, lifecycle hooks
- `lib/src/event-bus/bus.ts` — event bus with concurrency control and health tracking
- `.agents/AGENTS.md` — workspace-wide error resilience patterns
