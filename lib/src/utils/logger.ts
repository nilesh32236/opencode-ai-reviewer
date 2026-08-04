import { randomUUID } from 'node:crypto';
import * as core from '@actions/core';
import { sanitizeString } from './sanitize.js';

/** Log levels supported by Logger, ordered by increasing severity. */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** Output format for log messages: human-readable or structured NDJSON. */
export type LogFormat = 'human' | 'json';

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
  /** Correlation ID used to trace a single review request across subsystems */
  correlationId?: string;
  /** LLM model identifier used for the operation */
  model?: string;
  /** Wall-clock duration of the operation in milliseconds */
  durationMs?: number;
  /** Number of tokens consumed by the operation */
  tokensUsed?: number;
  [key: string]: unknown;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  trace: -1,
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

/**
 * A single structured log entry serialized as one line of NDJSON (newline-delimited JSON).
 * Known fields are kept at the top level so log aggregators can filter on them.
 */
export interface StructuredLogEntry {
  /** ISO 8601 timestamp of the log entry */
  timestamp: string;
  /** Severity level of the entry */
  level: LogLevel;
  /** Component name that produced the entry */
  name: string;
  /** Human-readable message */
  message: string;
  /** Correlation ID for tracing a single request across subsystems */
  correlationId?: string;
  /** PR number associated with the entry */
  prNumber?: number;
  /** Repository in owner/repo format */
  repo?: string;
  /** GitHub event type */
  eventType?: string;
  /** LLM model identifier */
  model?: string;
  /** Wall-clock duration in milliseconds */
  durationMs?: number;
  /** Number of tokens consumed */
  tokensUsed?: number;
  /** Arbitrary extra structured data not covered by the fields above */
  data?: unknown;
}

/** Known structured fields promoted to the top level of NDJSON entries. */
const STRUCTURED_FIELDS = [
  'prNumber',
  'repo',
  'eventType',
  'model',
  'durationMs',
  'tokensUsed',
] as const;

/** Destination for Logger output. Defaults to GitHub Actions core methods. */
export interface LoggerSink {
  /** Emit a debug-level message.
   * @param message - The message to log.
   */
  debug(message: string): void;
  /** Emit an info-level message.
   * @param message - The message to log.
   */
  info(message: string): void;
  /** Emit a warning-level message.
   * @param message - The message to log.
   */
  warn(message: string): void;
  /** Emit an error-level message.
   * @param message - The message to log.
   */
  error(message: string): void;
  /** Emit a structured NDJSON line (includes a trailing newline).
   * @param line - The complete, sanitized NDJSON record to write.
   */
  structured(line: string): void;
}

/** Default sink routing through @actions/core (GitHub Actions command strings). */
const ACTIONS_SINK: LoggerSink = {
  debug: (message) => core.debug(message),
  info: (message) => core.info(message),
  warn: (message) => core.warning(message),
  error: (message) => core.error(message),
  // Structured records are intentionally NOT wrapped in `::` Actions commands so
  // log aggregators can parse the raw NDJSON line from stdout.
  structured: (line) => process.stdout.write(line),
};

let currentSink: LoggerSink = ACTIONS_SINK;

/**
 * Structured logger with level filtering, context enrichment, and token sanitization.
 * Wraps GitHub Actions core logging methods by default; a plain-text sink can be
 * installed for local (non-CI) consumers such as the CLI.
 */
export class Logger {
  private static defaultLevel: LogLevel = 'info';
  private static rootCorrelationId: string | null = null;
  private readonly correlationId: string;

  /**
   * Install a custom output sink for all Logger instances. The CLI uses this to
   * route logs to plain console output so `::command::` GitHub Actions strings
   * never leak into a local terminal. Pass an {@link LoggerSink} implementation.
   * @param sink - The sink to use for all subsequent log calls.
   */
  static setSink(sink: LoggerSink): void {
    currentSink = sink;
  }

  /**
   * Restore the default GitHub Actions output sink. Useful for tests and for
   * long-lived processes that toggle between CI and local output.
   */
  static resetSink(): void {
    currentSink = ACTIONS_SINK;
  }

  /**
   * Generate a new correlation ID (UUID v4) for tracing a single request.
   * @returns A fresh UUID string.
   */
  static generateCorrelationId(): string {
    return randomUUID();
  }

  /**
   * Set the process-wide root correlation ID. When set, any Logger created
   * without an explicit `correlationId` in its context inherits this value.
   * Single-shot processes (e.g. the GitHub Action) call this once so every
   * subsystem shares one trace ID.
   * @param id - Optional correlation ID; a new UUID is generated when omitted.
   * @returns The active root correlation ID.
   */
  static setRootCorrelationId(id?: string): string {
    Logger.rootCorrelationId = id ?? Logger.generateCorrelationId();
    return Logger.rootCorrelationId;
  }

  /**
   * Get the current process-wide root correlation ID, if any.
   * @returns The root correlation ID, or null when none is set.
   */
  static getRootCorrelationId(): string | null {
    return Logger.rootCorrelationId;
  }

  /**
   * Resolve the effective log level threshold. Prefers the validated `LOG_LEVEL`
   * environment variable and falls back to the programmatic default.
   * @returns The effective minimum log level.
   */
  static getEffectiveLevel(): LogLevel {
    const envLevel = (process.env.LOG_LEVEL ?? '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(LOG_LEVEL_PRIORITY, envLevel)) {
      return envLevel as LogLevel;
    }
    return Logger.defaultLevel;
  }

  /**
   * Resolve the output format. An explicit `LOG_FORMAT` value always wins;
   * otherwise structured JSON is used when `NODE_ENV=production`.
   * @returns `'json'` or `'human'`.
   */
  static getFormat(): LogFormat {
    const format = (process.env.LOG_FORMAT ?? '').toLowerCase();
    if (format === 'json') return 'json';
    if (format === 'human') return 'human';
    if (process.env.NODE_ENV === 'production') return 'json';
    return 'human';
  }

  /**
   * Create a new Logger instance.
   *
   * @param name - Component name for log identification.
   * @param context - Initial context metadata.
   */
  constructor(
    private name: string,
    private context: LogContext = {},
  ) {
    this.correlationId =
      context.correlationId ?? Logger.rootCorrelationId ?? Logger.generateCorrelationId();
  }

  /**
   * Set the global default log level threshold. Messages below this level are
   * suppressed. A `LOG_LEVEL` env var takes precedence over this value.
   *
   * @param level - Minimum log level to output.
   */
  static setDefaultLevel(level: LogLevel): void {
    Logger.defaultLevel = level;
  }

  /**
   * Create a child logger with merged context.
   * The child inherits the parent's name and context, merged with the provided
   * extra context. The parent's correlation ID is propagated unless the child
   * explicitly overrides it.
   *
   * @param extraContext - Additional context to merge.
   * @returns A new Logger instance with merged context.
   */
  child(extraContext: LogContext): Logger {
    const merged: LogContext = { ...this.context, ...extraContext };
    if (extraContext.correlationId === undefined) {
      merged.correlationId = this.correlationId;
    }
    return new Logger(this.name, merged);
  }

  /**
   * Get the correlation ID resolved for this logger instance.
   * @returns The correlation ID (UUID) carried by this logger.
   */
  getCorrelationId(): string {
    return this.correlationId;
  }

  /**
   * Log a trace-level message (finest granularity; typically suppressed).
   *
   * @param message - The message to log.
   * @param data - Optional structured data to include.
   */
  trace(message: string, data?: unknown): void {
    this.log('trace', message, data);
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

  /**
   * Log a fatal-level message (unrecoverable errors).
   *
   * @param message - The message to log.
   * @param data - Optional structured data to include.
   */
  fatal(message: string, data?: unknown): void {
    this.log('fatal', message, data);
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[Logger.getEffectiveLevel()]) return;

    if (Logger.getFormat() === 'json') {
      this.writeStructured(level, message, data);
      return;
    }

    const prefix = this.buildPrefix(level);
    const rawMessage = data
      ? `${prefix} ${message} ${this.formatData(data)}`
      : `${prefix} ${message}`;

    const fullMessage = sanitizeError(rawMessage);

    switch (level) {
      case 'trace':
      case 'debug':
        currentSink.debug(fullMessage);
        break;
      case 'info':
        currentSink.info(fullMessage);
        break;
      case 'warn':
        currentSink.warn(fullMessage);
        break;
      case 'error':
      case 'fatal':
        currentSink.error(fullMessage);
        break;
    }
  }

  /**
   * Emit a structured NDJSON line to stdout (machine-parseable, filterable).
   * Known fields are promoted to the top level; extra data is nested under `data`.
   * @param level - The log level.
   * @param message - The human-readable message.
   * @param data - Optional structured data to include.
   */
  private writeStructured(level: LogLevel, message: string, data?: unknown): void {
    const entry = this.buildStructuredEntry(level, message, data);
    let line: string;
    try {
      line = safeJsonStringify(entry);
    } catch {
      line = JSON.stringify({
        timestamp: entry.timestamp,
        level: entry.level,
        name: entry.name,
        message: sanitizeError(message),
        correlationId: this.correlationId,
      });
    }
    // Redact credentials even in JSON output, then emit a newline-delimited
    // record through the configured sink (like human-format calls) so custom
    // sinks keep JSON output consistent with the LoggerSink contract.
    currentSink.structured(`${sanitizeError(line)}\n`);
  }

  private buildStructuredEntry(
    level: LogLevel,
    message: string,
    data?: unknown,
  ): StructuredLogEntry {
    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      name: this.name,
      message: typeof data === 'string' ? `${message} ${data}` : message,
      correlationId: this.correlationId,
    };

    const entryRecord = entry as unknown as Record<string, unknown>;
    const contextRecord = this.context as unknown as Record<string, unknown>;
    for (const key of STRUCTURED_FIELDS) {
      const value = contextRecord[key];
      if (value !== undefined) {
        entryRecord[key] = value;
      }
    }

    if (data !== undefined && data !== null) {
      if (isPlainObject(data)) {
        const dataRecord = data;
        for (const key of STRUCTURED_FIELDS) {
          const value = dataRecord[key];
          if (value !== undefined && entryRecord[key] === undefined) {
            entryRecord[key] = value;
          }
        }
        const extra = Object.fromEntries(
          Object.entries(dataRecord).filter(
            ([k]) => !(STRUCTURED_FIELDS as readonly string[]).includes(k),
          ),
        );
        if (Object.keys(extra).length > 0) {
          entry.data = extra;
        }
      } else if (data instanceof Error) {
        entry.data = { error: data.stack || data.message };
      } else {
        // Date, array, primitive, etc. — leave as-is so natively serializable
        // values (Date → ISO string, array → JSON array) round-trip correctly
        // instead of being mangled as a pseudo-record.
        entry.data = data;
      }
    }

    return entry;
  }

  private buildPrefix(level: LogLevel): string {
    const timestamp = new Date().toISOString();
    const contextStr = this.formatContext();
    return `[${timestamp}] [${level.toUpperCase()}] [${this.name}]${contextStr}`;
  }

  private formatContext(): string {
    const parts: string[] = [];
    if (this.correlationId) parts.push(`corr=${this.correlationId.slice(0, 8)}`);
    if (this.context.prNumber) parts.push(`pr#${this.context.prNumber}`);
    if (this.context.repo) parts.push(`${this.context.repo}`);
    if (this.context.eventType) parts.push(`${this.context.eventType}`);
    // correlationId is already rendered as the short `corr=` prefix above;
    // emitting it again from the generic loop would duplicate the trace ID.
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
      return safeJsonStringify(data);
    } catch {
      return String(data);
    }
  }
}

/**
 * Check whether a value is a plain object (Object.prototype or null prototype).
 * Arrays, Date, Map, etc. are not treated as key/value records.
 * @param value - The value to test.
 * @returns True when the value is a plain object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Serialize a value to JSON while safely handling circular references and
 * Error instances (rendered as their stack/message). Only the current ancestry
 * (parent chain) is tracked, so a shared non-circular reference is serialized
 * on each occurrence instead of being misreported as '[Circular]'.
 * @param value - The value to serialize.
 * @returns A JSON string.
 */
function safeJsonStringify(value: unknown): string {
  const ancestors: object[] = [];
  return JSON.stringify(value, function (this: unknown, _key: string, item: unknown) {
    if (typeof item === 'object' && item !== null) {
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
        ancestors.pop();
      }
      if (ancestors.includes(item)) return '[Circular]';
      ancestors.push(item);
      if (item instanceof Error) return item.stack || item.message;
    }
    return item;
  });
}
