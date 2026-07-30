import { validateRefName } from '../src/utils/validation.js';

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
