import { DEFAULT_ALLOWLIST, validateRunChecksCommand } from '../src/utils/command.js';

describe('validateRunChecksCommand()', () => {
  it('exports DEFAULT_ALLOWLIST', () => {
    expect(DEFAULT_ALLOWLIST).toEqual(['pnpm', 'npm', 'yarn', 'node']);
  });

  it('accepts allowed commands with no args', () => {
    const result = validateRunChecksCommand('pnpm');
    expect(result).toEqual({ program: 'pnpm', args: [] });
  });

  it('accepts allowed commands with safe args', () => {
    const result = validateRunChecksCommand('pnpm lint');
    expect(result).toEqual({ program: 'pnpm', args: ['lint'] });
  });

  it('accepts allowed commands with multiple safe args', () => {
    const result = validateRunChecksCommand('npm run build -- --filter foo');
    expect(result).toEqual({
      program: 'npm',
      args: ['run', 'build', '--', '--filter', 'foo'],
    });
  });

  it('accepts custom allowlist', () => {
    const result = validateRunChecksCommand('go build', ['go', 'make']);
    expect(result).toEqual({ program: 'go', args: ['build'] });
  });

  it('rejects empty command', () => {
    expect(() => validateRunChecksCommand('  ')).toThrow('run_checks_after_fix must not be empty');
  });

  it('rejects commands not in default allowlist', () => {
    expect(() => validateRunChecksCommand('bash -c "rm -rf /"')).toThrow(
      'Command "bash" is not allowed',
    );
  });

  it('rejects node eval flags', () => {
    expect(() => validateRunChecksCommand('node -e "console.log(1)"')).toThrow(
      'Dangerous flag "-e" is not allowed for node',
    );
    expect(() => validateRunChecksCommand('node --eval "console.log(1)"')).toThrow(
      'Dangerous flag "--eval" is not allowed for node',
    );
  });

  it('rejects dangerous runner subcommands', () => {
    expect(() => validateRunChecksCommand('npm exec foo')).toThrow(
      'Subcommand "exec" is not allowed for npm',
    );
    expect(() => validateRunChecksCommand('yarn dlx foo')).toThrow(
      'Subcommand "dlx" is not allowed for yarn',
    );
    expect(() => validateRunChecksCommand('pnpm dlx foo')).toThrow(
      'Subcommand "dlx" is not allowed for pnpm',
    );
  });

  it('rejects commands with unsafe shell characters', () => {
    expect(() => validateRunChecksCommand('pnpm lint; rm -rf /')).toThrow(
      'contains unsafe shell characters',
    );
  });

  it('rejects commands with backtick injection', () => {
    expect(() => validateRunChecksCommand('pnpm lint `id`')).toThrow(
      'contains unsafe shell characters',
    );
  });

  it('rejects commands with pipe', () => {
    expect(() => validateRunChecksCommand('pnpm lint | echo pwned')).toThrow(
      'contains unsafe shell characters',
    );
  });

  it('rejects commands with dollar paren', () => {
    expect(() => validateRunChecksCommand('pnpm lint $(whoami)')).toThrow(
      'contains unsafe shell characters',
    );
  });

  it('rejects commands not in custom allowlist', () => {
    expect(() => validateRunChecksCommand('python test.py', ['node', 'pnpm'])).toThrow(
      'Command "python" is not allowed',
    );
  });

  it('trims whitespace from command', () => {
    const result = validateRunChecksCommand('  pnpm test  ');
    expect(result).toEqual({ program: 'pnpm', args: ['test'] });
  });
});
