import path from 'node:path';
import {
  DEFAULT_ALLOWLIST,
  parseRunChecksCommands,
  validateRunChecksCommand,
} from '../src/utils/command.js';

const BLOCKED_PROGRAMS = [
  'rm',
  'sudo',
  'chmod',
  'curl',
  'wget',
  'bash',
  'sh',
  'zsh',
  'python',
  'python3',
  'perl',
  'ruby',
  'deno',
  'pip',
  'npx',
  'cargo',
  'mv',
  'cp',
  'cat',
  'kill',
  'dd',
  'mkfs',
  'fdisk',
  'scp',
  'ssh',
  'telnet',
  'nc',
  'powershell',
  'cmd',
  'git',
  'docker',
];

const DANGEROUS_NODE_FLAGS = [
  '-e',
  '--eval',
  '-p',
  '--print',
  '-c',
  '--check',
  '-i',
  '--interactive',
  '-e=code',
  '--eval=code',
  '-p=code',
  '--print=code',
];

const DANGEROUS_RUNNER_SUBCOMMANDS = [
  'npm exec foo',
  'npm x foo',
  'yarn dlx foo',
  'yarn exec foo',
  'pnpm dlx foo',
  'pnpm exec foo',
];

const CHAINING_OPERATORS = [';', '||', '|', '&'];

const SHELL_EXPANSION_PATTERNS = [
  '`id`',
  '$(whoami)',
  '${HOME}',
  '$VAR',
  '$((1+1))',
  '{malicious,args}',
  '<file',
  '>file',
  '2>&1',
];

const PATH_TRAVERSAL_PROGRAMS = [
  '../safe',
  '../../etc/passwd',
  '/absolute/path',
  './node',
  'foo/../../../bar',
  'C:\\Windows\\system32\\cmd.exe',
];

const BLANK_COMMANDS = ['', '   ', '\t', ' \t '];

describe('validateRunChecksCommand()', () => {
  it('exports DEFAULT_ALLOWLIST', () => {
    expect(DEFAULT_ALLOWLIST).toEqual(['pnpm', 'npm', 'yarn', 'node']);
  });

  describe('allowed programs', () => {
    it.each(DEFAULT_ALLOWLIST)('accepts "%s" with no args', (program) => {
      expect(validateRunChecksCommand(program)).toEqual({ program, args: [] });
    });

    it.each([
      ['pnpm lint', 'pnpm', ['lint']],
      ['npm run build -- --filter foo', 'npm', ['run', 'build', '--', '--filter', 'foo']],
      ['yarn test', 'yarn', ['test']],
      ['node --version', 'node', ['--version']],
      ['node ./scripts/test.js', 'node', ['./scripts/test.js']],
      ['pnpm run lint --no-fix', 'pnpm', ['run', 'lint', '--no-fix']],
    ])('accepts safe command "%s"', (command, program, args) => {
      expect(validateRunChecksCommand(command)).toEqual({ program, args });
    });

    it('collapses repeated internal whitespace', () => {
      expect(validateRunChecksCommand('pnpm   test    unit')).toEqual({
        program: 'pnpm',
        args: ['test', 'unit'],
      });
    });

    it('accepts commands from a custom allowlist', () => {
      expect(validateRunChecksCommand('go build', ['go', 'make'])).toEqual({
        program: 'go',
        args: ['build'],
      });
      expect(validateRunChecksCommand('make all', ['go', 'make'])).toEqual({
        program: 'make',
        args: ['all'],
      });
    });
  });

  describe('blocked programs', () => {
    it.each(BLOCKED_PROGRAMS)('rejects "%s" against the default allowlist', (program) => {
      expect(() => validateRunChecksCommand(program)).toThrow(
        `Command "${program}" is not allowed`,
      );
    });

    it('rejects a program not in the custom allowlist', () => {
      expect(() => validateRunChecksCommand('python test.py', ['node', 'pnpm'])).toThrow(
        'Command "python" is not allowed',
      );
    });
  });

  describe('dangerous node flags', () => {
    it.each(DANGEROUS_NODE_FLAGS)('rejects node flag "%s"', (flag) => {
      expect(() => validateRunChecksCommand(`node ${flag}`)).toThrow('is not allowed for node');
    });

    it('accepts safe node invocations', () => {
      expect(() => validateRunChecksCommand('node --version')).not.toThrow();
      expect(() => validateRunChecksCommand('node -v')).not.toThrow();
      expect(() => validateRunChecksCommand('node ./scripts/test.js')).not.toThrow();
    });
  });

  describe('dangerous runner subcommands', () => {
    it.each(DANGEROUS_RUNNER_SUBCOMMANDS)('rejects subcommand command "%s"', (command) => {
      expect(() => validateRunChecksCommand(command)).toThrow('is not allowed for');
    });
  });

  describe('command chaining operators', () => {
    it.each(CHAINING_OPERATORS)('rejects chaining operator "%s"', (op) => {
      expect(() => validateRunChecksCommand(`pnpm test ${op} echo pwned`)).toThrow(
        'contains unsafe shell characters',
      );
    });

    it('rejects a disallowed program after a "&&" separator', () => {
      expect(() => validateRunChecksCommand('pnpm test && echo pwned')).toThrow(
        'Command "echo" is not allowed',
      );
    });
  });

  describe('parseRunChecksCommands()', () => {
    it('parses a single command', () => {
      expect(parseRunChecksCommands('pnpm typecheck')).toEqual([
        { program: 'pnpm', args: ['typecheck'] },
      ]);
    });

    it('parses chained commands in sequence', () => {
      expect(parseRunChecksCommands('pnpm typecheck && pnpm lint')).toEqual([
        { program: 'pnpm', args: ['typecheck'] },
        { program: 'pnpm', args: ['lint'] },
      ]);
    });

    it('applies "cd <dir>" to subsequent commands', () => {
      expect(
        parseRunChecksCommands(
          'cd frontend && pnpm typecheck && pnpm lint && cd ../backend && pnpm typecheck',
        ),
      ).toEqual([
        { program: 'pnpm', args: ['typecheck'], cwd: path.resolve('frontend') },
        { program: 'pnpm', args: ['lint'], cwd: path.resolve('frontend') },
        { program: 'pnpm', args: ['typecheck'], cwd: path.resolve('frontend', '../backend') },
      ]);
    });

    it('resolves nested "cd" paths', () => {
      expect(parseRunChecksCommands('cd a && cd b && pnpm test')).toEqual([
        { program: 'pnpm', args: ['test'], cwd: path.resolve('a', 'b') },
      ]);
    });

    it('rejects a "cd" without exactly one argument', () => {
      expect(() => parseRunChecksCommands('cd')).toThrow('exactly one path argument');
      expect(() => parseRunChecksCommands('cd a b && pnpm test')).toThrow(
        'exactly one path argument',
      );
    });

    it('rejects an unsafe "cd" target', () => {
      expect(() => parseRunChecksCommands('cd "x;y" && pnpm test')).toThrow('Unsafe cd target');
    });

    it('rejects a disallowed program after "cd"', () => {
      expect(() => parseRunChecksCommands('cd frontend && rm -rf .')).toThrow(
        'Command "rm" is not allowed',
      );
    });

    it('rejects a command with no actual executions', () => {
      expect(() => parseRunChecksCommands('cd frontend')).toThrow(
        'must contain at least one command',
      );
    });
  });

  describe('newline handling', () => {
    it('treats a newline as an argument separator, not a command separator', () => {
      const result = validateRunChecksCommand('pnpm lint\nrm -rf /');
      expect(result).toEqual({ program: 'pnpm', args: ['lint', 'rm', '-rf', '/'] });
    });

    it('treats CRLF as an argument separator, not a command separator', () => {
      const result = validateRunChecksCommand('pnpm lint\r\nnode --version');
      expect(result).toEqual({ program: 'pnpm', args: ['lint', 'node', '--version'] });
    });

    it('still rejects dangerous node flags that appear after a newline', () => {
      expect(() => validateRunChecksCommand('node\n-e console.log(1)')).toThrow(
        'is not allowed for node',
      );
    });
  });

  describe('path traversal', () => {
    it.each(PATH_TRAVERSAL_PROGRAMS)('rejects path traversal program "%s"', (command) => {
      expect(() => validateRunChecksCommand(command)).toThrow('is not allowed');
    });

    it('accepts relative-path arguments (executed argv-style, without a shell)', () => {
      expect(validateRunChecksCommand('pnpm lint ../safe')).toEqual({
        program: 'pnpm',
        args: ['lint', '../safe'],
      });
      expect(validateRunChecksCommand('pnpm lint foo/../../../bar')).toEqual({
        program: 'pnpm',
        args: ['lint', 'foo/../../../bar'],
      });
    });
  });

  describe('shell expansion characters', () => {
    it.each(SHELL_EXPANSION_PATTERNS)('rejects shell expansion pattern "%s"', (pattern) => {
      expect(() => validateRunChecksCommand(`pnpm lint ${pattern}`)).toThrow(
        'contains unsafe shell characters',
      );
    });
  });

  describe('edge cases', () => {
    it.each(BLANK_COMMANDS)('rejects blank command %j', (command) => {
      expect(() => validateRunChecksCommand(command)).toThrow(
        'run_checks_after_fix must not be empty',
      );
    });

    it('rejects a whitespace-only command containing only a newline', () => {
      expect(() => validateRunChecksCommand('\n  \n')).toThrow(
        'run_checks_after_fix must not be empty',
      );
    });

    it.each(['pnpm 🔥 test', 'pnpm тест', 'pnpm テスト'])(
      'accepts unicode command "%s"',
      (command) => {
        expect(() => validateRunChecksCommand(command)).not.toThrow();
      },
    );

    it('accepts an excessively long but safe command', () => {
      const command = `pnpm ${'a'.repeat(4096)} ${'b'.repeat(4096)}`;
      expect(command.length).toBeGreaterThan(4096);
      expect(validateRunChecksCommand(command)).toEqual({
        program: 'pnpm',
        args: ['a'.repeat(4096), 'b'.repeat(4096)],
      });
    });

    it('rejects an excessively long command containing a shell metacharacter', () => {
      const command = `pnpm ${'a'.repeat(4096)};evil`;
      expect(() => validateRunChecksCommand(command)).toThrow('contains unsafe shell characters');
    });

    it('trims surrounding whitespace from the command', () => {
      expect(validateRunChecksCommand('  pnpm test  ')).toEqual({
        program: 'pnpm',
        args: ['test'],
      });
    });
  });
});
