import path from 'node:path';

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
  if (!VALID_REF_REGEX.test(ref)) {
    throw new Error(
      `Ref name "${ref}" contains invalid characters. Only letters, digits, underscores, dots, slashes, and hyphens are allowed.`,
    );
  }
}

/**
 * Validate a single program/args pair against the allowlist and shell-safety
 * rules (dangerous flags, unsafe shell characters). Throws on any violation.
 *
 * @param program - The executable name.
 * @param args - The argument array.
 * @param allowSet - Set of permitted executables.
 */
export function validateProgramArgs(
  program: string,
  args: string[],
  allowSet: Set<string>,
): void {
  if (!allowSet.has(program)) {
    throw new Error(
      `Command "${program}" is not allowed. Allowed programs: ${[...allowSet].join(', ')}`,
    );
  }

  if (program === 'node') {
    for (const arg of args) {
      if (
        arg === '-e' ||
        arg === '--eval' ||
        arg === '-p' ||
        arg === '--print' ||
        arg === '-c' ||
        arg === '--check' ||
        arg === '-i' ||
        arg === '--interactive' ||
        arg.startsWith('-e=') ||
        arg.startsWith('--eval=') ||
        arg.startsWith('-p=') ||
        arg.startsWith('--print=')
      ) {
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
 * resolves to:
 *
 *   [{program:'pnpm', args:['typecheck'], cwd:'frontend'},
 *    {program:'pnpm', args:['lint'],      cwd:'frontend'},
 *    {program:'pnpm', args:['typecheck'], cwd:'../backend'}]
 *
 * @param command - The raw command string to parse.
 * @param allowlist - Optional list of permitted program executables. Defaults to `DEFAULT_ALLOWLIST`.
 * @returns An array of validated `CheckExecution` steps, in order.
 * @throws {Error} If the command is empty, a program is not allowlisted, a `cd`
 *   step is malformed, or any argument contains unsafe shell characters.
 */
export function parseRunChecksCommands(
  command: string,
  allowlist: string[] = DEFAULT_ALLOWLIST,
): CheckExecution[] {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error('run_checks_after_fix must not be empty');
  }

  const allowSet = new Set(allowlist);
  const executions: CheckExecution[] = [];
  let cwd: string | undefined;

  for (const rawStep of trimmed.split(/\s*&&\s*/)) {
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
      cwd = cwd ? path.resolve(cwd, dir) : path.resolve(dir);
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
 * Retained for backward compatibility with single-command callers. For
 * multi-step commands (with `cd` / `&&`) use `parseRunChecksCommands`.
 *
 * @param command - The raw command string to validate (e.g., "pnpm test").
 * @param allowlist - Optional list of permitted program executables. Defaults to `DEFAULT_ALLOWLIST`.
 * @returns An object containing the parsed executable `program` and array of `args`.
 * @throws {Error} If the command is empty, the program is not in the allowlist, dangerous execution flags or subcommands are present, or arguments contain unsafe shell characters.
 */
export function validateRunChecksCommand(
  command: string,
  allowlist: string[] = DEFAULT_ALLOWLIST,
): { program: string; args: string[] } {
  const steps = parseRunChecksCommands(command, allowlist);
  const first = steps[0];
  return { program: first.program, args: first.args };
}
