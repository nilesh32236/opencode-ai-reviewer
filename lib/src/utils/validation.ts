export const DEFAULT_ALLOWLIST = ['pnpm', 'npm', 'yarn', 'node'];

/**
 * Validates a verification command string against an allowlist, dangerous flags, and shell safety rules.
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
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error('run_checks_after_fix must not be empty');
  }
  const parts = trimmed.split(/\s+/);
  const program = parts[0];
  const allowSet = new Set(allowlist);
  if (!allowSet.has(program)) {
    throw new Error(
      `Command "${program}" is not allowed. Allowed programs: ${[...allowSet].join(', ')}`,
    );
  }
  const args = parts.slice(1);

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
  return { program, args };
}
