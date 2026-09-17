import { isValidCommitSha, validateRefName } from '../src/utils/validation.js';

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
