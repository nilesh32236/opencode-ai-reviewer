import { describe, expect, it } from 'vitest';
import { parseAnalysisPlan } from '../src/utils/analyze-parser.js';

describe('parseAnalysisPlan', () => {
  it('parses plan with no blocking questions (formatted with Q1 prefix)', () => {
    const markdown = `
# 🔍 Issue Analysis & Implementation Plan

## 📊 Summary & Priority
- Priority: High

### Blocking Questions
- **Q1:** None — implementation can proceed immediately. All design decisions have clear precedent in existing code.

### Confidence Level
HIGH
    `;
    const res = parseAnalysisPlan(markdown);
    expect(res.hasBlockingQuestions).toBe(false);
    expect(res.blockingQuestions).toEqual([]);
    expect(res.confidenceLevel).toBe('HIGH');
  });

  it('parses plan with no blocking questions', () => {
    const markdown = `
# 🔍 Issue Analysis & Implementation Plan

## 📊 Summary & Priority
- Priority: High

### Blocking Questions
None — implementation can proceed immediately.

### Confidence Level
HIGH
    `;
    const res = parseAnalysisPlan(markdown);
    expect(res.hasBlockingQuestions).toBe(false);
    expect(res.blockingQuestions).toEqual([]);
    expect(res.confidenceLevel).toBe('HIGH');
  });

  it('parses mixed-content sections (first item none, second item real question)', () => {
    const markdown = `
# Analysis

### Blocking Questions
- **Q1:** None — implementation can proceed immediately.
- **Q2:** Should we use Redis or Memcached?

### Confidence Level
HIGH
    `;
    const res = parseAnalysisPlan(markdown);
    expect(res.hasBlockingQuestions).toBe(true);
    expect(res.blockingQuestions).toHaveLength(1);
    expect(res.blockingQuestions[0]).toBe('Should we use Redis or Memcached?');
  });

  it('parses blocking questions correctly', () => {
    const markdown = `
# Analysis

### Blocking Questions
- **Q1:** Should we use Zod or Valibot for validation?
- **Q2:** Is backward compatibility required for API v1?

### Confidence Level
MEDIUM
    `;
    const res = parseAnalysisPlan(markdown);
    expect(res.hasBlockingQuestions).toBe(true);
    expect(res.blockingQuestions).toHaveLength(2);
    expect(res.blockingQuestions[0]).toBe('Should we use Zod or Valibot for validation?');
    expect(res.blockingQuestions[1]).toBe('Is backward compatibility required for API v1?');
    expect(res.confidenceLevel).toBe('MEDIUM');
  });

  it('handles emoji-prefixed section headers', () => {
    const markdown = `
## ❓ Questions / Decisions Needed from Maintainer
- **Q1:** Do we need to update the database schema?

## Confidence Level
LOW
    `;
    const res = parseAnalysisPlan(markdown);
    expect(res.hasBlockingQuestions).toBe(true);
    expect(res.blockingQuestions[0]).toBe('Do we need to update the database schema?');
    expect(res.confidenceLevel).toBe('LOW');
  });

  it('handles empty or unparseable markdown gracefully', () => {
    const res = parseAnalysisPlan('');
    expect(res.hasBlockingQuestions).toBe(false);
    expect(res.blockingQuestions).toEqual([]);
    expect(res.confidenceLevel).toBe('MEDIUM');
  });
});
