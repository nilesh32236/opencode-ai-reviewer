export const DEFAULT_ALLOWLIST = ['pnpm', 'npm', 'yarn', 'node'];

/**
 * Validate a run-checks command against an allowlist to prevent shell injection.
 * Returns the program and args for use with array-form exec (no shell string).
 * @param command - The command string to validate and parse.
 * @param allowlist - List of allowed program names (defaults to common package managers).
 * @returns An object containing the program name and its arguments.
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
  for (const arg of parts.slice(1)) {
    if (/[;&|`$(){}<>\n\r]/.test(arg)) {
      throw new Error(`Argument "${arg}" contains unsafe shell characters`);
    }
  }
  return { program, args: parts.slice(1) };
}
