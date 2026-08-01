import * as path from 'node:path';
import type { EventLoggingConfig, PluggableSubscriberConfig, Subscriber } from '../types/index.js';
import { Logger } from '../utils/logger.js';
import type { EventBus } from './bus.js';
import { LoggingSubscriber } from './logging-subscriber.js';

const logger = new Logger('EventSubscribers');

/**
 * Options controlling which event subscribers may be registered.
 */
export interface RegisterEventSubscribersOptions {
  /**
   * Whether pluggable subscribers declared in `eventSubscribers` may be
   * loaded and executed. Pluggable modules are arbitrary code: loading them
   * from repo-controlled config (as the GitHub Action does when it reads
   * `.opencode-reviewer.yml` from an untrusted PR checkout) would let a
   * hostile PR run code on the runner. Callers must therefore opt in
   * explicitly — e.g. gated behind an operator-set env var — for pluggable
   * subscribers to be registered. The built-in LoggingSubscriber is always
   * safe and is not affected by this flag.
   */
  allowPluggable?: boolean;
}

/**
 * Resolve a configured subscriber module path to an absolute path that must
 * live inside the working directory. Relative paths are resolved against
 * `process.cwd()` and absolute paths that escape the working directory are
 * rejected.
 *
 * NOTE: confining paths to the working directory is NOT a security boundary —
 * in the GitHub Action the working directory IS the untrusted repo checkout,
 * so a repo can ship and load arbitrary modules. Loading pluggable modules is
 * therefore gated behind the `allowPluggable` opt-in flag, which must only be
 * set from operator-controlled configuration (env vars / action inputs), never
 * from repo-controlled config.
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
 * Pluggable subscribers are arbitrary code, so they are only loaded when the
 * caller explicitly opts in via `options.allowPluggable`. See
 * {@link RegisterEventSubscribersOptions} for the security rationale. When
 * pluggable subscribers are configured but not allowed, they are skipped with
 * a warning and only the built-in logging subscriber is registered.
 * @param bus - The event bus to register subscribers on.
 * @param eventLogging - Event logging config controlling the LoggingSubscriber.
 * @param eventSubscribers - Pluggable subscriber config entries to load.
 * @param options - Options controlling which subscribers may be loaded.
 * @returns The list of subscribers that were successfully registered.
 */
export async function registerEventSubscribers(
  bus: EventBus,
  eventLogging?: EventLoggingConfig,
  eventSubscribers?: PluggableSubscriberConfig[],
  options?: RegisterEventSubscribersOptions,
): Promise<Subscriber[]> {
  const registered: Subscriber[] = [];
  const loggingConfig: EventLoggingConfig = eventLogging ?? { enabled: false };
  const subscriberConfigs: PluggableSubscriberConfig[] = eventSubscribers ?? [];
  const allowPluggable = options?.allowPluggable === true;

  if (loggingConfig.enabled) {
    const logPath = loggingConfig.path ?? '.opencode/events.ndjson';
    const loggingSub = new LoggingSubscriber(logPath);
    bus.register(loggingSub);
    registered.push(loggingSub);
    logger.info(`Registered LoggingSubscriber (path: ${logPath})`);
  }

  if (subscriberConfigs.length > 0 && !allowPluggable) {
    logger.warn(
      `Skipping ${subscriberConfigs.length} pluggable event subscriber(s): pluggable subscribers require explicit opt-in via an operator-controlled setting`,
    );
    return registered;
  }

  const seenPaths = new Set<string>();
  for (const entry of subscriberConfigs) {
    const displayName = entry.name && entry.name.trim() !== '' ? entry.name : '<anonymous>';
    if (typeof entry.path !== 'string' || entry.path.trim() === '') {
      logger.warn(
        `Skipping event subscriber "${displayName}": missing or empty path ${String(entry.path)}`,
      );
      continue;
    }
    const resolvedPath = resolveSubscriberModulePath(entry.path);
    if (!resolvedPath) {
      logger.warn(`Skipping event subscriber "${displayName}": invalid path ${entry.path}`);
      continue;
    }
    if (seenPaths.has(resolvedPath)) {
      logger.warn(
        `Skipping duplicate event subscriber "${displayName}": ${entry.path} already registered`,
      );
      continue;
    }
    seenPaths.add(resolvedPath);

    const sub = await resolveSubscriberModule(resolvedPath);
    if (!sub) {
      logger.warn(`Skipping event subscriber "${displayName}": could not load ${entry.path}`);
      continue;
    }

    // Never mutate the object returned by dynamic import() — Node caches imports,
    // so writing sub.name would leak into the shared module namespace (and throw
    // for frozen ESM namespaces). Build a copy preserving the prototype chain
    // instead, carrying the configured display name.
    let named: Subscriber = sub;
    if (!sub.name || sub.name === '') {
      named = Object.assign(Object.create(Object.getPrototypeOf(sub) as object), sub, {
        name: displayName,
      }) as Subscriber;
    }
    bus.register(named);
    registered.push(named);
    logger.info(`Registered event subscriber "${named.name}" from ${entry.path}`);
  }

  return registered;
}
