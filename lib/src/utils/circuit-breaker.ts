import * as core from '@actions/core';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  successThreshold?: number;
  cooldownMs?: number;
  name?: string;
  /** Called when circuit transitions from CLOSED or HALF_OPEN to OPEN */
  onOpen?: (metrics: { failureCount: number; successCount: number }) => void;
  /** Called when circuit transitions from OPEN or HALF_OPEN to CLOSED */
  onClose?: (metrics: { failureCount: number; successCount: number }) => void;
  /** Called when circuit transitions from OPEN to HALF_OPEN after cooldown */
  onHalfOpen?: (metrics: { failureCount: number; successCount: number }) => void;
}

type RequiredCircuitBreakerOptions = Required<
  Omit<CircuitBreakerOptions, 'onOpen' | 'onClose' | 'onHalfOpen'>
> & {
  onOpen?: (metrics: { failureCount: number; successCount: number }) => void;
  onClose?: (metrics: { failureCount: number; successCount: number }) => void;
  onHalfOpen?: (metrics: { failureCount: number; successCount: number }) => void;
};

const DEFAULT_OPTIONS: RequiredCircuitBreakerOptions = {
  failureThreshold: 5,
  successThreshold: 2,
  cooldownMs: 30000,
  name: 'CircuitBreaker',
};

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private options: RequiredCircuitBreakerOptions;
  private inFlightProbe = false;

  constructor(options: CircuitBreakerOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  private transitionState(): void {
    if (this.state === 'OPEN' && Date.now() - this.lastFailureTime >= this.options.cooldownMs) {
      this.state = 'HALF_OPEN';
      core.info(`[${this.options.name}] Circuit transitioning OPEN -> HALF_OPEN after cooldown`);
      this.options.onHalfOpen?.(this.getMetrics());
    }
  }

  getState(): CircuitState {
    return this.state;
  }

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
        this.failureCount = 0;
        this.successCount = 0;
        core.info(
          `[${this.options.name}] Circuit HALF_OPEN -> CLOSED after ${count} consecutive successes`,
        );
        this.options.onClose?.(this.getMetrics());
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
      this.options.onOpen?.(this.getMetrics());
    } else if (this.state === 'CLOSED' && this.failureCount >= this.options.failureThreshold) {
      this.state = 'OPEN';
      this.successCount = 0;
      core.warning(
        `[${this.options.name}] Circuit CLOSED -> OPEN after ${this.failureCount} consecutive failures`,
      );
      this.options.onOpen?.(this.getMetrics());
    }
  }

  reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
  }

  getMetrics(): { state: CircuitState; failureCount: number; successCount: number } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
    };
  }
}
