import * as core from '@actions/core';

/** State of the circuit breaker: CLOSED (normal), OPEN (failing), HALF_OPEN (probing). */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** Snapshot of circuit breaker state and observability counters. */
export interface CircuitBreakerMetrics {
  /** Current circuit state. */
  state: CircuitState;
  /** Consecutive failures in the current window (reset on recovery). */
  failureCount: number;
  /** Consecutive successes accumulated in the HALF_OPEN probing window. */
  successCount: number;
  /** Total number of calls routed through the breaker (lifetime). */
  callCount: number;
  /** Total number of times the circuit has transitioned into OPEN (lifetime). */
  tripCount: number;
  /** Epoch millisecond timestamp of the last recorded failure, or null. */
  lastFailureAt: number | null;
  /** Epoch millisecond timestamp of the last recorded success, or null. */
  lastSuccessAt: number | null;
}

/** Options for configuring a CircuitBreaker instance. */
export interface CircuitBreakerOptions {
  /** Number of consecutive failures to trip the circuit (default: 5) */
  failureThreshold?: number;
  /** Number of consecutive successes in half-open state to close the circuit (default: 2) */
  successThreshold?: number;
  /** Cooldown period in ms before transitioning from OPEN to HALF_OPEN (default: 30000) */
  cooldownMs?: number;
  /**
   * Jitter ratio applied to the cooldown to prevent thundering-herd recovery
   * when many breakers trip simultaneously (e.g. a shared downstream outage).
   * Effective cooldown becomes `cooldownMs * (1 + rand * jitterRatio)` where
   * `rand` is uniform in [0, 1). Default: 0 (no jitter, deterministic).
   * Recommended for self-healing pipelines: 0.15–0.25.
   */
  jitterRatio?: number;
  /** Name for this circuit breaker, used in log messages (default: "CircuitBreaker") */
  name?: string;
  /**
   * Optional predicate that classifies whether a thrown error counts as a
   * circuit failure. When it returns false, the error is still re-thrown to
   * the caller but does NOT increment the failure count or influence the
   * circuit state. Use this to exclude deterministic errors that will never
   * recover on retry (e.g. HTTP 4xx client errors) from tripping the circuit.
   * Default: every error counts.
   */
  shouldCountFailure?: (err: unknown) => boolean;
  /** Called when circuit transitions from CLOSED or HALF_OPEN to OPEN */
  onOpen?: (metrics: CircuitBreakerMetrics) => void;
  /** Called when circuit transitions from OPEN or HALF_OPEN to CLOSED */
  onClose?: (metrics: CircuitBreakerMetrics) => void;
  /** Called when circuit transitions from OPEN to HALF_OPEN after cooldown */
  onHalfOpen?: (metrics: CircuitBreakerMetrics) => void;
}

type RequiredCircuitBreakerOptions = Required<
  Omit<CircuitBreakerOptions, 'onOpen' | 'onClose' | 'onHalfOpen' | 'shouldCountFailure'>
> & {
  shouldCountFailure?: (err: unknown) => boolean;
  onOpen?: (metrics: CircuitBreakerMetrics) => void;
  onClose?: (metrics: CircuitBreakerMetrics) => void;
  onHalfOpen?: (metrics: CircuitBreakerMetrics) => void;
};

const DEFAULT_OPTIONS: RequiredCircuitBreakerOptions = {
  failureThreshold: 5,
  successThreshold: 2,
  cooldownMs: 30000,
  jitterRatio: 0,
  name: 'CircuitBreaker',
};

/**
 * Circuit breaker that protects external API calls from cascading failures.
 * Tracks consecutive failures and short-circuits requests when the threshold is exceeded,
 * then periodically probes to recover.
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private successCount = 0;
  private callCount = 0;
  private tripCount = 0;
  private lastFailureTime = 0;
  private lastFailureAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private options: RequiredCircuitBreakerOptions;
  private inFlightProbe = false;
  private effectiveCooldownMs: number;

  /**
   * Create a new CircuitBreaker.
   *
   * @param options - Configuration options for failure/success thresholds, cooldown, and lifecycle hooks.
   */
  constructor(options: CircuitBreakerOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.effectiveCooldownMs = this.options.cooldownMs;
  }

  private safeInvokeHook(
    hook: ((metrics: CircuitBreakerMetrics) => void) | undefined,
    metrics: CircuitBreakerMetrics,
  ): void {
    if (!hook) return;
    try {
      hook(metrics);
    } catch (err) {
      core.warning(
        `[${this.options.name}] Lifecycle hook error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private transitionState(): void {
    if (this.state === 'OPEN' && Date.now() - this.lastFailureTime >= this.effectiveCooldownMs) {
      this.state = 'HALF_OPEN';
      core.info(`[${this.options.name}] Circuit transitioning OPEN -> HALF_OPEN after cooldown`);
      this.safeInvokeHook(this.options.onHalfOpen, this.getMetrics());
    }
  }

  /**
   * Get the current circuit breaker state.
   *
   * Runs the cooldown transition first so idle-time recovery is observable:
   * after the cooldown elapses, polling `getState()` reports HALF_OPEN without
   * requiring an incoming `call()`. Note that actual recovery still requires a
   * `call()` probe — this only makes the pending transition visible.
   *
   * @returns The current CircuitState (CLOSED, OPEN, or HALF_OPEN).
   */
  getState(): CircuitState {
    this.transitionState();
    return this.state;
  }

  /**
   * Execute a function through the circuit breaker.
   * If the circuit is OPEN, the function is not called and an error is thrown immediately.
   * If HALF_OPEN, only one probe request is allowed at a time.
   *
   * @param fn - Async function to execute.
   * @returns The result of the function.
   * @throws Error if the circuit is OPEN or if the function itself throws.
   */
  /**
   * Get the remaining cooldown time in milliseconds before the circuit
   * transitions from OPEN to HALF_OPEN. Returns 0 when not OPEN or when
   * the cooldown has already elapsed.
   *
   * @returns Remaining cooldown in milliseconds.
   */
  getRemainingCooldownMs(): number {
    if (this.state !== 'OPEN') return 0;
    const elapsed = Date.now() - this.lastFailureTime;
    return Math.max(0, this.effectiveCooldownMs - elapsed);
  }

  /**
   * Execute a function through the circuit breaker.
   * If the circuit is OPEN, the function is not called and an error is thrown immediately.
   * If HALF_OPEN, only one probe request is allowed at a time.
   *
   * @param fn - Async function to execute.
   * @returns The result of the function.
   * @throws Error if the circuit is OPEN or if the function itself throws.
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    this.transitionState();
    if (this.state === 'OPEN') {
      throw new Error(
        `[${this.options.name}] Circuit is OPEN — request not attempted (cooldown: ${this.effectiveCooldownMs}ms, remaining: ${this.getRemainingCooldownMs()}ms)`,
      );
    }

    if (this.state === 'HALF_OPEN') {
      if (this.inFlightProbe) {
        throw new Error(
          `[${this.options.name}] Circuit is HALF_OPEN with an in-flight probe — request not attempted`,
        );
      }
      this.inFlightProbe = true;
    }

    this.callCount++;

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      if (this.shouldCountFailure(err)) {
        this.onFailure();
      }
      throw err;
    } finally {
      this.inFlightProbe = false;
    }
  }

  /**
   * Determine whether a thrown error counts toward the circuit failure
   * threshold, honoring the optional `shouldCountFailure` classifier.
   *
   * @param err - The error thrown by the wrapped function.
   * @returns True when the error should count as a failure (default).
   */
  private shouldCountFailure(err: unknown): boolean {
    const classifier = this.options.shouldCountFailure;
    if (!classifier) {
      return true;
    }
    try {
      return classifier(err);
    } catch (classifyError) {
      core.warning(
        `[${this.options.name}] shouldCountFailure classifier threw: ${
          classifyError instanceof Error ? classifyError.message : String(classifyError)
        } — treating error as a failure`,
      );
      return true;
    }
  }

  private onSuccess(): void {
    this.lastSuccessAt = Date.now();
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.options.successThreshold) {
        const count = this.successCount;
        this.state = 'CLOSED';
        const metrics = this.getMetrics();
        this.failureCount = 0;
        this.successCount = 0;
        core.info(
          `[${this.options.name}] Circuit HALF_OPEN -> CLOSED after ${count} consecutive successes`,
        );
        this.safeInvokeHook(this.options.onClose, metrics);
      }
    } else {
      this.reset();
    }
  }

  /**
   * Compute the effective cooldown with optional jitter.
   *
   * @returns Effective cooldown in milliseconds, with jitter applied when configured.
   */
  private computeEffectiveCooldown(): number {
    const base = this.options.cooldownMs;
    const ratio = this.options.jitterRatio ?? 0;
    if (ratio <= 0) return base;
    return Math.round(base * (1 + Math.random() * ratio));
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    this.lastFailureAt = this.lastFailureTime;

    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.successCount = 0;
      this.tripCount++;
      this.effectiveCooldownMs = this.computeEffectiveCooldown();
      core.warning(
        `[${this.options.name}] Circuit HALF_OPEN -> OPEN after failure in half-open state (cooldown: ${this.effectiveCooldownMs}ms)`,
      );
      this.safeInvokeHook(this.options.onOpen, this.getMetrics());
    } else if (this.state === 'CLOSED' && this.failureCount >= this.options.failureThreshold) {
      this.state = 'OPEN';
      this.successCount = 0;
      this.tripCount++;
      this.effectiveCooldownMs = this.computeEffectiveCooldown();
      core.warning(
        `[${this.options.name}] Circuit CLOSED -> OPEN after ${this.failureCount} consecutive failures (cooldown: ${this.effectiveCooldownMs}ms)`,
      );
      this.safeInvokeHook(this.options.onOpen, this.getMetrics());
    }
  }

  /**
   * Manually reset the circuit breaker to CLOSED state, clearing failure and success counts.
   * Fires the onClose hook if the circuit was previously OPEN or HALF_OPEN.
   */
  reset(): void {
    const priorState = this.state;
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.effectiveCooldownMs = this.options.cooldownMs;
    if (priorState === 'OPEN' || priorState === 'HALF_OPEN') {
      this.safeInvokeHook(this.options.onClose, this.getMetrics());
    }
  }

  /**
   * Get current circuit breaker metrics, including cumulative observability
   * counters (call count, trip count) and last success/failure timestamps.
   *
   * Runs the cooldown transition first so the reported `state` reflects
   * idle-time recovery (see `getState()`).
   *
   * @returns A snapshot of the current state and counters.
   */
  getMetrics(): CircuitBreakerMetrics {
    this.transitionState();
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      callCount: this.callCount,
      tripCount: this.tripCount,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
    };
  }
}

/**
 * Read the numeric HTTP status from a thrown error, if one is attached.
 *
 * @param err - The thrown value, which may carry a `status` property.
 * @returns The HTTP status code, or null when not present.
 */
function getHttpStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) {
    return null;
  }
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}

/**
 * Default `shouldCountFailure` classifier for HTTP-backed circuit breakers.
 *
 * Classification rules:
 * - Unknown/network errors (no status) always count as failures.
 * - 5xx server errors always count as failures.
 * - 429 rate limits count as failures — a persistent rate limit indicates the
 *   caller is hammering the API, so tripping the circuit provides backoff.
 * - Other 4xx client errors (400, 404, 422, ...) are deterministic and will
 *   never recover on retry, so they do NOT count toward tripping the circuit.
 *
 * @param err - The error thrown by the wrapped call.
 * @returns True when the error should count toward the failure threshold.
 */
export function countHttpError(err: unknown): boolean {
  const status = getHttpStatus(err);
  if (status === null) {
    return true;
  }
  if (status === 429) {
    return true;
  }
  return !(status >= 400 && status < 500);
}
