import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/event-bus/bus.js';
import { LoggingSubscriber } from '../src/event-bus/logging-subscriber.js';
import { registerEventSubscribers } from '../src/event-bus/register-event-subscribers.js';
import type { GitHubEvent } from '../src/types/index.js';

const tmpDir = path.join(os.tmpdir(), `.test-event-subs-${Date.now()}`);
// Pluggable subscriber modules must resolve inside process.cwd(), so fixtures
// are written under the working directory (and cleaned up after each test).
const fixtureDir = path.join(process.cwd(), `.test-event-subs-fixture-${Date.now()}`);

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(fixtureDir, { recursive: true, force: true });
});

describe('LoggingSubscriber', () => {
  it('writes each event as a sanitized JSONL line', async () => {
    const logPath = path.join(tmpDir, 'events.ndjson');
    const sub = new LoggingSubscriber(logPath);

    await sub.handle({
      type: 'review.completed',
      category: 'pipeline',
      prNumber: 42,
      payload: { prNumber: 42, body: 'secret contents', tokensUsed: 100 },
      timestamp: 123,
    });
    await sub.handle({
      type: 'pr.opened',
      category: 'pr',
      prNumber: 1,
      payload: {},
      timestamp: 456,
    });

    const lines = (await fs.readFile(logPath, 'utf-8')).trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]) as GitHubEvent;
    expect(first.type).toBe('review.completed');
    expect(first.prNumber).toBe(42);
    expect(first.timestamp).toBe(123);
    expect(first.payload.body).toBe('[redacted]');
    expect(first.payload.tokensUsed).toBe(100);
  });

  it('truncates long strings to prevent unbounded log growth', async () => {
    const logPath = path.join(tmpDir, 'events.ndjson');
    const sub = new LoggingSubscriber(logPath);

    await sub.handle({
      type: 'review.completed',
      category: 'pipeline',
      payload: { prNumber: 1, text: 'x'.repeat(5000) },
      timestamp: 1,
    });

    const line = (await fs.readFile(logPath, 'utf-8')).trim();
    const parsed = JSON.parse(line) as GitHubEvent;
    const text = parsed.payload.text as string;
    expect(text.length).toBeLessThanOrEqual(2000 + '...[truncated]'.length);
    expect(text.endsWith('...[truncated]')).toBe(true);
  });

  it('creates the log directory lazily', async () => {
    const logPath = path.join(tmpDir, 'nested', 'dir', 'events.ndjson');
    const sub = new LoggingSubscriber(logPath);

    await sub.handle({ type: 'pr.opened', category: 'pr', payload: {}, timestamp: 1 });

    const lines = (await fs.readFile(logPath, 'utf-8')).trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('tolerates write failures without throwing', async () => {
    // Points at a path that cannot be created (an existing file used as a dir).
    await fs.mkdir(tmpDir, { recursive: true });
    const blocker = path.join(tmpDir, 'blocker');
    await fs.writeFile(blocker, 'x');
    const sub = new LoggingSubscriber(path.join(blocker, 'events.ndjson'));

    await expect(
      sub.handle({ type: 'pr.opened', category: 'pr', payload: {}, timestamp: 1 }),
    ).resolves.not.toThrow();
  });
});

describe('registerEventSubscribers', () => {
  it('registers the LoggingSubscriber when eventLogging is enabled', async () => {
    const bus = new EventBus();
    const logPath = path.join(tmpDir, 'events.ndjson');

    const registered = await registerEventSubscribers(bus, { enabled: true, path: logPath });

    expect(registered).toHaveLength(1);
    expect(registered[0].name).toBe('LoggingSubscriber');
    expect(bus.getHistory()).toHaveLength(0);

    await bus.publish({ type: 'pr.opened', category: 'pr', payload: {}, timestamp: 1 });
    const lines = (await fs.readFile(logPath, 'utf-8')).trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('registers nothing when logging is disabled and no pluggable subscribers', async () => {
    const bus = new EventBus();
    const registered = await registerEventSubscribers(bus, { enabled: false });
    expect(registered).toHaveLength(0);
  });

  it('skips pluggable subscribers unless explicitly opted in via allowPluggable', async () => {
    const bus = new EventBus();
    const subPath = path.join(fixtureDir, 'custom-subscriber.mjs');
    await fs.mkdir(fixtureDir, { recursive: true });
    await fs.writeFile(
      subPath,
      `export default { name: 'CustomSub', subscribedEvents: ['review.completed'], handle: async () => {} };`,
    );

    // Without opt-in, configured pluggable subscribers are skipped entirely.
    const withoutOptIn = await registerEventSubscribers(bus, { enabled: false }, [
      { name: 'custom', path: subPath },
    ]);
    expect(withoutOptIn).toHaveLength(0);

    // With opt-in, the module is loaded and registered.
    const withOptIn = await registerEventSubscribers(
      bus,
      { enabled: false },
      [{ name: 'custom', path: subPath }],
      { allowPluggable: true },
    );
    expect(withOptIn).toHaveLength(1);
    expect(withOptIn[0].name).toBe('CustomSub');
  });

  it('skips pluggable subscribers whose paths escape the working directory', async () => {
    const bus = new EventBus();
    const registered = await registerEventSubscribers(
      bus,
      { enabled: false },
      [{ name: 'evil', path: '/etc/passwd' }],
      { allowPluggable: true },
    );
    expect(registered).toHaveLength(0);
  });

  it('skips pluggable subscribers pointing at non-existent modules', async () => {
    const bus = new EventBus();
    const registered = await registerEventSubscribers(
      bus,
      { enabled: false },
      [{ name: 'ghost', path: 'does-not-exist.mjs' }],
      { allowPluggable: true },
    );
    expect(registered).toHaveLength(0);
  });

  it('skips entries with missing or empty paths even when opted in', async () => {
    const bus = new EventBus();
    const registered = await registerEventSubscribers(
      bus,
      { enabled: false },
      [{ name: 'bad', path: '' }, { name: 'missing' }],
      { allowPluggable: true },
    );
    expect(registered).toHaveLength(0);
  });
});
