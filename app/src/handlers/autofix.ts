import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import type { AgentConfig } from '@opencode-pr-agent/lib';
import { GitHubHelper, ReviewEngine, buildFixPrompt } from '@opencode-pr-agent/lib';

export async function handleAutofixLoop(
  prNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
): Promise<void> {
  console.log(`🔄 Starting autofix loop for PR #${prNumber} in ${repo}`);

  const gh = new GitHubHelper(token, repo);
  const pr = await gh.getPR(prNumber);

  const comments = await gh.getIssueComments(prNumber);
  const iteration = comments.filter((c) => c.body.includes('<!-- autofix-review -->')).length;

  if (iteration >= config.maxIterations) {
    console.log(`⚠️ Max iterations reached (${config.maxIterations}) for PR #${prNumber}`);
    await gh.setLabels(prNumber, ['autofix:needs-manual-review'], ['autofix', 'autofix:needs-fix']);
    await gh.postOrUpdateComment(
      prNumber,
      '<!-- autofix-status -->',
      `⚠️ **Max iterations reached** (${config.maxIterations}). This PR needs manual review.`,
    );
    return;
  }

  const engine = new ReviewEngine(config, token, repo);

  try {
    const result = await engine.reviewPR(pr);

    const isApproved =
      result.verdict.ready && result.stats.critical === 0 && result.stats.important === 0;

    const reviewBody = buildReviewComment(result, iteration);
    await gh.postOrUpdateComment(prNumber, '<!-- autofix-review -->', reviewBody);

    if (isApproved) {
      await gh.setLabels(prNumber, ['autofix:approved'], ['autofix', 'autofix:needs-fix']);

      const merged = await gh.mergePR(prNumber);

      if (merged) {
        await gh.setLabels(prNumber, ['autofix:merged'], ['autofix:approved', 'autofix']);
        await gh.postOrUpdateComment(
          prNumber,
          '<!-- autofix-status -->',
          '✅ Review approved. Auto-merge enabled — will merge when CI passes.',
        );

        if (pr.linkedIssue) {
          try {
            await gh.closeIssue(pr.linkedIssue, `✅ Fixed by PR #${prNumber}`);
          } catch {}
        }
      } else {
        await gh.postOrUpdateComment(
          prNumber,
          '<!-- autofix-status -->',
          '⚠️ Review approved but auto-merge failed. Please merge manually.',
        );
      }
    } else {
      await gh.setLabels(prNumber, ['autofix:needs-fix'], []);

      let contextMd = `## PR #${prNumber}\n\n${pr.body}`;
      if (pr.linkedIssue) {
        try {
          const issue = await gh.getIssue(pr.linkedIssue);
          contextMd += `\n\n## Issue #${pr.linkedIssue}\n\n${issue.body}`;
        } catch {
          /* skip */
        }
      }

      contextMd += `\n\n## Review Feedback (Iteration ${iteration})\n\n`;
      contextMd += `Summary: ${result.summary}\n`;
      contextMd += `Verdict: ${result.verdict.ready ? 'READY' : 'NEEDS FIXES'} — ${result.verdict.reasoning}\n\n`;
      for (const issue of result.issues) {
        contextMd += `- [${issue.severity.toUpperCase()}] ${issue.file}:${issue.line} — ${issue.message}`;
        if (issue.suggestion) contextMd += `\n  > Fix: ${issue.suggestion}`;
        contextMd += '\n';
      }

      configureGit(token, repo);

      const fixResult = await engine.runFix(prNumber, iteration, contextMd);

      if (fixResult.changesMade) {
        execSync('git add -A');
        execSync(`git commit -m "fix: address review feedback (iteration ${iteration + 1})"`);
        execSync(`git remote set-url origin https://x-access-token:${token}@github.com/${repo}`);
        execSync(`git push origin ${pr.headRef}`);
      }

      await gh.removeLabel(prNumber, 'autofix:needs-fix');

      const statusMsg = fixResult.changesMade
        ? `🔧 Fix applied (iteration ${iteration + 1}). Waiting for review...`
        : `ℹ️ Fix agent ran but made no changes (iteration ${iteration + 1}). Manual review may be needed.`;

      await gh.postOrUpdateComment(prNumber, '<!-- autofix-status -->', statusMsg);
    }
  } finally {
    await engine.cleanup();
  }
}

function buildReviewComment(
  result: {
    summary: string;
    verdict: { ready: boolean; reasoning: string };
    strengths: any[];
    issues: any[];
    stats: { critical: number; important: number; minor: number };
  },
  iteration: number,
): string {
  const lines: string[] = [
    '<!-- autofix-review -->',
    '',
    `## 🔍 Autofix Review (Iteration ${iteration + 1}/${3})`,
    '',
    result.summary,
    '',
  ];

  if (result.verdict.ready && result.stats.critical === 0 && result.stats.important === 0) {
    lines.push(`✅ **Ready to merge** — ${result.verdict.reasoning}`);
  } else {
    lines.push(
      `❌ **Needs fixes** — ${result.stats.critical} critical, ${result.stats.important} important, ${result.stats.minor} minor`,
    );
    lines.push('');
    lines.push(`**Reasoning:** ${result.verdict.reasoning}`);
  }

  if (result.strengths.length > 0) {
    lines.push('');
    lines.push('### Strengths');
    for (const s of result.strengths) {
      lines.push(`- ✅ **${s.file}:${s.line}** — ${s.message}`);
    }
  }

  if (result.issues.length > 0) {
    lines.push('');
    lines.push('### Issues');
    for (const i of result.issues) {
      lines.push(`- **${i.severity.toUpperCase()}:** ${i.file}:${i.line} — ${i.message}`);
      if (i.suggestion) {
        lines.push(`  > 💡 ${i.suggestion}`);
      }
    }
  }

  return lines.join('\n');
}

function configureGit(token: string, repo: string): void {
  execSync('git config --global user.name "opencode-pr-agent[bot]"');
  execSync('git config --global user.email "opencode-pr-agent[bot]@users.noreply.github.com"');
  execSync(
    `git config --global url."https://x-access-token:${token}@github.com/".insteadOf "https://github.com/"`,
  );
}
