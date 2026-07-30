import { EventBus, EventRouter, LearningStore, Logger } from '@opencode-pr-agent/lib';
import type { Probot } from 'probot';
import { registerSubscribers } from './subscribers/index.js';
import { buildConfig } from './utils/config.js';

const logger = new Logger('App');

/**
 * Initialize the Probot app with event subscribers for review, fix, and audit.
 * Registers all subscribers with the event bus and handles SIGTERM cleanup.
 * @param app - The Probot application instance.
 */
export default (app: Probot): void => {
  if (!process.env.GITHUB_TOKEN && !process.env.APP_ID) {
    throw new Error('GITHUB_TOKEN or APP_ID must be set for the GitHub App to start');
  }

  const config = buildConfig();
  const learningStore = new LearningStore();
  const bus = new EventBus();
  const router = new EventRouter(bus);

  registerSubscribers(bus, learningStore, config);

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
