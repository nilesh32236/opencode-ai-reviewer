import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
/**
 * Runtime coverage for the strict-checksum gate applied to a binary that is
 * already on PATH (`resolveOpenCodePath` / `setupOpenCode` in
 * `lib/src/opencode.ts`).
 *
 * These are end-to-end over the REAL filesystem and the REAL sha256
 * implementation: a real binary file in a real temp dir, a real attestation
 * file, and a real re-hash on every call. Only `io.which` (so PATH resolution
 * is controllable) and `@actions/core` (so log lines are assertable and quiet)
 * are mocked. No fs or checksum stubbing, so no digest comparison can pass
 * because a mock handed back the value under test.
 *
 * Every test title names the mutation it kills.
 */
import * as core from '@actions/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockIoWhich } = vi.hoisted(() => ({ mockIoWhich: vi.fn() }));

vi.mock('@actions/io', () => ({ which: mockIoWhich }));

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  addPath: vi.fn(),
  setOutput: vi.fn(),
  setSecret: vi.fn(),
  getInput: vi.fn(),
  getBooleanInput: vi.fn(),
  isDebug: vi.fn(() => false),
}));

import {
  resetOpenCodeState,
  resolveOpenCodePath,
  resolveRequireChecksum,
  setupOpenCode,
} from '../src/opencode.js';
import { ATTESTATION_PATH_ENV } from '../src/utils/attestation.js';

const IMAGE_ATTESTATION_PATH = '/usr/local/share/opencode/attestation.json';

describe('PATH binary vs. the build-time attestation (strict checksum gate)', () => {
  let dir: string;
  let binaryPath: string;
  let attestationPath: string;
  let binaryBody: string;
  let realBinarySha: string;
  const savedEnv = process.env[ATTESTATION_PATH_ENV];

  /** Write a record that attests the binary exactly as it is right now. */
  function writeHonestAttestation(overrides: Record<string, unknown> = {}): void {
    fs.writeFileSync(
      attestationPath,
      JSON.stringify({
        version: '1.18.31',
        binarySha256: realBinarySha,
        source: 'dockerfile-build',
        ...overrides,
      }),
      'utf-8',
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetOpenCodeState();

    // os.tmpdir() honours TMPDIR; CI/harness runs point it at a disk-backed dir.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-runtime-'));
    binaryPath = path.join(dir, 'opencode');
    attestationPath = path.join(dir, 'attestation.json');

    binaryBody = '#!/bin/sh\necho opencode v1.18.31\n';
    fs.writeFileSync(binaryPath, binaryBody, { mode: 0o755 });
    realBinarySha = crypto.createHash('sha256').update(binaryBody).digest('hex');

    process.env[ATTESTATION_PATH_ENV] = attestationPath;
    mockIoWhich.mockResolvedValue(binaryPath);
  });

  afterEach(() => {
    try {
      fs.chmodSync(attestationPath, 0o644);
    } catch {
      /* never created */
    }
    if (savedEnv === undefined) delete process.env[ATTESTATION_PATH_ENV];
    else process.env[ATTESTATION_PATH_ENV] = savedEnv;
    fs.rmSync(dir, { recursive: true, force: true });
    resetOpenCodeState();
  });

  describe('the accept path', () => {
    it('ALLOWS a PATH binary backed by a valid attestation that matches on disk', async () => {
      writeHonestAttestation();

      await expect(
        resolveOpenCodePath('latest', undefined, { requireChecksum: true }),
      ).resolves.toBe(binaryPath);
    });

    it('logs that the binary was attested, naming the record and its source', async () => {
      writeHonestAttestation();
      await resolveOpenCodePath('latest', undefined, { requireChecksum: true });

      const logged = (core.info as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => String(c[0]))
        .join('\n');
      expect(logged).toMatch(/integrity verified/i);
      expect(logged).toContain(binaryPath);
      expect(logged).toContain(attestationPath);
      expect(logged).toContain('dockerfile-build');
      // Must not silently degrade to the "no attestation" path.
      expect(logged).not.toMatch(/no build-time attestation was readable/i);
    });

    it('KILLS "case-sensitive digest compare": an UPPERCASE recorded digest still verifies', async () => {
      // The builder could emit either case; a raw byte compare would reject
      // this even though the binary is byte-for-byte the attested one.
      writeHonestAttestation({ binarySha256: realBinarySha.toUpperCase() });

      await expect(
        resolveOpenCodePath('latest', undefined, { requireChecksum: true }),
      ).resolves.toBe(binaryPath);
    });

    it('accepts the same binary through setupOpenCode(), not just resolveOpenCodePath()', async () => {
      // Both entry points reach the same gate; a fix applied to only one of
      // them would leave the other throwing on a perfectly good binary.
      writeHonestAttestation();

      await expect(
        setupOpenCode('latest', undefined, undefined, { requireChecksum: true }),
      ).resolves.toBe(binaryPath);
      resetOpenCodeState();
      await expect(
        setupOpenCode('latest', undefined, undefined, { requireChecksum: true }),
      ).resolves.toBe(binaryPath);
    });
  });

  describe('the reject path', () => {
    /** Assert the strict gate refused the binary with an integrity error. */
    async function expectRejected(promise: Promise<unknown>): Promise<Error> {
      let caught: unknown;
      try {
        await promise;
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      const err = caught as Error;
      expect(err.message).toMatch(/OpenCode integrity verification failed/i);
      // Deterministic failure: tagged non-retryable so withRetry fails fast.
      expect((err as Error & { status?: number }).status).toBe(422);
      return err;
    }

    it('KILLS "no attestation means no check": a missing attestation is REJECTED', async () => {
      // This is the unauthenticated-PATH-binary case the whole control exists
      // for: a binary merely present on PATH, with nothing vouching for it.
      expect(fs.existsSync(attestationPath)).toBe(false);

      const err = await expectRejected(
        resolveOpenCodePath('latest', undefined, { requireChecksum: true }),
      );
      expect(err.message).toContain(attestationPath);
    });

    it('KILLS "re-hash the file at setup time only": a binary swapped AFTER attestation is REJECTED', async () => {
      writeHonestAttestation();
      // Post-build tampering: the record still says the original digest.
      fs.writeFileSync(binaryPath, `${binaryBody}echo pwned\n`, { mode: 0o755 });

      const err = await expectRejected(
        resolveOpenCodePath('latest', undefined, { requireChecksum: true }),
      );
      expect(err.message).toMatch(/does not match the binary on disk/i);
      expect(err.message).toContain(binaryPath);
    });

    it('KILLS "re-read the digest from the record at verify time": a swapped attestation digest is REJECTED', async () => {
      // The record now claims the digest of something else entirely.
      writeHonestAttestation({ binarySha256: crypto.randomBytes(32).toString('hex') });

      const err = await expectRejected(
        resolveOpenCodePath('latest', undefined, { requireChecksum: true }),
      );
      expect(err.message).toMatch(/does not match the binary on disk/i);
    });

    it('KILLS "compare a prefix only": an attestation whose digest shares a long prefix is REJECTED', async () => {
      // 63 of 64 hex characters identical — a prefix/early-exit comparison
      // would wave this through.
      writeHonestAttestation({ binarySha256: realBinarySha.slice(0, 63) });
      await expectRejected(resolveOpenCodePath('latest', undefined, { requireChecksum: true }));

      // And the same with a single differing trailing character.
      const flipped = `${realBinarySha.slice(0, 63)}${realBinarySha.at(-1) === 'a' ? 'b' : 'a'}`;
      writeHonestAttestation({ binarySha256: flipped });
      await expectRejected(resolveOpenCodePath('latest', undefined, { requireChecksum: true }));
    });

    // The raw bodies are built inside each test (not in an `it.each` table)
    // because the table is evaluated at collection time, before `beforeEach`
    // has created the binary and computed its digest.
    const MALFORMED: Array<[string, (sha: string) => string]> = [
      ['not JSON at all', () => 'definitely not json'],
      ['truncated JSON', () => '{"version":"1.0.0","binarySha256":'],
      ['an empty file', () => ''],
      ['a JSON array', () => '[]'],
      ['a JSON scalar', () => '1234'],
      // Missing / wrong-typed fields.
      ['a record with no binarySha256', () => '{"version":"1.0.0","source":"dockerfile-build"}'],
      ['a record with no version', (sha) => `{"binarySha256":"${sha}","source":"s"}`],
      ['a record with no source', (sha) => `{"version":"1.0.0","binarySha256":"${sha}"}`],
      ['a numeric binarySha256', () => '{"version":"1.0.0","binarySha256":1234,"source":"s"}'],
      [
        'a sha256:-prefixed binarySha256',
        (sha) => `{"version":"1.0.0","binarySha256":"sha256:${sha}","source":"s"}`,
      ],
      [
        'a short binarySha256',
        (sha) => `{"version":"1.0.0","binarySha256":"${sha.slice(0, 40)}","source":"s"}`,
      ],
    ];

    for (const [label, build] of MALFORMED) {
      it(`KILLS "recover from a malformed record": ${label} is REJECTED`, async () => {
        fs.writeFileSync(attestationPath, build(realBinarySha), 'utf-8');

        await expectRejected(resolveOpenCodePath('latest', undefined, { requireChecksum: true }));
      });
    }

    it('KILLS "let an EACCES escape the helper": an unreadable attestation path is REJECTED', async () => {
      writeHonestAttestation();
      fs.chmodSync(attestationPath, 0o000);

      // Guard: a root runner would still read it; that is not a code defect.
      let readable = true;
      try {
        fs.readFileSync(attestationPath, 'utf-8');
      } catch {
        readable = false;
      }
      if (readable) return;

      await expectRejected(resolveOpenCodePath('latest', undefined, { requireChecksum: true }));
    });

    it('KILLS "treat a directory as an empty record": an unreadable attestation PATH is REJECTED', async () => {
      const asDir = path.join(dir, 'attestation-as-dir');
      fs.mkdirSync(asDir);
      process.env[ATTESTATION_PATH_ENV] = asDir;

      await expectRejected(resolveOpenCodePath('latest', undefined, { requireChecksum: true }));
    });

    it('KILLS "cache the verified verdict": a second call re-hashes and re-rejects', async () => {
      // Verifying once and memoizing would let a swap between calls through.
      writeHonestAttestation();
      await resolveOpenCodePath('latest', undefined, { requireChecksum: true });
      resetOpenCodeState();

      fs.writeFileSync(binaryPath, 'evil\n', { mode: 0o755 });
      mockIoWhich.mockResolvedValue(binaryPath);
      await expectRejected(resolveOpenCodePath('latest', undefined, { requireChecksum: true }));
    });

    it('KILLS "treat a hash failure as a pass": a binary that vanished after PATH lookup is REJECTED', async () => {
      // TOCTOU: io.which resolved a path, then the file was removed before the
      // attestation re-hash could read it. computeSha256 rejects; the gate must
      // treat that rejection as a verification failure, never as a pass.
      writeHonestAttestation();
      const ghost = path.join(dir, 'ghost-opencode');
      mockIoWhich.mockResolvedValue(ghost);
      expect(fs.existsSync(ghost)).toBe(false);

      await expectRejected(resolveOpenCodePath('latest', undefined, { requireChecksum: true }));

      // ...and it must not be papered over with a "verified" log line.
      const logged = (core.info as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => String(c[0]))
        .join('\n');
      expect(logged).not.toMatch(/integrity verified/i);
    });
  });

  describe('opt-out still works', () => {
    it('ALLOWS an unattested PATH binary when requireChecksum is explicitly false', async () => {
      expect(fs.existsSync(attestationPath)).toBe(false);

      await expect(
        resolveOpenCodePath('latest', undefined, { requireChecksum: false }),
      ).resolves.toBe(binaryPath);
    });

    it('ALLOWS a tampered binary when requireChecksum is explicitly false', async () => {
      writeHonestAttestation();
      fs.writeFileSync(binaryPath, 'evil\n', { mode: 0o755 });

      await expect(
        resolveOpenCodePath('latest', undefined, { requireChecksum: false }),
      ).resolves.toBe(binaryPath);
    });

    it('ALLOWS via INPUT_REQUIRE_OPENCODE_CHECKSUM=false with no explicit option', async () => {
      process.env.INPUT_REQUIRE_OPENCODE_CHECKSUM = 'false';
      try {
        expect(resolveRequireChecksum()).toBe(false);
        await expect(resolveOpenCodePath('latest')).resolves.toBe(binaryPath);
      } finally {
        // biome-ignore lint/performance/noDelete: test isolation requires removing the var
        delete process.env.INPUT_REQUIRE_OPENCODE_CHECKSUM;
      }
    });
  });

  describe('fail-closed default (resolveRequireChecksum)', () => {
    const ENV_KEY = 'INPUT_REQUIRE_OPENCODE_CHECKSUM';
    let saved: string | undefined;

    beforeEach(() => {
      saved = process.env[ENV_KEY];
      delete process.env[ENV_KEY];
    });

    afterEach(() => {
      if (saved === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = saved;
    });

    it('KILLS "unset means fail-open": enforcement is ON when nothing is set', () => {
      expect(resolveRequireChecksum()).toBe(true);
      expect(resolveRequireChecksum({})).toBe(true);
    });

    it.each([
      ['an empty string', ''],
      ['whitespace', '   '],
      ['a typo', 'ture'],
      ['a numeric 1', '1'],
      ['"no"', 'no'],
      ['"0"', '0'],
    ])('KILLS "treat a non-false value as opt-out": %s leaves enforcement ON', (_l, v) => {
      process.env[ENV_KEY] = v;
      expect(resolveRequireChecksum()).toBe(true);
    });

    it.each([
      ['false', 'false'],
      ['False', 'False'],
      ['FALSE', 'FALSE'],
      ['padded false', '  false  '],
    ])('treats only %s as the opt-out', (_l, v) => {
      process.env[ENV_KEY] = v;
      expect(resolveRequireChecksum()).toBe(false);
    });

    it('still lets an explicit option win over the env var', () => {
      process.env[ENV_KEY] = 'false';
      expect(resolveRequireChecksum({ requireChecksum: true })).toBe(true);
      process.env[ENV_KEY] = 'true';
      expect(resolveRequireChecksum({ requireChecksum: false })).toBe(false);
    });

    it('REJECTS an unattested PATH binary with no option and no env var at all', async () => {
      // The scenario that made the default un-flippable: the Probot app
      // forwards `requireChecksum: undefined`, so this is what /setup does.
      await expect(resolveOpenCodePath('latest')).rejects.toThrow(
        /OpenCode integrity verification failed/i,
      );
    });
  });

  describe('production default path', () => {
    it('reads the well-known image location when no env override is set', async () => {
      // A build that forgot to emit the attestation at the documented path
      // must fail closed, not fall through to some other location.
      delete process.env[ATTESTATION_PATH_ENV];

      let caught: unknown;
      try {
        await resolveOpenCodePath('latest', undefined, { requireChecksum: true });
      } catch (err) {
        caught = err;
      }
      expect((caught as Error | undefined)?.message).toContain(IMAGE_ATTESTATION_PATH);
    });
  });
});
