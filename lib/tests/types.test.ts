import { describe, expect, it } from 'vitest';
import { ReviewEntrySchema } from '../src/types/schemas.js';

describe('types', () => {
  it('ReviewEntrySchema validates a valid issue', () => {
    const valid = ReviewEntrySchema.safeParse({
      type: 'issue',
      severity: 'critical',
      file: 'src/test.ts',
      line: 10,
      message: 'Test issue message',
    });
    expect(valid.success).toBe(true);
  });

  it('ReviewEntrySchema validates a valid summary', () => {
    const valid = ReviewEntrySchema.safeParse({
      type: 'summary',
      text: 'This is a valid summary text that is long enough.',
    });
    expect(valid.success).toBe(true);
  });

  it('ReviewEntrySchema validates a valid verdict', () => {
    const valid = ReviewEntrySchema.safeParse({
      type: 'verdict',
      ready: true,
      reasoning: 'The reasoning is long enough to pass.',
    });
    expect(valid.success).toBe(true);
  });

  it('ReviewEntrySchema rejects invalid severity', () => {
    const valid = ReviewEntrySchema.safeParse({
      type: 'issue',
      severity: 'blocker',
      file: 'src/test.ts',
      line: 10,
      message: 'Test issue message',
    });
    expect(valid.success).toBe(false);
  });

  it('ReviewEntrySchema rejects issue without file', () => {
    const valid = ReviewEntrySchema.safeParse({
      type: 'issue',
      severity: 'critical',
      line: 10,
      message: 'Test issue message',
    });
    expect(valid.success).toBe(false);
  });

  it('ReviewEntrySchema rejects issue with line <= 0', () => {
    const valid = ReviewEntrySchema.safeParse({
      type: 'issue',
      severity: 'critical',
      file: 'src/test.ts',
      line: 0,
      message: 'Test issue message',
    });
    expect(valid.success).toBe(false);
  });
});
