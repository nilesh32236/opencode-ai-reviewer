/**
 * Unit coverage for the build-time attestation helper
 * (`lib/src/utils/attestation.ts`).
 *
 * Everything here uses REAL files in a real temp directory and the REAL
 * `computeSha256` — no fs/checksum mocking — so a digest comparison cannot
 * pass because a mock returned the value under test. Each test names the
 * mutation it kills in its title, so the discrimination claim is auditable.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockTimingSafeEqual } = vi.hoisted(() => ({ mockTimingSafeEqual: vi.fn() }));

// Only the comparator is wrapped; every other member (createHash, used by
// computeSha256) stays real, so the file hashing under test is untouched.
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  mockTimingSafeEqual.mockImplementation((a: Buffer, b: Buffer) => actual.timingSafeEqual(a, b));
  return { ...actual, timingSafeEqual: mockTimingSafeEqual };
});

import {
  ATTESTATION_PATH_ENV,
  DEFAULT_ATTESTATION_PATH,
  digestEquals,
  parseBinaryAttestation,
  readBinaryAttestation,
  resolveAttestationPath,
  verifyAttestedBinary,
} from '../src/utils/attestation.js';

const HEX64 = 'a'.repeat(64);
const HEX64_UPPER = 'A'.repeat(64);

describe('utils/attestation', () => {
  let dir: string;
  let binaryPath: string;
  let attestationPath: string;
  let binaryBody: string;
  let realBinarySha: string;
  const savedEnv = process.env[ATTESTATION_PATH_ENV];

  beforeEach(() => {
    // os.tmpdir() honours TMPDIR; the repo's CI/harness runs point it at a
    // disk-backed dir because /tmp is a small tmpfs on the build hosts.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-helper-'));
    binaryPath = path.join(dir, 'opencode');
    attestationPath = path.join(dir, 'attestation.json');

    binaryBody = '#!/bin/sh\necho opencode v1.18.31\n';
    fs.writeFileSync(binaryPath, binaryBody, { mode: 0o755 });
    realBinarySha = crypto.createHash('sha256').update(binaryBody).digest('hex');

    // Default every test to the fixture attestation path so the production
    // well-known constant is never touched by an accident.
    process.env[ATTESTATION_PATH_ENV] = attestationPath;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ATTESTATION_PATH_ENV];
    else process.env[ATTESTATION_PATH_ENV] = savedEnv;
    // Restore write permission so cleanup can remove a chmod-000 fixture.
    try {
      fs.chmodSync(attestationPath, 0o644);
    } catch {
      /* never created */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeAttestation(raw: string): void {
    fs.writeFileSync(attestationPath, raw, 'utf-8');
  }

  function validRecord(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      version: '1.18.31',
      binarySha256: realBinarySha,
      source: 'dockerfile-build',
      ...overrides,
    });
  }

  describe('resolveAttestationPath()', () => {
    it('uses the well-known image path when the env override is unset', () => {
      delete process.env[ATTESTATION_PATH_ENV];
      expect(resolveAttestationPath()).toBe(DEFAULT_ATTESTATION_PATH);
      expect(DEFAULT_ATTESTATION_PATH).toBe('/usr/local/share/opencode/attestation.json');
    });

    it('honours the env override and trims surrounding whitespace', () => {
      process.env[ATTESTATION_PATH_ENV] = `  ${attestationPath}  `;
      expect(resolveAttestationPath()).toBe(attestationPath);
    });

    it('falls back to the default when the env override is whitespace-only', () => {
      process.env[ATTESTATION_PATH_ENV] = '   ';
      expect(resolveAttestationPath()).toBe(DEFAULT_ATTESTATION_PATH);
    });
  });

  describe('parseBinaryAttestation()', () => {
    it('accepts a well-formed record and preserves the digest byte-for-byte', () => {
      const parsed = parseBinaryAttestation({
        version: '1.18.31',
        binarySha256: HEX64_UPPER,
        source: 'dockerfile-build',
      });
      expect(parsed).toEqual({
        version: '1.18.31',
        binarySha256: HEX64_UPPER,
        source: 'dockerfile-build',
      });
    });

    it('ignores unknown extra fields instead of rejecting the record', () => {
      // Forward-compatibility: a newer builder may add fields. Only the three
      // load-bearing ones are read, so extras must not break the trust path.
      const parsed = parseBinaryAttestation({
        version: '1.18.31',
        binarySha256: HEX64,
        source: 'dockerfile-build',
        builtAt: '2026-09-26T00:00:00Z',
        extra: { nested: true },
      });
      expect(parsed?.source).toBe('dockerfile-build');
    });

    it.each([
      ['null', null],
      ['an array', []],
      ['a string', 'not-a-record'],
      ['a number', 42],
      ['a boolean', true],
    ])('rejects %s as a non-record', (_label, value) => {
      expect(parseBinaryAttestation(value)).toBeNull();
    });

    it.each([
      ['binarySha256 missing', { version: '1.0.0', source: 's' }],
      ['version missing', { binarySha256: HEX64, source: 's' }],
      ['source missing', { version: '1.0.0', binarySha256: HEX64 }],
    ])('rejects a record with %s', (_label, value) => {
      expect(parseBinaryAttestation(value)).toBeNull();
    });

    it.each([
      ['an empty binarySha256', { version: 'v', source: 's', binarySha256: '' }],
      ['a 63-char binarySha256', { version: 'v', source: 's', binarySha256: 'a'.repeat(63) }],
      ['a 65-char binarySha256', { version: 'v', source: 's', binarySha256: 'a'.repeat(65) }],
      [
        'a sha256:-prefixed binarySha256',
        { version: 'v', source: 's', binarySha256: `sha256:${HEX64}` },
      ],
      ['a non-hex binarySha256', { version: 'v', source: 's', binarySha256: 'z'.repeat(64) }],
      // No silent coercion: a numeric digest must never be stringified into
      // something that could compare equal to a real hash.
      ['a numeric binarySha256', { version: 'v', source: 's', binarySha256: 1234 }],
      ['a null binarySha256', { version: 'v', source: 's', binarySha256: null }],
      ['an array binarySha256', { version: 'v', source: 's', binarySha256: [HEX64] }],
      ['an object binarySha256', { version: 'v', source: 's', binarySha256: { h: HEX64 } }],
      ['an empty version', { version: '   ', source: 's', binarySha256: HEX64 }],
      ['a numeric version', { version: 1, source: 's', binarySha256: HEX64 }],
      ['an empty source', { version: 'v', source: '', binarySha256: HEX64 }],
      ['a numeric source', { version: 'v', source: 1, binarySha256: HEX64 }],
    ])('rejects %s', (_label, value) => {
      expect(parseBinaryAttestation(value)).toBeNull();
    });
  });

  describe('readBinaryAttestation()', () => {
    it('reads a valid record from disk', () => {
      writeAttestation(validRecord());
      expect(readBinaryAttestation()).toEqual({
        version: '1.18.31',
        binarySha256: realBinarySha,
        source: 'dockerfile-build',
      });
    });

    it('KILLS "swallow missing file and return a record": an absent file is null', () => {
      // No attestation on disk at all.
      expect(fs.existsSync(attestationPath)).toBe(false);
      expect(readBinaryAttestation()).toBeNull();
    });

    it('KILLS "empty file parses as an empty record": blank content is null', () => {
      writeAttestation('');
      expect(readBinaryAttestation()).toBeNull();
    });

    it.each([
      ['truncated JSON', '{"version": "1.0.0", "binarySha256":'],
      ['not JSON at all', 'this is not json'],
      ['a JSON scalar', '42'],
      ['a JSON null', 'null'],
      ['an empty JSON object', '{}'],
    ])('KILLS "recover from a bad record": %s is rejected', (_label, raw) => {
      writeAttestation(raw);
      expect(readBinaryAttestation()).toBeNull();
    });

    it('KILLS "ignore the digest field shape": a tampered digest of the wrong length is rejected', () => {
      writeAttestation(validRecord({ binarySha256: 'deadbeef' }));
      expect(readBinaryAttestation()).toBeNull();
    });

    it('KILLS "treat a directory as an empty record": an unreadable path is null', () => {
      // EISDIR on readFileSync — a path that exists but cannot be read must
      // behave exactly like a missing one, never throw out of the helper.
      const asDir = path.join(dir, 'attestation-as-dir');
      fs.mkdirSync(asDir);
      expect(() => readBinaryAttestation(asDir)).not.toThrow();
      expect(readBinaryAttestation(asDir)).toBeNull();
    });

    it('KILLS "let an EACCES escape and be swallowed upstream": chmod 000 is null, not a throw', () => {
      writeAttestation(validRecord());
      fs.chmodSync(attestationPath, 0o000);
      // Guard: a root test runner could read it anyway; that is not a defect
      // in the code under test, so skip rather than assert a false failure.
      let readable = true;
      try {
        fs.readFileSync(attestationPath, 'utf-8');
      } catch {
        readable = false;
      }
      if (readable) return;

      expect(() => readBinaryAttestation()).not.toThrow();
      expect(readBinaryAttestation()).toBeNull();
    });

    it('accepts an explicit path argument over the env override', () => {
      const other = path.join(dir, 'other.json');
      fs.writeFileSync(other, validRecord({ source: 'explicit-path' }));
      expect(readBinaryAttestation(other)?.source).toBe('explicit-path');
    });
  });

  describe('digestEquals()', () => {
    it('matches identical lowercase digests', () => {
      expect(digestEquals(HEX64, HEX64)).toBe(true);
    });

    it('KILLS "case-sensitive digest compare": uppercase vs lowercase still matches', () => {
      // Kills a mutation that drops the toLowerCase() normalization and
      // compares the raw bytes, which would reject a builder that wrote the
      // digest in uppercase.
      expect(digestEquals(HEX64_UPPER, HEX64)).toBe(true);
      expect(digestEquals(HEX64, HEX64_UPPER)).toBe(true);
      expect(digestEquals(HEX64_UPPER, HEX64_UPPER)).toBe(true);
    });

    it('rejects digests that differ in a single character', () => {
      const other = `b${'a'.repeat(63)}`;
      expect(digestEquals(HEX64, other)).toBe(false);
      // ...including at the very last character, which a prefix-compare or an
      // early-returning loop could miss.
      const lastDiff = `${'a'.repeat(63)}b`;
      expect(digestEquals(HEX64, lastDiff)).toBe(false);
    });

    it('KILLS "compare raw bytes with no shape guard": two IDENTICAL malformed digests are NOT equal', () => {
      // This is the only observable the SHA256_HEX guard controls. With the
      // guard removed both operands are byte-identical, so a plain compare
      // returns true — i.e. a digest of a shape we cannot read with certainty
      // would be reported "verified". Every other malformed-input case is
      // already caught by the length check, so it does not discriminate.
      expect(digestEquals('z'.repeat(64), 'z'.repeat(64))).toBe(false);
      expect(digestEquals(`sha256:${HEX64}`, `sha256:${HEX64}`)).toBe(false);
      expect(digestEquals(` ${HEX64} `, ` ${HEX64} `)).toBe(false);
    });

    it('KILLS "swap the constant-time compare for ==": timingSafeEqual is the comparator', () => {
      // A functional test cannot observe a timing side channel, so assert the
      // comparator directly: digestEquals must delegate to timingSafeEqual
      // with equal-length byte buffers rather than comparing strings.
      mockTimingSafeEqual.mockClear();
      expect(digestEquals(HEX64, HEX64)).toBe(true);
      expect(mockTimingSafeEqual).toHaveBeenCalledTimes(1);
      const [left, right] = mockTimingSafeEqual.mock.calls[0] as [Buffer, Buffer];
      expect(Buffer.isBuffer(left)).toBe(true);
      expect(Buffer.isBuffer(right)).toBe(true);
      expect(left.toString('utf-8')).toBe(HEX64);
      expect(right.toString('utf-8')).toBe(HEX64);
    });

    it.each([
      ['an empty string', ''],
      ['a 63-char string', 'a'.repeat(63)],
      ['a 65-char string', 'a'.repeat(65)],
      ['a sha256: prefix', `sha256:${HEX64}`],
      ['non-hex characters', 'z'.repeat(64)],
      ['surrounding whitespace', ` ${HEX64} `],
    ])('KILLS "coerce a malformed operand into a match": %s is never equal', (_label, bad) => {
      // A lenient comparator that padded/trimmed or coerced could turn one of
      // these into `true`; the helper must not.
      expect(digestEquals(bad, HEX64)).toBe(false);
      expect(digestEquals(HEX64, bad)).toBe(false);
    });

    it('does not throw on malformed operands', () => {
      expect(() => digestEquals('nope', 'also-nope')).not.toThrow();
    });
  });

  describe('verifyAttestedBinary()', () => {
    it('accepts a binary whose on-disk digest matches the attestation', async () => {
      const record = parseBinaryAttestation(JSON.parse(validRecord()));
      expect(record).not.toBeNull();
      await expect(verifyAttestedBinary(binaryPath, record!)).resolves.toBe(true);
    });

    it('KILLS "trust the record without hashing": a binary replaced after the build fails', async () => {
      const record = parseBinaryAttestation(JSON.parse(validRecord()));
      // The digest the build recorded is now stale — the file on disk differs.
      fs.writeFileSync(binaryPath, `${binaryBody}echo pwned\n`, { mode: 0o755 });
      await expect(verifyAttestedBinary(binaryPath, record!)).resolves.toBe(false);
    });

    it('KILLS "accept an uppercase recorded digest verbatim only": case-insensitive match on disk', async () => {
      const record = parseBinaryAttestation(
        JSON.parse(validRecord({ binarySha256: realBinarySha.toUpperCase() })),
      );
      // computeSha256 always emits lowercase; the recorded value is uppercase.
      await expect(verifyAttestedBinary(binaryPath, record!)).resolves.toBe(true);
    });

    it('KILLS "treat an empty file as hashable/verifiable": a truncated binary fails', async () => {
      const record = parseBinaryAttestation(JSON.parse(validRecord()));
      fs.writeFileSync(binaryPath, '', { mode: 0o755 });
      await expect(verifyAttestedBinary(binaryPath, record!)).resolves.toBe(false);
    });

    it('KILLS "swallow the read error and return true": a missing binary propagates, it does not pass', async () => {
      const record = parseBinaryAttestation(JSON.parse(validRecord()));
      const gone = path.join(dir, 'not-installed');
      // The contract is explicit: this REJECTS. A caller that treats a
      // rejection as "verified" is the bug this test exists to prevent.
      await expect(verifyAttestedBinary(gone, record!)).rejects.toThrow();
    });
  });
});

// F-1: a RELATIVE override resolves against process.cwd(), which in the image
// is /app -- chowned to the unprivileged `reviewer` user. Accepting one lets the
// runtime user point the gate at a record it wrote, converting a filesystem
// guarantee into a config guarantee. The override exists for non-POSIX layouts,
// which all use absolute paths, so a relative value is refused outright.
describe('attestation path override is absolute-only', () => {
  const ENV = 'OPENCODE_BINARY_ATTESTATION';
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  it('refuses a relative override', () => {
    process.env[ENV] = 'attestation.json';
    expect(() => resolveAttestationPath()).toThrow(/absolute path/);
  });

  it('KILLS "let the config error escape readBinaryAttestation": a relative override is null, not a throw', () => {
    // readBinaryAttestation documents "nothing here throws" — a relative
    // override must degrade to "no usable attestation" (null), which fails
    // closed at the enforcement call site, rather than surfacing the
    // AttestationConfigError in place of the integrity error.
    process.env[ENV] = 'attestation.json';
    expect(() => readBinaryAttestation()).not.toThrow();
    expect(readBinaryAttestation()).toBeNull();
  });

  it('refuses a traversal override such as ../attestation.json', () => {
    process.env[ENV] = '../attestation.json';
    expect(() => resolveAttestationPath()).toThrow(/absolute path/);
  });

  it('still accepts an absolute override', () => {
    process.env[ENV] = '/opt/custom/attestation.json';
    expect(resolveAttestationPath()).toBe('/opt/custom/attestation.json');
  });

  it('falls back to the default for an empty or whitespace value', () => {
    for (const v of ['', '   ']) {
      process.env[ENV] = v;
      expect(resolveAttestationPath()).toBe(DEFAULT_ATTESTATION_PATH);
    }
  });
});
