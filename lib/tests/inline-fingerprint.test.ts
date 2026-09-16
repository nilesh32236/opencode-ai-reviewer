import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@actions/core', () => {
  const warning = vi.fn();
  const info = vi.fn();
  const debug = vi.fn();
  return { warning, info, debug };
});

import {
  FingerprintStore,
  collectFingerprintsFromBodies,
  extractFingerprintFromBody,
  filterIssuesByFingerprints,
  fingerprintFinding,
  fingerprintForIssue,
  isValidFingerprint,
  shortFingerprint,
  shouldPostFingerprint,
  withFingerprintMarker,
} from '../src/utils/inline-fingerprint.js';

const ISSUE = {
  file: 'src/foo.ts',
  line: 42,
  category: 'bugs',
  severity: 'important',
  message: 'Null dereference on user input',
  suggestion: 'Guard with optional chaining',
};

describe('inline-fingerprint', () => {
  it('produces a stable full-range 64-char sha256 fingerprint', () => {
    const a = fingerprintForIssue({ ...ISSUE });
    const b = fingerprintForIssue({ ...ISSUE, file: '/SRC/foo.ts' });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect(fingerprintFinding('a.ts', 1, 'bugs', 'x')).toHaveLength(64);
  });

  it('derives a short marker and validates both fingerprint forms', () => {
    const full = fingerprintForIssue({ ...ISSUE });
    expect(isValidFingerprint(full)).toBe(true);
    expect(isValidFingerprint(shortFingerprint(full))).toBe(true);
    expect(shortFingerprint(full)).toBe(full.slice(0, 16));
    expect(shortFingerprint('deadbeefdeadbeef')).toBe('deadbeefdeadbeef');
    expect(isValidFingerprint('deadbeefdeadbeef')).toBe(true);
    expect(isValidFingerprint('not-a-fingerprint')).toBe(false);
    expect(isValidFingerprint(undefined)).toBe(false);
  });

  it('extracts both full-range and legacy markers', () => {
    const full = fingerprintForIssue({ ...ISSUE });
    expect(extractFingerprintFromBody(withFingerprintMarker('hello', full))).toBe(full);
    expect(extractFingerprintFromBody('hello <!-- inline-fp:deadbeefdeadbeef -->')).toBe(
      'deadbeefdeadbeef',
    );
  });

  it('dedups across short/full marker forms server-side', () => {
    const full = fingerprintForIssue({ ...ISSUE });
    const short = shortFingerprint(full);
    // Full key against a known short marker, and vice versa.
    expect(shouldPostFingerprint(full, new Set([short]))).toBe(false);
    expect(shouldPostFingerprint(short, new Set([full]))).toBe(false);
    expect(shouldPostFingerprint(full, new Set([full]))).toBe(false);
  });

  it('changes fingerprint when line or snippet changes', () => {
    const base = fingerprintForIssue({ ...ISSUE });
    expect(fingerprintForIssue({ ...ISSUE, line: 43 })).not.toBe(base);
    expect(fingerprintForIssue({ ...ISSUE, message: 'Different problem' })).not.toBe(base);
    expect(fingerprintForIssue({ ...ISSUE, suggestion: 'Different fix' })).not.toBe(base);
  });

  it('skips identical findings and keeps changed ones', () => {
    const fp = fingerprintForIssue({ ...ISSUE });
    const known = new Set([fp]);
    const { kept, skipped } = filterIssuesByFingerprints(
      [{ ...ISSUE }, { ...ISSUE, line: 99 }],
      known,
    );
    expect(skipped).toHaveLength(1);
    expect(kept).toHaveLength(1);
    expect(kept[0].line).toBe(99);
  });

  it('is a no-op when disabled or history is empty', () => {
    const issues = [{ ...ISSUE }];
    expect(filterIssuesByFingerprints(issues, new Set(['abc'])).kept).toHaveLength(1);
    expect(
      filterIssuesByFingerprints(issues, new Set([fingerprintForIssue({ ...ISSUE })]), {
        enabled: false,
      }).kept,
    ).toHaveLength(1);
    expect(filterIssuesByFingerprints(issues, new Set()).kept).toHaveLength(1);
  });

  it('round-trips the marker through posted bodies', () => {
    const fp = fingerprintForIssue({ ...ISSUE });
    const body = withFingerprintMarker('hello', fp);
    expect(extractFingerprintFromBody(body)).toBe(fp);
    expect(shouldPostFingerprint(fp, collectFingerprintsFromBodies([body]))).toBe(false);
    expect(
      shouldPostFingerprint(
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        collectFingerprintsFromBodies([body]),
      ),
    ).toBe(true);
    // Idempotent: never double-stamp.
    expect(withFingerprintMarker(body, fp)).toBe(body);
    // Legacy 16-char threads still dedup and round-trip.
    const legacyBody = withFingerprintMarker('hello', 'deadbeefdeadbeef');
    expect(extractFingerprintFromBody(legacyBody)).toBe('deadbeefdeadbeef');
    expect(
      shouldPostFingerprint('deadbeefdeadbeef', collectFingerprintsFromBodies([legacyBody])),
    ).toBe(false);
  });

  it('posts everything and warns on a corrupt store (fail-open)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-'));
    try {
      const file = join(dir, 'fps.json');
      writeFileSync(file, '{ not json', 'utf-8');
      const store = new FingerprintStore(file);
      expect(store.load().size).toBe(0);
      expect(store.isCorrupt()).toBe(true);
      expect(store.shouldPost(fingerprintForIssue({ ...ISSUE }))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists posted fingerprints across instances', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-'));
    try {
      const file = join(dir, 'nested', 'fps.json');
      const fp = fingerprintForIssue({ ...ISSUE });
      const store = new FingerprintStore(file);
      store.markPosted([fp]);
      const reloaded = new FingerprintStore(file);
      expect(reloaded.shouldPost(fp)).toBe(false);
      expect(reloaded.shouldPost('a'.repeat(64))).toBe(true);
      // Legacy 16-char entries persist and still gate their short form.
      reloaded.markPosted(['bbbbbbbbbbbbbbbb']);
      const reloadedAgain = new FingerprintStore(file);
      expect(reloadedAgain.shouldPost('bbbbbbbbbbbbbbbb')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
