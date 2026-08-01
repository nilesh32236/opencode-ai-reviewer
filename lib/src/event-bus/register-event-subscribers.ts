import type { EventLoggingConfig, PluggableSubscriberConfig, Subscriber } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import type { EventBus } from './bus.js';
import { LoggingSubscriber } from './logging-subscriber.js';

const logger = new Logger('EventSubscribers');

/**
 * Load a subscriber object from a dynamically imported module.
 * Accepts modules that export a `Subscriber`, a `subscriber` field, or a
 * `createSubscriber` factory function. Returns null when the module cannot be
 * loaded or does not expose a usable subscriber.
 * @param modulePath - Absolute path or module specifier to load.
 * @returns The resolved subscriber, or null when unsupported.
 */
async function resolveSubscriberModule(modulePath: string): Promise<Subscriber | null> {
  try {
    const mod = await import(modulePath);
    const candidate = mod.default ?? mod.subscriber ?? mod;
    if (candidate && typeof candidate.handle === 'function' && Array.isArray(candidate.subscribedEvents)) {
      return candidate as Subscriber;
    }
    if (typeof mod.createSubscriber === 'function') {
      const created = await mod.createSubscriber();
      if (created && typeof created.handle === 'function' && Array.isArray(created.subscribedEvents)) {
        return created as Subscriber;
      }
    }
  } catch (err) {
    logger.warn(
      `Failed to load event subscriber module ${modulePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return null;
}

/**
 * Register the built-in logging subscriber (when enabled) plus any pluggable
 * subscribers declared in `eventSubscribers` on the given event bus.
 * @param bus - The event bus to register subscribers on.
 * @param eventLogging - Event logging config controlling the LoggingSubscriber.
 * @param eventSubscribers - Pluggable subscriber config entries to load.
 * @returns The list of subscribers that were successfully registered.
 */
export async function registerEventSubscribers(
  bus: EventBus,
  eventLogging?: EventLoggingConfig,
  eventSubscribers?: PluggableSubscriberConfig[],
): Promise<Subscriber[]> {
  const registered: Subscriber[] = [];
  const loggingConfig: EventLoggingConfig = eventLogging ?? { enabled: false };
  const subscriberConfigs: PluggableSubscriberConfig[] = eventSubscribers ?? [];

  if (loggingConfig.enabled) {
    const logPath = loggingConfig.path ?? '.opencode/events.ndjson';
    const loggingSub = new LoggingSubscriber(logPath);
    bus.register(loggingSub);
    registered.push(loggingSub);
    logger.info(`Registered LoggingSubscriber (path: ${logPath})`);
  }

  for (const entry of subscriberConfigs) {
    const sub = await resolveSubscriberModule(entry.path);
    if (!sub) {
      logger.warn(`Skipping event subscriber "${entry.name}": could not load ${entry.path}`);
      continue;
    }
    if (sub.name === undefined || sub.name === '') {
      sub.name = entry.name;
    }
    bus.register(sub);
    registered.push(sub);
    logger.info(`Registered event subscriber "${sub.name}" from ${entry.path}`);
  }

  return registered;
}
