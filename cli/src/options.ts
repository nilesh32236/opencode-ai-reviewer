import { parseArgs } from 'node:util';
import type { OutputFormat } from './commands/review.js';

/** Help text shown for `--help` / unknown usage. */
export const HELP_TEXT = `opencode-reviewer — local AI code review outside of CI/CD

Usage:
  opencode-reviewer review [options]

Options:
  --staged               Review staged (index) changes only (default)
  --branch <name>        Review the diff between <name>...HEAD
  --output <format>      Output format: terminal (default), json, or markdown
  --config <path>        Custom config file (default: .opencode-reviewer.yml)
   --model <name>         Model to use (default: opencode/muse-spark-1.2-contributor-free)
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
  // No `default: false`: staged must be `undefined` when the flag is absent so
  // the bare `review` command can be distinguished from an explicit `--staged`.
  staged: { type: 'boolean' as const },
  branch: { type: 'string' as const },
  output: { type: 'string' as const, default: 'terminal' },
  config: { type: 'string' as const },
  model: { type: 'string' as const },
  'timeout-minutes': { type: 'string' as const },
  help: { type: 'boolean' as const, default: false, short: 'h' },
  version: { type: 'boolean' as const, default: false, short: 'v' },
};

const VALID_OUTPUTS: OutputFormat[] = ['terminal', 'json', 'markdown'];

/** Options resolved for the `review` subcommand. */
export interface ReviewCliOptions {
  /** Whether to review staged changes. True unless `--branch` was provided. */
  staged: boolean;
  /** Branch (or ref) to diff HEAD against; set only for branch mode. */
  branch?: string;
  /** Output format: terminal (default), json, or markdown. */
  output: OutputFormat;
  /** Explicit config file path for `loadConfig`. */
  configPath?: string;
  /** Model override passed to the review engine. */
  model?: string;
  /** Max execution timeout in minutes. */
  timeoutMinutes?: number;
}

/** Result of parsing CLI arguments. */
export type ParseCliResult =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'review'; options: ReviewCliOptions }
  | { kind: 'error'; code: 1 | 2; message: string; showHelp: boolean };

interface ParsedValues {
  staged?: boolean;
  branch?: string;
  output?: string;
  config?: string;
  model?: string;
  'timeout-minutes'?: string;
  help?: boolean;
  version?: boolean;
}

/**
 * Parse and validate the CLI argument vector.
 *
 * `--branch` implies branch mode; `--staged` is the default for bare reviews.
 * `--staged` and `--branch` are mutually exclusive.
 * @param args - Raw argument vector (process.argv minus node and the script).
 * @returns A discriminated result describing how to handle the invocation.
 */
export function parseCliArgs(args: string[]): ParseCliResult {
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    return { kind: 'help' };
  }
  if (args[0] === '--version' || args[0] === '-v' || args[0] === 'version') {
    return { kind: 'version' };
  }

  // Flags may appear before or after the `review` subcommand (e.g. the bare
  // `opencode-reviewer --staged` form), so a leading `-` implies `review`.
  const command = args[0].startsWith('-') ? 'review' : args[0];
  const flagArgs = args[0].startsWith('-') ? args : args.slice(1);
  if (command !== 'review') {
    return {
      kind: 'error',
      code: 2,
      message: `Error: unknown command "${command}".`,
      showHelp: true,
    };
  }

  let values: ParsedValues;
  try {
    values = parseArgs({
      args: flagArgs,
      options: OPTION_DEFINITIONS,
      strict: true,
      allowPositionals: false,
    }).values as ParsedValues;
  } catch (err) {
    return {
      kind: 'error',
      code: 2,
      message: `Error: ${err instanceof Error ? err.message : String(err)}`,
      showHelp: true,
    };
  }

  if (values.help) return { kind: 'help' };
  if (values.version) return { kind: 'version' };

  const output = (values.output ?? 'terminal').toLowerCase();
  if (!VALID_OUTPUTS.includes(output as OutputFormat)) {
    return {
      kind: 'error',
      code: 2,
      message: `Error: invalid output format "${output}" (expected ${VALID_OUTPUTS.join(', ')}).`,
      showHelp: false,
    };
  }

  const timeoutRaw = values['timeout-minutes'];
  const timeoutMinutes = timeoutRaw !== undefined ? Number(timeoutRaw) : undefined;
  if (
    timeoutRaw !== undefined &&
    (!Number.isFinite(timeoutMinutes) || (timeoutMinutes ?? 0) <= 0)
  ) {
    return {
      kind: 'error',
      code: 2,
      message: `Error: invalid --timeout-minutes value "${timeoutRaw}".`,
      showHelp: false,
    };
  }

  if (values.branch !== undefined && values.staged) {
    return {
      kind: 'error',
      code: 2,
      message: 'Error: --staged and --branch are mutually exclusive.',
      showHelp: false,
    };
  }

  // `--branch` implies branch mode; bare `review` (and `--staged`) review the
  // staged index by default.
  const staged = values.branch === undefined;

  return {
    kind: 'review',
    options: {
      staged,
      branch: values.branch,
      output: output as OutputFormat,
      configPath: values.config,
      model: values.model,
      timeoutMinutes,
    },
  };
}
