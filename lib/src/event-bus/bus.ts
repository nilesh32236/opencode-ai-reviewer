import type { GitHubEvent, Subscriber } from '../types/index.js';
import { Logger } from '../utils/logger.js';

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

    for (const sub of [...matching, ...wildcard]) {
      const health = this.subscriberHealth.get(sub.name);
      if (health) {
        health.totalCalls++;
        health.lastEvent = event.type;
        health.lastEventTimestamp = Date.now();
      }

      const TIMEOUT_MS = 120_000;
      try {
        await Promise.race([
          sub.handle(event),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Subscriber ${sub.name} timed out after ${TIMEOUT_MS}ms`)),
              TIMEOUT_MS,
            ),
          ),
        ]);
      } catch (err) {
        if (health) {
          health.failedCalls++;
          health.lastError = err instanceof Error ? err.message : String(err);
        }
        this.logger.error(
          `Subscriber ${sub.name} failed on ${event.type}: ${err instanceof Error ? err.message : err}`,
          { prNumber: event.prNumber, repo: event.repo },
        );

        // Circuit breaker: skip subscriber after N consecutive failures
        if (health && health.failedCalls >= 5) {
          this.logger.warn(
            `Subscriber ${sub.name} has failed ${health.failedCalls} times consecutively — skipping until next event`,
            { prNumber: event.prNumber, repo: event.repo },
          );
        }
      }
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
  }
}
