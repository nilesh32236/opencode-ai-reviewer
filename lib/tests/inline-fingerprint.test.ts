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
  legacyInlineKey,
  normalizeLegacyThreadBody,
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
  it('produces a stable 16-char sha1 fingerprint', () => {
    const a = fingerprintForIssue({ ...ISSUE });
    const b = fingerprintForIssue({ ...ISSUE, file: '/SRC/foo.ts' });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(b).toBe(a);
    expect(fingerprintFinding('a.ts', 1, 'bugs', 'x')).toHaveLength(16);
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
    expect(shouldPostFingerprint('deadbeefdeadbeef', collectFingerprintsFromBodies([body]))).toBe(
      true,
    );
    // Idempotent: never double-stamp.
    expect(withFingerprintMarker(body, fp)).toBe(body);
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

  it('skips legacy threads via coarse keys built from rendered bodies', () => {
    // A pre-marker thread renders as "**SEVERITY**: message"; the handler
    // builds legacyKeys via normalizeLegacyThreadBody + legacyInlineKey from
    // that rendered body. The filter must skip a matching fresh issue but
    // keep an issue on a different line.
    const renderedBody = `**IMPORTANT**: ${ISSUE.message}`;
    const legacyKeys = new Set([
      legacyInlineKey(ISSUE.file, ISSUE.line, normalizeLegacyThreadBody(renderedBody)),
    ]);
    const matching = { ...ISSUE };
    const otherLine = { ...ISSUE, line: ISSUE.line + 1 };
    const { kept, skipped } = filterIssuesByFingerprints([matching, otherLine], new Set(), {
      legacyKeys,
    });
    expect(skipped).toHaveLength(1);
    expect(kept).toHaveLength(1);
    expect(kept[0].line).toBe(ISSUE.line + 1);
    // normalizeLegacyThreadBody strips markers and severity prefixes.
    const fp = fingerprintForIssue({ ...ISSUE });
    expect(normalizeLegacyThreadBody(`**IMPORTANT**: msg\n\n<!-- inline-fp:${fp} -->`)).toBe('msg');
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
      expect(reloaded.shouldPost('aaaaaaaaaaaaaaaa')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
