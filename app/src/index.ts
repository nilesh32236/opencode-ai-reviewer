import {
  DEFAULT_CONFIG,
  EventBus,
  EventRouter,
  FeedbackSubscriber,
  LearningStore,
  Logger,
  MetaReviewEngine,
  MetaReviewSubscriber,
  PatternDetector,
  RuleApprovalSubscriber,
  getDefaultMCPServers,
} from '@opencode-pr-agent/lib';
import type { AgentConfig, GitHubEvent, Subscriber } from '@opencode-pr-agent/lib';
import type { Probot } from 'probot';
import { handleAudit } from './handlers/audit.js';
import { handleCommand } from './handlers/commands.js';
import { handlePRReview } from './handlers/pr-review.js';

const logger = new Logger('App');

/**
 * Initialize the Probot app with event subscribers for review, fix, and audit.
 * Registers all subscribers with the event bus and handles SIGTERM cleanup.
 * @param app - The Probot application instance.
 */
export default (app: Probot): void => {
  const learningStore = new LearningStore();
  const bus = new EventBus();
  const router = new EventRouter(bus);

  const subscribers: Subscriber[] = [];

  const reviewSubscriber: Subscriber = {
    name: 'ReviewSubscriber',
    subscribedEvents: ['pr.opened', 'pr.synchronize', 'comment.created', 'review_comment.created'],
    async handle(event: GitHubEvent) {
      try {
        if (event.type === 'comment.created' || event.type === 'review_comment.created') {
          const evPayload = event.payload as Record<string, unknown>;
          const commentBody = (evPayload.comment as Record<string, string> | undefined)?.body;
          if (!commentBody?.includes('/review') && !commentBody?.includes('/oc')) return;
        }

        const evPayload = event.payload as Record<string, unknown>;
        const pullRequest = evPayload.pull_request as Record<string, unknown> | undefined;
        const prUser = pullRequest?.user as Record<string, string> | undefined;
        const prLabels = pullRequest?.labels as Array<Record<string, string>> | undefined;

        if (event.type === 'pr.opened' || event.type === 'pr.synchronize') {
          if (prUser?.login === 'github-actions[bot]') return;
          const labels = prLabels?.map((l) => l.name) || [];
          if (labels.some((l) => ['autofix', 'autofix:approved', 'autofix:merged'].includes(l)))
            return;
        }

        const config = buildConfig();
        const prNumber = event.prNumber || 0;
        if (!prNumber) return;

        const result = await handlePRReview(
          prNumber,
          event.repo || '',
          getToken(),
          config,
          learningStore,
        );
        if (result) {
          try {
            await bus.publish({
              type: 'review.completed',
              category: 'internal',
              payload: {
                prNumber: event.prNumber || 0,
                reviewSummary: result.summary,
                findingsCount: result.issues.length + result.strengths.length,
                issuesCount: result.issues.length,
                strengthsCount: result.strengths.length,
                hasVerdict: !!result.verdict.reasoning,
                fileCount: new Set(result.issues.map((i) => i.file).filter(Boolean)).size,
              },
              timestamp: Date.now(),
              repo: event.repo,
              prNumber: event.prNumber || 0,
            });
          } catch (err) {
            logger.error(
              `Failed to publish review.completed event: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      } catch (err) {
        logger.error(`ReviewSubscriber failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  };

  const fixSubscriber: Subscriber = {
    name: 'FixSubscriber',
    subscribedEvents: ['comment.created', 'review_comment.created', 'issue.labeled'],
    async handle(event: GitHubEvent) {
      try {
        const fixPayload = event.payload as Record<string, unknown>;
        const fixComment = fixPayload.comment as Record<string, string> | undefined;
        const fixIssue = fixPayload.issue as Record<string, unknown> | undefined;
        const fixLabels = fixPayload.labels as Array<Record<string, string>> | undefined;

        if (event.type === 'comment.created' || event.type === 'review_comment.created') {
          if (!fixComment?.body?.includes('/fix')) return;
        }

        if (event.type === 'issue.labeled') {
          const labels = fixLabels?.map((l) => l.name) || [];
          if (!labels.includes('autofix-trigger')) return;
          if (fixIssue?.pull_request) return;
        }

        const config = buildConfig();
        const prNumber = event.prNumber || 0;
        if (!prNumber) return;

        await handleCommand('fix', prNumber, event.repo || '', getToken(), config);
      } catch (err) {
        logger.error(
          `FixSubscriber failed for repo ${event.repo}, prNumber ${event.prNumber}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };

  const auditSubscriber: Subscriber = {
    name: 'AuditSubscriber',
    subscribedEvents: ['comment.created', 'review_comment.created'],
    async handle(event: GitHubEvent) {
      try {
        const auditPayload = event.payload as Record<string, unknown>;
        const auditComment = auditPayload.comment as Record<string, string> | undefined;
        if (!auditComment?.body?.includes('/audit')) return;
        const config = buildConfig();
        await handleAudit(event.repo || '', getToken(), config);
      } catch (err) {
        logger.error(
          `AuditSubscriber failed for repo ${event.repo}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };

  subscribers.push(reviewSubscriber, fixSubscriber, auditSubscriber);

  const feedbackSub = new FeedbackSubscriber(learningStore);
  subscribers.push(feedbackSub);

  const patternDetector = new PatternDetector(learningStore, {
    windowSize: DEFAULT_CONFIG.learning.patternDiscovery.windowSize,
  });
  const metaReviewEngine = new MetaReviewEngine(learningStore, patternDetector);
  const metaReviewSub = new MetaReviewSubscriber(
    metaReviewEngine,
    learningStore,
    DEFAULT_CONFIG.learning.metaReview.interval,
  );
  subscribers.push(metaReviewSub);

  const ruleApprovalSub = new RuleApprovalSubscriber(learningStore);
  subscribers.push(ruleApprovalSub);

  bus.registerAll(subscribers);

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

/**
 * Get the GitHub token from the environment.
 * @returns The GitHub token string.
 */
function getToken(): string {
  const token = process.env.GITHUB_TOKEN || '';
  if (!token) {
    throw new Error('GITHUB_TOKEN is not set — all GitHub API calls will fail with 401');
  }
  return token;
}

/**
 * Build the agent configuration from environment variables and defaults.
 * @returns A fully populated AgentConfig object.
 */
function buildConfig(): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    reviewModel: process.env.REVIEW_MODEL || DEFAULT_CONFIG.reviewModel,
    fixModel: process.env.FIX_MODEL || DEFAULT_CONFIG.fixModel,
    batchSize: Number.parseInt(process.env.BATCH_SIZE || '3', 10),
    maxLinesPerFile: Number.parseInt(process.env.MAX_LINES_PER_FILE || '200', 10),
    maxIterations: Number.parseInt(process.env.MAX_ITERATIONS || '3', 10),
    enableMCP: process.env.ENABLE_MCP !== 'false',
    mcpServers:
      process.env.ENABLE_MCP !== 'false'
        ? getDefaultMCPServers(process.env.GITHUB_TOKEN || '')
        : [],
    projectContext: {
      description: process.env.PROJECT_DESCRIPTION || '',
      conventionsPath: process.env.CONVENTIONS_PATH || undefined,
      typecheckCommands: process.env.TYPECHECK_COMMANDS
        ? process.env.TYPECHECK_COMMANDS.split(',')
        : [],
      lintCommands: process.env.LINT_COMMANDS ? process.env.LINT_COMMANDS.split(',') : [],
    },
    review: {
      ...DEFAULT_CONFIG.review,
      inline: process.env.REVIEW_INLINE !== 'false',
    },
    learning: {
      enabled: true,
      feedbackSignals: ['dismissed', 'reaction', 'disputed_comment'],
      metaReview: { enabled: true, interval: 5, minFindingsForReview: 3 },
      patternDiscovery: { enabled: true, minFrequency: 3, windowSize: 100 },
    },
  };
}
