import type { AgentConfig } from '@opencode-pr-agent/lib';
import { GitHubHelper } from '@opencode-pr-agent/lib';
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
          await createAutofixPR(gh, issueNumber, repo, token, config);
        }
        break;
      }

      case 'audit': {
        await handleAudit(repo, token, config);
        break;
      }
    }
  } catch (err) {
    console.error(
      `Command ${command} failed for issue ${issueNumber} in ${repo}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

async function findExistingAutofixPR(
  gh: GitHubHelper,
  issueNumber: number,
): Promise<number | null> {
  try {
    const issue = await gh.getIssue(issueNumber);
    const prLink = issue.body?.match(/PR #(\d+)/)?.[1];
    if (prLink) return Number.parseInt(prLink, 10);
  } catch (err) {
    console.debug(
      `Failed to find existing autofix PR for issue ${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
  }
  return null;
}

async function createAutofixPR(
  gh: GitHubHelper,
  issueNumber: number,
  _repo: string,
  _token: string,
  _config: AgentConfig,
): Promise<void> {
  console.log(`🔧 Fix triggered for issue #${issueNumber}`);

  try {
    await gh.ensureLabels(['autofix', 'autofix-trigger', 'autofix:needs-fix']);
  } catch (err) {
    console.warn(`Failed to ensure autofix labels: ${err instanceof Error ? err.message : err}`);
  }
  await gh.addLabels(issueNumber, ['autofix']);

  console.log(
    `Fix flow initiated for issue #${issueNumber}. In production, this creates a branch, runs the fix, and opens a PR.`,
  );
}
