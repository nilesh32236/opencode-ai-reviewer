import { describe, expect, it } from 'vitest';
import { PUBLIC_GENERIC_FAILURE, publicErrorComment } from '../../src/utils/public-error.js';

describe('publicErrorComment', () => {
  it('never emits run-derived or internal text', () => {
    const body = publicErrorComment('Changelog generation failed');

    // The body is fully determined by the constant summary — no interpolation
    // channel exists for an error message to slip through.
    expect(body).toBe(`❌ **Changelog generation failed** ${PUBLIC_GENERIC_FAILURE}`);
  });

  it('does not double-prefix a summary that already carries the marker', () => {
    expect(publicErrorComment('❌ Changelog push failed')).toBe(
      `❌ Changelog push failed ${PUBLIC_GENERIC_FAILURE}`,
    );
  });

  it('appends an optional remediation hint instead of the generic line', () => {
    expect(publicErrorComment('Docs generation failed', 'Re-run with `/docs` to retry.')).toBe(
      '❌ **Docs generation failed** Re-run with `/docs` to retry.',
    );
  });

  it('carries no filesystem paths, hostnames, or credential material', () => {
    // Regression guard for the reason this module exists: a sanitized error
    // message is safe to *log* but not to *publish*, because redaction strips
    // credentials while keeping absolute paths, internal hostnames, and
    // attacker-influenced command text.
    const body = publicErrorComment('Autofix failed');

    expect(body).not.toMatch(/\/(?:home|var|tmp|etc|usr)\//);
    expect(body).not.toMatch(/gh[pousr]_/);
    expect(body).not.toMatch(/sk-[A-Za-z0-9]/);
  });
});
