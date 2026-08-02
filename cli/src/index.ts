#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { runReviewCommand } from './commands/review.js';
import { HELP_TEXT, parseCliArgs } from './options.js';

/**
 * GitHub Actions workflow-command names that @actions/core emits to stdout as
 * `::command::message` strings even when not running inside GitHub Actions.
 * Only these known commands are filtered, so legitimate content that merely
 * begins with `::` (e.g. a reviewed bash line like `::foo::bar`) passes through.
 */
const WORKFLOW_COMMAND_NAMES = new Set([
  'error',
  'warning',
  'notice',
  'debug',
  'info',
  'group',
  'endgroup',
  'add-mask',
  'add-path',
  'set-env',
  'set-output',
  'set-secret',
  'stop-commands',
]);

/** Signature of a writable stream's `write` method. */
type StdioWrite = (chunk: unknown, ...rest: unknown[]) => boolean;

/**
 * Reroute a chunk of CLI stdout/stderr so GitHub Actions workflow-command lines
 * (`::level::message`, `::group::name`, ...) never leak into the local terminal.
 * A workflow command is recognized by its `::`-delimited shape and known command
 * name; when found, only its human-readable message portion is emitted. Any
 * other line is returned unchanged, so legitimate content such as a diff line
 * or bash transcript starting with `::` is preserved.
 * @param chunk - Raw write chunk.
 * @returns The cleaned text (message only for recognized workflow commands).
 */
function sanitizeOutputChunk(chunk: unknown): string {
  const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
  return text.replace(/^::([^ :]+)[^:]*::.*$/gm, (match, name: string) =>
    WORKFLOW_COMMAND_NAMES.has(name) ? match.slice(match.indexOf('::', 2) + 2) : match,
  );
}

/**
 * Strip GitHub Actions workflow-command lines (`::error::`, `::warning::`,
 * `::info::`, ...) from the CLI's stdout/stderr. lib code calls @actions/core
 * directly in many places, and @actions/core emits these `::command::` strings
 * unconditionally even outside GitHub Actions; they would otherwise corrupt the
 * local terminal output the CLI is designed to produce.
 */
function installPlainOutputFilter(): void {
  const route =
    (write: StdioWrite): StdioWrite =>
    (chunk: unknown, ...rest: unknown[]) =>
      write(sanitizeOutputChunk(chunk), ...rest);
  const stdoutWrite = process.stdout.write.bind(process.stdout) as StdioWrite;
  process.stdout.write = route(stdoutWrite) as typeof process.stdout.write;
  const stderrWrite = process.stderr.write.bind(process.stderr) as StdioWrite;
  process.stderr.write = route(stderrWrite) as typeof process.stderr.write;
}

installPlainOutputFilter();

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
  const parsed = parseCliArgs(process.argv.slice(2));

  switch (parsed.kind) {
    case 'help':
      printHelp();
      return 0;
    case 'version':
      process.stdout.write(`opencode-reviewer ${readVersion()}\n`);
      return 0;
    case 'error':
      process.stderr.write(`${parsed.message}\n`);
      if (parsed.showHelp) printHelp();
      return parsed.code;
    case 'review':
      return runReviewCommand({
        ...parsed.options,
        cwd: process.cwd(),
      });
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
