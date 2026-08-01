import * as path from 'node:path';
import type { EventLoggingConfig, PluggableSubscriberConfig, Subscriber } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import type { EventBus } from './bus.js';
import { LoggingSubscriber } from './logging-subscriber.js';

const logger = new Logger('EventSubscribers');

/**
 * Resolve a configured subscriber module path to an absolute path that must
 * live inside the working directory (the repo checkout). Relative paths are
 * resolved against `process.cwd()`, and absolute paths that escape the checkout
 * are rejected so a hostile repository cannot load arbitrary code into the
 * runner via `eventSubscribers`.
 * @param modulePath - Configured module path (relative or absolute).
 * @returns The resolved absolute path, or null when it escapes the checkout.
 */
function resolveSubscriberModulePath(modulePath: string): string | null {
  const cwd = process.cwd();
  const resolved = path.isAbsolute(modulePath) ? modulePath : path.resolve(cwd, modulePath);
  const rel = path.relative(cwd, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    logger.warn(`Refusing to load event subscriber outside the working directory: ${modulePath}`);
    return null;
  }
  return resolved;
}

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
    if (
      candidate &&
      typeof candidate.handle === 'function' &&
      Array.isArray(candidate.subscribedEvents)
    ) {
      return candidate as Subscriber;
    }
    if (typeof mod.createSubscriber === 'function') {
      const created = await mod.createSubscriber();
      if (
        created &&
        typeof created.handle === 'function' &&
        Array.isArray(created.subscribedEvents)
      ) {
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
 *
 * Pluggable subscribers are treated as trusted first-party configuration: their
 * module paths must resolve inside the working directory (the repo checkout).
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

  const seenPaths = new Set<string>();
  for (const entry of subscriberConfigs) {
    const resolvedPath = resolveSubscriberModulePath(entry.path);
    if (!resolvedPath) {
      logger.warn(`Skipping event subscriber "${entry.name}": invalid path ${entry.path}`);
      continue;
    }
    if (seenPaths.has(resolvedPath)) {
      logger.warn(
        `Skipping duplicate event subscriber "${entry.name}": ${entry.path} already registered`,
      );
      continue;
    }
    seenPaths.add(resolvedPath);

    const sub = await resolveSubscriberModule(resolvedPath);
    if (!sub) {
      logger.warn(`Skipping event subscriber "${entry.name}": could not load ${entry.path}`);
      continue;
    }

    // Never mutate the object returned by dynamic import() — Node caches imports,
    // so writing sub.name would leak into the shared module namespace (and throw
    // for frozen ESM namespaces). Build a copy preserving the prototype chain
    // instead, carrying the configured display name.
    let named: Subscriber = sub;
    if (!sub.name || sub.name === '') {
      named = Object.assign(Object.create(Object.getPrototypeOf(sub) as object), sub, {
        name: entry.name,
      }) as Subscriber;
    }
    bus.register(named);
    registered.push(named);
    logger.info(`Registered event subscriber "${named.name}" from ${entry.path}`);
  }

  return registered;
}
