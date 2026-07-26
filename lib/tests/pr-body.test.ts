import { describe, expect, it } from 'vitest';
import { buildAutofixPRBody } from '../src/utils/pr-body.js';

describe('buildAutofixPRBody', () => {
  const baseOptions = {
    issueNumber: 42,
    issueTitle: 'Fix login timeout',
    filesChanged: ['src/auth.ts', 'src/config.ts'],
    branchName: 'autofix/issue-42',
  };

  it('includes issue reference', () => {
    const body = buildAutofixPRBody(baseOptions);
    expect(body).toContain('Fixes #42');
  });

  it('includes fix summary when provided', () => {
    const body = buildAutofixPRBody({
      ...baseOptions,
      fixSummary: 'Updated token refresh logic and added timeout handling.',
    });
    expect(body).toContain('Updated token refresh logic');
  });

  it('includes fallback text when fix summary is empty', () => {
    const body = buildAutofixPRBody({
      ...baseOptions,
      fixSummary: '',
    });
    expect(body).toContain('The fix agent applied changes');
  });

  it('lists changed files', () => {
    const body = buildAutofixPRBody(baseOptions);
    expect(body).toContain('src/auth.ts');
    expect(body).toContain('src/config.ts');
  });

  it('includes test plan with hasTests=true', () => {
    const body = buildAutofixPRBody({ ...baseOptions, hasTests: true });
    expect(body).toContain('Automated tests were run and passed');
    expect(body).toContain('lint/typecheck commands');
  });

  it('includes manual verification prompt when hasTests=false', () => {
    const body = buildAutofixPRBody({ ...baseOptions, hasTests: false });
    expect(body).toContain('Please verify the fix manually');
    expect(body).toContain('pnpm test');
  });

  it('includes analysis approach in collapsible section', () => {
    const body = buildAutofixPRBody({
      ...baseOptions,
      analysisApproach: 'Refactor the auth module to use refresh tokens.',
    });
    expect(body).toContain('Implementation Approach');
  });

  it('includes branch name in footer', () => {
    const body = buildAutofixPRBody(baseOptions);
    expect(body).toContain('autofix/issue-42');
  });

  it('handles empty files list', () => {
    const body = buildAutofixPRBody({
      ...baseOptions,
      filesChanged: [],
    });
    expect(body).not.toContain('## Files Changed');
  });
});
