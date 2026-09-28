import * as core from '@actions/core';
import { describe, expect, it, vi } from 'vitest';
import { Logger, sanitizeErrorMessage } from '../src/utils/logger.js';

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

  it('emits parseable NDJSON with top-level known fields in json mode', () => {
    Logger.setDefaultLevel('trace');
    const lines: string[] = [];
    Logger.setSink({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      structured: (line) => lines.push(line),
    });
    process.env.LOG_FORMAT = 'json';
    try {
      const logger = new Logger('Test', {
        repo: 'owner/repo',
        prNumber: 42,
        correlationId: 'corr-id-123',
      });
      logger.info('hello world', { model: 'gpt-4', extra: 'x' });
    } finally {
      process.env.LOG_FORMAT = '';
      Logger.resetSink();
    }

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe('info');
    expect(entry.name).toBe('Test');
    expect(entry.message).toBe('hello world');
    expect(entry.correlationId).toBe('corr-id-123');
    expect(entry.repo).toBe('owner/repo');
    expect(entry.prNumber).toBe(42);
    expect(entry.model).toBe('gpt-4');
    expect(entry.data).toEqual({ extra: 'x' });
  });

  it('keeps a structured field that conflicts with context inside data', () => {
    Logger.setDefaultLevel('trace');
    const lines: string[] = [];
    Logger.setSink({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      structured: (line) => lines.push(line),
    });
    process.env.LOG_FORMAT = 'json';
    try {
      // Context already promotes `model`; the data payload also carries `model`.
      const logger = new Logger('Test', { model: 'from-context' });
      logger.info('msg', { model: 'from-data', note: 'kept' });
    } finally {
      process.env.LOG_FORMAT = '';
      Logger.resetSink();
    }

    const entry = JSON.parse(lines[0]);
    // Context value wins the top-level promotion; the conflicting data value
    // must not be silently dropped — it stays under `data`.
    expect(entry.model).toBe('from-context');
    expect(entry.data).toEqual({ model: 'from-data', note: 'kept' });
  });

  it('redacts secrets without corrupting the NDJSON record', () => {
    Logger.setDefaultLevel('trace');
    const lines: string[] = [];
    Logger.setSink({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      structured: (line) => lines.push(line),
    });
    process.env.LOG_FORMAT = 'json';
    try {
      const logger = new Logger('Test', { correlationId: 'c1' });
      const secret = `ghp_${'A'.repeat(36)}`;
      logger.warn('credential involved', {
        GITHUB_TOKEN: secret,
        apiKey: secret,
        path: '/tmp/file',
      });
    } finally {
      process.env.LOG_FORMAT = '';
      Logger.resetSink();
    }

    expect(lines).toHaveLength(1);
    // The emitted line must still be valid JSON even though a key is literally
    // named GITHUB_TOKEN (the previous serialized-line sanitizer corrupted it).
    const entry = JSON.parse(lines[0]);
    const data = entry.data as Record<string, unknown>;
    expect(data.GITHUB_TOKEN).toBe('[REDACTED]');
    expect(data.apiKey).toContain('[REDACTED]');
    expect(data.path).toBe('/tmp/file');
  });

  it('falls back to a plain stdout write when the sink lacks structured()', () => {
    Logger.setDefaultLevel('trace');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    Logger.setSink({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} });
    process.env.LOG_FORMAT = 'json';
    try {
      const logger = new Logger('Test', { correlationId: 'c2' });
      expect(() => logger.info('structured without sink method')).not.toThrow();
      expect(stdoutSpy).toHaveBeenCalled();
    } finally {
      process.env.LOG_FORMAT = '';
      Logger.resetSink();
      stdoutSpy.mockRestore();
    }
  });

  it('child() propagates the parent correlation id unless overridden', () => {
    const parent = new Logger('Parent', { correlationId: 'parent-id' });
    expect(parent.child({}).getCorrelationId()).toBe('parent-id');
    expect(parent.child({ correlationId: 'child-id' }).getCorrelationId()).toBe('child-id');
  });

  it('falls back to the process-wide root correlation id', () => {
    const previousRoot = Logger.getRootCorrelationId();
    Logger.setRootCorrelationId('root-id');
    try {
      const logger = new Logger('Test');
      expect(logger.getCorrelationId()).toBe('root-id');
    } finally {
      if (previousRoot) Logger.setRootCorrelationId(previousRoot);
    }
  });
});

describe('sanitizeErrorMessage', () => {
  // Fake credential-shaped fixtures are assembled via concatenation so the
  // literal token prefix never appears in source and static secret scanners
  // (gitleaks et al.) have nothing to flag. Every value below is fake.
  const tokenPrefix = String.fromCharCode(103, 104, 112, 95);
  const fakeToken = `${tokenPrefix}${'x'.repeat(36)}`;

  it('redacts tokens from error messages', () => {
    const err = new Error(`Auth failed for token ${fakeToken}`);
    const sanitized = sanitizeErrorMessage(err);
    expect(sanitized).toBe('Auth failed for token [REDACTED_GITHUB_TOKEN]');
    expect(sanitized).not.toContain(tokenPrefix);
  });

  it('redacts tokens from raw strings', () => {
    const raw = `Auth failed for token ${fakeToken}`;
    const sanitized = sanitizeErrorMessage(raw);
    expect(sanitized).toBe('Auth failed for token [REDACTED_GITHUB_TOKEN]');
    expect(sanitized).not.toContain(tokenPrefix);
  });

  it('never emits the stack trace, only the message', () => {
    // Public-facing callers (PR comments) must not disclose internal paths or
    // call frames, so the stack is deliberately excluded here — unlike
    // `sanitizeError`, which resolves stack-or-message.
    const err = new Error(`bad token ${fakeToken}`);
    const sanitized = sanitizeErrorMessage(err);
    expect(sanitized).not.toContain('at ');
    expect(sanitized).not.toContain(err.stack ?? '\0');
  });

  it('never throws on values that cannot be coerced to a string', () => {
    // `sanitizeErrorMessage` is the single funnel for nearly every catch block
    // in action/ and app/, so a throwing coercion here would turn a *handled*
    // error into an unhandled rejection.
    const nullProto = Object.create(null) as unknown;
    const hostile = {
      toString() {
        throw new Error('nope');
      },
    } as unknown;

    expect(() => sanitizeErrorMessage(nullProto)).not.toThrow();
    expect(sanitizeErrorMessage(nullProto)).toBe('[unstringifiable error]');
    expect(() => sanitizeErrorMessage(hostile)).not.toThrow();
    expect(sanitizeErrorMessage(hostile)).toBe('[unstringifiable error]');
  });
});
