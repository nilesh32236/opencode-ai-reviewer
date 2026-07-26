import { describe, expect, it } from 'vitest';
import { parseAnalysisPlan } from '../src/utils/analyze-parser.js';

describe('parseAnalysisPlan', () => {
  it('parses blocking questions section', () => {
    const input = `## Analysis Plan

### Blocking Questions
- **Q1:** What authentication strategy should we use?
- **Q2:** Should we support rate limiting?

### Confidence Level
HIGH

### Implementation Approach
Use JWT tokens.`;
    const result = parseAnalysisPlan(input);
    expect(result.hasBlockingQuestions).toBe(true);
    expect(result.blockingQuestions).toHaveLength(2);
    expect(result.blockingQuestions[0]).toContain('What authentication strategy');
    expect(result.blockingQuestions[1]).toContain('rate limiting');
    expect(result.confidenceLevel).toBe('HIGH');
  });

  it('detects no blocking questions when section says none', () => {
    const input = `## Analysis Plan

### Blocking Questions
None

### Confidence Level
MEDIUM`;
    const result = parseAnalysisPlan(input);
    expect(result.hasBlockingQuestions).toBe(false);
    expect(result.blockingQuestions).toHaveLength(0);
  });

  it('detects no blocking questions with "ready to proceed"', () => {
    const input = `## Analysis Plan

### Blocking Questions
Ready to proceed

### Confidence Level
LOW`;
    const result = parseAnalysisPlan(input);
    expect(result.hasBlockingQuestions).toBe(false);
  });

  it('detects no blocking questions with "no blocking questions"', () => {
    const input = `## Analysis Plan

### Blocking Questions
No blocking questions identified.

### Confidence Level
MEDIUM`;
    const result = parseAnalysisPlan(input);
    expect(result.hasBlockingQuestions).toBe(false);
  });

  it('handles emoji-prefixed headers', () => {
    const input = `## Analysis Plan

### ❓ Blocking Questions
- **Q1:** Is there a database migration plan?

### Confidence Level
HIGH`;
    const result = parseAnalysisPlan(input);
    expect(result.hasBlockingQuestions).toBe(true);
    expect(result.blockingQuestions).toHaveLength(1);
  });

  it('handles "Questions / Decisions Needed" heading', () => {
    const input = `## Analysis Plan

### Questions / Decisions Needed
- What is the target deployment environment?

### Confidence Level
MEDIUM`;
    const result = parseAnalysisPlan(input);
    expect(result.hasBlockingQuestions).toBe(true);
    expect(result.blockingQuestions).toHaveLength(1);
  });

  it('returns MEDIUM confidence when section is missing', () => {
    const input = `## Analysis Plan

### Blocking Questions
None`;
    const result = parseAnalysisPlan(input);
    expect(result.confidenceLevel).toBe('MEDIUM');
  });

  it('returns empty markdown gracefully', () => {
    const result = parseAnalysisPlan('');
    expect(result.hasBlockingQuestions).toBe(false);
    expect(result.blockingQuestions).toHaveLength(0);
    expect(result.confidenceLevel).toBe('MEDIUM');
  });

  it('falls back to raw section text when no list items match', () => {
    const input = `## Analysis Plan

### Blocking Questions
Some descriptive text about questions without list formatting.

### Confidence Level
HIGH`;
    const result = parseAnalysisPlan(input);
    expect(result.hasBlockingQuestions).toBe(true);
    expect(result.blockingQuestions).toHaveLength(1);
    expect(result.blockingQuestions[0]).toBe(
      'Some descriptive text about questions without list formatting.',
    );
  });

  it('handles double-hash headings', () => {
    const input = `## Analysis Plan

## Blocking Questions
- **Q1:** What is the migration approach?

## Confidence Level
HIGH`;
    const result = parseAnalysisPlan(input);
    expect(result.hasBlockingQuestions).toBe(true);
    expect(result.blockingQuestions).toHaveLength(1);
  });
});
