import { describe, expect, it } from 'vitest';

import {
  MAX_ARTIFACT_BYTES,
  type PatchArtifact,
  validateArtifactPath,
  validatePatchArtifact,
} from '../src/utils/artifact-guard.js';

const BASE_SHA = 'abc123def4567890abc123def4567890abc123de';
const SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function validArtifact(overrides: Partial<PatchArtifact> = {}): PatchArtifact {
  return {
    runId: 'run-123',
    baseSha: BASE_SHA,
    attempt: 1,
    files: [{ path: 'lib/src/utils/foo.ts', size: 12, symlink: false }],
    byteCount: 12,
    sha256: SHA256,
    ...overrides,
  };
}

function validate(artifact: unknown, expectedBaseSha = BASE_SHA, actualSha256 = SHA256) {
  return validatePatchArtifact(artifact, { expectedBaseSha, actualSha256 });
}

describe('validateArtifactPath()', () => {
  it('accepts a normal repo-relative path', () => {
    expect(validateArtifactPath('lib/src/utils/foo.ts')).toBeNull();
  });

  it('rejects absolute, traversal, and git-internal paths', () => {
    expect(validateArtifactPath('/etc/passwd')).toBe('absolute-path');
    expect(validateArtifactPath('../escape.ts')).toBe('traversal-segment');
    expect(validateArtifactPath('a/./b.ts')).toBe('traversal-segment');
    expect(validateArtifactPath('.git/hooks/pre-commit')).toBe('forbidden-segment');
  });

  it('rejects workflow, env, and bundle paths', () => {
    expect(validateArtifactPath('.github/workflows/self-improvement.yml')).toBe('forbidden-path');
    expect(validateArtifactPath('.github/workflows/evil.yml')).toBe('forbidden-path');
    expect(validateArtifactPath('action.yml')).toBe('forbidden-path');
    expect(validateArtifactPath('action.yaml')).toBe('forbidden-path');
    expect(validateArtifactPath('.env')).toBe('forbidden-path');
    expect(validateArtifactPath('.env.local')).toBe('forbidden-path');
    expect(validateArtifactPath('.env.production')).toBe('forbidden-path');
    expect(validateArtifactPath('config/.env.development')).toBe('forbidden-path');
    expect(validateArtifactPath('action/lib/index.js')).toBe('forbidden-path');
  });

  it('rejects empty and backslash paths', () => {
    expect(validateArtifactPath('')).toBe('empty-path');
    expect(validateArtifactPath('a\\b.ts')).toBe('backslash-path');
  });
});

describe('validatePatchArtifact()', () => {
  it('accepts a well-formed artifact', () => {
    expect(validate(validArtifact())).toEqual({ ok: true, reason: 'valid' });
  });

  it('fails closed on checksum and base-SHA mismatch', () => {
    expect(validate(validArtifact(), BASE_SHA, '0'.repeat(64)).reason).toBe('checksum-mismatch');
    expect(validate(validArtifact(), 'deadbeefcafe1234')).toEqual({
      ok: false,
      reason: 'base-sha-mismatch',
    });
  });

  it('fails closed on malformed metadata', () => {
    expect(validate(null).reason).toBe('not-an-object');
    expect(validate(validArtifact({ runId: '' })).reason).toBe('missing-run-id');
    expect(validate(validArtifact({ baseSha: 'not-a-sha' })).reason).toBe('invalid-base-sha');
    expect(validate(validArtifact({ attempt: -1 })).reason).toBe('invalid-attempt');
    expect(validate(validArtifact({ files: [] })).reason).toBe('empty-files');
    expect(validate(validArtifact({ sha256: 'short' })).reason).toBe('invalid-sha256');
  });

  it('rejects symlink, duplicate, traversal, and forbidden entries', () => {
    expect(
      validate(
        validArtifact({ files: [{ path: 'link.ts', size: 1, symlink: true }], byteCount: 1 }),
      ).reason,
    ).toBe('symlink-entry');
    expect(
      validate(
        validArtifact({
          files: [
            { path: 'a.ts', size: 1, symlink: false },
            { path: 'a.ts', size: 1, symlink: false },
          ],
          byteCount: 2,
        }),
      ).reason,
    ).toBe('duplicate-path');
    expect(
      validate(
        validArtifact({ files: [{ path: '../x.ts', size: 1, symlink: false }], byteCount: 1 }),
      ).reason,
    ).toBe('traversal-segment');
    expect(
      validate(
        validArtifact({
          files: [{ path: '.git/config', size: 1, symlink: false }],
          byteCount: 1,
        }),
      ).reason,
    ).toBe('forbidden-segment');
  });

  it('rejects byte-count mismatch and oversized payloads', () => {
    expect(validate(validArtifact({ byteCount: 999 })).reason).toBe('byte-count-mismatch');
    expect(
      validate(
        validArtifact({
          files: [{ path: 'big.bin', size: MAX_ARTIFACT_BYTES + 1, symlink: false }],
        }),
      ).reason,
    ).toBe('payload-too-large');
  });

  it('rejects too many files', () => {
    const files = Array.from({ length: 201 }, (_, i) => ({
      path: `file-${i}.ts`,
      size: 1,
      symlink: false as const,
    }));
    expect(validate(validArtifact({ files, byteCount: 201 })).reason).toBe('too-many-files');
  });

  it('fails closed on invalid options', () => {
    expect(validatePatchArtifact(validArtifact(), undefined as unknown as never).reason).toBe(
      'invalid-options',
    );
    expect(validatePatchArtifact(validArtifact(), null as unknown as never).reason).toBe(
      'invalid-options',
    );
  });

  it('rejects truthy non-boolean symlink flags', () => {
    const artifact = validArtifact({
      files: [{ path: 'link.ts', size: 1, symlink: 1 as unknown as boolean }],
      byteCount: 1,
    });
    expect(validate(artifact).reason).toBe('symlink-entry');
  });

  it('binds runId when expectedRunId is provided', () => {
    const ok = validatePatchArtifact(validArtifact(), {
      expectedBaseSha: BASE_SHA,
      actualSha256: SHA256,
      expectedRunId: 'run-123',
    });
    expect(ok).toEqual({ ok: true, reason: 'valid' });
    expect(
      validatePatchArtifact(validArtifact(), {
        expectedBaseSha: BASE_SHA,
        actualSha256: SHA256,
        expectedRunId: 'run-456',
      }).reason,
    ).toBe('run-id-mismatch');
  });
});
