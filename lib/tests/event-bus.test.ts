import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/event-bus/bus.js';
import { EventRouter } from '../src/event-bus/router.js';
import type { GitHubEvent, Subscriber } from '../src/types/index.js';

describe('EventBus', () => {
  it('registers subscribers and dispatches events by type', async () => {
    const bus = new EventBus();
    const handled: string[] = [];

    const sub: Subscriber = {
      name: 'test',
      subscribedEvents: ['pr.opened'],
      async handle(event: GitHubEvent) {
        handled.push(event.type);
      },
    };

    bus.register(sub);

    await bus.publish({ type: 'pr.opened', category: 'pr', payload: {}, timestamp: 1 });
    await bus.publish({ type: 'pr.synchronize', category: 'pr', payload: {}, timestamp: 2 });

    expect(handled).toEqual(['pr.opened']);
  });

  it('wildcard subscriber matches all events', async () => {
    const bus = new EventBus();
    const handled: string[] = [];

    const sub: Subscriber = {
      name: 'wildcard',
      subscribedEvents: ['*'],
      async handle(event: GitHubEvent) {
        handled.push(event.type);
      },
    };

    bus.register(sub);
    await bus.publish({ type: 'pr.opened', category: 'pr', payload: {}, timestamp: 1 });
    await bus.publish({
      type: 'review.completed',
      category: 'internal',
      payload: {},
      timestamp: 2,
    });

    expect(handled).toEqual(['pr.opened', 'review.completed']);
  });

  it('subscriber errors do not crash the bus', async () => {
    const bus = new EventBus();
    const sub: Subscriber = {
      name: 'crashy',
      subscribedEvents: ['*'],
      async handle() {
        throw new Error('boom');
      },
    };

    bus.register(sub);
    await expect(
      bus.publish({ type: 'pr.opened', category: 'pr', payload: {}, timestamp: 1 }),
    ).resolves.not.toThrow();
  });

  it('maintains event history', async () => {
    const bus = new EventBus();
    await bus.publish({ type: 'pr.opened', category: 'pr', payload: {}, timestamp: 1 });
    expect(bus.getHistory()).toHaveLength(1);
    expect(bus.getHistory()[0].type).toBe('pr.opened');
  });

  it('registerAll registers multiple subscribers', async () => {
    const bus = new EventBus();
    const handled: string[] = [];

    bus.registerAll([
      {
        name: 'a',
        subscribedEvents: ['pr.opened'],
        async handle() {
          handled.push('a');
        },
      },
      {
        name: 'b',
        subscribedEvents: ['pr.synchronize'],
        async handle() {
          handled.push('b');
        },
      },
    ]);

    await bus.publish({ type: 'pr.opened', category: 'pr', payload: {}, timestamp: 1 });
    await bus.publish({ type: 'pr.synchronize', category: 'pr', payload: {}, timestamp: 2 });

    expect(handled).toEqual(['a', 'b']);
  });

  it('unregister removes subscriber and stops dispatch', async () => {
    const bus = new EventBus();
    const handled: string[] = [];

    const sub = {
      name: 'removable',
      subscribedEvents: ['pr.opened'],
      async handle() {
        handled.push('called');
      },
    };

    bus.register(sub);
    await bus.publish({ type: 'pr.opened', category: 'pr', payload: {}, timestamp: 1 });
    expect(handled).toEqual(['called']);

    const removed = bus.unregister('removable');
    expect(removed).toBe(true);

    await bus.publish({ type: 'pr.opened', category: 'pr', payload: {}, timestamp: 2 });
    expect(handled).toEqual(['called']);
  });

  it('unregister returns false for non-existent subscriber', () => {
    const bus = new EventBus();
    expect(bus.unregister('nonexistent')).toBe(false);
  });

  it('passes AbortSignal to subscriber handle method', async () => {
    const bus = new EventBus();
    let receivedSignal: AbortSignal | undefined;

    const sub: Subscriber = {
      name: 'signal-catcher',
      subscribedEvents: ['test.event'],
      async handle(_event: GitHubEvent, signal?: AbortSignal) {
        receivedSignal = signal;
      },
    };

    bus.register(sub);
    await bus.publish({ type: 'test.event', category: 'internal', payload: {}, timestamp: 1 });

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal instanceof AbortSignal).toBe(true);
    expect(receivedSignal!.aborted).toBe(false);
  });

  it('subscriber exits early when signal is aborted', async () => {
    let iterations = 0;

    const sub: Subscriber = {
      name: 'abort-check',
      subscribedEvents: ['*'],
      async handle(_event: GitHubEvent, signal?: AbortSignal) {
        for (let i = 0; i < 1000; i++) {
          if (signal?.aborted) return;
          iterations++;
        }
      },
    };

    const controller = new AbortController();
    controller.abort();
    await sub.handle(
      { type: 'test', category: 'internal', payload: {}, timestamp: 1 },
      controller.signal,
    );

    expect(iterations).toBe(0);
  });

  it('unregister cleans up health tracking', () => {
    const bus = new EventBus();
    bus.register({
      name: 'healthy',
      subscribedEvents: ['*'],
      async handle() {},
    });
    bus.unregister('healthy');
    expect(bus.getSubscriberHealth()).toHaveLength(0);
  });

  it('times out a hung subscriber instead of blocking the dispatch forever', async () => {
    const bus = new EventBus({ subscriberTimeoutMs: 5 });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const fastCalls: string[] = [];

    try {
      bus.register({
        name: 'hung',
        subscribedEvents: ['*'],
        handle() {
          // Never settles and ignores the AbortSignal: the case the old
          // implementation could not survive, because it awaited the work
          // unconditionally and only set a flag from the timer.
          return new Promise<void>(() => {});
        },
      });
      bus.register({
        name: 'fast',
        subscribedEvents: ['*'],
        async handle() {
          fastCalls.push('called');
        },
      });

      // Five consecutive hangs is the breaker's failure threshold.
      for (let i = 0; i < 5; i++) {
        await bus.publish({ type: 'pr.opened', category: 'pr', payload: {}, timestamp: i });
      }
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    const health = bus.getSubscriberHealth().find((h) => h.name === 'hung');
    expect(health?.totalCalls).toBe(5);
    expect(health?.failedCalls).toBe(5);
    expect(health?.consecutiveFailures).toBe(5);
    expect(health?.lastError).toContain('TimeoutError');
    expect(bus.getFailedSubscribers().map((h) => h.name)).toEqual(['hung']);
    // The circuit must trip, otherwise a subscriber that hangs on every event
    // is reported as healthy and retried on every future dispatch.
    expect(bus.getSubscriberCircuitState('hung')).toBe('OPEN');
    // A hung subscriber must not starve its batch peers.
    expect(fastCalls).toHaveLength(5);

    // The abandoned work promise resolves/rejects long after the race is over;
    // a late rejection must not surface as an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(unhandled).toEqual([]);
  });

  it('records a failure when a subscriber finishes only after its timeout', async () => {
    const bus = new EventBus({ subscriberTimeoutMs: 5 });
    let calls = 0;

    bus.register({
      name: 'slow',
      subscribedEvents: ['*'],
      async handle() {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 40));
      },
    });

    await bus.publish({ type: 'pr.opened', category: 'pr', payload: {}, timestamp: 1 });

    const health = bus.getSubscriberHealth().find((h) => h.name === 'slow');
    expect(calls).toBe(1);
    // Completing late is still a timeout: it must count as a failure rather
    // than return early with the breaker already credited a success.
    expect(health?.failedCalls).toBe(1);
    expect(health?.consecutiveFailures).toBe(1);
    expect(health?.lastError).toContain('TimeoutError');
  });

  it('keeps failedCalls cumulative when a subscriber recovers', async () => {
    const bus = new EventBus();
    let shouldFail = true;

    bus.register({
      name: 'flaky',
      subscribedEvents: ['*'],
      async handle() {
        if (shouldFail) throw new Error('transient boom');
      },
    });

    await bus.publish({ type: 'pr.opened', category: 'pr', payload: {}, timestamp: 1 });
    shouldFail = false;
    for (let i = 0; i < 3; i++) {
      await bus.publish({ type: 'pr.opened', category: 'pr', payload: {}, timestamp: 2 + i });
    }

    const health = bus.getSubscriberHealth().find((h) => h.name === 'flaky');
    // Cumulative: zeroing it on success is what let a subscriber failing 1 of 4
    // events report zero failures and hide from getFailedSubscribers().
    expect(health?.totalCalls).toBe(4);
    expect(health?.failedCalls).toBe(1);
    // The current-degradation streak does reset, and the stale error is cleared.
    expect(health?.consecutiveFailures).toBe(0);
    expect(health?.lastError).toBeNull();
    expect(bus.getFailedSubscribers().map((h) => h.name)).toEqual(['flaky']);

    bus.resetHealth('flaky');
    const reset = bus.getSubscriberHealth().find((h) => h.name === 'flaky');
    expect(reset?.failedCalls).toBe(0);
    expect(reset?.consecutiveFailures).toBe(0);
  });
});

describe('EventRouter', () => {
  it('maps pull_request.opened to pr.opened with PR number', async () => {
    const bus = new EventBus();
    const router = new EventRouter(bus);
    const events: GitHubEvent[] = [];

    bus.register({
      name: 'collector',
      subscribedEvents: ['pr.opened'],
      async handle(e) {
        events.push(e);
      },
    });

    await router.handle('pull_request.opened', {
      pull_request: { number: 42 },
      repository: { full_name: 'owner/repo' },
    });

    expect(events[0].type).toBe('pr.opened');
    expect(events[0].prNumber).toBe(42);
    expect(events[0].repo).toBe('owner/repo');
    expect(events[0].category).toBe('pr');
  });

  it('rejects unknown events without publishing', async () => {
    const bus = new EventBus();
    const router = new EventRouter(bus);
    const events: GitHubEvent[] = [];

    bus.register({
      name: 'collector',
      subscribedEvents: ['*'],
      async handle(e) {
        events.push(e);
      },
    });

    await router.handle('some.unknown.event', {});
    expect(events).toHaveLength(0);
  });

  it('rejects non-object payloads without publishing', async () => {
    const bus = new EventBus();
    const router = new EventRouter(bus);
    const events: GitHubEvent[] = [];

    bus.register({
      name: 'collector',
      subscribedEvents: ['*'],
      async handle(e) {
        events.push(e);
      },
    });

    await router.handle('pull_request.opened', null);
    expect(events).toHaveLength(0);
  });
});
