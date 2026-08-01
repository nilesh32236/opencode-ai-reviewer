import * as core from '@actions/core';
import * as github from '@actions/github';
import type { AgentConfig, PlatformAdapter } from '@opencode-pr-agent/lib';
import { SetupEngine } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
import { sanitize } from './utils.js';

/**
 * Run the setup validation flow: execute all pre-flight checks, emit the
 * markdown report as a step summary and action outputs, optionally post it as
 * a comment on the triggering issue, and fail the action when checks fail.
 * @param inputs - Parsed action inputs.
 * @param config - Full agent configuration.
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 * @param repo - Repository string (owner/repo).
 * @param token - GitHub authentication token.
 */
export async function runSetup(
  inputs: ActionInputs,
  config: AgentConfig,
  gh: PlatformAdapter,
  repo: string,
  token: string,
): Promise<void> {
  const issueNumber =
    github.context.payload.issue?.number || github.context.payload.pull_request?.number;
  const platform = (process.env.PLATFORM || config.platform || 'github') as 'github' | 'gitlab';

  core.info(`Running setup validation for ${repo}...`);

  const engine = new SetupEngine(config, {
    workingDirectory: process.cwd(),
    platform,
    githubToken: token,
    repo: platform === 'github' ? repo : undefined,
    ...(inputs.probeAllModels ? { probeAllModels: true } : { probeModels: [config.reviewModel] }),
    opencodeVersion: inputs.opencodeVersion,
  });

  try {
    const result = await engine.runAll();
    const report = engine.formatReport(result);

    core.setOutput('setup_passed', String(result.overall === 'pass'));
    core.setOutput('setup_report', report);

    try {
      await core.summary.addRaw(report).write({ overwrite: true });
    } catch (err) {
      core.warning(sanitize(`Failed to write setup report to step summary: ${String(err)}`));
    }

    if (issueNumber && gh) {
      try {
        await gh.postOrUpdateComment(issueNumber, '<!-- setup-report -->', report);
        core.info(`Posted setup validation report to issue #${issueNumber}`);
      } catch (err) {
        core.warning(
          sanitize(
            `Failed to post setup report comment: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    }

    if (result.overall === 'fail') {
      core.setFailed('Setup validation failed — see the report above for actionable fixes');
    } else {
      core.info('Setup validation passed');
    }
  } catch (err) {
    core.setFailed(
      sanitize(`Setup validation failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
}
