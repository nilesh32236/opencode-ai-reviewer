import type { GitHubEvent, Subscriber } from '../types/index.js';
import { CircuitBreaker } from '../utils/circuit-breaker.js';
import { Logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

const DEFAULT_SUBSCRIBER_CONCURRENCY = 10;
const DEFAULT_SUBSCRIBER_TIMEOUT_MS = 600_000;

/** Options for configuring an EventBus instance. */
export interface EventBusOptions {
  /** Maximum number of subscribers executed concurrently per publish batch (default: 10). */
  concurrency?: number;
  /** Per-subscriber timeout in milliseconds (default: 600_000 / 10 min). */
  subscriberTimeoutMs?: number;
}

/** Health metrics for a single event subscriber. */
export interface SubscriberHealth {
  name: string;
  totalCalls: number;
  failedCalls: number;
  lastError: string | null;
  lastEvent: string | null;
  lastEventTimestamp: number | null;
}

/**
 * Central event bus for publishing and subscribing to GitHub events.
 * Manages subscriber registration, circuit breaker health, and
 * concurrent execution of subscribers with timeout protection.
 */
export class EventBus {
  private subscribers: Map<string, Subscriber[]> = new Map();
  private history: GitHubEvent[] = [];
  private readonly maxHistory = 100;
  private subscriberHealth: Map<string, SubscriberHealth> = new Map();
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private logger = new Logger('EventBus');
  private readonly concurrency: number;
  private readonly subscriberTimeoutMs: number;

  /**
   * Create a new EventBus.
   *
   * @param options - Optional tuning for concurrency and per-subscriber timeout.
   */
  constructor(options: EventBusOptions = {}) {
    this.concurrency = options.concurrency ?? DEFAULT_SUBSCRIBER_CONCURRENCY;
    this.subscriberTimeoutMs = options.subscriberTimeoutMs ?? DEFAULT_SUBSCRIBER_TIMEOUT_MS;
  }

  /**
   * Register a subscriber for its subscribed event types.
   * Also initializes health tracking and a circuit breaker for the subscriber.
   * @param subscriber The subscriber to register
   */
  register(subscriber: Subscriber): void {
    for (const eventType of subscriber.subscribedEvents) {
      const existing = this.subscribers.get(eventType) || [];
      existing.push(subscriber);
      this.subscribers.set(eventType, existing);
    }

    if (!this.subscriberHealth.has(subscriber.name)) {
      this.subscriberHealth.set(subscriber.name, {
        name: subscriber.name,
        totalCalls: 0,
        failedCalls: 0,
        lastError: null,
        lastEvent: null,
        lastEventTimestamp: null,
      });
    }

    if (!this.circuitBreakers.has(subscriber.name)) {
      this.circuitBreakers.set(
        subscriber.name,
        new CircuitBreaker({
          failureThreshold: 5,
          successThreshold: 2,
          cooldownMs: 30000,
          name: subscriber.name,
        }),
      );
    }
  }

  /**
   * Register multiple subscribers at once.
   * @param subscribers Array of subscribers to register
   */
  registerAll(subscribers: Subscriber[]): void {
    for (const sub of subscribers) {
      this.register(sub);
    }
  }

  /**
   * Publish an event to all matching subscribers.
   * Subscribers are executed in batches with configurable concurrency.
   * Also matches wildcard ('*') subscribers.
   * @param event The event to publish
   */
  async publish(event: GitHubEvent): Promise<void> {
    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    const matching = this.subscribers.get(event.type) || [];
    const wildcard = this.subscribers.get('*') || [];
    const allSubs = [...new Set([...matching, ...wildcard])];

    for (let i = 0; i < allSubs.length; i += this.concurrency) {
      const batch = allSubs.slice(i, i + this.concurrency);
      await Promise.allSettled(batch.map((sub) => this.executeSubscriber(sub, event)));
    }
  }

  /**
   * Execute a single subscriber for an event, with timeout and circuit breaker protection.
   * Tracks health metrics and logs failures for observability.
   * @param sub The subscriber to execute
   * @param event The event to deliver to the subscriber
   */
  private async executeSubscriber(sub: Subscriber, event: GitHubEvent): Promise<void> {
    const health = this.subscriberHealth.get(sub.name);
    const cb = this.circuitBreakers.get(sub.name);
    // Child logger carries the event's correlation ID so subscriber-level logs
    // stay traceable to the originating webhook.
    const logger = this.logger.child({
      correlationId: event.correlationId,
      prNumber: event.prNumber,
      repo: event.repo,
      eventType: event.type,
    });

    if (cb && cb.getState() === 'OPEN') {
      logger.warn(`Subscriber ${sub.name} circuit is OPEN — skipping`, {
        prNumber: event.prNumber,
        repo: event.repo,
      });
      return;
    }

    if (health) {
      health.totalCalls++;
      health.lastEvent = event.type;
      health.lastEventTimestamp = Date.now();
    }

    const abortController = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      abortController.abort();
      logger.warn(`Subscriber ${sub.name} timed out after ${this.subscriberTimeoutMs}ms`, {
        prNumber: event.prNumber,
        repo: event.repo,
      });
    }, this.subscriberTimeoutMs);

    try {
      const subscriberWork = async () => {
        if (abortController.signal.aborted) return;
        await sub.handle(event, abortController.signal);
      };

      const work = cb ? () => cb.call(subscriberWork) : subscriberWork;
      await work();

      if (timedOut) {
        logger.warn(
          `Subscriber ${sub.name} completed after timeout (${this.subscriberTimeoutMs}ms)`,
          {
            prNumber: event.prNumber,
            repo: event.repo,
          },
        );
        return;
      }

      if (health) {
        health.failedCalls = 0;
      }
    } catch (err) {
      if (health) {
        health.failedCalls++;
        health.lastError = err instanceof Error ? err.message : String(err);
      }
      logger.warn(
        `Subscriber ${sub.name} failed on ${event.type}: ${err instanceof Error ? err.message : err}`,
        { prNumber: event.prNumber, repo: event.repo },
      );

      if (cb && cb.getState() === 'OPEN') {
        logger.warn(`Subscriber ${sub.name} circuit is now OPEN — will be skipped on next event`, {
          prNumber: event.prNumber,
          repo: event.repo,
        });
      }
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Get a copy of the event history log.
   * @returns A copy of the event history array
   */
  getHistory(): GitHubEvent[] {
    return [...this.history];
  }

  /**
   * Get the number of registered event types (not individual subscribers).
   * @returns The number of registered event types
   */
  subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Unregister a subscriber by name, removing it from all event type mappings.
   * Also cleans up health and circuit breaker tracking.
   * @param subscriberName Name of the subscriber to unregister
   * @returns true if the subscriber was found and removed
   */
  unregister(subscriberName: string): boolean {
    let removed = false;
    for (const [eventType, subs] of this.subscribers.entries()) {
      const filtered = subs.filter((s) => s.name !== subscriberName);
      if (filtered.length !== subs.length) {
        if (filtered.length === 0) {
          this.subscribers.delete(eventType);
        } else {
          this.subscribers.set(eventType, filtered);
        }
        removed = true;
      }
    }
    this.subscriberHealth.delete(subscriberName);
    this.circuitBreakers.delete(subscriberName);
    return removed;
  }

  /**
   * Get health metrics for all registered subscribers.
   * @returns Array of subscriber health metrics
   */
  getSubscriberHealth(): SubscriberHealth[] {
    return Array.from(this.subscriberHealth.values()).map((h) => ({ ...h }));
  }

  /**
   * Get health metrics for subscribers that have recorded failures.
   * @returns Array of health metrics for failed subscribers
   */
  getFailedSubscribers(): SubscriberHealth[] {
    return Array.from(this.subscriberHealth.values())
      .filter((h) => h.failedCalls > 0)
      .map((h) => ({ ...h }));
  }

  /**
   * Reset health metrics and circuit breaker for a given subscriber.
   * @param subscriberName Name of the subscriber to reset
   */
  resetHealth(subscriberName: string): void {
    const health = this.subscriberHealth.get(subscriberName);
    if (health) {
      health.totalCalls = 0;
      health.failedCalls = 0;
      health.lastError = null;
    }
    const cb = this.circuitBreakers.get(subscriberName);
    if (cb) {
      cb.reset();
    }
  }

  /**
   * Get the circuit breaker state for a specific subscriber.
   *
   * @param subscriberName - Name of the subscriber.
   * @returns The circuit state, or null when the subscriber has no breaker.
   */
  getSubscriberCircuitState(subscriberName: string): string | null {
    const cb = this.circuitBreakers.get(subscriberName);
    return cb ? cb.getState() : null;
  }

  /**
   * Get the configured concurrency limit.
   *
   * @returns The maximum number of subscribers executed concurrently.
   */
  getConcurrency(): number {
    return this.concurrency;
  }

  /**
   * Get the configured per-subscriber timeout.
   *
   * @returns The per-subscriber timeout in milliseconds.
   */
  getSubscriberTimeoutMs(): number {
    return this.subscriberTimeoutMs;
  }
}
