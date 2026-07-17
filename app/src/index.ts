import {
  DEFAULT_CONFIG,
  EventBus,
  EventRouter,
  FeedbackSubscriber,
  LearningStore,
  MetaReviewEngine,
  MetaReviewSubscriber,
  getDefaultMCPServers,
} from '@opencode-pr-agent/lib';
import type { AgentConfig, GitHubEvent, Subscriber } from '@opencode-pr-agent/lib';
import type { Probot } from 'probot';
import { handleAudit } from './handlers/audit.js';
import { handleCommand } from './handlers/commands.js';
import { handlePRReview } from './handlers/pr-review.js';

export default (app: Probot): void => {
  const learningStore = new LearningStore();
  const bus = new EventBus();
  const router = new EventRouter(bus);

  const subscribers: Subscriber[] = [];

  const reviewSubscriber: Subscriber = {
    name: 'ReviewSubscriber',
    subscribedEvents: ['pr.opened', 'pr.synchronize', 'comment.created'],
    async handle(event: GitHubEvent) {
      if (event.type === 'comment.created') {
        const payload = event.payload as { body?: string; issue?: { number: number } };
        if (!payload.body?.includes('/review') && !payload.body?.includes('/oc')) return;
      }

      const payload = event.payload as {
        pull_request?: { user?: { login: string }; labels?: Array<{ name: string }> };
        issue?: { number: number };
      };

      if (event.type === 'pr.opened' || event.type === 'pr.synchronize') {
        if (payload.pull_request?.user?.login === 'github-actions[bot]') return;
        const labels = payload.pull_request?.labels?.map((l) => l.name) || [];
        if (labels.some((l) => ['autofix', 'autofix:approved', 'autofix:merged'].includes(l)))
          return;
      }

      const config = buildConfig();
      const prNumber = event.prNumber || 0;
      if (!prNumber) return;

      await handlePRReview(prNumber, event.repo || '', getToken(), config);

      await bus.publish({
        type: 'review.completed',
        category: 'internal',
        payload: {
          prNumber,
          reviewSummary: '',
          findingsCount: 0,
          issuesCount: 0,
          strengthsCount: 0,
          hasVerdict: true,
          fileCount: 0,
        },
        timestamp: Date.now(),
        repo: event.repo,
        prNumber,
      });
    },
  };

  const fixSubscriber: Subscriber = {
    name: 'FixSubscriber',
    subscribedEvents: ['comment.created', 'issue.labeled'],
    async handle(event: GitHubEvent) {
      const payload = event.payload as {
        body?: string;
        issue?: { number: number };
        labels?: Array<{ name: string }>;
      };

      if (event.type === 'comment.created') {
        if (!payload.body?.includes('/fix')) return;
      }

      if (event.type === 'issue.labeled') {
        const labels = payload.labels?.map((l) => l.name) || [];
        if (!labels.includes('autofix-trigger')) return;
        const issuePayload = event.payload as { issue?: { pull_request?: unknown } };
        if (issuePayload.issue?.pull_request) return;
      }

      const config = buildConfig();
      const prNumber = event.prNumber || 0;
      if (!prNumber) return;

      await handleCommand('fix', prNumber, event.repo || '', getToken(), config);
    },
  };

  const auditSubscriber: Subscriber = {
    name: 'AuditSubscriber',
    subscribedEvents: ['comment.created'],
    async handle(event: GitHubEvent) {
      const payload = event.payload as { body?: string };
      if (!payload.body?.includes('/audit')) return;
      const config = buildConfig();
      await handleAudit(event.repo || '', getToken(), config);
    },
  };

  subscribers.push(reviewSubscriber, fixSubscriber, auditSubscriber);

  const feedbackSub = new FeedbackSubscriber(learningStore);
  subscribers.push(feedbackSub);

  const metaReviewEngine = new MetaReviewEngine(learningStore);
  const metaReviewSub = new MetaReviewSubscriber(
    metaReviewEngine,
    learningStore,
    DEFAULT_CONFIG.learning.metaReview.interval,
  );
  subscribers.push(metaReviewSub);

  bus.registerAll(subscribers);

  app.onAny(async (context) => {
    await router.handle(context.name, context.payload);
  });

  process.on('SIGTERM', async () => {
    await learningStore.close();
  });

  console.log('✅ OpenCode PR Agent app loaded (self-improving)');
};

function getToken(): string {
  return process.env.GITHUB_TOKEN || '';
}

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
    learning: {
      enabled: true,
      feedbackSignals: ['dismissed', 'reaction', 'disputed_comment'],
      metaReview: { enabled: true, interval: 5, minFindingsForReview: 3 },
      patternDiscovery: { enabled: true, minFrequency: 3, windowSize: 100 },
    },
  };
}
