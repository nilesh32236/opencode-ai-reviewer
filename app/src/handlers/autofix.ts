import { execFileSync } from 'child_process';
import type { AgentConfig, ReviewResult } from '@opencode-pr-agent/lib';
import { GitHubHelper, ReviewEngine, configureGit } from '@opencode-pr-agent/lib';

interface IterationRecord {
  iteration: number;
  status: 'approved' | 'fix-applied' | 'needs-fix' | 'no-changes';
  summary: string;
  critical: number;
  important: number;
  minor: number;
}

const AUTOFIX_MARKER = '<!-- autofix-review -->';

function buildAutofixBody(
  history: IterationRecord[],
  maxIterations: number,
  phase: 'reviewing' | 'approved' | 'no-changes' | 'max-iterations' | 'merged' | 'merge-failed',
  current?: ReviewResult,
): string {
  const lines: string[] = [AUTOFIX_MARKER, '', '## 🤖 Autofix Review', ''];

  const currentIter = history.length;

  switch (phase) {
    case 'reviewing':
      lines.push(`**Status:** 🔍 Reviewing (iteration ${currentIter}/${maxIterations})`);
      break;
    case 'approved':
      lines.push('**Status:** ✅ Approved — all issues resolved');
      break;
    case 'no-changes':
      lines.push(
        `**Status:** ℹ️ Fix agent made no changes (iteration ${currentIter}/${maxIterations})`,
      );
      break;
    case 'max-iterations':
      lines.push('**Status:** ⚠️ Manual review required');
      break;
    case 'merged':
      lines.push('**Status:** ✅ Merged');
      break;
    case 'merge-failed':
      lines.push('**Status:** ⚠️ Approved but auto-merge failed');
      break;
  }

  if (current) {
    if (current.summary) {
      lines.push('', '### Summary', '', current.summary);
    }

    if (current.issues.length > 0) {
      lines.push('', '### Issues Found');
      for (const i of current.issues) {
        lines.push(`- **${i.severity.toUpperCase()}:** ${i.file}:${i.line} — ${i.message}`);
        if (i.suggestion) lines.push(`  > ${i.suggestion}`);
      }
    }

    if (current.strengths.length > 0) {
      lines.push('', '### Strengths');
      for (const s of current.strengths) {
        lines.push(`- ✅ **${s.file}:${s.line}** — ${s.message}`);
      }
    }
  }

  if (history.length > 0) {
    lines.push('', '### Iteration History');
    for (const h of history) {
      let icon: string;
      let detail: string;
      switch (h.status) {
        case 'approved':
          icon = '✅';
          detail = 'All issues resolved';
          break;
        case 'fix-applied':
          icon = '🔧';
          detail = `Fix applied — ${h.critical} critical, ${h.important} important`;
          break;
        case 'needs-fix':
          icon = '❌';
          detail = `${h.critical} critical, ${h.important} important remaining`;
          break;
        case 'no-changes':
          icon = 'ℹ️';
          detail = 'No changes made';
          break;
      }
      lines.push(`- ${icon} **Iteration ${h.iteration}:** ${detail}`);
    }
  }

  switch (phase) {
    case 'approved':
      lines.push('', '✅ **Ready to merge!**');
      break;
    case 'max-iterations':
      lines.push(
        '',
        `⚠️ **Max iterations reached (${maxIterations}).** This PR needs manual review.`,
      );
      break;
    case 'merged':
      lines.push('', '✅ **PR has been merged.**');
      break;
    case 'merge-failed':
      lines.push('', '⚠️ **Approved but auto-merge failed.** Please merge manually.');
      break;
  }

  return lines.join('\n');
}

export async function handleAutofixLoop(
  prNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
): Promise<void> {
  console.log(`🔄 Starting autofix loop for PR #${prNumber} in ${repo}`);

  const gh = new GitHubHelper(token, repo);

  const engine = new ReviewEngine(config, token, repo);
  const history: IterationRecord[] = [];
  let approved = false;

  try {
    for (let i = 0; i < config.maxIterations; i++) {
      console.log(`=== Autofix iteration ${i + 1}/${config.maxIterations} ===`);

      const pr = await gh.getPR(prNumber);
      const result = await engine.reviewPR(pr, i);

      const entry: IterationRecord = {
        iteration: i + 1,
        status: 'approved',
        summary: result.summary,
        critical: result.stats.critical,
        important: result.stats.important,
        minor: result.stats.minor,
      };

      const isApproved =
        result.verdict.ready && result.stats.critical === 0 && result.stats.important === 0;

      if (isApproved) {
        approved = true;
        entry.status = 'approved';
        history.push(entry);
        await gh.postOrUpdateComment(
          prNumber,
          AUTOFIX_MARKER,
          buildAutofixBody(history, config.maxIterations, 'approved'),
        );
        break;
      }

      entry.status = 'needs-fix';
      history.push(entry);
      await gh.postOrUpdateComment(
        prNumber,
        AUTOFIX_MARKER,
        buildAutofixBody(history, config.maxIterations, 'reviewing', result),
      );

      let contextMd = `## PR #${prNumber}\n\n${pr.body}`;
      if (pr.linkedIssue) {
        try {
          const issue = await gh.getIssue(pr.linkedIssue);
          contextMd += `\n\n## Issue #${pr.linkedIssue}\n\n${issue.body}`;
        } catch {
          /* skip */
        }
      }

      contextMd += `\n\n## Review Feedback (Iteration ${i})\n\n`;
      contextMd += `Summary: ${result.summary}\n`;
      contextMd += `Verdict: ${result.verdict.ready ? 'READY' : 'NEEDS FIXES'} — ${result.verdict.reasoning}\n\n`;
      for (const issue of result.issues) {
        contextMd += `- [${issue.severity.toUpperCase()}] ${issue.file}:${issue.line} — ${issue.message}`;
        if (issue.suggestion) contextMd += `\n  > Fix: ${issue.suggestion}`;
        contextMd += '\n';
      }

      configureGit(
        'opencode-pr-agent[bot]',
        'opencode-pr-agent[bot]@users.noreply.github.com',
        token,
      );

      const fixResult = await engine.runFix(prNumber, i, contextMd);

      if (!fixResult.changesMade) {
        history[history.length - 1].status = 'no-changes';
        await gh.postOrUpdateComment(
          prNumber,
          AUTOFIX_MARKER,
          buildAutofixBody(history, config.maxIterations, 'no-changes', result),
        );
        console.log('Fix agent made no changes — stopping loop');
        break;
      }

      history[history.length - 1].status = 'fix-applied';

      execFileSync('git', ['add', '-A']);
      execFileSync('git', ['commit', '-m', `fix: address review feedback (iteration ${i + 1})`]);
      execFileSync('git', ['push', 'origin', pr.headRef]);
    }

    if (approved) {
      await gh.setLabels(prNumber, ['autofix:approved'], ['autofix', 'autofix:needs-fix']);
      const merged = await gh.mergePR(prNumber);

      if (merged) {
        await gh.setLabels(prNumber, ['autofix:merged'], ['autofix:approved', 'autofix']);
        await gh.postOrUpdateComment(
          prNumber,
          AUTOFIX_MARKER,
          buildAutofixBody(history, config.maxIterations, 'merged'),
        );

        if (prNumber) {
          const pr = await gh.getPR(prNumber);
          if (pr.linkedIssue) {
            try {
              await gh.closeIssue(pr.linkedIssue, `✅ Fixed by PR #${prNumber}`);
            } catch {}
          }
        }
      } else {
        await gh.postOrUpdateComment(
          prNumber,
          AUTOFIX_MARKER,
          buildAutofixBody(history, config.maxIterations, 'merge-failed'),
        );
      }
    } else {
      console.log(`⚠️ Max iterations reached (${config.maxIterations}) for PR #${prNumber}`);
      await gh.setLabels(
        prNumber,
        ['autofix:needs-manual-review'],
        ['autofix', 'autofix:needs-fix'],
      );
      await gh.postOrUpdateComment(
        prNumber,
        AUTOFIX_MARKER,
        buildAutofixBody(history, config.maxIterations, 'max-iterations'),
      );
    }
  } finally {
    await engine.cleanup();
  }
}
