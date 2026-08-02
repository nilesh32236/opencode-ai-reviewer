#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { runReviewCommand } from './commands/review.js';
import { HELP_TEXT, parseCliArgs } from './options.js';

/**
 * Strip GitHub Actions workflow-command lines (`::error::`, `::warning::`,
 * `::info::`, ...) from the CLI's stdout/stderr. lib code calls @actions/core
 * directly in many places, and @actions/core emits these `::command::` strings
 * unconditionally even outside GitHub Actions; they would otherwise corrupt the
 * local terminal output the CLI is designed to produce.
 */
function installPlainOutputFilter(): void {
  const stripCommands = (chunk: unknown): string => {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    return text.replace(/^::[^\n]*\n?/gm, '');
  };
  type StdioWrite = (chunk: unknown, ...rest: unknown[]) => boolean;
  const stdoutWrite = process.stdout.write.bind(process.stdout) as StdioWrite;
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
    stdoutWrite(stripCommands(chunk), ...rest)) as typeof process.stdout.write;
  const stderrWrite = process.stderr.write.bind(process.stderr) as StdioWrite;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) =>
    stderrWrite(stripCommands(chunk), ...rest)) as typeof process.stderr.write;
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
