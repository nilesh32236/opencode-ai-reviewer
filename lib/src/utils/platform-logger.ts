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
import { sanitizeString } from './sanitize.js';

/** Shape of the optional `@actions/core` module used for GitHub Actions output. */
type GitHubCoreModule = typeof import('@actions/core');

/** Numeric ordering of log levels used for level comparisons. */
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  trace: -1,
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

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
   * Format a message into the shared line layout.
   * @param level - The log level.
   * @param message - The message to format.
   * @param data - Optional structured data to include.
   * @returns The formatted message line.
   */
  protected formatMessage(level: LogLevel, message: string, data?: unknown): string {
    return this.formatMessageWithContext(level, message, data);
  }

  /**
   * Format a message, merging an optional per-call context over the base context.
   * @param level - The log level.
   * @param message - The message to format.
   * @param data - Optional structured data to include.
   * @param context - Optional per-call context merged over the base context.
   * @returns The formatted message line.
   */
  protected formatMessageWithContext(
    level: LogLevel,
    message: string,
    data?: unknown,
    context?: LogContext,
  ): string {
    const timestamp = new Date().toISOString();
    const contextStr = this.formatContext(context);
    const dataStr = data ? ` ${this.formatData(data)}` : '';
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
    const formatted = context
      ? this.formatMessageWithContext(level, message, data, context)
      : this.formatMessage(level, message, data);
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
 * Console implementation of PlatformLogger for CLI and development environments.
 */
export class ConsolePlatformLogger extends BasePlatformLogger {
  private readonly useColors: boolean;

  /**
   * Create a console platform logger.
   * @param name - The logger name shown in formatted output.
   * @param level - Optional initial log level.
   * @param context - Optional initial logging context.
   */
  constructor(name: string, level?: LogLevel, context: LogContext = {}) {
    super(name, level, context);
    this.useColors = process.stdout.isTTY;
  }

  private static readonly COLORS = {
    trace: '\x1b[90m',
    debug: '\x1b[90m',
    info: '\x1b[36m',
    warn: '\x1b[33m',
    error: '\x1b[31m',
    fatal: '\x1b[35m',
    reset: '\x1b[0m',
  };

  private colorize(level: LogLevel, message: string): string {
    if (!this.useColors) return message;
    const color = ConsolePlatformLogger.COLORS[level] || '';
    const reset = ConsolePlatformLogger.COLORS.reset;
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
        console.warn(
          `[platform-logger] @actions/core unavailable, falling back to console: ${err instanceof Error ? err.message : String(err)}`,
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
