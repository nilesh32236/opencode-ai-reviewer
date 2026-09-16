import { describe, expect, it } from 'vitest';
import { buildAutofixPRBody, buildDocsPRBody } from '../src/utils/pr-body.js';

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

    expect(body).toContain('Fixes #42');
    expect(body).not.toContain('## Fixes #42');
    expect(body).toContain('## What Was Changed');
    expect(body).toContain('Added null check before iterating over items');
    // Zero-width spaces after '/' give narrow viewports a break opportunity.
    expect(body).toContain('- `lib/\u200bsrc/\u200bparser.ts`');
    expect(body).toContain('- `lib/\u200btests/\u200bparser.test.ts`');
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

    expect(body).toContain('Fixes #10');
    expect(body).toContain('The fix agent applied changes to address the issue.');
    expect(body).toContain('- Please verify the fix manually before merging');
  });
});

describe('buildDocsPRBody', () => {
  it('builds docs PR body with summary and changed files', () => {
    const body = buildDocsPRBody({
      prNumber: 199,
      prTitle: 'Add docs generation',
      docsSummary: 'Added JSDoc to the changed API surface',
      filesChanged: ['lib/src/engine.ts'],
      branchName: 'docs/issue-199',
      docStyle: 'tsdoc',
    });

    expect(body).toContain('## Adds documentation for #199');
    expect(body).toContain('## What Was Documented');
    expect(body).toContain('Added JSDoc to the changed API surface');
    expect(body).toContain('- `lib/\u200bsrc/\u200bengine.ts`');
    expect(body).toContain('## Doc Style');
    expect(body).toContain('`tsdoc`');
    expect(body).toContain('docs/issue-199');
  });

  it('provides fallback text when docsSummary is empty', () => {
    const body = buildDocsPRBody({
      prNumber: 199,
      prTitle: 'Add docs generation',
      filesChanged: ['lib/src/engine.ts'],
      branchName: 'docs/issue-199',
    });

    expect(body).toContain('## Adds documentation for #199');
    expect(body).toContain('The documentation agent added doc comments');
    expect(body).toContain('- Please verify the documentation renders correctly before merging');
  });

  it('omits the doc style section for the auto style', () => {
    const body = buildDocsPRBody({
      prNumber: 199,
      prTitle: 'Add docs generation',
      filesChanged: ['lib/src/engine.ts'],
      branchName: 'docs/issue-199',
      docStyle: 'auto',
    });

    expect(body).not.toContain('## Doc Style');
  });

  it('escapes markdown metacharacters in the PR title and file paths', () => {
    const body = buildDocsPRBody({
      prNumber: 199,
      prTitle: 'Add `docs` [generation] (final)',
      filesChanged: ['src/odd`file.ts', 'src/back\\slash.ts', 'src/normal.ts'],
      branchName: 'docs/issue-199',
      docStyle: 'tsdoc',
    });

    expect(body).toContain('Add \\`docs\\` \\[generation\\] \\(final\\)');
    expect(body).toContain('- `src/\u200bodd\\`file.ts`');
    expect(body).toContain('- `src/\u200bback\\\\slash.ts`');
    expect(body).toContain('- `src/\u200bnormal.ts`');
  });
});
