/**
 * Build-time attestation for a pre-installed OpenCode CLI binary.
 *
 * The strict checksum gate (`require_opencode_checksum`, see
 * `resolveRequireChecksum` in `opencode.ts`) cannot verify a binary that was
 * already on PATH: no archive is downloaded, so there is no archive to
 * checksum. The previous behavior therefore rejected *every* PATH binary
 * under strict mode, which is correct but unsatisfiable for deployments that
 * legitimately ship their own verified binary — notably this repository's
 * Docker/Probot image, which installs the CLI at build time.
 *
 * An attestation closes that gap without weakening the gate. The image build
 * verifies the downloaded archive against a pinned SHA-256, then records what
 * the *extracted binary* actually hashes to. At runtime the binary on disk is
 * re-hashed and compared against that record.
 *
 * The trust root is the build itself: whoever can write the attestation file
 * can also swap the digest it claims. So the record is only meaningful when it
 * is no more writable than the binary it describes — `docker/Dockerfile` keeps
 * it root-owned and read-only while the binary itself stays writable by the
 * unprivileged runtime user, so tampering with the *binary* is detected at
 * the next `resolveOpenCodePath` / `setupOpenCode` call, and PATH-poisoning
 * with a *different* binary fails the digest
 * check. This is deliberately NOT a signature: it makes an unverifiable
 * environment fail closed instead of unverifiably, and it does not defend
 * against an attacker who can already rewrite the attestation.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import { computeSha256 } from './checksum.js';

/**
 * Tag an attestation-configuration failure so callers can distinguish a bad
 * record from an unverifiable binary. Mirrors the 422 integrity classification
 * used on the OpenCode path without importing that module.
 * @param message - Human-readable description of the configuration fault.
 * @returns The error, with `attestationConfig` set for the caller.
 */
function markAttestationError(message: string): Error {
  const err = new Error(message);
  Object.assign(err, { name: 'AttestationConfigError', attestationConfig: true });
  return err;
}

/**
 * Well-known location of the build-time attestation record inside the runtime
 * image. Kept outside the binary's own directory (`/usr/local/bin`) so the
 * record can be owned by root and left read-only while the binary next to it
 * stays writable — see the module comment.
 */
export const DEFAULT_ATTESTATION_PATH = '/usr/local/share/opencode/attestation.json';

/**
 * Environment variable that overrides {@link DEFAULT_ATTESTATION_PATH}.
 *
 * Needed on platforms that do not use the POSIX layout above (Windows), and
 * available to tests so a fixture directory can stand in for the image.
 */
export const ATTESTATION_PATH_ENV = 'OPENCODE_BINARY_ATTESTATION';

/**
 * A parsed, structurally valid build-time attestation record.
 *
 * Every field is required. A record that is missing any of them, or that
 * carries a field of the wrong type, is rejected by
 * {@link readBinaryAttestation} rather than partially trusted.
 */
export interface BinaryAttestation {
  /** Version string of the installed binary, as reported by the build. */
  version: string;
  /** SHA-256 hex digest of the *installed binary file*, not of its archive. */
  binarySha256: string;
  /** Identifier for what produced the record (e.g. `'dockerfile-build'`). */
  source: string;
}

/** A bare SHA-256 hex digest: exactly 64 hex characters, nothing else. */
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

/**
 * Resolve the attestation path to read, honouring
 * {@link ATTESTATION_PATH_ENV} and falling back to
 * {@link DEFAULT_ATTESTATION_PATH}.
 * @returns The absolute path of the attestation file to read.
 */
export function resolveAttestationPath(): string {
  const override = process.env[ATTESTATION_PATH_ENV]?.trim();
  if (override) {
    // A RELATIVE value resolves against process.cwd(), which in the image is
    // /app -- chowned to the unprivileged `reviewer` user. Accepting one would
    // turn a filesystem guarantee into a config guarantee and let the runtime
    // user point the gate at a record it controls. Refuse it outright; the
    // override exists for non-POSIX layouts, which all use absolute paths.
    if (!path.isAbsolute(override)) {
      throw markAttestationError(
        `${ATTESTATION_PATH_ENV} must be an absolute path, got ${JSON.stringify(override)}. ` +
          `A relative path resolves against the working directory, which is not ` +
          `guaranteed to be operator-owned, so it cannot be trusted as the record.`,
      );
    }
    // Absolute is necessary but not sufficient: the record is only meaningful
    // while it is operator-owned and not group- or world-writable.
    core.warning(
      `${ATTESTATION_PATH_ENV} overrides the attestation path to ${override}. ` +
        `That record is trusted only if it is operator-owned and not group- or ` +
        `world-writable; a writable record provides no integrity guarantee.`,
    );
  }
  return override ? override : DEFAULT_ATTESTATION_PATH;
}

/**
 * Validate an already-parsed JSON value as a {@link BinaryAttestation}.
 *
 * Fail-closed and non-coercing: a value is accepted only when it is a plain
 * object whose `version`, `binarySha256` and `source` are all non-empty
 * strings, and whose `binarySha256` is exactly 64 hex characters. Numbers,
 * arrays, `null`, and hex digests carrying a `sha256:` prefix are all
 * rejected instead of being silently stringified or stripped — a digest this
 * function cannot read with certainty is a digest it must not trust.
 * @param value - The raw value parsed out of the attestation file.
 * @returns The validated record, or null when the value is not a valid record.
 */
export function parseBinaryAttestation(value: unknown): BinaryAttestation | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const { version, binarySha256, source } = record;

  if (typeof version !== 'string' || version.trim() === '') return null;
  if (typeof source !== 'string' || source.trim() === '') return null;
  if (typeof binarySha256 !== 'string' || !SHA256_HEX.test(binarySha256)) return null;

  // Keep the caller's exact bytes (case is irrelevant to the comparison, which
  // normalizes) so a round-trip through the file does not mutate the record.
  return { version, binarySha256, source };
}

/**
 * Read and parse a build-time attestation record.
 *
 * Every failure mode — file absent, unreadable (permissions, EISDIR), not
 * valid JSON, not a record of the expected shape — returns null. Callers treat
 * null as "no attestation", which under strict checksum enforcement means the
 * binary is rejected. Nothing here throws, because an attacker must not be
 * able to turn "the record is broken" into "the gate is skipped".
 * @param filePath - Attestation file to read; defaults to {@link resolveAttestationPath}.
 * @returns The validated record, or null when it is absent, unreadable or malformed.
 */
export function readBinaryAttestation(filePath?: string): BinaryAttestation | null {
  // resolveAttestationPath() throws AttestationConfigError on a relative
  // OPENCODE_BINARY_ATTESTATION override. Swallow it here so the "nothing
  // throws" contract holds: a broken override is "no usable attestation",
  // which fails closed at the enforcement call site rather than surfacing a
  // config error in place of the documented integrity error.
  let target: string;
  try {
    target = filePath ?? resolveAttestationPath();
  } catch {
    return null;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(target, 'utf-8');
  } catch {
    // ENOENT, EACCES, EISDIR, … — all equivalent to "no usable attestation".
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  return parseBinaryAttestation(parsed);
}

/**
 * Compare two SHA-256 digests for equality, case-insensitively, without an
 * early return that leaks the position of the first differing character.
 *
 * Both operands must be 64-char hex strings; anything else is a hard `false`
 * rather than a coerced comparison, so a malformed expected value can never be
 * "equal" to a well-formed actual one.
 * @param a - First digest (64-char hex, either case).
 * @param b - Second digest (64-char hex, either case).
 * @returns True when both operands are well-formed and equal after lowercasing.
 */
export function digestEquals(a: string, b: string): boolean {
  if (!SHA256_HEX.test(a) || !SHA256_HEX.test(b)) return false;

  const left = Buffer.from(a.toLowerCase(), 'utf-8');
  const right = Buffer.from(b.toLowerCase(), 'utf-8');
  // Lengths are equal by construction (both matched a 64-char pattern), but
  // timingSafeEqual throws on a mismatch, so keep the guard explicit.
  if (left.length !== right.length) return false;

  return crypto.timingSafeEqual(left, right);
}

/**
 * Re-verify a binary on disk against the digest recorded in an attestation.
 *
 * This is the load-bearing check of the whole trust path: the attestation says
 * what the build installed, and this hashes what is actually there now, so a
 * binary replaced after the build does not pass.
 * @param binaryPath - Absolute path to the installed binary to hash.
 * @param attestation - The validated record to compare against.
 * @returns True when the binary's actual SHA-256 matches `attestation.binarySha256`.
 * @throws {Error} Propagates the underlying read/hash failure (e.g. the file
 *   was removed between PATH resolution and hashing). Callers on an enforcement
 *   path must treat a throw as a verification failure, not as a pass.
 */
export async function verifyAttestedBinary(
  binaryPath: string,
  attestation: BinaryAttestation,
): Promise<boolean> {
  const actual = await computeSha256(binaryPath);
  return digestEquals(actual, attestation.binarySha256);
}
