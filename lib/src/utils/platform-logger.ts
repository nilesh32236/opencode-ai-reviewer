/**
 * Platform-agnostic logging abstraction layer.
 * This module provides a unified logging interface that can be used throughout the
 * core library without depending on specific platform implementations.
 * 
 * The existing Logger class in logger.ts is platform-specific (GitHub Actions).
 * This module provides an abstraction that allows the core library to use logging
 * without importing @actions/core directly.
 */

import { LogLevel, LogContext } from './logger.js';

/**
 * Abstract logger interface for platform-agnostic logging.
 * Implementations can route to different platforms (GitHub Actions, CLI, web, etc.).
 */
export interface PlatformLogger {
  /** Log a trace-level message. */
  trace(message: string, data?: unknown, context?: LogContext): void;
  
  /** Log a debug-level message. */
  debug(message: string, data?: unknown, context?: LogContext): void;
  
  /** Log an info-level message. */
  info(message: string, data?: unknown, context?: LogContext): void;
  
  /** Log a warning-level message. */
  warn(message: string, data?: unknown, context?: LogContext): void;
  
  /** Log an error-level message. */
  error(message: string, data?: unknown, context?: LogContext): void;
  
  /** Log a fatal-level message. */
  fatal(message: string, data?: unknown, context?: LogContext): void;
  
  /** Check if a log level is enabled. */
  isLevelEnabled(level: LogLevel): boolean;
  
  /** Get the current log level. */
  getLevel(): LogLevel;
  
  /** Set the log level. */
  setLevel(level: LogLevel): void;
  
  /** Create a child logger with additional context. */
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
 */
export function setPlatformLoggerFactory(factory: PlatformLoggerFactory): void {
  globalLoggerFactory = factory;
}

/**
 * Get the global platform logger factory.
 */
export function getPlatformLoggerFactory(): PlatformLoggerFactory {
  return globalLoggerFactory;
}

/**
 * Create a platform logger with the specified context.
 */
export function createPlatformLogger(context: string, level?: LogLevel): PlatformLogger {
  return globalLoggerFactory(context, level);
}

/**
 * Console implementation of PlatformLogger for CLI and development environments.
 */
export class ConsolePlatformLogger implements PlatformLogger {
  private level: LogLevel = 'info';
  private context: LogContext = {};

  constructor(private readonly name: string, level?: LogLevel) {
    if (level) this.level = level;
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

  private readonly useColors: boolean;

  constructor(name: string, level?: LogLevel) {
    this.name = name;
    this.level = level ?? 'info';
    this.useColors = process.stdout.isTTY;
  }

  private colorize(level: LogLevel, message: string): string {
    if (!this.useColors) return message;
    const color = ConsolePlatformLogger.COLORS[level] || '';
    const reset = ConsolePlatformLogger.COLORS.reset;
    return `${color}${message}${reset}`;
  }

  private formatMessage(level: LogLevel, message: string, data?: unknown): string {
    const timestamp = new Date().toISOString();
    const contextStr = this.formatContext();
    const dataStr = data ? ` ${this.formatData(data)}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] [${this.name}]${contextStr} ${message}${dataStr}`;
  }

  private formatContext(): string {
    const parts: string[] = [];
    if (this.context.correlationId) parts.push(`corr=${this.context.correlationId.slice(0, 8)}`);
    if (this.context.prNumber) parts.push(`pr#${this.context.prNumber}`);
    if (this.context.repo) parts.push(`${this.context.repo}`);
    if (this.context.eventType) parts.push(`${this.context.eventType}`);
    for (const [k, v] of Object.entries(this.context)) {
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

  private log(level: LogLevel, message: string, data?: unknown): void {
    const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
      trace: -1,
      debug: 0,
      info: 1,
      warn: 2,
      error: 3,
      fatal: 4,
    };
    
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.level]) return;
    
    const formatted = this.formatMessage(level, message, data);
    const colored = this.colorize(level, formatted);
    
    switch (level) {
      case 'trace':
      case 'debug':
        console.log(colored);
        break;
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

  trace(message: string, data?: unknown, context?: LogContext): void {
    this.log('trace', message, data);
  }

  debug(message: string, data?: unknown, context?: LogContext): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: unknown, context?: LogContext): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: unknown, context?: LogContext): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: unknown, context?: LogContext): void {
    this.log('error', message, data);
  }

  fatal(message: string, data?: unknown, context?: LogContext): void {
    this.log('fatal', message, data);
  }

  isLevelEnabled(level: LogLevel): boolean {
    const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
      trace: -1,
      debug: 0,
      info: 1,
      warn: 2,
      error: 3,
      fatal: 4,
    };
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];
  }

  getLevel(): LogLevel {
    return this.level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  child(context: LogContext): PlatformLogger {
    const merged = { ...this.context, ...context };
    return new ConsolePlatformLogger(this.name, this.level);
  }
}

/**
 * GitHub Actions implementation of PlatformLogger.
 * Uses @actions/core for output, maintaining compatibility with existing code.
 */
export class GitHubActionsPlatformLogger implements PlatformLogger {
  private level: LogLevel = 'info';
  private context: LogContext = {};
  private static coreModule: typeof import('@actions/core') | null = null;

  constructor(private readonly name: string, level?: LogLevel) {
    if (level) this.level = level;
    this.getCore();
  }

  private getCore(): typeof import('@actions/core') {
    if (!GitHubActionsPlatformLogger.coreModule) {
      try {
        GitHubActionsPlatformLogger.coreModule = require('@actions/core') as typeof import('@actions/core');
      } catch {
        // Fall back to console if @actions/core is not available
        GitHubActionsPlatformLogger.coreModule = {
          debug: (msg: string) => console.log(`[DEBUG] ${msg}`),
          info: (msg: string) => console.log(`[INFO] ${msg}`),
          warning: (msg: string) => console.warn(`[WARNING] ${msg}`),
          error: (msg: string) => console.error(`[ERROR] ${msg}`),
        } as unknown as typeof import('@actions/core');
      }
    }
    return GitHubActionsPlatformLogger.coreModule;
  }

  private formatMessage(level: LogLevel, message: string, data?: unknown): string {
    const timestamp = new Date().toISOString();
    const contextStr = this.formatContext();
    const dataStr = data ? ` ${this.formatData(data)}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] [${this.name}]${contextStr} ${message}${dataStr}`;
  }

  private formatContext(): string {
    const parts: string[] = [];
    if (this.context.correlationId) parts.push(`corr=${this.context.correlationId.slice(0, 8)}`);
    if (this.context.prNumber) parts.push(`pr#${this.context.prNumber}`);
    if (this.context.repo) parts.push(`${this.context.repo}`);
    if (this.context.eventType) parts.push(`${this.context.eventType}`);
    for (const [k, v] of Object.entries(this.context)) {
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

  private log(level: LogLevel, message: string, data?: unknown): void {
    const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
      trace: -1,
      debug: 0,
      info: 1,
      warn: 2,
      error: 3,
      fatal: 4,
    };
    
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.level]) return;
    
    const formatted = this.formatMessage(level, message, data);
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

  trace(message: string, data?: unknown, context?: LogContext): void {
    this.log('trace', message, data);
  }

  debug(message: string, data?: unknown, context?: LogContext): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: unknown, context?: LogContext): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: unknown, context?: LogContext): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: unknown, context?: LogContext): void {
    this.log('error', message, data);
  }

  fatal(message: string, data?: unknown, context?: LogContext): void {
    this.log('fatal', message, data);
  }

  isLevelEnabled(level: LogLevel): boolean {
    const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
      trace: -1,
      debug: 0,
      info: 1,
      warn: 2,
      error: 3,
      fatal: 4,
    };
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];
  }

  getLevel(): LogLevel {
    return this.level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  child(context: LogContext): PlatformLogger {
    const merged = { ...this.context, ...context };
    return new GitHubActionsPlatformLogger(this.name, this.level);
  }
}

/**
 * Factory function for creating console platform loggers.
 */
export function createConsolePlatformLogger(context: string, level?: LogLevel): PlatformLogger {
  return new ConsolePlatformLogger(context, level);
}

/**
 * Factory function for creating GitHub Actions platform loggers.
 */
export function createGitHubActionsPlatformLogger(context: string, level?: LogLevel): PlatformLogger {
  return new GitHubActionsPlatformLogger(context, level);
}

/**
 * Null logger that discards all messages.
 * Useful for testing or when logging should be suppressed.
 */
export class NullPlatformLogger implements PlatformLogger {
  trace(): void {}
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  fatal(): void {}
  isLevelEnabled(): boolean { return false; }
  getLevel(): LogLevel { return 'fatal'; }
  setLevel(): void {}
  child(): PlatformLogger { return this; }
}

/**
 * Factory function for creating null platform loggers.
 */
export function createNullPlatformLogger(): PlatformLogger {
  return new NullPlatformLogger();
}

// Re-export types
export type { LogLevel, LogContext };
