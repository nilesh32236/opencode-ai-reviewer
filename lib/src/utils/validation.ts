import path from 'node:path';
import { isConfinedPath } from './safe-exec.js';

const VALID_REF_REGEX = /^[a-zA-Z0-9_./-]+$/;

export const DEFAULT_ALLOWLIST = ['pnpm', 'npm', 'yarn', 'node'];

/** A single program execution within a run_checks_after_fix sequence. */
export interface CheckExecution {
  program: string;
  args: string[];
  /** Optional working directory (resolved via `cd <dir>` steps). */
  cwd?: string;
}

/**
 * Validates a git ref name (branch or tag) against a strict character allowlist.
 *
 * Only letters, digits, underscores, dots, slashes, and hyphens are permitted.
 * This prevents injection attacks via colons, spaces, newlines, null bytes,
 * shell metacharacters, or other special characters that could alter git
 * behavior (e.g., refspec syntax like `:` for arbitrary branch pushes).
 *
 * @param ref - The ref name to validate.
 * @throws {Error} If the ref is empty or contains invalid characters.
 */
export function validateRefName(ref: string): void {
  if (!ref) {
    throw new Error('Ref name must not be empty');
  }
  if (ref.startsWith('-')) {
    throw new Error('Ref name must not begin with a dash');
  }
  if (!VALID_REF_REGEX.test(ref)) {
    throw new Error(
      `Ref name "${ref}" contains invalid characters. Only letters, digits, underscores, dots, slashes, and hyphens are allowed.`,
    );
  }
}

/** Plausible git commit SHA: hex, 4–64 chars (full or abbreviated). */
const COMMIT_SHA_REGEX = /^[0-9a-fA-F]{4,64}$/;

/**
 * Whether a value is a plausible git commit SHA (hex string, 4–64 chars).
 *
 * Interpolating an unvalidated revision into a git argv risks flag injection
 * (`git blame --output=<path>` writes files; a leading `-` parses as a flag).
 * Callers must gate SHA-typed argv entries on this predicate and fail closed.
 * @param sha - Candidate SHA value.
 * @returns True when the value looks like a hex commit SHA.
 */
export function isValidCommitSha(sha: unknown): sha is string {
  return typeof sha === 'string' && COMMIT_SHA_REGEX.test(sha);
}

/**
 * Owner/repo slug pattern restricted to the GitHub/GitLab owner/repo charset
 * (alphanumerics, dot, dash, underscore) with one or more slash-separated
 * segments. Multiple segments support GitLab nested-group paths
 * (`group/subgroup/repo`); single-slash `owner/repo` is the GitHub form.
 * Rejects whitespace, backslashes, `..` segments, single-dot segments,
 * URL-confusing characters (`@`, `:`, `%`, control chars), and empty parts so
 * a webhook-supplied repo value can never escape into a crafted clone URL or
 * git remote.
 *
 * Single owner for fork-slug validation shared by app/ branch-workspace flows
 * (previously triplicated in `app/src/handlers/commands.ts`).
 */
export const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/;

/**
 * Whether a repository slug is safe to interpolate into a clone/remote URL.
 *
 * @param repo - Repository string in "owner/repo" (or GitLab nested-group) form.
 * @returns True when the slug matches slash-separated segments with no traversal.
 */
export function isValidRepoSlug(repo: string): boolean {
  if (typeof repo !== 'string' || repo.length === 0) return false;
  if (repo.includes('\\')) return false;
  if (!REPO_SLUG_PATTERN.test(repo)) return false;
  if (repo.includes('..')) return false;
  if (repo.split('/').some((p) => p === '.' || p === '')) return false;
  return true;
}

/**
 * Exact-match denylist for `node` code-execution / code-loading flags.
 * Covers the eval family (`-e/--eval/-p/--print/-c/--check/-i/--interactive`)
 * and the preload/loader family (`-r/--require/--import/--loader/
 * --experimental-loader/--run`) which executes checkout code
 * (`node -r ./evil.js --version`, `node --import ./evil.mjs`), plus the
 * test-runner (`--test`, which discovers and executes checkout test files
 * without naming a script — same class as `--run`) and the watch/inspect
 * family (`--watch`, `--inspect`, `--inspect-brk`, `--inspect-port`, which
 * re-execute checkout code or open a debugger port on the runner).
 * Joined `--flag=value` / `--flag:value` forms and concatenated short flags
 * (`-r<module>`) are rejected by {@link isBlockedNodeArg}, mirroring
 * `isBlockedMcpLocalArg` in `safe-exec.ts`.
 */
const BLOCKED_NODE_ARGS: ReadonlySet<string> = new Set([
  '-e',
  '--eval',
  '-p',
  '--print',
  '-c',
  '--check',
  '-i',
  '--interactive',
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--test',
  '--watch',
  '--inspect',
  '--inspect-brk',
  '--inspect-port',
  '--run',
]);

/**
 * Whether a single `node` argument is a blocked code-execution /
 * code-loading flag, including `--flag=value` / `--flag:value`
 * concatenated forms and joined short flags (`-e<code>`, `-p<code>`,
 * `-c<code>`, `-i<code>`, `-r<module>`).
 * @param arg - Single argument string.
 * @returns True when the arg must be rejected.
 */
function isBlockedNodeArg(arg: string): boolean {
  const v = arg.trim();
  if (BLOCKED_NODE_ARGS.has(v)) return true;
  for (const blocked of BLOCKED_NODE_ARGS) {
    if (blocked.startsWith('--') && (v.startsWith(`${blocked}=`) || v.startsWith(`${blocked}:`))) {
      return true;
    }
  }
  if (/^-[epcir]\S/.test(v)) return true;
  return false;
}

/**
 * Validate a single program/args pair against the allowlist and shell-safety
 * rules (dangerous flags, unsafe shell characters). Throws on any violation.
 *
 * @param program - The executable name.
 * @param args - The argument array.
 * @param allowSet - Set of permitted executables.
 */
export function validateProgramArgs(program: string, args: string[], allowSet: Set<string>): void {
  if (!allowSet.has(program)) {
    throw new Error(
      `Command "${program}" is not allowed. Allowed programs: ${[...allowSet].join(', ')}`,
    );
  }

  if (program === 'node') {
    for (const arg of args) {
      if (isBlockedNodeArg(arg)) {
        throw new Error(`Dangerous flag "${arg}" is not allowed for node`);
      }
    }
  } else if (program === 'npm') {
    if (args.length > 0 && (args[0] === 'exec' || args[0] === 'x')) {
      throw new Error(`Subcommand "${args[0]}" is not allowed for npm`);
    }
  } else if (program === 'yarn') {
    if (args.length > 0 && (args[0] === 'dlx' || args[0] === 'exec')) {
      throw new Error(`Subcommand "${args[0]}" is not allowed for yarn`);
    }
  } else if (program === 'pnpm') {
    if (args.length > 0 && (args[0] === 'dlx' || args[0] === 'exec')) {
      throw new Error(`Subcommand "${args[0]}" is not allowed for pnpm`);
    }
  }

  for (const arg of args) {
    if (/[;&|`$(){}<>\n\r]/.test(arg)) {
      throw new Error(`Argument "${arg}" contains unsafe shell characters`);
    }
  }
}

/**
 * Parses a `run_checks_after_fix` command string into a safe sequence of
 * program executions, WITHOUT invoking a shell.
 *
 * The string may chain multiple commands with `&&` and change directories
 * with `cd <dir>` (no shell operators are executed — each step is validated
 * and run directly). Example:
 *
 *   `cd frontend && pnpm typecheck && pnpm lint && cd ../backend && pnpm typecheck`
 *
 * resolves to (with `baseDir` = `/repo`):
 *
 *   [{program:'pnpm', args:['typecheck'], cwd:'/repo/frontend'},
 *    {program:'pnpm', args:['lint'],      cwd:'/repo/frontend'},
 *    {program:'pnpm', args:['typecheck'], cwd:'/repo/backend'}]
 *
 * (`cwd` values are absolute paths anchored at `baseDir`; the last step
 * resolves `../backend` relative to `/repo/frontend`, i.e. `/repo/backend`.)
 *
 * @param command - The raw command string to parse.
 * @param allowlist - Optional list of permitted program executables. Defaults to `DEFAULT_ALLOWLIST`.
 * @param baseDir - Trusted starting directory `cd` targets are confined to
 *   and `step.cwd` values are anchored at. Defaults to `process.cwd()` for
 *   backward compatibility, but production callers MUST pass the real
 *   checkout dir so validation and execution share the same base.
 * @returns An array of validated `CheckExecution` steps, in order. Each
 *   `cwd` is an absolute path anchored at `baseDir` — use it directly as
 *   the exec `cwd` (do NOT re-resolve it against another base with
 *   `path.resolve(base, step.cwd)`, which discards the base for absolute
 *   paths).
 * @throws {Error} If the command is empty, a program is not allowlisted, a `cd`
 *   step is malformed or escapes the starting directory, or any argument
 *   contains unsafe shell characters.
 */
export function parseRunChecksCommands(
  command: string,
  allowlist: string[] = DEFAULT_ALLOWLIST,
  baseDir?: string,
): CheckExecution[] {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error('run_checks_after_fix must not be empty');
  }

  const allowSet = new Set(allowlist);
  const executions: CheckExecution[] = [];
  const baseResolved = path.resolve(baseDir ?? process.cwd());
  let current = baseResolved;
  let cwd: string | undefined;

  // NOTE: split on the literal `&&` (not /\s*&&\s*/) — each step is trimmed
  // below, and the regex form risks polynomial backtracking on adversarial
  // whitespace (js/polynomial-redos). Identical results, linear time.
  for (const rawStep of trimmed.split('&&')) {
    const step = rawStep.trim();
    if (!step) continue;

    const parts = step.split(/\s+/);
    const program = parts[0];

    // `cd <dir>` — changes the working directory for subsequent steps.
    if (program === 'cd') {
      if (parts.length !== 2) {
        throw new Error('`cd` must take exactly one path argument');
      }
      const dir = parts[1];
      if (!/^[a-zA-Z0-9_./~-]+$/.test(dir)) {
        throw new Error(`Unsafe cd target "${dir}"`);
      }
      const next = path.resolve(current, dir);
      if (!isConfinedPath(baseResolved, next)) {
        throw new Error(`Unsafe cd target "${dir}": escapes the working directory`);
      }
      current = next;
      cwd = next;
      continue;
    }

    const args = parts.slice(1);
    validateProgramArgs(program, args, allowSet);
    executions.push({ program, args, cwd });
  }

  if (executions.length === 0) {
    throw new Error('run_checks_after_fix must contain at least one command');
  }
  return executions;
}

/**
 * Validates a single verification command string against an allowlist,
 * dangerous flags, and shell safety rules.
 *
 * Single-command-only: `command` must resolve to exactly one execution step.
 * Commands resolving to multiple executions (e.g. `pnpm test && pnpm lint`)
 * throw — use `parseRunChecksCommands` so every step (and its `cwd`) is
 * preserved and executed.
 *
 * @param command - The raw command string to validate (e.g., "pnpm test").
 * @param allowlist - Optional list of permitted program executables. Defaults to `DEFAULT_ALLOWLIST`.
 * @param baseDir - Optional trusted starting directory `cd` targets are
 *   confined to. Defaults to `process.cwd()`.
 * @returns An object containing the parsed executable `program`, array of `args`,
 *   and the absolute `cwd` (anchored at `baseDir`) when the command changes
 *   directories (e.g. `"cd frontend && pnpm test"` returns
 *   `{program:'pnpm', args:['test'], cwd:'<baseDir>/frontend'}`).
 *   Callers must honor the returned `cwd` as the exec `cwd` instead of
 *   executing in the process cwd.
 * @throws {Error} If the command is empty, the program is not in the allowlist, dangerous execution flags or subcommands are present, arguments contain unsafe shell characters, or the command resolves to multiple execution steps (use `parseRunChecksCommands` for those).
 */
export function validateRunChecksCommand(
  command: string,
  allowlist: string[] = DEFAULT_ALLOWLIST,
  baseDir?: string,
): { program: string; args: string[]; cwd?: string } {
  const steps = parseRunChecksCommands(command, allowlist, baseDir);
  if (steps.length > 1) {
    throw new Error(
      'validateRunChecksCommand accepts only a single command; use parseRunChecksCommands for multi-step commands with `cd` / `&&`',
    );
  }
  const first = steps[0];
  return first.cwd !== undefined
    ? { program: first.program, args: first.args, cwd: first.cwd }
    : { program: first.program, args: first.args };
}
