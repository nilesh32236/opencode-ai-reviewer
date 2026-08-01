import { promises as fs } from 'fs';
import * as path from 'path';
import type { GitHubEvent, Subscriber } from '../types/index.js';
import { Logger } from '../utils/logger.js';

/**
 * Subscriber that writes every published event to a JSONL file for auditability.
 * Listens on the wildcard `*` event type so it captures all internal events
 * (pipeline lifecycle, config changes, errors) as well as external webhook events.
 *
 * Opt-in: only registered when `eventLogging.enabled` is true.
 */
export class LoggingSubscriber implements Subscriber {
  name = 'LoggingSubscriber';
  subscribedEvents = ['*'];

  private logger = new Logger('LoggingSubscriber');

  /**
   * @param logPath - Absolute or relative path to the JSONL event log file.
   */
  constructor(private readonly logPath: string) {}

  /**
   * Append a single event as a JSON line to the event log.
   * @param event - The event to write.
   */
  async handle(event: GitHubEvent): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.logPath), { recursive: true });
      await fs.appendFile(this.logPath, `${JSON.stringify(event)}\n`, 'utf-8');
    } catch (err) {
      this.logger.warn(
        `Failed to write event to ${this.logPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
