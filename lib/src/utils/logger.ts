import * as core from '@actions/core';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

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
    const fullMessage = data
      ? `${prefix} ${message} ${this.formatData(data)}`
      : `${prefix} ${message}`;

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
