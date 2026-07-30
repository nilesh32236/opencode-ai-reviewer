import * as core from '@actions/core';

/** Log levels supported by Logger, ordered by increasing severity. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Sanitize an error for secure logging.
 * Strips sensitive tokens from error messages and stack traces.
 *
 * @param error - The error value to sanitize.
 * @returns Sanitized error string with tokens redacted.
 */
export function sanitizeError(error: unknown): string {
  const errorStr =
    error instanceof Error
      ? error.stack || error.message
      : typeof error === 'string'
        ? error
        : String(error);

  return sanitizeString(errorStr);
}

/**
 * Sanitize an error for public-facing output (e.g., PR comments).
 * Uses only the error message, never the stack trace, to avoid
 * disclosing internal paths and call frames.
 *
 * @param error - The error value to sanitize.
 * @returns Sanitized error message string with tokens redacted.
 */
export function sanitizeErrorMessage(error: unknown): string {
  const msg =
    error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);

  return sanitizeString(msg);
}

function sanitizeString(input: string): string {
  return input
    .replace(/(ghp|github_pat|gho|ghs|ghu)_[a-zA-Z0-9_-]{36,}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/sk-[a-zA-Z0-9-]{48,}/g, '[REDACTED_OPENAI_KEY]')
    .replace(/sk-ant-[a-zA-Z0-9_-]{40,}/g, '[REDACTED_ANTHROPIC_KEY]')
    .replace(/x-access-token:[^@]+@/g, 'x-access-token:[REDACTED]@')
    .replace(
      /(OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GITHUB_TOKEN)[=":]+[^&\s'"]+/gi,
      '$1=[REDACTED]',
    );
}

/** Context metadata attached to log messages for structured logging. */
export interface LogContext {
  /** PR number associated with the log entry */
  prNumber?: number;
  /** Repository in owner/repo format */
  repo?: string;
  /** GitHub event type */
  eventType?: string;
  /** File path associated with the log entry */
  file?: string;
  [key: string]: unknown;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Structured logger with level filtering, context enrichment, and token sanitization.
 * Wraps GitHub Actions core logging methods.
 */
export class Logger {
  private static defaultLevel: LogLevel = 'info';

  /**
   * Create a new Logger instance.
   *
   * @param name - Component name for log identification.
   * @param context - Initial context metadata.
   */
  constructor(
    private name: string,
    private context: LogContext = {},
  ) {}

  /**
   * Set the global default log level threshold. Messages below this level are suppressed.
   *
   * @param level - Minimum log level to output.
   */
  static setDefaultLevel(level: LogLevel): void {
    Logger.defaultLevel = level;
  }

  /**
   * Create a child logger with merged context.
   * The child inherits the parent's name and context, merged with the provided extra context.
   *
   * @param extraContext - Additional context to merge.
   * @returns A new Logger instance with merged context.
   */
  child(extraContext: LogContext): Logger {
    return new Logger(this.name, { ...this.context, ...extraContext });
  }

  /**
   * Log a debug-level message.
   *
   * @param message - The message to log.
   * @param data - Optional structured data to include.
   */
  debug(message: string, data?: unknown): void {
    this.log('debug', message, data);
  }

  /**
   * Log an info-level message.
   *
   * @param message - The message to log.
   * @param data - Optional structured data to include.
   */
  info(message: string, data?: unknown): void {
    this.log('info', message, data);
  }

  /**
   * Log a warning-level message.
   *
   * @param message - The message to log.
   * @param data - Optional structured data to include.
   */
  warn(message: string, data?: unknown): void {
    this.log('warn', message, data);
  }

  /**
   * Log an error-level message.
   *
   * @param message - The message to log.
   * @param data - Optional structured data to include.
   */
  error(message: string, data?: unknown): void {
    this.log('error', message, data);
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[Logger.defaultLevel]) return;

    const prefix = this.buildPrefix(level);
    const rawMessage = data
      ? `${prefix} ${message} ${this.formatData(data)}`
      : `${prefix} ${message}`;

    const fullMessage = sanitizeError(rawMessage);

    switch (level) {
      case 'debug':
        core.debug(fullMessage);
        break;
      case 'info':
        core.info(fullMessage);
        break;
      case 'warn':
        core.warning(fullMessage);
        break;
      case 'error':
        core.error(fullMessage);
        break;
    }
  }

  private buildPrefix(level: LogLevel): string {
    const timestamp = new Date().toISOString();
    const contextStr = this.formatContext();
    return `[${timestamp}] [${level.toUpperCase()}] [${this.name}]${contextStr}`;
  }

  private formatContext(): string {
    if (Object.keys(this.context).length === 0) return '';
    const parts: string[] = [];
    if (this.context.prNumber) parts.push(`pr#${this.context.prNumber}`);
    if (this.context.repo) parts.push(`${this.context.repo}`);
    if (this.context.eventType) parts.push(`${this.context.eventType}`);
    for (const [k, v] of Object.entries(this.context)) {
      if (!['prNumber', 'repo', 'eventType'].includes(k) && v !== undefined) {
        parts.push(`${k}=${v}`);
      }
    }
    return parts.length > 0 ? ` [${parts.join(' ')}]` : '';
  }

  private formatData(data: unknown): string {
    if (typeof data === 'string') return data;
    if (data instanceof Error) return data.stack || data.message;
    try {
      const seen = new WeakSet<object>();
      return JSON.stringify(data, (_key: string, value: unknown) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
          if (value instanceof Error) return value.stack || value.message;
        }
        return value;
      });
    } catch {
      return String(data);
    }
  }
}
