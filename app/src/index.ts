import {
  DEFAULT_CONFIG,
  GitHubHelper,
  ReviewEngine,
  getDefaultMCPServers,
} from '@opencode-pr-agent/lib';
import type { AgentConfig, ReviewResult } from '@opencode-pr-agent/lib';
import type { Probot, ProbotOctokit } from 'probot';
import { handleAudit } from './handlers/audit.js';
import { handleAutofixLoop } from './handlers/autofix.js';
import { handleCommand } from './handlers/commands.js';
import { handlePRReview } from './handlers/pr-review.js';

export default (app: Probot): void => {
  app.on(['pull_request.opened', 'pull_request.synchronize'], async (context) => {
    const pr = context.payload.pull_request;
    const repo = context.payload.repository.full_name;
    const token = await getInstallationToken(context);

    if (pr.user.login === 'github-actions[bot]') return;

    const labels = pr.labels?.map((l: { name: string }) => l.name) || [];
    if (labels.some((l: string) => ['autofix', 'autofix:approved', 'autofix:merged'].includes(l))) {
      return;
    }

    const config = buildConfig(context);
    await handlePRReview(pr.number, repo, token, config);
  });

  app.on(['issue_comment.created', 'pull_request_review_comment.created'], async (context) => {
    const comment = context.payload.comment;
    const repo = context.payload.repository.full_name;
    const token = await getInstallationToken(context);
    const payload = context.payload as { issue: { number: number } };
    const issueNumber = payload.issue.number;

    const config = buildConfig(context);

    if (comment.body.includes('/review') || comment.body.includes('/oc')) {
      const gh = new GitHubHelper(token, repo);
      if (await gh.isPR(issueNumber)) {
        await handlePRReview(issueNumber, repo, token, config);
      }
    }

    if (comment.body.includes('/fix')) {
      await handleCommand('fix', issueNumber, repo, token, config);
    }

    if (comment.body.includes('/audit')) {
      await handleAudit(repo, token, config);
    }
  });

  app.on(['issues.labeled'], async (context) => {
    const issue = context.payload.issue;
    const repo = context.payload.repository.full_name;
    const token = await getInstallationToken(context);

    const labels = issue.labels?.map((l: { name: string }) => l.name) || [];
    if (!labels.includes('autofix-trigger')) return;
    if (issue.pull_request) return;

    const config = buildConfig(context);
    await handleCommand('fix', issue.number, repo, token, config);
  });

  app.on(['pull_request.opened', 'pull_request.synchronize'], async (context) => {
    const pr = context.payload.pull_request;
    const repo = context.payload.repository.full_name;
    const token = await getInstallationToken(context);

    const labels = pr.labels?.map((l: { name: string }) => l.name) || [];
    if (!labels.includes('autofix')) return;
    if (
      labels.some((l: string) =>
        ['autofix:approved', 'autofix:needs-manual-review', 'autofix:merged'].includes(l),
      )
    ) {
      return;
    }

    const config = buildConfig(context);
    await handleAutofixLoop(pr.number, repo, token, config);
  });

  console.log('✅ OpenCode PR Agent app loaded');
};

function buildConfig(_context: unknown): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    reviewModel: process.env.REVIEW_MODEL || DEFAULT_CONFIG.reviewModel,
    fixModel: process.env.FIX_MODEL || DEFAULT_CONFIG.fixModel,
    batchSize: Number.parseInt(process.env.BATCH_SIZE || '3', 10),
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
  };
}

async function getInstallationToken(context: {
  octokit: InstanceType<typeof ProbotOctokit>;
}): Promise<string> {
  return (context.octokit as unknown as { token?: string }).token || process.env.GITHUB_TOKEN || '';
}
