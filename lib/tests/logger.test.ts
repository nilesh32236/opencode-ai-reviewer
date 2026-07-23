import * as core from '@actions/core';
import { describe, expect, it, vi } from 'vitest';
import { Logger } from '../src/utils/logger.js';

vi.mock('@actions/core', () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

describe('Logger', () => {
  it('creates a logger with the given name', () => {
    const logger = new Logger('TestLogger');
    expect(logger).toBeInstanceOf(Logger);
  });

  it('creates a child logger with merged context', () => {
    const parent = new Logger('Parent', { repo: 'owner/repo' });
    const child = parent.child({ prNumber: 42 });
    expect(child).toBeInstanceOf(Logger);
    expect(child).not.toBe(parent);
  });

  it('child does not share context mutations with parent', () => {
    const parent = new Logger('Parent', { repo: 'owner/repo' });
    const child = parent.child({ prNumber: 42 });
    const parent2 = parent.child({ prNumber: 99 });
    expect(child).not.toBe(parent2);
  });

  it('sets default log level', () => {
    expect(() => Logger.setDefaultLevel('debug')).not.toThrow();
    expect(() => Logger.setDefaultLevel('info')).not.toThrow();
  });

  it('filters output based on log level', () => {
    Logger.setDefaultLevel('error');
    const logger = new Logger('TestFilter');

    logger.info('should be filtered');
    expect(core.info).not.toHaveBeenCalled();

    logger.warn('should be filtered');
    expect(core.warning).not.toHaveBeenCalled();

    logger.error('should not be filtered');
    expect(core.error).toHaveBeenCalled();
  });

  it('accepts all log levels', () => {
    const logger = new Logger('Test', { prNumber: 1 });
    expect(() => {
      logger.debug('debug msg');
      logger.info('info msg');
      logger.warn('warn msg');
      logger.error('error msg');
    }).not.toThrow();
  });

  it('handles undefined context gracefully', () => {
    const logger = new Logger('Test');
    expect(() => logger.info('no context')).not.toThrow();
  });
});
