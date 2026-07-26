import { describe, expect, it } from 'vitest';
import { buildAutofixPRBody } from '../src/utils/pr-body.js';

describe('buildAutofixPRBody', () => {
  it('builds PR body with fix summary and changed files', () => {
    const body = buildAutofixPRBody({
      issueNumber: 42,
      issueTitle: 'Fix crash in parser',
      fixSummary: 'Added null check before iterating over items',
      filesChanged: ['lib/src/parser.ts', 'lib/tests/parser.test.ts'],
      branchName: 'autofix/issue-42',
      hasTests: true,
      analysisApproach: 'Check for null input at entry point',
    });

    expect(body).toContain('## Fixes #42');
    expect(body).toContain('## What Was Changed');
    expect(body).toContain('Added null check before iterating over items');
    expect(body).toContain('- `lib/src/parser.ts`');
    expect(body).toContain('- `lib/tests/parser.test.ts`');
    expect(body).toContain('Implementation Approach (from analysis)');
    expect(body).toContain('Check for null input at entry point');
    expect(body).toContain('- Automated tests were run and passed');
    expect(body).toContain('autofix/issue-42');
  });

  it('provides fallback text when fixSummary is empty', () => {
    const body = buildAutofixPRBody({
      issueNumber: 10,
      issueTitle: 'Minor fix',
      filesChanged: ['lib/src/index.ts'],
      branchName: 'autofix/issue-10',
      hasTests: false,
    });

    expect(body).toContain('## Fixes #10');
    expect(body).toContain('The fix agent applied changes to address the issue.');
    expect(body).toContain('- Please verify the fix manually before merging');
  });
});
