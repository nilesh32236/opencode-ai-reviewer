import * as core from '@actions/core';

/** State of the circuit breaker: CLOSED (normal), OPEN (failing), HALF_OPEN (probing). */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** Options for configuring a CircuitBreaker instance. */
export interface CircuitBreakerOptions {
  /** Number of consecutive failures to trip the circuit (default: 5) */
  failureThreshold?: number;
  /** Number of consecutive successes in half-open state to close the circuit (default: 2) */
  successThreshold?: number;
  /** Cooldown period in ms before transitioning from OPEN to HALF_OPEN (default: 30000) */
  cooldownMs?: number;
  /** Name for this circuit breaker, used in log messages (default: "CircuitBreaker") */
  name?: string;
  /** Called when circuit transitions from CLOSED or HALF_OPEN to OPEN */
  onOpen?: (metrics: { state: CircuitState; failureCount: number; successCount: number }) => void;
  /** Called when circuit transitions from OPEN or HALF_OPEN to CLOSED */
  onClose?: (metrics: { state: CircuitState; failureCount: number; successCount: number }) => void;
  /** Called when circuit transitions from OPEN to HALF_OPEN after cooldown */
  onHalfOpen?: (metrics: {
    state: CircuitState;
    failureCount: number;
    successCount: number;
  }) => void;
}

type CircuitBreakerMetrics = { state: CircuitState; failureCount: number; successCount: number };

type RequiredCircuitBreakerOptions = Required<
  Omit<CircuitBreakerOptions, 'onOpen' | 'onClose' | 'onHalfOpen'>
> & {
  onOpen?: (metrics: CircuitBreakerMetrics) => void;
  onClose?: (metrics: CircuitBreakerMetrics) => void;
  onHalfOpen?: (metrics: CircuitBreakerMetrics) => void;
};

const DEFAULT_OPTIONS: RequiredCircuitBreakerOptions = {
  failureThreshold: 5,
  successThreshold: 2,
  cooldownMs: 30000,
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
  private lastFailureTime = 0;
  private options: RequiredCircuitBreakerOptions;
  private inFlightProbe = false;

  /**
   * Create a new CircuitBreaker.
   *
   * @param options - Configuration options for failure/success thresholds, cooldown, and lifecycle hooks.
   */
  constructor(options: CircuitBreakerOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
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
    if (this.state === 'OPEN' && Date.now() - this.lastFailureTime >= this.options.cooldownMs) {
      this.state = 'HALF_OPEN';
      core.info(`[${this.options.name}] Circuit transitioning OPEN -> HALF_OPEN after cooldown`);
      this.safeInvokeHook(this.options.onHalfOpen, this.getMetrics());
    }
  }

  /**
   * Get the current circuit breaker state.
   *
   * @returns The current CircuitState (CLOSED, OPEN, or HALF_OPEN).
   */
  getState(): CircuitState {
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
  async call<T>(fn: () => Promise<T>): Promise<T> {
    this.transitionState();
    if (this.state === 'OPEN') {
      throw new Error(
        `[${this.options.name}] Circuit is OPEN — request not attempted (cooldown: ${this.options.cooldownMs}ms)`,
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

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    } finally {
      this.inFlightProbe = false;
    }
  }

  private onSuccess(): void {
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

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.successCount = 0;
      core.warning(
        `[${this.options.name}] Circuit HALF_OPEN -> OPEN after failure in half-open state`,
      );
      this.safeInvokeHook(this.options.onOpen, this.getMetrics());
    } else if (this.state === 'CLOSED' && this.failureCount >= this.options.failureThreshold) {
      this.state = 'OPEN';
      this.successCount = 0;
      core.warning(
        `[${this.options.name}] Circuit CLOSED -> OPEN after ${this.failureCount} consecutive failures`,
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
    if (priorState === 'OPEN' || priorState === 'HALF_OPEN') {
      this.safeInvokeHook(this.options.onClose, this.getMetrics());
    }
  }

  /**
   * Get current circuit breaker metrics.
   *
   * @returns Object containing the current state, failure count, and success count.
   */
  getMetrics(): { state: CircuitState; failureCount: number; successCount: number } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
    };
  }
}
