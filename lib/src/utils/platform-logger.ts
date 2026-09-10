/**
 * Platform-agnostic logging abstraction layer.
 * This module provides a unified logging interface that can be used throughout the
 * core library without depending on specific platform implementations.
 *
 * The existing Logger class in logger.ts is platform-specific (GitHub Actions).
 * This module provides an abstraction that allows the core library to use logging
 * without importing @actions/core directly.
 */

import type { LogContext, LogLevel } from './logger.js';
import { LOG_LEVEL_PRIORITY } from './logger.js';
import { sanitizeString } from './sanitize.js';

/** Shape of the optional `@actions/core` module used for GitHub Actions output. */
type GitHubCoreModule = typeof import('@actions/core');

/**
 * Abstract logger interface for platform-agnostic logging.
 * Implementations can route to different platforms (GitHub Actions, CLI, web, etc.).
 */
export interface PlatformLogger {
  /**
   * Log a trace-level message.
   * @param message - The message to log.
   * @param data - Optional structured data to include.
   * @param context - Optional logging context.
   */
  trace(message: string, data?: unknown, context?: LogContext): void;

  /**
   * Log a debug-level message.
   * @param message - The message to log.
   * @param data - Optional structured data to include.
   * @param context - Optional logging context.
   */
  debug(message: string, data?: unknown, context?: LogContext): void;

  /**
   * Log an info-level message.
   * @param message - The message to log.
   * @param data - Optional structured data to include.
   * @param context - Optional logging context.
   */
  info(message: string, data?: unknown, context?: LogContext): void;

  /**
   * Log a warning-level message.
   * @param message - The message to log.
   * @param data - Optional structured data to include.
   * @param context - Optional logging context.
   */
  warn(message: string, data?: unknown, context?: LogContext): void;

  /**
   * Log an error-level message.
   * @param message - The message to log.
   * @param data - Optional structured data to include.
   * @param context - Optional logging context.
   */
  error(message: string, data?: unknown, context?: LogContext): void;

  /**
   * Log a fatal-level message.
   * @param message - The message to log.
   * @param data - Optional structured data to include.
   * @param context - Optional logging context.
   */
  fatal(message: string, data?: unknown, context?: LogContext): void;

  /**
   * Check if a log level is enabled.
   * @param level - The log level to check.
   * @returns True when the given level is enabled.
   */
  isLevelEnabled(level: LogLevel): boolean;

  /**
   * Get the current log level.
   * @returns The current log level.
   */
  getLevel(): LogLevel;

  /**
   * Set the log level.
   * @param level - The log level to set.
   */
  setLevel(level: LogLevel): void;

  /**
   * Create a child logger with additional context.
   * @param context - Additional context for the child logger.
   * @returns A child logger with merged context.
   */
  child(context: LogContext): PlatformLogger;
}

/**
 * Factory function type for creating platform-specific loggers.
 */
export type PlatformLoggerFactory = (context: string, level?: LogLevel) => PlatformLogger;

/**
 * Global platform logger factory.
 * Defaults to creating ConsolePlatformLogger instances.
 */
let globalLoggerFactory: PlatformLoggerFactory = createConsolePlatformLogger;

/**
 * Set the global platform logger factory.
 * Call this during application initialization to configure platform-specific logging.
 * @param factory - The factory to use when creating platform loggers.
 */
export function setPlatformLoggerFactory(factory: PlatformLoggerFactory): void {
  globalLoggerFactory = factory;
}

/**
 * Get the global platform logger factory.
 * @returns The currently configured platform logger factory.
 */
export function getPlatformLoggerFactory(): PlatformLoggerFactory {
  return globalLoggerFactory;
}

/**
 * Create a platform logger with the specified context.
 * @param context - The logger context/name.
 * @param level - Optional initial log level.
 * @returns A platform logger instance.
 */
export function createPlatformLogger(context: string, level?: LogLevel): PlatformLogger {
  return globalLoggerFactory(context, level);
}

/**
 * Base implementation of {@link PlatformLogger} sharing the formatting and
 * level-filtering logic between the console and GitHub Actions variants.
 */
abstract class BasePlatformLogger implements PlatformLogger {
  protected level: LogLevel;
  protected context: LogContext;
  protected readonly name: string;

  /**
   * Create a platform logger.
   * @param name - The logger name shown in formatted output.
   * @param level - Optional initial log level.
   * @param context - Optional initial logging context.
   */
  constructor(name: string, level?: LogLevel, context: LogContext = {}) {
    this.name = name;
    this.level = level ?? 'info';
    this.context = context;
  }

  /**
   * Emit a fully formatted, already-sanitized line to the platform sink.
   * @param level - The log level.
   * @param formatted - The formatted line to emit.
   */
  protected abstract emit(level: LogLevel, formatted: string): void;

  /**
   * Create a child logger inheriting this logger's name, level, and context.
   * @param context - Additional context for the child logger.
   * @returns A child logger with merged context.
   */
  abstract child(context: LogContext): PlatformLogger;

  /**
   * Format a message, merging an optional per-call context over the base context.
   * @param level - The log level.
   * @param message - The message to format.
   * @param data - Optional structured data to include.
   * @param context - Optional per-call context merged over the base context.
   * @returns The formatted message line.
   */
  protected formatMessage(
    level: LogLevel,
    message: string,
    data?: unknown,
    context?: LogContext,
  ): string {
    const timestamp = new Date().toISOString();
    const contextStr = this.formatContext(context);
    const dataStr = data !== undefined ? ` ${this.formatData(data)}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] [${this.name}]${contextStr} ${message}${dataStr}`;
  }

  private formatContext(context?: LogContext): string {
    const merged = { ...this.context, ...context };
    const parts: string[] = [];
    if (merged.correlationId) parts.push(`corr=${merged.correlationId.slice(0, 8)}`);
    if (merged.prNumber) parts.push(`pr#${merged.prNumber}`);
    if (merged.repo) parts.push(`${merged.repo}`);
    if (merged.eventType) parts.push(`${merged.eventType}`);
    for (const [k, v] of Object.entries(merged)) {
      if (!['prNumber', 'repo', 'eventType', 'correlationId'].includes(k) && v !== undefined) {
        parts.push(`${k}=${v}`);
      }
    }
    return parts.length > 0 ? ` [${parts.join(' ')}]` : '';
  }

  private formatData(data: unknown): string {
    if (typeof data === 'string') return data;
    if (data instanceof Error) return data.stack || data.message;
    try {
      return JSON.stringify(data);
    } catch {
      return String(data);
    }
  }

  private log(level: LogLevel, message: string, data?: unknown, context?: LogContext): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.level]) return;

    // Redact credentials/PII before emitting, mirroring Logger.log.
    const formatted = this.formatMessage(level, message, data, context);
    this.emit(level, sanitizeString(formatted));
  }

  trace(message: string, data?: unknown, context?: LogContext): void {
    this.log('trace', message, data, context);
  }

  debug(message: string, data?: unknown, context?: LogContext): void {
    this.log('debug', message, data, context);
  }

  info(message: string, data?: unknown, context?: LogContext): void {
    this.log('info', message, data, context);
  }

  warn(message: string, data?: unknown, context?: LogContext): void {
    this.log('warn', message, data, context);
  }

  error(message: string, data?: unknown, context?: LogContext): void {
    this.log('error', message, data, context);
  }

  fatal(message: string, data?: unknown, context?: LogContext): void {
    this.log('fatal', message, data, context);
  }

  isLevelEnabled(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];
  }

  getLevel(): LogLevel {
    return this.level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }
}

/**
 * Resolve whether console color output should be enabled, honoring the
 * NO_COLOR / CLICOLOR conventions on top of TTY detection.
 *
 * Precedence (evaluated in order):
 * - `NO_COLOR` present and non-empty → disabled (https://no-color.org).
 * - `CLICOLOR === '0'` → disabled.
 * - `CLICOLOR_FORCE` / `FORCE_COLOR` set to a non-zero, non-empty value →
 *   enabled, even when stdout is not a TTY.
 * - Otherwise → `process.stdout.isTTY` (preserves historical behavior).
 *
 * @param env - Environment record to read (defaults to `process.env`).
 * @param isTTY - TTY flag to use (defaults to `process.stdout.isTTY`).
 * @returns True when ANSI colors should be emitted.
 */
export function shouldUseConsoleColors(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean | undefined = process.stdout.isTTY,
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.CLICOLOR === '0') return false;
  const force = env.CLICOLOR_FORCE ?? env.FORCE_COLOR;
  if (force !== undefined && force !== '' && force !== '0') return true;
  return Boolean(isTTY);
}

/**
 * Terminal background polarity used to pick a legible ANSI palette.
 */
export type TerminalBackground = 'light' | 'dark';

/**
 * Detect a light terminal background via the `COLORFGBG` variable
 * (rxvt convention `"fg;bg"` where the last component is the background
 * xterm color index). An index `>= 7` (7 = light gray, 15 = white)
 * indicates a light background; anything else (including unset or
 * unparsable values) is treated as dark/unknown.
 *
 * @param colorfgbg - Raw `COLORFGBG` value (defaults to `process.env.COLORFGBG`).
 * @returns True when the terminal background looks light.
 */
export function isLightTerminalBackground(colorfgbg?: string): boolean {
  const raw = colorfgbg ?? process.env.COLORFGBG;
  if (!raw) return false;
  const parts = raw.split(';');
  const bgRaw = parts[parts.length - 1].trim();
  const bg = Number.parseInt(bgRaw, 10);
  if (Number.isNaN(bg)) return false;
  return bg >= 7;
}

/**
 * Resolve the terminal background polarity for palette selection.
 *
 * Resolution order:
 * 1. Explicit override `OPENCODE_LOG_BACKGROUND` (or `TERM_BACKGROUND`) set
 *    to `light` / `dark` — lets users of terminals that do not export
 *    `COLORFGBG` (iTerm2, VS Code, most CI) force the correct palette.
 * 2. `COLORFGBG` heuristic via {@link isLightTerminalBackground}.
 * 3. Default `dark` (historical behavior; the dark palette is legible on
 *    black and, while not ideal on white, remains readable for the colorblind-
 *    safe `[LEVEL]` tag which is always emitted as the primary cue).
 *
 * @param env - Environment record to read (defaults to `process.env`).
 * @returns The resolved background polarity.
 */
export function resolveTerminalBackground(
  env: NodeJS.ProcessEnv = process.env,
): TerminalBackground {
  const explicit = (env.OPENCODE_LOG_BACKGROUND ?? env.TERM_BACKGROUND ?? '').trim().toLowerCase();
  if (explicit === 'light' || explicit === 'dark') return explicit;
  return isLightTerminalBackground(env.COLORFGBG) ? 'light' : 'dark';
}

/**
 * Console implementation of PlatformLogger for CLI and development environments.
 *
 * Color output honors `NO_COLOR` / `CLICOLOR` / `CLICOLOR_FORCE` /
 * `FORCE_COLOR`, adapts the palette to the terminal background (explicit
 * `OPENCODE_LOG_BACKGROUND` / `TERM_BACKGROUND` override, else `COLORFGBG`),
 * and always keeps the `[LEVEL]` tag emitted by `formatMessage()` as the
 * primary, non-color level cue so color is never the sole indicator.
 */
export class ConsolePlatformLogger extends BasePlatformLogger {
  private readonly useColors: boolean;
  private readonly background: TerminalBackground;

  /**
   * Create a console platform logger.
   * @param name - The logger name shown in formatted output.
   * @param level - Optional initial log level.
   * @param context - Optional initial logging context.
   */
  constructor(name: string, level?: LogLevel, context: LogContext = {}) {
    super(name, level, context);
    this.useColors = shouldUseConsoleColors();
    this.background = resolveTerminalBackground();
  }

  /**
   * Bright ANSI palette tuned for dark terminal backgrounds. Each color is
   * highly legible against black (~16.7:1 for cyan/yellow) and is always
   * paired with the `[LEVEL]` tag so hue is never the only cue.
   */
  private static readonly DARK_BG_COLORS: Record<LogLevel, string> & { reset: string } = {
    trace: '\x1b[90m',
    debug: '\x1b[90m',
    info: '\x1b[36m',
    warn: '\x1b[33m',
    error: '\x1b[31m',
    fatal: '\x1b[35m',
    reset: '\x1b[0m',
  };

  /**
   * Bold truecolor palette tuned for light terminal backgrounds. Each entry
   * meets WCAG AA 4.5:1 against white: trace/debug dark gray #586069
   * (~6.4:1), info dark blue #005cc5 (~6.3:1), warn dark amber #735c0f
   * (~6.4:1), error dark red #d73a49 (~4.6:1), fatal dark purple #6f42c1
   * (~6.5:1). Used when the background resolves to `light` via
   * {@link resolveTerminalBackground} (`OPENCODE_LOG_BACKGROUND=light` /
   * `COLORFGBG`); otherwise the dark-background palette is kept.
   */
  private static readonly LIGHT_BG_COLORS: Record<LogLevel, string> & { reset: string } = {
    trace: '\x1b[1m\x1b[38;2;88;96;105m',
    debug: '\x1b[1m\x1b[38;2;88;96;105m',
    info: '\x1b[1m\x1b[38;2;0;92;197m',
    warn: '\x1b[1m\x1b[38;2;115;92;15m',
    error: '\x1b[1m\x1b[38;2;215;58;73m',
    fatal: '\x1b[1m\x1b[38;2;111;66;193m',
    reset: '\x1b[0m',
  };

  private colorize(level: LogLevel, message: string): string {
    if (!this.useColors) return message;
    const palette =
      this.background === 'light'
        ? ConsolePlatformLogger.LIGHT_BG_COLORS
        : ConsolePlatformLogger.DARK_BG_COLORS;
    const color = palette[level] || '';
    const reset = palette.reset;
    return `${color}${message}${reset}`;
  }

  /**
   * Emit the formatted line to stdout/stderr, applying ANSI colors.
   * @param level - The log level.
   * @param formatted - The formatted, sanitized line to emit.
   */
  protected emit(level: LogLevel, formatted: string): void {
    const colored = this.colorize(level, formatted);
    switch (level) {
      case 'trace':
      case 'debug':
      case 'info':
        console.log(colored);
        break;
      case 'warn':
        console.warn(colored);
        break;
      case 'error':
      case 'fatal':
        console.error(colored);
        break;
    }
  }

  /**
   * Create a child console logger with merged context.
   * @param context - Additional context for the child logger.
   * @returns A child console logger.
   */
  child(context: LogContext): PlatformLogger {
    return new ConsolePlatformLogger(this.name, this.level, {
      ...this.context,
      ...context,
    });
  }
}

/**
 * GitHub Actions implementation of PlatformLogger.
 * Uses @actions/core for output, maintaining compatibility with existing code.
 */
export class GitHubActionsPlatformLogger extends BasePlatformLogger {
  private static coreModule: GitHubCoreModule | null = null;

  /**
   * Create a GitHub Actions platform logger.
   * @param name - The logger name shown in formatted output.
   * @param level - Optional initial log level.
   * @param context - Optional initial logging context.
   */
  constructor(name: string, level?: LogLevel, context: LogContext = {}) {
    super(name, level, context);
    this.getCore();
  }

  private getCore(): GitHubCoreModule {
    if (!GitHubActionsPlatformLogger.coreModule) {
      try {
        GitHubActionsPlatformLogger.coreModule = require('@actions/core') as GitHubCoreModule;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(
          sanitizeString(
            `[platform-logger] @actions/core unavailable, falling back to console: ${reason}`,
          ),
        );
        // Fall back to console if @actions/core is not available
        GitHubActionsPlatformLogger.coreModule = {
          debug: (msg: string) => console.log(`[DEBUG] ${msg}`),
          info: (msg: string) => console.log(`[INFO] ${msg}`),
          warning: (msg: string) => console.warn(`[WARNING] ${msg}`),
          error: (msg: string) => console.error(`[ERROR] ${msg}`),
        } as unknown as GitHubCoreModule;
      }
    }
    return GitHubActionsPlatformLogger.coreModule;
  }

  /**
   * Emit the formatted line through the GitHub Actions core API.
   * @param level - The log level.
   * @param formatted - The formatted, sanitized line to emit.
   */
  protected emit(level: LogLevel, formatted: string): void {
    const core = this.getCore();
    switch (level) {
      case 'trace':
      case 'debug':
        core.debug(formatted);
        break;
      case 'info':
        core.info(formatted);
        break;
      case 'warn':
        core.warning(formatted);
        break;
      case 'error':
      case 'fatal':
        core.error(formatted);
        break;
    }
  }

  /**
   * Create a child GitHub Actions logger with merged context.
   * @param context - Additional context for the child logger.
   * @returns A child GitHub Actions logger.
   */
  child(context: LogContext): PlatformLogger {
    return new GitHubActionsPlatformLogger(this.name, this.level, {
      ...this.context,
      ...context,
    });
  }
}

/**
 * Factory function for creating console platform loggers.
 * @param context - The logger context/name.
 * @param level - Optional initial log level.
 * @returns A console-backed platform logger.
 */
export function createConsolePlatformLogger(context: string, level?: LogLevel): PlatformLogger {
  return new ConsolePlatformLogger(context, level);
}

/**
 * Factory function for creating GitHub Actions platform loggers.
 * @param context - The logger context/name.
 * @param level - Optional initial log level.
 * @returns A GitHub Actions-backed platform logger.
 */
export function createGitHubActionsPlatformLogger(
  context: string,
  level?: LogLevel,
): PlatformLogger {
  return new GitHubActionsPlatformLogger(context, level);
}

/**
 * Null logger that discards all messages.
 * Useful for testing or when logging should be suppressed.
 */
export class NullPlatformLogger implements PlatformLogger {
  private level: LogLevel = 'fatal';

  /**
   * Create a null platform logger.
   * @param _name - Ignored; the logger emits nothing.
   * @param level - Optional initial log level (defaults to 'fatal').
   */
  constructor(_name?: string, level?: LogLevel) {
    if (level) this.level = level;
  }

  trace(_message: string, _data?: unknown, _context?: LogContext): void {}
  debug(_message: string, _data?: unknown, _context?: LogContext): void {}
  info(_message: string, _data?: unknown, _context?: LogContext): void {}
  warn(_message: string, _data?: unknown, _context?: LogContext): void {}
  error(_message: string, _data?: unknown, _context?: LogContext): void {}
  fatal(_message: string, _data?: unknown, _context?: LogContext): void {}
  isLevelEnabled(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];
  }
  getLevel(): LogLevel {
    return this.level;
  }
  setLevel(level: LogLevel): void {
    this.level = level;
  }
  child(_context: LogContext): PlatformLogger {
    return this;
  }
}

/**
 * Factory function for creating null platform loggers.
 * @param _context - Ignored; the logger emits nothing.
 * @param level - Optional initial log level.
 * @returns A no-op platform logger.
 */
export function createNullPlatformLogger(_context?: string, level?: LogLevel): PlatformLogger {
  return new NullPlatformLogger(_context, level);
}

// Re-export types
export type { LogLevel, LogContext };
