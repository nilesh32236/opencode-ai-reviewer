import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConsolePlatformLogger,
  GitHubActionsPlatformLogger,
  NullPlatformLogger,
  createConsolePlatformLogger,
  createNullPlatformLogger,
  createPlatformLogger,
  getPlatformLoggerFactory,
  isLightTerminalBackground,
  resolveTerminalBackground,
  setPlatformLoggerFactory,
  shouldUseConsoleColors,
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

  it('switches to the light-background palette when overridden', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('OPENCODE_LOG_BACKGROUND', 'light');
    vi.stubEnv('FORCE_COLOR', '1');
    try {
      const logger = new ConsolePlatformLogger('Test');
      logger.info('light line');
      const line = String(spy.mock.calls[0][0]);
      // light info color is bold truecolor #005cc5
      expect(line).toContain('38;2;0;92;197');
      expect(line).not.toContain('\x1b[36m');
      // the non-color [LEVEL] cue is always present
      expect(line).toContain('[INFO]');
    } finally {
      vi.unstubAllEnvs();
    }
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

describe('shouldUseConsoleColors', () => {
  it('disables color when NO_COLOR is set to any non-empty value', () => {
    expect(shouldUseConsoleColors({ NO_COLOR: '1' } as NodeJS.ProcessEnv, true)).toBe(false);
    expect(shouldUseConsoleColors({ NO_COLOR: 'false' } as NodeJS.ProcessEnv, true)).toBe(false);
  });

  it('ignores an empty NO_COLOR', () => {
    expect(shouldUseConsoleColors({ NO_COLOR: '' } as NodeJS.ProcessEnv, true)).toBe(true);
  });

  it('disables color when CLICOLOR is "0"', () => {
    expect(shouldUseConsoleColors({ CLICOLOR: '0' } as NodeJS.ProcessEnv, true)).toBe(false);
  });

  it('forces color via CLICOLOR_FORCE / FORCE_COLOR even without a TTY', () => {
    expect(shouldUseConsoleColors({ CLICOLOR_FORCE: '1' } as NodeJS.ProcessEnv, false)).toBe(true);
    expect(shouldUseConsoleColors({ FORCE_COLOR: '1' } as NodeJS.ProcessEnv, false)).toBe(true);
  });

  it('lets NO_COLOR win over FORCE_COLOR', () => {
    expect(
      shouldUseConsoleColors({ NO_COLOR: '1', FORCE_COLOR: '1' } as NodeJS.ProcessEnv, true),
    ).toBe(false);
  });

  it('falls back to TTY detection', () => {
    expect(shouldUseConsoleColors({} as NodeJS.ProcessEnv, true)).toBe(true);
    expect(shouldUseConsoleColors({} as NodeJS.ProcessEnv, false)).toBe(false);
    expect(shouldUseConsoleColors({} as NodeJS.ProcessEnv, undefined)).toBe(false);
  });
});

describe('isLightTerminalBackground', () => {
  it('treats xterm color indices >= 7 as light', () => {
    expect(isLightTerminalBackground('0;15')).toBe(true);
    expect(isLightTerminalBackground('0;7')).toBe(true);
  });

  it('treats indices < 7 as dark', () => {
    expect(isLightTerminalBackground('15;0')).toBe(false);
    expect(isLightTerminalBackground('7;0')).toBe(false);
  });

  it('treats unset or unparsable values as dark', () => {
    expect(isLightTerminalBackground('')).toBe(false);
    expect(isLightTerminalBackground('not-a-color')).toBe(false);
  });
});

describe('resolveTerminalBackground', () => {
  it('honors the explicit OPENCODE_LOG_BACKGROUND override', () => {
    expect(
      resolveTerminalBackground({ OPENCODE_LOG_BACKGROUND: 'light' } as NodeJS.ProcessEnv),
    ).toBe('light');
    expect(
      resolveTerminalBackground({ OPENCODE_LOG_BACKGROUND: 'DARK' } as NodeJS.ProcessEnv),
    ).toBe('dark');
  });

  it('honors the TERM_BACKGROUND fallback override', () => {
    expect(resolveTerminalBackground({ TERM_BACKGROUND: 'light' } as NodeJS.ProcessEnv)).toBe(
      'light',
    );
  });

  it('falls back to COLORFGBG detection when no override is set', () => {
    expect(resolveTerminalBackground({ COLORFGBG: '0;15' } as NodeJS.ProcessEnv)).toBe('light');
    expect(resolveTerminalBackground({ COLORFGBG: '15;0' } as NodeJS.ProcessEnv)).toBe('dark');
  });

  it('defaults to dark when nothing is known', () => {
    expect(resolveTerminalBackground({} as NodeJS.ProcessEnv)).toBe('dark');
    expect(resolveTerminalBackground({ COLORFGBG: 'garbage' } as NodeJS.ProcessEnv)).toBe('dark');
  });

  it('lets an explicit override win over COLORFGBG', () => {
    expect(
      resolveTerminalBackground({
        COLORFGBG: '15;0',
        OPENCODE_LOG_BACKGROUND: 'light',
      } as NodeJS.ProcessEnv),
    ).toBe('light');
  });
});
