/**
 * A parsed semantic version.
 */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifier (e.g. "rc.1") or null for a release version. */
  prerelease: string | null;
}

/** Sentinel returned by {@link compareVersions} when either input is unparseable. */
export const UNPARSEABLE_VERSION = Number.MAX_SAFE_INTEGER;

/**
 * Minimum supported OpenCode CLI version. The v1.1.1 release introduced the
 * `permission` config system that `buildCIConfig()` depends on (the legacy
 * `tools` boolean block was deprecated and merged into `permission`), so older
 * binaries cannot reliably run our non-interactive invocations.
 */
export const MINIMUM_OPENCODE_VERSION = '1.1.1';

/**
 * Parse a semantic version string (e.g. "v1.2.3", "1.2.3-rc.1").
 * Build metadata is ignored; pre-release suffixes are captured for ordering.
 * @param text - The version text to parse.
 * @returns A parsed version, or null when no semver shape is found.
 */
export function parseVersion(text: string): ParsedVersion | null {
  const match = text.match(/\bv?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?/);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4] || null,
  };
}

/**
 * Compare two semantic version strings per the SemVer 2.0.0 ordering rules.
 * Pre-release versions sort below the corresponding release (1.1.1-rc.1 < 1.1.1),
 * and pre-release identifiers are compared segment-wise: numeric identifiers are
 * compared numerically (1.1.1-rc.10 > 1.1.1-rc.2), numeric identifiers sort below
 * alphanumeric ones, and alphanumeric identifiers compare lexically (ASCII).
 * @param a - First version string.
 * @param b - Second version string.
 * @returns Negative when a < b, positive when a > b, 0 when equal, or
 * {@link UNPARSEABLE_VERSION} when either input cannot be parsed so callers
 * never silently treat an unparseable version as "pass".
 */
export function compareVersions(a: string, b: string): number {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  if (!av || !bv) return UNPARSEABLE_VERSION;
  if (av.major !== bv.major) return av.major - bv.major;
  if (av.minor !== bv.minor) return av.minor - bv.minor;
  if (av.patch !== bv.patch) return av.patch - bv.patch;
  return comparePrerelease(av.prerelease, bv.prerelease);
}

/**
 * Compare two pre-release identifiers (or null for a release version) using
 * SemVer precedence rules. A release version (null) always sorts above any
 * pre-release of the same major.minor.patch.
 * @param a - Pre-release identifier of the first version, or null.
 * @param b - Pre-release identifier of the second version, or null.
 * @returns Negative when a < b, positive when a > b, 0 when equal.
 */
function comparePrerelease(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const aParts = a.split('.');
  const bParts = b.split('.');
  const segmentCount = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < segmentCount; i++) {
    const aPart = aParts[i];
    const bPart = bParts[i];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    const cmp = comparePrereleaseSegment(aPart, bPart);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

/**
 * Compare two single pre-release identifier segments.
 * Numeric identifiers compare numerically and sort below alphanumeric ones;
 * alphanumeric identifiers compare lexically (ASCII).
 * @param a - First identifier segment.
 * @param b - Second identifier segment.
 * @returns Negative when a < b, positive when a > b, 0 when equal.
 */
function comparePrereleaseSegment(a: string, b: string): number {
  if (a === b) return 0;
  const aIsNumeric = /^\d+$/.test(a);
  const bIsNumeric = /^\d+$/.test(b);
  if (aIsNumeric && bIsNumeric) {
    const aNum = BigInt(a);
    const bNum = BigInt(b);
    return aNum < bNum ? -1 : aNum > bNum ? 1 : 0;
  }
  if (aIsNumeric) return -1;
  if (bIsNumeric) return 1;
  return a < b ? -1 : 1;
}

/**
 * Format a parsed version back into its canonical string form.
 * @param version - The parsed version to format.
 * @returns "major.minor.patch" with an optional "-prerelease" suffix.
 */
export function formatVersion(version: ParsedVersion): string {
  return version.prerelease
    ? `${version.major}.${version.minor}.${version.patch}-${version.prerelease}`
    : `${version.major}.${version.minor}.${version.patch}`;
}
