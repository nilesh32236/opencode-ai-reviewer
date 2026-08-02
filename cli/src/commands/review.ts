import * as fs from 'fs';
import * as path from 'path';
import {
  Logger,
  type LoggerSink,
  type PRContext,
  ReviewEngine,
  type ReviewResult,
  buildLocalOpenCodeConfig,
  buildPRContextFromBranchDiff,
  buildPRContextFromStagedDiff,
  isInsideGitWorkTree,
  loadConfig,
  sanitizeErrorMessage,
  setOpenCodeRunMode,
  setupOpenCode,
} from '@opencode-pr-agent/lib';
import { buildAgentConfig } from '../config.js';
import { formatJson, formatMarkdown, formatTerminal } from '../formatters/index.js';
import { LocalAdapter } from '../local-adapter.js';

/** Supported output formats for the review command. */
export type OutputFormat = 'terminal' | 'json' | 'markdown';

/** Options for the `review` subcommand. */
export interface ReviewCommandOptions {
  /** Whether to review staged changes (default). False when `--branch` is used. */
  staged: boolean;
  /** Branch (or ref) to diff HEAD against; mutually exclusive with staged. */
  branch?: string;
  /** Output format: terminal (default), json, or markdown. */
  output: OutputFormat;
  /** Explicit config file path for `loadConfig`. */
  configPath?: string;
  /** Model override passed to the review engine. */
  model?: string;
  /** Max execution timeout in minutes. */
  timeoutMinutes?: number;
  /** Working directory the review runs in (default: process.cwd()). */
  cwd: string;
}

/** Plain-text logging sink so `::command::` GitHub Actions strings never appear. */
const plainSink: LoggerSink = {
  debug: (message) => {
    if (process.env.OPENCODE_REVIEWER_DEBUG === 'true') {
      process.stdout.write(`[debug] ${message}\n`);
    }
  },
  info: (message) => process.stdout.write(`${message}\n`),
  warn: (message) => process.stdout.write(`${message}\n`),
  error: (message) => process.stderr.write(`${message}\n`),
};

/** Default file names for file-based output formats. */
const JSON_OUTPUT_FILE = 'review-result.json';
const MARKDOWN_OUTPUT_FILE = 'review-result.md';

/**
 * Run a local review of staged changes or a branch diff, printing a colorized
 * report to the terminal or writing a JSON/markdown report file.
 * @param options - Review command options.
 * @returns The process exit code (0 on success, 1 on failure).
 */
export async function runReviewCommand(options: ReviewCommandOptions): Promise<number> {
  Logger.setSink(plainSink);

  const branch = options.branch;

  if (!isInsideGitWorkTree(options.cwd)) {
    process.stderr.write(`Not a git repository: ${options.cwd}\n`);
    return 1;
  }

  let pr: PRContext;
  try {
    if (options.staged) {
      pr = buildPRContextFromStagedDiff({ cwd: options.cwd });
    } else {
      // Branch mode requires an explicit branch; never pass `undefined` through
      // to git, which would produce a confusing `git diff undefined...HEAD`
      // error.
      if (branch === undefined) {
        process.stderr.write(
          'Error: review requires either --staged (default) or --branch <name>.\n',
        );
        return 1;
      }
      pr = buildPRContextFromBranchDiff(branch, { cwd: options.cwd });
    }
  } catch (err) {
    process.stderr.write(
      `Failed to read the git diff: ${sanitizeErrorMessage(err)}. ` +
        `Is this a git repository with ${options.staged ? 'staged changes' : `a "${options.branch}" branch`}?\n`,
    );
    return 1;
  }

  if (pr.changedFiles.length === 0) {
    process.stdout.write(
      options.staged
        ? 'No staged changes to review.\n'
        : `No differences between ${options.branch} and HEAD to review.\n`,
    );
    return 0;
  }

  process.stdout.write(
    `Reviewing ${pr.changedFiles.length} changed file(s) (${pr.baseRef} → ${pr.headRef})...\n`,
  );

  const loadedConfig = loadConfig(options.cwd, 'github', options.configPath);
  if (options.configPath && loadedConfig === null) {
    process.stderr.write(`Failed to load config file: ${options.configPath}\n`);
    return 1;
  }
  const agentConfig = buildAgentConfig(loadedConfig, { model: options.model });

  try {
    await setupOpenCode();
  } catch (err) {
    process.stderr.write(`Failed to set up the OpenCode CLI: ${sanitizeErrorMessage(err)}\n`);
    return 1;
  }
  // Local mode: never auto-approve permissions and don't clear the user's
  // project opencode.json / plugins (the CI config does both).
  setOpenCodeRunMode({ autoApprove: false, opencodeConfig: buildLocalOpenCodeConfig() });

  const engine = new ReviewEngine(
    agentConfig,
    new LocalAdapter(),
    undefined,
    undefined,
    'local/local',
  );

  let result: ReviewResult;
  try {
    result = await engine.reviewPR(
      pr,
      undefined,
      undefined,
      undefined,
      options.timeoutMinutes,
      undefined,
      options.cwd,
    );
  } catch (err) {
    process.stderr.write(`Review failed: ${sanitizeErrorMessage(err)}\n`);
    return 1;
  }

  const hasContent = Boolean(
    result.summary ||
      result.issues.length > 0 ||
      result.strengths.length > 0 ||
      result.verdict?.reasoning,
  );
  if (!hasContent) {
    process.stderr.write(
      'Review returned no meaningful content — the model may have failed silently. ' +
        'Check your API key and model configuration.\n',
    );
    return 1;
  }

  switch (options.output) {
    case 'json': {
      const outputPath = path.join(options.cwd, JSON_OUTPUT_FILE);
      fs.writeFileSync(outputPath, `${formatJson(result)}\n`, 'utf-8');
      process.stdout.write(`Review written to ${outputPath}\n`);
      break;
    }
    case 'markdown': {
      const outputPath = path.join(options.cwd, MARKDOWN_OUTPUT_FILE);
      fs.writeFileSync(outputPath, formatMarkdown(result), 'utf-8');
      process.stdout.write(`Review written to ${outputPath}\n`);
      break;
    }
    default:
      process.stdout.write(`${formatTerminal(result)}\n`);
      break;
  }

  return 0;
}
