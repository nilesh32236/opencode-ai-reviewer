#!/usr/bin/env node
import * as fs from 'fs';
import { parseArgs } from 'node:util';
import * as path from 'path';
import { type OutputFormat, runReviewCommand } from './commands/review.js';

/** Help text shown for `--help` / unknown usage. */
const HELP_TEXT = `opencode-reviewer — local AI code review outside of CI/CD

Usage:
  opencode-reviewer review [options]

Options:
  --staged               Review staged (index) changes only (default)
  --branch <name>        Review the diff between <name>...HEAD
  --output <format>      Output format: terminal (default), json, or markdown
  --config <path>        Custom config file (default: .opencode-reviewer.yml)
  --model <name>         Model to use (default: opencode/deepseek-v4-flash-free)
  --timeout-minutes <n>  Max execution timeout in minutes (default: 20)
  -h, --help             Show this help message
  -v, --version          Show the CLI version

Examples:
  opencode-reviewer review                     # review staged changes
  opencode-reviewer review --output markdown   # write review-result.md
  opencode-reviewer review --branch main       # review main...HEAD diff
`;

/** Option schema for `parseArgs`. */
const OPTION_DEFINITIONS = {
  staged: { type: 'boolean' as const, default: false },
  branch: { type: 'string' as const },
  output: { type: 'string' as const, default: 'terminal' },
  config: { type: 'string' as const },
  model: { type: 'string' as const },
  'timeout-minutes': { type: 'string' as const },
  help: { type: 'boolean' as const, default: false, short: 'h' },
  version: { type: 'boolean' as const, default: false, short: 'v' },
};

const VALID_OUTPUTS: OutputFormat[] = ['terminal', 'json', 'markdown'];

/** Read the package version from the nearest package.json at runtime.
 * @returns The package version string, or "0.0.0" when it cannot be read.
 */
function readVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'),
    ) as { version?: string };
    if (pkg.version) return pkg.version;
  } catch {
    /* fall through */
  }
  return '0.0.0';
}

/** Print help to stdout.
 * @returns Nothing (void).
 */
function printHelp(): void {
  process.stdout.write(HELP_TEXT);
}

/**
 * CLI entry point: parse arguments, dispatch to subcommands, and map the
 * subcommand exit code to the process exit code.
 * @returns The process exit code (0 success, 1 error, 2 usage error).
 */
async function main(): Promise<number> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    return 0;
  }
  if (args[0] === '--version' || args[0] === '-v' || args[0] === 'version') {
    process.stdout.write(`opencode-reviewer ${readVersion()}\n`);
    return 0;
  }

  const command = args[0];
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: args.slice(1),
      options: OPTION_DEFINITIONS,
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n\n`);
    printHelp();
    return 2;
  }

  const values = parsed.values as {
    staged?: boolean;
    branch?: string;
    output?: string;
    config?: string;
    model?: string;
    'timeout-minutes'?: string;
    help?: boolean;
    version?: boolean;
  };

  if (values.help) {
    printHelp();
    return 0;
  }
  if (values.version) {
    process.stdout.write(`opencode-reviewer ${readVersion()}\n`);
    return 0;
  }

  if (command !== 'review') {
    process.stderr.write(`Error: unknown command "${command}".\n\n`);
    printHelp();
    return 2;
  }

  const output = (values.output ?? 'terminal').toLowerCase();
  if (!VALID_OUTPUTS.includes(output as OutputFormat)) {
    process.stderr.write(
      `Error: invalid output format "${output}" (expected ${VALID_OUTPUTS.join(', ')}).\n`,
    );
    return 2;
  }

  const timeoutRaw = values['timeout-minutes'];
  const timeoutMinutes = timeoutRaw !== undefined ? Number(timeoutRaw) : undefined;
  if (
    timeoutRaw !== undefined &&
    (!Number.isFinite(timeoutMinutes) || (timeoutMinutes ?? 0) <= 0)
  ) {
    process.stderr.write(`Error: invalid --timeout-minutes value "${timeoutRaw}".\n`);
    return 2;
  }

  // `--branch` implies branch mode; `--staged` is the default for bare reviews.
  const staged = values.branch === undefined && values.staged !== false;

  return runReviewCommand({
    staged,
    branch: values.branch,
    output: output as OutputFormat,
    configPath: values.config,
    model: values.model,
    timeoutMinutes,
    cwd: process.cwd(),
  });
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
