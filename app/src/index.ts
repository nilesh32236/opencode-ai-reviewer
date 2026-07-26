import {
  DEFAULT_CONFIG,
  EventBus,
  EventRouter,
  FeedbackSubscriber,
  GitHubHelper,
  LearningStore,
  Logger,
  MetaReviewEngine,
  MetaReviewSubscriber,
  PatternDetector,
  RuleApprovalSubscriber,
  getDefaultMCPServers,
  parseCommand,
} from '@opencode-pr-agent/lib';
import type { AgentConfig, GitHubEvent, Subscriber } from '@opencode-pr-agent/lib';
import type { Probot } from 'probot';
import { handleAudit } from './handlers/audit.js';
import { handleCommand } from './handlers/commands.js';
import { handleConversation } from './handlers/conversation.js';
import { handlePRReview } from './handlers/pr-review.js';
import { handleReply } from './handlers/reply.js';

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

  const learningStore = new LearningStore();
  const bus = new EventBus();
  const router = new EventRouter(bus);

  const subscribers: Subscriber[] = [];

  const reviewSubscriber: Subscriber = {
    name: 'ReviewSubscriber',
    subscribedEvents: ['pr.opened', 'pr.synchronize', 'comment.created', 'review_comment.created'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        if (event.type === 'comment.created' || event.type === 'review_comment.created') {
          const evPayload = event.payload as Record<string, unknown>;
          const commentBody = (evPayload.comment as Record<string, string> | undefined)?.body;
          const parsed = commentBody ? parseCommand(commentBody) : null;
          if (!parsed || parsed.command !== 'review') return;
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

        const previousHeadSha =
          event.type === 'pr.synchronize'
            ? (evPayload.before as string) ||
              ((evPayload.pull_request as Record<string, unknown> | undefined)?.before as string)
            : undefined;

        const result = await handlePRReview(
          prNumber,
          event.repo || '',
          getToken(),
          config,
          learningStore,
          undefined,
          previousHeadSha,
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
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const fixPayload = event.payload as Record<string, unknown>;
        const fixComment = fixPayload.comment as Record<string, string> | undefined;
        const fixIssue = fixPayload.issue as Record<string, unknown> | undefined;
        const fixLabels = fixPayload.labels as Array<Record<string, string>> | undefined;

        if (event.type === 'comment.created' || event.type === 'review_comment.created') {
          const parsed = fixComment?.body ? parseCommand(fixComment.body) : null;
          if (!parsed || parsed.command !== 'fix') return;
        }

        if (event.type === 'issue.labeled') {
          const labels = fixLabels?.map((l) => l.name) || [];
          if (!labels.includes('autofix-trigger')) return;
          if (fixIssue?.pull_request) return;
        }

        const config = buildConfig();
        const prNumber = event.prNumber || 0;
        if (!prNumber) return;

        await handleCommand('fix', prNumber, event.repo || '', getToken(), config, signal);
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
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const auditPayload = event.payload as Record<string, unknown>;
        const auditComment = auditPayload.comment as Record<string, string> | undefined;
        const parsed = auditComment?.body ? parseCommand(auditComment.body) : null;
        if (!parsed || parsed.command !== 'audit') return;
        const config = buildConfig();
        await handleAudit(event.repo || '', getToken(), config);
      } catch (err) {
        logger.error(
          `AuditSubscriber failed for repo ${event.repo}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };

  const analyzeSubscriber: Subscriber = {
    name: 'AnalyzeSubscriber',
    subscribedEvents: ['comment.created', 'review_comment.created'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const analyzePayload = event.payload as Record<string, unknown>;
        const analyzeComment = analyzePayload.comment as Record<string, string> | undefined;
        const parsed = analyzeComment?.body ? parseCommand(analyzeComment.body) : null;
        if (!parsed || parsed.command !== 'analyze') return;
        const config = buildConfig();
        const issueNumber = event.prNumber || 0;
        if (!issueNumber) return;
        await handleCommand('analyze', issueNumber, event.repo || '', getToken(), config);
      } catch (err) {
        logger.error(
          `AnalyzeSubscriber failed for repo ${event.repo}, prNumber ${event.prNumber}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };

  const replySubscriber: Subscriber = {
    name: 'ReplySubscriber',
    subscribedEvents: ['review_comment.created'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const payload = event.payload as Record<string, unknown>;
        const comment = payload.comment as Record<string, unknown> | undefined;
        if (!comment) return;

        // Skip bot-generated comments
        const user = comment.user as Record<string, unknown> | undefined;
        if (user?.type === 'Bot') return;

        // Must be a reply in a thread (not a top-level comment)
        const parentId = comment.in_reply_to_id as number | undefined;
        if (!parentId) return;

        const prNumber = event.prNumber || 0;
        if (!prNumber) return;

        const config = buildConfig();
        const { handleReply } = await import('./handlers/reply.js');
        await handleReply(
          prNumber,
          event.repo || '',
          getToken(),
          config,
          parentId,
          comment.body as string,
        );
      } catch (err) {
        logger.error(`ReplySubscriber failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  };

  const explainSubscriber: Subscriber = {
    name: 'ExplainSubscriber',
    subscribedEvents: ['comment.created', 'review_comment.created'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const payload = event.payload as Record<string, unknown>;
        const comment = payload.comment as Record<string, string> | undefined;
        const parsed = comment?.body ? parseCommand(comment.body) : null;
        if (!parsed || parsed.command !== 'explain') return;
        const config = buildConfig();
        const issueNumber = event.prNumber || 0;
        if (!issueNumber) return;
        await handleCommand('explain', issueNumber, event.repo || '', getToken(), config);
      } catch (err) {
        logger.error(
          `ExplainSubscriber failed for repo ${event.repo}, prNumber ${event.prNumber}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };

  const conversationSubscriber: Subscriber = {
    name: 'ConversationSubscriber',
    subscribedEvents: ['comment.created', 'review_comment.created'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const convPayload = event.payload as Record<string, unknown>;
        const convComment = convPayload.comment as Record<string, unknown> | undefined;
        const convBody = (convComment?.body as string) || '';
        const convUser = (convComment?.user as Record<string, string>)?.login || '';

        const config = buildConfig();
        const mentionHandle = config.conversation.mentionHandle;

        // Check if comment mentions our handle
        if (!convBody.toLowerCase().includes(`@${mentionHandle.toLowerCase()}`)) return;

        // Prevent infinite loops — don't respond to our own comments
        if (
          convUser.includes('[bot]') ||
          convUser.includes('github-actions') ||
          convUser.toLowerCase().includes(mentionHandle.toLowerCase())
        ) {
          return;
        }

        if (!config.conversation.enabled) return;

        const prNumber = event.prNumber || 0;
        if (!prNumber) return;

        const commentId = (convComment?.id as number) || 0;
        if (!commentId) return;

        const isReviewComment = event.type === 'review_comment.created';

        await handleConversation(
          commentId,
          prNumber,
          event.repo || '',
          getToken(),
          config,
          isReviewComment,
          learningStore,
          signal,
        );
      } catch (err) {
        logger.error(
          `ConversationSubscriber failed for repo ${event.repo}: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };

  const autoAnalyzeSubscriber: Subscriber = {
    name: 'AutoAnalyzeSubscriber',
    subscribedEvents: ['issue.opened'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const payload = event.payload as Record<string, unknown>;
        const issue = payload.issue as Record<string, unknown> | undefined;
        if (!issue) return;
        if (issue.pull_request) return;

        const user = issue.user as Record<string, string> | undefined;
        if (user?.type === 'Bot') return;

        const issueNumber = (issue.number as number) || 0;
        if (!issueNumber) return;

        const config = buildConfig();
        await handleCommand('analyze', issueNumber, event.repo || '', getToken(), config, signal);
      } catch (err) {
        logger.error(`AutoAnalyzeSubscriber failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  };

  const questionAnsweredSubscriber: Subscriber = {
    name: 'QuestionAnsweredSubscriber',
    subscribedEvents: ['comment.created'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const payload = event.payload as Record<string, unknown>;
        const comment = payload.comment as Record<string, unknown> | undefined;
        const issue = payload.issue as Record<string, unknown> | undefined;

        if (!comment || !issue) return;
        if (issue.pull_request) return;
        const user = comment.user as Record<string, string> | undefined;
        if (user?.type === 'Bot') return;

        const labels = (issue.labels as Array<Record<string, string>>)?.map((l) => l.name) ?? [];
        if (!labels.includes('analysis:needs-input')) return;

        const issueNumber = (issue.number as number) || 0;
        if (!issueNumber) return;

        const _config = buildConfig();
        const gh = new GitHubHelper(getToken(), event.repo || '');

        await gh.setLabels(issueNumber, ['analysis:ready'], ['analysis:needs-input']);
        await gh.postOrUpdateComment(
          issueNumber,
          '<!-- analysis-answers-received -->',
          '✅ **Answers received.** You can now comment `/fix` to start the implementation.',
        );

        logger.info(`Received answers for issue #${issueNumber} — marked as analysis:ready`);
      } catch (err) {
        logger.error(
          `QuestionAnsweredSubscriber failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  };

  subscribers.push(
    reviewSubscriber,
    fixSubscriber,
    auditSubscriber,
    analyzeSubscriber,
    autoAnalyzeSubscriber,
    questionAnsweredSubscriber,
    replySubscriber,
    explainSubscriber,
    conversationSubscriber,
  );

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

  const discoverSubscriber: Subscriber = {
    name: 'DiscoverSubscriber',
    subscribedEvents: ['comment.created', 'review_comment.created'],
    async handle(event: GitHubEvent, signal?: AbortSignal) {
      if (signal?.aborted) return;
      try {
        const payload = event.payload as Record<string, unknown>;
        const comment = payload.comment as Record<string, string> | undefined;
        const parsed = comment?.body ? parseCommand(comment.body) : null;
        if (!parsed || parsed.command !== 'discover') return;

        const issueNumber = event.prNumber || 0;
        if (!issueNumber) return;
        if (!learningStore) return;

        const detector = new PatternDetector(learningStore);
        const patterns = await detector.discover(2);

        const gh = new GitHubHelper(getToken(), event.repo || '');

        let body = '## 🔍 Discovered Patterns\n\n';
        if (patterns.length === 0) {
          body += 'No recurring patterns found in recent reviews.';
        } else {
          body += 'The following recurring review patterns were discovered:\n\n';
          for (const p of patterns) {
            body += `- **Pattern:** ${p.patternKey}\n  - Frequency: ${p.frequency}\n  - File types: ${p.fileTypes.join(', ')}\n\n`;
          }
        }

        await gh.postOrUpdateComment(issueNumber, '<!-- discovered-patterns -->', body);
      } catch (err) {
        logger.error(`DiscoverSubscriber failed: ${err instanceof Error ? err.message : err}`);
      }
    },
  };
  subscribers.push(discoverSubscriber);

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
 * @param envVar - Environment variable value (may be undefined).
 * @param fallback - Default value if envVar is not set or not a valid integer.
 * @returns The parsed integer or the fallback value.
 */
function parseEnvInt(envVar: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(envVar || String(fallback), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function buildConfig(): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    reviewModel: process.env.REVIEW_MODEL || DEFAULT_CONFIG.reviewModel,
    fixModel: process.env.FIX_MODEL || DEFAULT_CONFIG.fixModel,
    batchSize: parseEnvInt(process.env.BATCH_SIZE, 3),
    maxLinesPerFile: parseEnvInt(process.env.MAX_LINES_PER_FILE, 200),
    maxIterations: parseEnvInt(process.env.MAX_ITERATIONS, 3),
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
      ...DEFAULT_CONFIG.learning,
      enabled: true,
      feedbackSignals: ['dismissed', 'reaction', 'disputed_comment'],
      metaReview: { enabled: true, interval: 5, minFindingsForReview: 3 },
      patternDiscovery: { enabled: true, minFrequency: 3, windowSize: 100 },
    },
  };
}
