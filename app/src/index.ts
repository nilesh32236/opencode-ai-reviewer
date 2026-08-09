import {
  EventBus,
  EventRouter,
  LearningStore,
  Logger,
  MCPManager,
  registerEventSubscribers,
} from '@opencode-pr-agent/lib';
import type { Probot } from 'probot';
import { createHealthRouter } from './health.js';
import { registerSubscribers } from './subscribers/index.js';
import { buildConfig } from './utils/config.js';

const logger = new Logger('App');

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

  const learningStore = new LearningStore();
  const bus = new EventBus();
  const router = new EventRouter(bus);
  const config = buildConfig();

  // Health/readiness probes for container orchestrators (Kubernetes, Docker
  // Compose). `/health` reports liveness + critical DB reachability;
  // `/ready` additionally requires MCP initialization to have completed.
  const mcpManager = new MCPManager(config.mcpServers);
  const healthRouter = createHealthRouter(learningStore, () => mcpManager.getStatus());
  const appRouter = options?.getRouter?.();
  if (appRouter && typeof (appRouter as { use?: unknown }).use === 'function') {
    (appRouter as { use: (p: string, r: unknown) => void }).use('/health', healthRouter);
    logger.info('Health endpoints mounted: GET /health, GET /ready');
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
      await router.handle(context.name, context.payload);
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

  logger.info('OpenCode PR Agent app loaded (self-improving)');
};
