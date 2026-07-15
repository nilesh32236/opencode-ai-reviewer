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

  it('maps unknown events as internal', async () => {
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
    expect(events[0].category).toBe('internal');
  });
});
