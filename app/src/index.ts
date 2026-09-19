import {
  EventBus,
  EventRouter,
  LearningStore,
  Logger,
  MCPManager,
  registerEventSubscribers,
} from '@opencode-pr-agent/lib';
import type { Probot } from 'probot';
import { checkHealthAuthConfig, createHealthRouter } from './health.js';
import { registerSubscribers } from './subscribers/index.js';
import { isBotUser } from './utils/bot.js';
import { buildConfig } from './utils/config.js';
import { type RepoFilter, isRepoAllowed, logRepoFilter, repoFilter } from './utils/repo-filter.js';

const logger = new Logger('App');

/**
 * Shared pre-dispatch gate applied before the EventRouter: payload shape
 * check, bot filter, and repo allowlist gate. New subscribers inherit it
 * instead of each re-implementing bot/rate-limit/repo checks inconsistently.
 * Per-subscriber rate-limit and privilege checks still run inside subscribers.
 * @param payload - Raw webhook payload.
 * @param filter - Optional repo allowlist/denylist override (defaults to the
 * shared process-wide filter). Injectable so tests and runtime config changes
 * do not see a stale import-time singleton.
 * @returns True when the event should be routed.
 *
 * Exported for unit testing.
 */
export function isEventAllowed(payload: unknown, filter: RepoFilter = repoFilter): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  // Bot filter: never spend budget on bot-authored events. Webhook actors can
  // arrive under several shapes depending on the event, so check them all.
  type MaybeUser = { type?: string; login?: string } | undefined;
  const sender = p.sender as MaybeUser;
  const comment = p.comment as { user?: MaybeUser } | undefined;
  const issue = p.issue as { user?: MaybeUser } | undefined;
  const pullRequest = p.pull_request as { user?: MaybeUser } | undefined;
  const review = p.review as { user?: MaybeUser } | undefined;
  if (
    isBotUser(sender) ||
    isBotUser(comment?.user) ||
    isBotUser(issue?.user) ||
    isBotUser(pullRequest?.user) ||
    isBotUser(review?.user)
  )
    return false;
  // Repo allowlist/denylist gate: a denied repo never reaches subscribers.
  // When the payload carries no repository (e.g. synthetic events), let it
  // through so subscribers can decide based on event.repo.
  const repo = (p.repository as { full_name?: string } | undefined)?.full_name;
  if (typeof repo === 'string' && repo.length > 0 && !isRepoAllowed(repo, filter)) {
    return false;
  }
  return true;
}

/**
 * Register process-level resilience handlers so rejected promises and
 * uncaught exceptions outside the onAny guard are observed via structured
 * logs instead of silently destabilizing the Node process.
 *
 * Policy: log-and-continue for `unhandledRejection` (keeps the Probot
 * process observable; orchestrators decide restarts); log-then-exit(1) for
 * `uncaughtException` so the orchestrator restarts a potentially corrupt
 * process (any listener suppresses Node's default crash, so we exit
 * explicitly).
 *
 * Idempotent: safe to call multiple times (e.g. in tests) — handlers are
 * registered once per process.
 */
export function setupGlobalErrorHandlers(): void {
  if (process.listenerCount('unhandledRejection') === 0) {
    process.on('unhandledRejection', (reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      const stack = reason instanceof Error ? reason.stack : undefined;
      logger.error(`Unhandled promise rejection: ${message}${stack ? `\n${stack}` : ''}`);
    });
  }
  if (process.listenerCount('uncaughtException') === 0) {
    process.on('uncaughtException', (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      logger.error(`Uncaught exception: ${message}${stack ? `\n${stack}` : ''}`);
      process.exit(1);
    });
  }
}

/**
 * Initialize the Probot app with event subscribers for review, fix, and audit.
 * Registers all subscribers with the event bus and handles SIGTERM cleanup.
 * Mounts health/readiness probes on the Probot Express router.
 * @param app - The Probot application instance.
 * @param options - Probot app options carrying `getRouter` (Express router access).
 * @param options.getRouter - Function returning an Express Router for HTTP endpoints.
 */
export default (app: Probot, options?: { getRouter?: (path?: string) => unknown }): void => {
  if (!process.env.GITHUB_TOKEN && !process.env.APP_ID) {
    throw new Error('GITHUB_TOKEN or APP_ID must be set for the GitHub App to start');
  }

  const hasProviderKey =
    Boolean(process.env.OPENAI_API_KEY) ||
    Boolean(process.env.INPUT_OPENAI_API_KEY) ||
    Boolean(process.env.ANTHROPIC_API_KEY) ||
    Boolean(process.env.INPUT_ANTHROPIC_API_KEY) ||
    Boolean(process.env.GEMINI_API_KEY) ||
    Boolean(process.env.INPUT_GEMINI_API_KEY) ||
    Boolean(process.env.OPENCODE_API_KEY) ||
    Boolean(process.env.INPUT_OPENCODE_API_KEY);
  if (!hasProviderKey) {
    logger.warn(
      'No AI provider API key found — set at least one of OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENCODE_API_KEY (unless using a default opencode/* model)',
    );
  }

  // Health probes expose component topology when public: require
  // HEALTH_AUTH_TOKEN in production (warns loudly when unset outside
  // development). Infrastructure-only endpoints — see health.ts.
  checkHealthAuthConfig();

  const learningStore = new LearningStore();
  const bus = new EventBus();
  const router = new EventRouter(bus);
  const config = buildConfig();

  // Log which repos the app will / won't process at startup so operators can
  // verify the allowlist/denylist config.
  logRepoFilter(repoFilter);
  const concurrentRuns = Math.max(
    1,
    Number.parseInt(process.env.MAX_CONCURRENT_RUNS ?? '1', 10) || 1,
  );
  logger.info(`Global run concurrency limit: ${concurrentRuns} (MAX_CONCURRENT_RUNS)`);

  // Health/readiness probes for container orchestrators (Kubernetes, Docker
  // Compose). `/health` reports liveness + critical DB reachability;
  // `/ready` additionally requires MCP initialization to have completed.
  const mcpManager = new MCPManager(config.mcpServers);
  const healthRouter = createHealthRouter(learningStore, () => mcpManager.getStatus());
  const appRouter = options?.getRouter?.();
  if (appRouter && typeof (appRouter as { use?: unknown }).use === 'function') {
    // Mount at the root: the health router defines `/health` and `/ready`
    // routes internally, so a `.use('/health', ...)` mount would strip the
    // prefix and make them unreachable (they'd become `/health/health`).
    (appRouter as { use: (p: string, r: unknown) => void }).use('/', healthRouter);
    logger.info(
      'Health endpoints mounted: GET /health, GET /ready, GET /api/v1/health, GET /api/v1/ready',
    );
  } else {
    logger.warn('getRouter() unavailable — health endpoints not mounted');
  }

  const registeredSubscribers = registerSubscribers(bus, learningStore, config);
  logger.info(`Registered ${registeredSubscribers.length} subscribers`);

  // Honor the eventLogging / eventSubscribers config options like the action
  // does; failures are logged so app startup never breaks on bad config.
  registerEventSubscribers(bus, config.eventLogging, config.eventSubscribers)
    .then((extra) => {
      if (extra.length > 0) {
        logger.info(`Registered ${extra.length} event subscriber(s)`);
      }
    })
    .catch((err) => {
      logger.warn(
        `Failed to register event subscribers: ${err instanceof Error ? err.message : err}`,
      );
    });

  app.onAny(async (context) => {
    try {
      // Probot's `context.name` is the bare event name (e.g. `issue_comment`),
      // while the EventRouter maps `issue_comment.created`-style keys. Compose
      // the full `name.action` so routing actually matches subscriber events.
      const payload = context.payload as Record<string, unknown>;
      // Shared validate → bot-filter → repo-allowlist gate before dispatch.
      if (!isEventAllowed(payload)) {
        return;
      }
      const action = typeof payload?.action === 'string' ? payload.action : undefined;
      const eventName = action ? `${context.name}.${action}` : context.name;
      await router.handle(eventName, payload);
    } catch (err) {
      logger.error(
        `Unhandled error in event router for ${context.name}: ${err instanceof Error ? err.message : err}`,
      );
    }
  });

  process.on('SIGTERM', async () => {
    try {
      await learningStore.close();
    } catch (err) {
      logger.warn(
        `LearningStore close failed during SIGTERM shutdown: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    process.exit(0);
  });

  setupGlobalErrorHandlers();

  logger.info('OpenCode PR Agent app loaded (self-improving)');
};
