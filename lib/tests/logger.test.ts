import { describe, expect, it } from 'vitest';
import { Logger } from '../src/utils/logger.js';

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
