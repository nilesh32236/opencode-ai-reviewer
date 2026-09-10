import { describe, expect, it } from 'vitest';
import {
  DESCRIBE_BODY_END,
  DESCRIBE_BODY_START,
  mergeDescribeBody,
} from '../src/utils/describe-markers.js';

describe('mergeDescribeBody', () => {
  it('returns just the marker block for empty body', () => {
    const merged = mergeDescribeBody('', 'new content');
    expect(merged).toBe(`${DESCRIBE_BODY_START}\nnew content\n${DESCRIBE_BODY_END}`);
  });

  it('returns just the marker block for null body', () => {
    const merged = mergeDescribeBody(null, 'new content');
    expect(merged).toContain('new content');
    expect(merged).toContain(DESCRIBE_BODY_START);
    expect(merged).toContain(DESCRIBE_BODY_END);
  });

  it('returns just the marker block for undefined body', () => {
    const merged = mergeDescribeBody(undefined, 'new content');
    expect(merged).toBe(`${DESCRIBE_BODY_START}\nnew content\n${DESCRIBE_BODY_END}`);
  });

  it('replaces content in place when markers are present', () => {
    const existing = `user intro\n${DESCRIBE_BODY_START}\nold\n${DESCRIBE_BODY_END}\nuser outro`;
    const merged = mergeDescribeBody(existing, 'new');
    expect(merged).toContain('user intro');
    expect(merged).toContain('user outro');
    expect(merged).toContain('new');
    expect(merged).not.toContain('old');
  });

  it('appends the block when markers are absent, preserving user text', () => {
    const merged = mergeDescribeBody('my important notes', 'generated');
    expect(merged.startsWith('my important notes')).toBe(true);
    expect(merged).toContain('generated');
    expect(merged).toContain(DESCRIBE_BODY_START);
  });

  it('never deletes user text on orphan START (appends instead of spanning)', () => {
    const userText = 'do not delete me';
    const existing = `${DESCRIBE_BODY_START}\npartial\n${userText}`;
    const merged = mergeDescribeBody(existing, 'generated');
    expect(merged).toContain(userText);
    expect(merged).toContain('generated');
  });

  it('appends instead of mismatching a stray END before START', () => {
    const existing = `stray ${DESCRIBE_BODY_END} then ${DESCRIBE_BODY_START}\npartial`;
    const merged = mergeDescribeBody(existing, 'generated');
    // Both the original text and the new block survive.
    expect(merged).toContain('stray');
    expect(merged).toContain('generated');
  });

  it('strips marker strings echoed in generated content', () => {
    const merged = mergeDescribeBody(
      'body',
      `evil ${DESCRIBE_BODY_START} nested ${DESCRIBE_BODY_END} done`,
    );
    const occurrences =
      merged.split(DESCRIBE_BODY_START).length - 1 + (merged.split(DESCRIBE_BODY_END).length - 1);
    // Exactly one START and one END (the real block delimiters).
    expect(occurrences).toBe(2);
    expect(merged.startsWith('body')).toBe(true);
  });

  it('is idempotent when merging the same content twice', () => {
    const once = mergeDescribeBody('user text', 'generated');
    expect(mergeDescribeBody(once, 'generated')).toBe(once);
  });
});
