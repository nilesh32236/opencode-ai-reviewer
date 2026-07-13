import type { AgentConfig } from '@opencode-pr-agent/lib';
import { GitHubHelper, ReviewEngine } from '@opencode-pr-agent/lib';

export async function handlePRReview(
  prNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
): Promise<void> {
  console.log(`🔍 Starting review for PR #${prNumber} in ${repo}`);

  const gh = new GitHubHelper(token, repo);
  const pr = await gh.getPR(prNumber);

  const hasSkipLabel = pr.labels.some((l) => config.review.skipLabels.includes(l));
  if (hasSkipLabel) {
    console.log(`PR #${prNumber} has skip label — skipping`);
    return;
  }

  const engine = new ReviewEngine(config, token, repo);

  try {
    let contextMd = `## PR #${prNumber}\n\n**Title:** ${pr.title}\n\n${pr.body}`;

    if (pr.linkedIssue) {
      try {
        const issue = await gh.getIssue(pr.linkedIssue);
        contextMd += `\n\n## Issue #${pr.linkedIssue}\n\n**Title:** ${issue.title}\n\n${issue.body}`;
      } catch {}
    }

    const result = await engine.reviewPR(pr);

    const reviewResult = await gh.postReview(prNumber, pr.headSha, result);

    if (reviewResult.success) {
      console.log(`✅ Review posted to PR #${prNumber} (${reviewResult.method})`);
    } else {
      console.log(`⚠️ Failed to post review to PR #${prNumber}`);
    }
  } finally {
    await engine.cleanup();
  }
}
