import type { AgentConfig } from '@opencode-pr-agent/lib';
import { GitHubHelper, Logger } from '@opencode-pr-agent/lib';
import { handleAudit } from './audit.js';
import { handleAutofixLoop } from './autofix.js';
import { handlePRReview } from './pr-review.js';

export async function handleCommand(
  command: 'fix' | 'review' | 'audit',
  issueNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
): Promise<void> {
  const logger = new Logger('Command', { repo, prNumber: issueNumber });
  const gh = new GitHubHelper(token, repo);

  try {
    switch (command) {
      case 'review': {
        if (await gh.isPR(issueNumber)) {
          await handlePRReview(issueNumber, repo, token, config);
        }
        break;
      }

      case 'fix': {
        const existingPR = await findExistingAutofixPR(gh, issueNumber);
        if (existingPR) {
          await handleAutofixLoop(existingPR, repo, token, config);
        } else {
          await createAutofixPR(gh, issueNumber, repo);
        }
        break;
      }

      case 'audit': {
        await handleAudit(repo, token, config);
        break;
      }
    }
  } catch (err) {
    logger.error(
      `Command ${command} failed for issue ${issueNumber} in ${repo}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

async function findExistingAutofixPR(
  gh: GitHubHelper,
  issueNumber: number,
): Promise<number | null> {
  const logger = new Logger('Command', { prNumber: issueNumber });
  try {
    const issue = await gh.getIssue(issueNumber);
    const prLink = issue.body?.match(/PR #(\d+)/)?.[1];
    if (prLink) return Number.parseInt(prLink, 10);
  } catch (err) {
    logger.debug(
      `Failed to find existing autofix PR for issue ${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
  }
  return null;
}

async function createAutofixPR(
  gh: GitHubHelper,
  issueNumber: number,
  repo: string,
): Promise<void> {
  const logger = new Logger('Command', { repo, prNumber: issueNumber });
  logger.info(`Fix triggered for issue #${issueNumber}`);

  try {
    await gh.ensureLabels(['autofix', 'autofix-trigger', 'autofix:needs-fix']);
  } catch (err) {
    logger.warn(`Failed to ensure autofix labels: ${err instanceof Error ? err.message : err}`);
  }
  await gh.addLabels(issueNumber, ['autofix']);

  logger.info(
    `Fix flow initiated for issue #${issueNumber}. In production, this creates a branch, runs the fix, and opens a PR.`,
  );
}
