import type { AgentConfig } from '@opencode-pr-agent/lib';
import {
  Logger,
  SetupEngine,
  createPlatformAdapter,
  sanitizeErrorMessage,
} from '@opencode-pr-agent/lib';
import type { PlatformAdapter } from '@opencode-pr-agent/lib';

/**
 * Handle a setup command: run the pre-flight validation checks against the
 * cloned workspace and post the markdown report as a comment on the issue.
 * @param issueNumber - The issue/PR number that triggered the setup.
 * @param repo - Repository string (owner/repo).
 * @param token - GitHub authentication token.
 * @param config - Agent configuration.
 * @param tempDir - Temporary working directory containing the cloned repo.
 */
export async function handleSetup(
  issueNumber: number,
  repo: string,
  token: string,
  config: AgentConfig,
  tempDir: string,
): Promise<void> {
  const logger = new Logger('Command:Setup', { repo, prNumber: issueNumber });
  logger.info(`Running setup validation for issue #${issueNumber}`);

  const gh: PlatformAdapter = createPlatformAdapter(token, repo, config.platform);
  const engine = new SetupEngine(config, {
    workingDirectory: tempDir,
    platform: config.platform,
    githubToken: token,
    repo: config.platform === 'github' ? repo : undefined,
  });

  try {
    const result = await engine.runAll();
    const report = engine.formatReport(result);

    await gh.postOrUpdateComment(issueNumber, '<!-- setup-report -->', report);

    logger.info(
      `Posted setup validation report for issue #${issueNumber} (overall: ${result.overall})`,
    );
  } catch (err) {
    logger.error(
      `Failed to run setup validation for issue #${issueNumber}: ${err instanceof Error ? err.message : err}`,
    );
    try {
      await gh.postOrUpdateComment(
        issueNumber,
        '<!-- setup-report -->',
        `❌ **Setup Validation Failed**: ${sanitizeErrorMessage(err)}`,
      );
    } catch (commentErr) {
      logger.warn(
        `Failed to post setup-failure comment: ${commentErr instanceof Error ? commentErr.message : String(commentErr)}`,
      );
    }
  }
}
