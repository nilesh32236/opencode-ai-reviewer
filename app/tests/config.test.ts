import { afterEach, describe, expect, it } from 'vitest';
import { buildConfig } from '../src/utils/config.js';

const SAVED: Record<string, string | undefined> = {};

function setEnv(overrides: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(overrides)) {
    const prev = process.env[key];
    SAVED[key] = prev;
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('buildConfig eventLogging / eventSubscribers', () => {
  afterEach(() => {
    for (const [key, value] of Object.entries(SAVED)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('defaults to disabled logging and no subscribers when env vars are unset', () => {
    setEnv({
      EVENT_LOGGING_ENABLED: undefined,
      EVENT_LOGGING_PATH: undefined,
      EVENT_SUBSCRIBERS: undefined,
    });
    const config = buildConfig();
    expect(config.eventLogging?.enabled).toBe(false);
    expect(config.eventLogging?.path).toBe('.opencode/events.ndjson');
    expect(config.eventSubscribers).toEqual([]);
  });

  it('wires EVENT_LOGGING_ENABLED and EVENT_LOGGING_PATH env vars', () => {
    setEnv({
      EVENT_LOGGING_ENABLED: 'true',
      EVENT_LOGGING_PATH: '.opencode/custom-events.ndjson',
      EVENT_SUBSCRIBERS: undefined,
    });
    const config = buildConfig();
    expect(config.eventLogging?.enabled).toBe(true);
    expect(config.eventLogging?.path).toBe('.opencode/custom-events.ndjson');
  });

  it('parses EVENT_SUBSCRIBERS JSON into subscriber entries', () => {
    setEnv({
      EVENT_SUBSCRIBERS: JSON.stringify([{ name: 'Custom Sub', path: './custom-subscriber.mjs' }]),
    });
    const config = buildConfig();
    expect(config.eventSubscribers).toEqual([
      { name: 'Custom Sub', path: './custom-subscriber.mjs' },
    ]);
  });

  it('ignores malformed EVENT_SUBSCRIBERS JSON', () => {
    setEnv({ EVENT_SUBSCRIBERS: 'not-json{' });
    const config = buildConfig();
    expect(config.eventSubscribers).toEqual([]);
  });

  it('ignores non-array EVENT_SUBSCRIBERS', () => {
    setEnv({ EVENT_SUBSCRIBERS: '{"path":"./x.mjs"}' });
    const config = buildConfig();
    expect(config.eventSubscribers).toEqual([]);
  });
});
