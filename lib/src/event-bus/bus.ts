import type { GitHubEvent, Subscriber } from '../types/index.js';
import { CircuitBreaker } from '../utils/circuit-breaker.js';
import { Logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

const SUBSCRIBER_CONCURRENCY = 10;
const SUBSCRIBER_TIMEOUT_MS = 120_000;

export interface SubscriberHealth {
  name: string;
  totalCalls: number;
  failedCalls: number;
  lastError: string | null;
  lastEvent: string | null;
  lastEventTimestamp: number | null;
}

export class EventBus {
  private subscribers: Map<string, Subscriber[]> = new Map();
  private history: GitHubEvent[] = [];
  private readonly maxHistory = 100;
  private subscriberHealth: Map<string, SubscriberHealth> = new Map();
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private logger = new Logger('EventBus');

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

  registerAll(subscribers: Subscriber[]): void {
    for (const sub of subscribers) {
      this.register(sub);
    }
  }

  async publish(event: GitHubEvent): Promise<void> {
    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    const matching = this.subscribers.get(event.type) || [];
    const wildcard = this.subscribers.get('*') || [];
    const allSubs = [...new Set([...matching, ...wildcard])];

    for (let i = 0; i < allSubs.length; i += SUBSCRIBER_CONCURRENCY) {
      const batch = allSubs.slice(i, i + SUBSCRIBER_CONCURRENCY);
      await Promise.allSettled(batch.map((sub) => this.executeSubscriber(sub, event)));
    }
  }

  private async executeSubscriber(sub: Subscriber, event: GitHubEvent): Promise<void> {
    const health = this.subscriberHealth.get(sub.name);
    const cb = this.circuitBreakers.get(sub.name);

    if (cb && cb.getState() === 'OPEN') {
      this.logger.warn(`Subscriber ${sub.name} circuit is OPEN — skipping`, {
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
      this.logger.warn(`Subscriber ${sub.name} timed out after ${SUBSCRIBER_TIMEOUT_MS}ms`, {
        prNumber: event.prNumber,
        repo: event.repo,
      });
    }, SUBSCRIBER_TIMEOUT_MS);

    try {
      const subscriberWork = async () => {
        if (abortController.signal.aborted) return;
        await sub.handle(event);
      };

      const work = cb ? () => cb.call(subscriberWork) : subscriberWork;
      await work();

      if (timedOut) {
        this.logger.warn(
          `Subscriber ${sub.name} completed after timeout (${SUBSCRIBER_TIMEOUT_MS}ms)`,
          { prNumber: event.prNumber, repo: event.repo },
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
      this.logger.warn(
        `Subscriber ${sub.name} failed on ${event.type}: ${err instanceof Error ? err.message : err}`,
        { prNumber: event.prNumber, repo: event.repo },
      );

      if (cb && cb.getState() === 'OPEN') {
        this.logger.warn(
          `Subscriber ${sub.name} circuit is now OPEN — will be skipped on next event`,
          { prNumber: event.prNumber, repo: event.repo },
        );
      }
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  getHistory(): GitHubEvent[] {
    return [...this.history];
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

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

  getSubscriberHealth(): SubscriberHealth[] {
    return Array.from(this.subscriberHealth.values()).map((h) => ({ ...h }));
  }

  getFailedSubscribers(): SubscriberHealth[] {
    return Array.from(this.subscriberHealth.values())
      .filter((h) => h.failedCalls > 0)
      .map((h) => ({ ...h }));
  }

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
}
