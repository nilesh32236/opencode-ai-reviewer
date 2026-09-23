import {
  isValidCommitSha,
  parseRunChecksCommands,
  validateRefName,
} from '../src/utils/validation.js';

describe('validateRefName()', () => {
  it('accepts simple branch names', () => {
    expect(() => validateRefName('main')).not.toThrow();
    expect(() => validateRefName('master')).not.toThrow();
    expect(() => validateRefName('develop')).not.toThrow();
  });

  it('accepts feature branch names with slashes', () => {
    expect(() => validateRefName('feature/my-feature')).not.toThrow();
    expect(() => validateRefName('fix/bug-123')).not.toThrow();
    expect(() => validateRefName('release/v1.0')).not.toThrow();
  });

  it('accepts refs with dots, underscores, and hyphens', () => {
    expect(() => validateRefName('v1.0.0')).not.toThrow();
    expect(() => validateRefName('fix_branch')).not.toThrow();
    expect(() => validateRefName('UPPERCASE')).not.toThrow();
    expect(() => validateRefName('mixed_Case-1.0')).not.toThrow();
  });

  it('rejects refs containing colons', () => {
    expect(() => validateRefName('main:evil')).toThrow('contains invalid characters');
  });

  it('rejects refs beginning with a dash', () => {
    expect(() => validateRefName('-malicious-ref')).toThrow('must not begin with a dash');
  });

  it('rejects refs containing spaces', () => {
    expect(() => validateRefName('branch name')).toThrow('contains invalid characters');
  });

  it('rejects refs containing newlines', () => {
    expect(() => validateRefName('branch\nname')).toThrow('contains invalid characters');
  });

  it('rejects refs containing semicolons', () => {
    expect(() => validateRefName('branch;rm')).toThrow('contains invalid characters');
  });

  it('rejects refs containing shell metacharacters', () => {
    expect(() => validateRefName('branch$(whoami)')).toThrow('contains invalid characters');
    expect(() => validateRefName('branch`whoami`')).toThrow('contains invalid characters');
    expect(() => validateRefName('branch|cat')).toThrow('contains invalid characters');
  });

  it('rejects empty strings', () => {
    expect(() => validateRefName('')).toThrow('must not be empty');
  });

  it('rejects non-strings', () => {
    expect(() => validateRefName(undefined as unknown as string)).toThrow('must not be empty');
  });

  it('accepts very long branch names (256 chars)', () => {
    const longName = 'a'.repeat(256);
    expect(() => validateRefName(longName)).not.toThrow();
  });
});

describe('isValidCommitSha()', () => {
  it('accepts full and abbreviated hex SHAs', () => {
    expect(isValidCommitSha('f0e2a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c')).toBe(true);
    expect(isValidCommitSha('abc123')).toBe(true);
    expect(isValidCommitSha('ABCDEF1234')).toBe(true);
  });

  it('rejects flag-injection shapes', () => {
    expect(isValidCommitSha('--output=/tmp/x')).toBe(false);
    expect(isValidCommitSha('-upload-pack=id')).toBe(false);
    expect(isValidCommitSha('--upload-pack=touch pwned')).toBe(false);
  });

  it('rejects non-hex, empty, and non-string input', () => {
    expect(isValidCommitSha('main')).toBe(false);
    expect(isValidCommitSha('HEAD@{1}')).toBe(false);
    expect(isValidCommitSha('abc')).toBe(false);
    expect(isValidCommitSha('')).toBe(false);
    expect(isValidCommitSha(undefined)).toBe(false);
    expect(isValidCommitSha(null)).toBe(false);
    expect(isValidCommitSha(1234)).toBe(false);
  });
});

describe('parseRunChecksCommands() node preload-flag denylist (REF-001)', () => {
  const BASE = '/repo/checkout';

  it.each([
    'node -r ./evil.js --version',
    'node --require ./evil.js',
    'node --require=./evil.js',
    'node --import ./evil.mjs',
    'node --loader ./evil.mjs',
    'node --experimental-loader ./evil.mjs',
    'node --run build',
  ])('rejects preload/loader bypass: %s', (command) => {
    expect(() => parseRunChecksCommands(command, undefined, BASE)).toThrow('Dangerous flag');
  });

  it('rejects joined short preload form (-r<module>)', () => {
    expect(() => parseRunChecksCommands('node -r./evil.js', undefined, BASE)).toThrow(
      'Dangerous flag',
    );
  });

  it('still rejects eval-family flags', () => {
    expect(() => parseRunChecksCommands('node -e "console.log(1)"', undefined, BASE)).toThrow(
      'Dangerous flag',
    );
    expect(() => parseRunChecksCommands('node --eval=x', undefined, BASE)).toThrow(
      'Dangerous flag',
    );
  });

  it('rejects test-runner and watch/inspect flags (same class as --run)', () => {
    expect(() => parseRunChecksCommands('node --test', undefined, BASE)).toThrow('Dangerous flag');
    expect(() => parseRunChecksCommands('node --watch', undefined, BASE)).toThrow('Dangerous flag');
    expect(() => parseRunChecksCommands('node --inspect script.js', undefined, BASE)).toThrow(
      'Dangerous flag',
    );
    expect(() => parseRunChecksCommands('node --inspect-brk script.js', undefined, BASE)).toThrow(
      'Dangerous flag',
    );
  });

  it('rejects joined -i short-flag form for consistency', () => {
    expect(() => parseRunChecksCommands('node -ievil', undefined, BASE)).toThrow('Dangerous flag');
  });

  it('allows legitimate node invocations', () => {
    expect(() => parseRunChecksCommands('node --version', undefined, BASE)).not.toThrow();
    expect(() => parseRunChecksCommands('node script.js', undefined, BASE)).not.toThrow();
    expect(() => parseRunChecksCommands('pnpm test', undefined, BASE)).not.toThrow();
  });
});

describe('parseRunChecksCommands() cd confinement (REF-001)', () => {
  const BASE = '/repo/checkout';

  it.each(['cd ..', 'cd ../..', 'cd /etc', 'cd .. && pnpm test'])(
    'rejects directory escape: %s',
    (command) => {
      expect(() => parseRunChecksCommands(command, undefined, BASE)).toThrow(/Unsafe cd target/);
    },
  );

  it('rejects escape via a subdirectory step (cd frontend && cd ../../..)', () => {
    expect(() =>
      parseRunChecksCommands('cd frontend && cd ../../.. && pnpm test', undefined, BASE),
    ).toThrow(/Unsafe cd target/);
  });

  it('allows legitimate cd usage staying inside the checkout', () => {
    expect(() =>
      parseRunChecksCommands('cd frontend && pnpm typecheck', undefined, BASE),
    ).not.toThrow();
    // Sibling-via-parent that resolves back inside stays confined.
    expect(() =>
      parseRunChecksCommands('cd frontend && cd ../backend && pnpm typecheck', undefined, BASE),
    ).not.toThrow();
  });
});
