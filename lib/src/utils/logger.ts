import * as core from '@actions/core';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function sanitizeError(error: unknown): string {
  const errorStr =
    error instanceof Error
      ? error.stack || error.message
      : typeof error === 'string'
        ? error
        : String(error);

  return errorStr
    .replace(/(ghp|github_pat|gho|ghs|ghu)_[a-zA-Z0-9]{36,}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/sk-[a-zA-Z0-9]{48,}/g, '[REDACTED_OPENAI_KEY]')
    .replace(/x-access-token:[^@]+@/g, 'x-access-token:[REDACTED]@')
    .replace(
      /(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GITHUB_TOKEN)[=":]+[^&\s'"]+/gi,
      '$1=[REDACTED]',
    );
}

export interface LogContext {
  prNumber?: number;
  repo?: string;
  eventType?: string;
  file?: string;
  [key: string]: unknown;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private static defaultLevel: LogLevel = 'info';

  constructor(
    private name: string,
    private context: LogContext = {},
  ) {}

  static setDefaultLevel(level: LogLevel): void {
    Logger.defaultLevel = level;
  }

  child(extraContext: LogContext): Logger {
    return new Logger(this.name, { ...this.context, ...extraContext });
  }

  debug(message: string, data?: unknown): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: unknown): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log('warn', message, data);
  }

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
      return JSON.stringify(data);
    } catch {
      return String(data);
    }
  }
}
