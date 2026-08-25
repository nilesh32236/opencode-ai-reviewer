import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConsolePlatformLogger,
  GitHubActionsPlatformLogger,
  NullPlatformLogger,
  createConsolePlatformLogger,
  createNullPlatformLogger,
  createPlatformLogger,
  getPlatformLoggerFactory,
  setPlatformLoggerFactory,
} from '../src/utils/platform-logger.js';
import { sanitizeString } from '../src/utils/sanitize.js';

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
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0][0]);
    expect(line).toContain('owner/repo');
    expect(line).toContain('pr#42');
  });

  it('per-call context is merged into the emitted line', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new ConsolePlatformLogger('Test');
    logger.info('with per-call context', undefined, { prNumber: 7 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('pr#7');
  });

  it('redacts credential-shaped values via sanitizeString', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new ConsolePlatformLogger('Test');
    logger.info('token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop');
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0][0]);
    expect(line).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop');
    expect(line).toContain('[REDACTED_GITHUB_TOKEN]');
  });

  it('redacts gateway keys end-to-end through the logger', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new ConsolePlatformLogger('Test');
    logger.info('export OPENCODE_API_KEY=oc-secret-123 before run');
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0][0]);
    expect(line).not.toContain('oc-secret-123');
    expect(line).toContain('OPENCODE_API_KEY=[REDACTED]');
  });

  it('redacts gateway and custom-provider API keys', () => {
    const line = sanitizeString(
      'OPENCODE_API_KEY=oc_key123 LLM_API_KEY:llm_secret456 AZURE_OPENAI_API_KEY="az-key-789"',
    );
    expect(line).not.toContain('oc_key123');
    expect(line).not.toContain('llm_secret456');
    expect(line).not.toContain('az-key-789');
    expect(line).toContain('OPENCODE_API_KEY=[REDACTED]');
    expect(line).toContain('LLM_API_KEY=[REDACTED]');
    expect(line).toContain('AZURE_OPENAI_API_KEY=[REDACTED]');
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

  it('routes debug, warn, and error to the matching core methods', async () => {
    const core = await import('@actions/core');
    const debugSpy = vi.spyOn(core, 'debug').mockImplementation(() => {});
    const warningSpy = vi.spyOn(core, 'warning').mockImplementation(() => {});
    const errorSpy = vi.spyOn(core, 'error').mockImplementation(() => {});
    const logger = new GitHubActionsPlatformLogger('Test', 'debug');
    logger.debug('d');
    logger.warn('w');
    logger.error('e');
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('child() inherits and merges the parent context', async () => {
    const core = await import('@actions/core');
    const infoSpy = vi.spyOn(core, 'info').mockImplementation(() => {});
    const parent = new GitHubActionsPlatformLogger('Test', 'info', { repo: 'owner/repo' });
    const child = parent.child({ prNumber: 42 });
    child.info('with context');
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const line = String(infoSpy.mock.calls[0][0]);
    expect(line).toContain('owner/repo');
    expect(line).toContain('pr#42');
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

  it('honours the level supplied to the factory', () => {
    const logger = createNullPlatformLogger('ctx', 'debug');
    expect(logger.getLevel()).toBe('debug');
    expect(logger.isLevelEnabled('info')).toBe(true);
  });
});

describe('createPlatformLogger', () => {
  afterEach(() => {
    setPlatformLoggerFactory(createConsolePlatformLogger);
  });

  it('uses the configured factory', () => {
    const original = getPlatformLoggerFactory();
    setPlatformLoggerFactory((context, level) => new NullPlatformLogger(context, level));
    const logger = createPlatformLogger('ctx');
    expect(logger).toBeInstanceOf(NullPlatformLogger);
    expect(getPlatformLoggerFactory()).not.toBe(original);
  });

  it('restores the default factory after the configured factory is replaced', () => {
    expect(getPlatformLoggerFactory()).toBe(createConsolePlatformLogger);
  });
});
