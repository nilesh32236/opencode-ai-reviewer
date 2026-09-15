import { describe, expect, it } from 'vitest';
import { isValidRepoSlug } from '../../src/handlers/commands.js';

describe('isValidRepoSlug', () => {
  it('accepts a valid owner/repo slug', () => {
    expect(isValidRepoSlug('octo-org/my.repo-name_1')).toBe(true);
  });

  it('rejects a missing slash', () => {
    expect(isValidRepoSlug('just-owner')).toBe(false);
  });

  it('rejects whitespace', () => {
    expect(isValidRepoSlug('owner/my repo')).toBe(false);
  });

  it('rejects path traversal', () => {
    expect(isValidRepoSlug('owner/../evil')).toBe(false);
  });

  it('rejects backslashes', () => {
    expect(isValidRepoSlug('owner\\repo/evil')).toBe(false);
  });

  it('rejects URL-confusing and control characters', () => {
    expect(isValidRepoSlug('own@er/repo')).toBe(false);
    expect(isValidRepoSlug('owner/re:po')).toBe(false);
    expect(isValidRepoSlug('owner/re%po')).toBe(false);
    expect(isValidRepoSlug('owner/re\npo')).toBe(false);
  });

  it('accepts GitLab nested-group paths', () => {
    expect(isValidRepoSlug('group/subgroup/repo')).toBe(true);
    expect(isValidRepoSlug('group/sub/nested/repo')).toBe(true);
  });

  it('rejects single-dot and empty segments', () => {
    expect(isValidRepoSlug('owner/.')).toBe(false);
    expect(isValidRepoSlug('./foo')).toBe(false);
    expect(isValidRepoSlug('owner//repo')).toBe(false);
    expect(isValidRepoSlug('owner/repo/')).toBe(false);
    expect(isValidRepoSlug('/owner/repo')).toBe(false);
  });
});
