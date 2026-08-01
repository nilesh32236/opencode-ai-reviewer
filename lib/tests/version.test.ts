import { describe, expect, it } from 'vitest';
import {
  MINIMUM_OPENCODE_VERSION,
  UNPARSEABLE_VERSION,
  compareVersions,
  formatVersion,
  parseVersion,
} from '../src/utils/version.js';

describe('parseVersion()', () => {
  it('parses plain and v-prefixed versions', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
    expect(parseVersion('v2.0.0')).toEqual({ major: 2, minor: 0, patch: 0, prerelease: null });
  });

  it('captures pre-release and ignores build metadata', () => {
    expect(parseVersion('1.1.1-rc.1')).toEqual({
      major: 1,
      minor: 1,
      patch: 1,
      prerelease: 'rc.1',
    });
    expect(parseVersion('1.1.1-rc.1+build.5')?.prerelease).toBe('rc.1');
  });

  it('returns null for non-semver input', () => {
    expect(parseVersion('')).toBeNull();
    expect(parseVersion('latest')).toBeNull();
    expect(parseVersion('not.a.version')).toBeNull();
    expect(parseVersion('1.2')).toBeNull();
  });
});

describe('compareVersions()', () => {
  it('compares release versions', () => {
    expect(compareVersions('1.1.1', '1.1.1')).toBe(0);
    expect(compareVersions('1.1.1', '1.1.2')).toBeLessThan(0);
    expect(compareVersions('1.1.2', '1.1.1')).toBeGreaterThan(0);
    expect(compareVersions('1.9.0', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '1.9.0')).toBeGreaterThan(0);
  });

  it('sorts pre-releases below the corresponding release', () => {
    expect(compareVersions('1.1.1-rc.1', '1.1.1')).toBeLessThan(0);
    expect(compareVersions('1.1.1', '1.1.1-rc.1')).toBeGreaterThan(0);
  });

  it('compares numeric pre-release identifiers numerically', () => {
    expect(compareVersions('1.1.1-rc.10', '1.1.1-rc.9')).toBeGreaterThan(0);
    expect(compareVersions('1.1.1-rc.2', '1.1.1-rc.10')).toBeLessThan(0);
    expect(compareVersions('1.1.1-rc.1', '1.1.1-rc.1')).toBe(0);
  });

  it('compares pre-release identifier segments in order', () => {
    expect(compareVersions('1.1.1-rc.1', '1.1.1-rc.1.1')).toBeLessThan(0);
    expect(compareVersions('1.1.1-rc.1.1', '1.1.1-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('1.1.1-alpha.2', '1.1.1-alpha.10')).toBeLessThan(0);
  });

  it('sorts numeric pre-release identifiers below alphanumeric ones', () => {
    expect(compareVersions('1.1.1-rc.1', '1.1.1-rc.beta')).toBeLessThan(0);
    expect(compareVersions('1.1.1-rc.beta', '1.1.1-rc.1')).toBeGreaterThan(0);
  });

  it('compares alphanumeric pre-release identifiers lexically', () => {
    expect(compareVersions('1.1.1-alpha', '1.1.1-beta')).toBeLessThan(0);
    expect(compareVersions('1.1.1-beta', '1.1.1-alpha')).toBeGreaterThan(0);
  });

  it('returns UNPARSEABLE_VERSION when either input is unparseable', () => {
    expect(compareVersions('latest', '1.1.1')).toBe(UNPARSEABLE_VERSION);
    expect(compareVersions('1.1.1', 'nope')).toBe(UNPARSEABLE_VERSION);
  });
});

describe('formatVersion()', () => {
  it('formats a parsed version back to its canonical string', () => {
    expect(formatVersion({ major: 1, minor: 2, patch: 3, prerelease: null })).toBe('1.2.3');
    expect(formatVersion({ major: 1, minor: 1, patch: 1, prerelease: 'rc.1' })).toBe('1.1.1-rc.1');
  });
});

describe('MINIMUM_OPENCODE_VERSION', () => {
  it('is a valid semantic version above 1.1.0', () => {
    expect(MINIMUM_OPENCODE_VERSION).toBe('1.1.1');
    expect(parseVersion(MINIMUM_OPENCODE_VERSION)).not.toBeNull();
    expect(compareVersions(MINIMUM_OPENCODE_VERSION, '1.1.0')).toBeGreaterThan(0);
  });
});
