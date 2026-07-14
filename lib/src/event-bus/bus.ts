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

      try {
        await sub.handle(event);
      } catch (err) {
        if (health) {
          health.failedCalls++;
          health.lastError = err instanceof Error ? err.message : String(err);
        }
        this.logger.error(
          `Subscriber ${sub.name} failed on ${event.type}: ${err instanceof Error ? err.message : err}`,
          { prNumber: event.prNumber, repo: event.repo },
        );
      }
    }
  }

  getHistory(): GitHubEvent[] {
    return [...this.history];
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  getSubscriberHealth(): SubscriberHealth[] {
    return Array.from(this.subscriberHealth.values());
  }

  getFailedSubscribers(): SubscriberHealth[] {
    return Array.from(this.subscriberHealth.values()).filter((h) => h.failedCalls > 0);
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
