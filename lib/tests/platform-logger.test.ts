import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConsolePlatformLogger,
  GitHubActionsPlatformLogger,
  NullPlatformLogger,
  createNullPlatformLogger,
  createPlatformLogger,
  setPlatformLoggerFactory,
} from '../src/utils/platform-logger.js';

describe('ConsolePlatformLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits info messages to console.log', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new ConsolePlatformLogger('Test');
    logger.info('hello world');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain('hello world');
  });

  it('child() inherits and merges the parent context', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const parent = new ConsolePlatformLogger('Test', 'info', { repo: 'owner/repo' });
    const child = parent.child({ prNumber: 42 });
    child.info('with context');
    const line = String(spy.mock.calls[0][0]);
    expect(line).toContain('owner/repo');
    expect(line).toContain('pr#42');
  });

  it('per-call context is merged into the emitted line', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new ConsolePlatformLogger('Test');
    logger.info('with per-call context', undefined, { prNumber: 7 });
    expect(String(spy.mock.calls[0][0])).toContain('pr#7');
  });

  it('redacts credential-shaped values via sanitizeString', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new ConsolePlatformLogger('Test');
    logger.info('token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop');
    expect(String(spy.mock.calls[0][0])).not.toContain(
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop',
    );
  });

  it('respects setLevel for level filtering', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = new ConsolePlatformLogger('Test');
    logger.setLevel('error');
    logger.info('suppressed');
    logger.error('emitted');
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('emitted');
  });
});

describe('GitHubActionsPlatformLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes messages through the @actions/core API', async () => {
    const core = await import('@actions/core');
    vi.spyOn(core, 'info').mockImplementation(() => {});
    const logger = new GitHubActionsPlatformLogger('Test');
    logger.info('hello');
    expect(core.info).toHaveBeenCalledTimes(1);
  });
});

describe('NullPlatformLogger', () => {
  it('discards all messages and tracks its level', () => {
    const logger = createNullPlatformLogger();
    logger.info('gone');
    expect(logger.isLevelEnabled('fatal')).toBe(true);
    expect(logger.isLevelEnabled('info')).toBe(false);
    logger.setLevel('info');
    expect(logger.isLevelEnabled('info')).toBe(true);
  });
});

describe('createPlatformLogger', () => {
  it('uses the configured factory', () => {
    setPlatformLoggerFactory((context, level) => new NullPlatformLogger(context, level));
    const logger = createPlatformLogger('ctx');
    expect(logger).toBeInstanceOf(NullPlatformLogger);
  });
});
