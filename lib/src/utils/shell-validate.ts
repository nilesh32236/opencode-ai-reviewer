import { execFile } from 'node:child_process';
import type { ReviewIssue } from '../types/index.js';
import {
  isAllowedLinterCommand,
  isConfinedPath,
  isSafeLinterArgs,
} from './safe-exec.js';

/** Default per-command timeout for shell validation (ms). */
export const SHELL_VALIDATE_TIMEOUT_MS = 30_000;

/** Maximum evidence bytes kept per finding (truncated, fail-open). */
export const SHELL_VALIDATE_MAX_BYTES = 2 * 1024;

/**
 * Options for shell-based finding validation.
 */
export interface ShellValidateOptions {
  /** Argv templates to run per finding (`{file}`/`{line}` placeholders). */
  commands: string[][];
  /** Repository root the commands run in (must confine `{file}`). */
  workDir: string;
  /** Per-command timeout in ms (default {@link SHELL_VALIDATE_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Maximum evidence bytes kept per finding (default {@link SHELL_VALIDATE_MAX_BYTES}). */
  maxBytes?: number;
}

/**
 * Substitute `{file}`/`{line}` placeholders in an argv template.
 * The file value is confined under `workDir` — placeholders resolving
 * outside the root yield `undefined` (caller skips the command fail-open).
 * @param template - Argv template with optional placeholders.
 * @param file - Finding file path (repo-relative).
 * @param line - Finding line number.
 * @param workDir - Repository root for confinement.
 * @returns Substituted argv, or `undefined` when unsafe.
 */
function substitutePlaceholders(
  template: string[],
  file: string,
  line: number,
  workDir: string,
): string[] | undefined {
  try {
    const out = template.map((arg) =>
      String(arg)
        .replaceAll('{file}', file)
        .replaceAll('{line}', String(line)),
    );
    if (out.some((a) => a.includes('\0'))) return undefined;
    if (typeof file === 'string' && file !== '' && !isConfinedPath(workDir, file)) return undefined;
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Execution seam for shell validation (defaults to `execFile`, no shell).
 * Injectable so tests never spawn real subprocesses.
 */
export interface ShellRunDeps {
  /**
   * Run one validated command.
   * @param command - Allowlisted basename.
   * @param args - Validated argv (no shell).
   * @param workDir - Confined working directory.
   * @param timeoutMs - Kill timeout in ms.
   * @param maxBytes - Evidence cap in bytes.
   * @returns Trimmed stdout (capped), or `undefined` on any failure.
   */
  run: (
    command: string,
    args: string[],
    workDir: string,
    timeoutMs: number,
    maxBytes: number,
  ) => Promise<string | undefined>;
}

/**
 * Default runner: `execFile` without a shell, bounded by timeout and output
 * cap. Never throws — every failure mode resolves to `undefined` (fail-open).
 * @param command - Basename of the allowlisted command.
 * @param args - Validated argument list (no shell).
 * @param workDir - Working directory for the subprocess.
 * @param timeoutMs - Kill timeout in ms.
 * @param maxBytes - Evidence cap in bytes.
 * @returns Trimmed stdout (capped), or `undefined` on any failure.
 */
export function defaultRunValidatorCommand(
  command: string,
  args: string[],
  workDir: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        { cwd: workDir, encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          try {
            if (err) return resolve(undefined);
            const text = String(stdout ?? '').trim();
            if (!text) return resolve(undefined);
            const buf = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
            return resolve(buf.trim() || undefined);
          } catch {
            return resolve(undefined);
          }
        },
      );
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Collect evidence snippets for one finding by running its configured
 * read-only validators. Annotation-only: validators can never demote or drop
 * a finding — a mismatch, timeout, missing binary, or disallowed command
 * simply yields no evidence.
 * @param issue - Finding to validate.
 * @param options - Commands, workdir, and caps.
 * @param deps - Optional execution seam (defaults to `execFile`, no shell).
 * @returns Evidence lines (possibly empty, never throws).
 */
export async function collectFindingEvidence(
  issue: ReviewIssue,
  options: ShellValidateOptions,
  deps?: ShellRunDeps,
): Promise<string[]> {
  const evidence: string[] = [];
  try {
    const run = deps?.run ?? defaultRunValidatorCommand;
    const timeoutMs = options.timeoutMs ?? SHELL_VALIDATE_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? SHELL_VALIDATE_MAX_BYTES;
    const file = typeof issue.file === 'string' ? issue.file : '';
    const line = typeof issue.line === 'number' && Number.isFinite(issue.line) ? issue.line : 0;
    const commands = Array.isArray(options.commands) ? options.commands : [];
    for (const template of commands.slice(0, 3)) {
      try {
        if (!Array.isArray(template) || template.length === 0) continue;
        const [command, ...rest] = template;
        if (!isAllowedLinterCommand(command)) continue;
        const argv = substitutePlaceholders(rest, file, line, options.workDir);
        if (!argv || !isSafeLinterArgs(argv)) continue;
        const out = await run(command, argv, options.workDir, timeoutMs, maxBytes);
        if (out) evidence.push(out);
      } catch {
        // Per-command fail-open: keep scanning the remaining validators.
      }
    }
  } catch {
    // Fail-open: validation must never break the review.
  }
  return evidence;
}

/**
 * Attach shell-validation evidence to findings (annotation-only).
 * Sets `validationEvidence` on findings with at least one evidence snippet;
 * findings without evidence pass through with a fresh object identity
 * preserved (no mutation of the input array).
 * @param issues - Findings to annotate.
 * @param options - Commands, workdir, and caps.
 * @param deps - Optional execution seam (defaults to `execFile`, no shell).
 * @returns Annotated findings (never throws).
 */
export async function attachShellEvidence(
  issues: ReviewIssue[],
  options: ShellValidateOptions,
  deps?: ShellRunDeps,
): Promise<ReviewIssue[]> {
  if (!Array.isArray(issues) || issues.length === 0) return issues;
  return Promise.all(
    issues.map(async (issue) => {
      try {
        const snippets = await collectFindingEvidence(issue, options, deps);
        if (snippets.length === 0) return issue;
        return { ...issue, validationEvidence: snippets.join('\n---\n') };
      } catch {
        return issue;
      }
    }),
  );
}

/**
 * Resolve and validate the shell-validation setup for an engine run.
 * Returns `undefined` (disabled) unless explicitly enabled with at least one
 * well-formed command — default-off preserves the current pipeline exactly.
 * @param enabled - The `review.sensitivity.shellValidate` flag.
 * @param commands - The `review.sensitivity.shellCommands` templates.
 * @param workDir - Repository root for confinement.
 * @returns Validated options, or `undefined` when disabled/misconfigured.
 */
export function resolveShellValidateOptions(
  enabled: unknown,
  commands: unknown,
  workDir: string,
): ShellValidateOptions | undefined {
  try {
    if (enabled !== true) return undefined;
    if (!Array.isArray(commands)) return undefined;
    // Fail closed on config: ANY malformed or disallowed entry rejects the
    // whole set so an operator typo surfaces instead of silently narrowing
    // validation. Runtime stays fail-open (see collectFindingEvidence).
    for (const c of commands) {
      if (!Array.isArray(c) || c.length === 0 || c.some((a) => typeof a !== 'string' || a === '')) {
        return undefined;
      }
      if (!isAllowedLinterCommand(c[0])) return undefined;
      const probe = c
        .slice(1)
        .map((a) => a.replaceAll('{file}', 'f').replaceAll('{line}', '1'));
      if (!isSafeLinterArgs(probe)) return undefined;
    }
    const valid = (commands as string[][]).slice(0, 3);
    if (valid.length === 0) return undefined;
    if (typeof workDir !== 'string' || workDir === '') return undefined;
    return { commands: valid, workDir };
  } catch {
    return undefined;
  }
}
