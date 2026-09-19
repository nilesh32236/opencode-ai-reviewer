import { describe, expect, it } from 'vitest';
import { escapeInlineCode, sanitizeMarkdown } from '../../src/utils/markdown.js';

describe('sanitizeMarkdown', () => {
  it('leaves ordinary prose and formatting untouched', () => {
    const prose = 'Fixed the login bug in `auth.ts` — see [docs](https://example.com) for details.';
    expect(sanitizeMarkdown(prose)).toBe(prose);
  });

  it('neutralizes raw HTML tags', () => {
    const out = sanitizeMarkdown('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('breaks HTML comment markers so marker spoofing fails', () => {
    const out = sanitizeMarkdown('done <!-- review-stream-progress --> bye');
    expect(out).not.toContain('<!-- review-stream-progress -->');
  });

  it('neutralizes markdown image exfiltration', () => {
    const out = sanitizeMarkdown('see ![x](https://evil.example/pixel.png)');
    expect(out).not.toMatch(/!\[x\]\(https/);
  });

  it('neutralizes javascript: and data: links', () => {
    expect(sanitizeMarkdown('[x](javascript:alert(1))')).toContain('](blocked:');
    expect(sanitizeMarkdown('[x](data:text/html,hi)')).toContain('](blocked:');
  });

  it('keeps ordinary https links clickable', () => {
    expect(sanitizeMarkdown('[docs](https://example.com)')).toContain(
      '[docs](https://example.com)',
    );
  });

  it('truncates oversized fields', () => {
    const out = sanitizeMarkdown('a'.repeat(6000));
    expect(out.length).toBeLessThan(6000);
    expect(out).toContain('truncated');
  });

  it('cuts oversized fields on a line boundary so markdown stays valid', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i} with some content here`);
    const out = sanitizeMarkdown(lines.join('\n'));
    expect(out).toContain('truncated');
    // The surviving body must end with a complete line, never a fragment.
    const body = out.slice(0, out.indexOf('… (truncated')).replace(/\n$/, '');
    expect(body.split('\n').pop()).toMatch(/^line-\d+ with some content here$/);
  });

  it('falls back to a hard cut when no newline fits', () => {
    const out = sanitizeMarkdown('b'.repeat(6000));
    expect(out).toContain('truncated');
    expect(out.length).toBeLessThan(6000);
  });
});

describe('escapeInlineCode', () => {
  it('escapes backticks and newlines', () => {
    expect(escapeInlineCode('a`b\nc')).toBe('a\\`b c');
  });

  it('leaves plain paths untouched', () => {
    expect(escapeInlineCode('src/index.ts:12')).toBe('src/index.ts:12');
  });

  it('escapes backslashes first so a trailing backslash cannot break out', () => {
    expect(escapeInlineCode('trail\\')).toBe('trail\\\\');
    expect(escapeInlineCode('a\\`b')).toBe('a\\\\\\`b');
  });
});
