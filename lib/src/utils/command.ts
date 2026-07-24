const DEFAULT_ALLOWLIST = ['pnpm', 'npm', 'yarn', 'node'];

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
