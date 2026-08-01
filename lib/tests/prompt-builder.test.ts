import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import {
  buildAnalyzePrompt,
  buildFixPrompt,
  buildReplyPrompt,
  buildReviewPrompt,
  listAuditCategories,
  loadAuditCategoryPrompt,
} from '../src/prompts/builder.js';
import { extractRelevantLogSnippet } from '../src/prompts/heal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('prompt-builder', () => {
  it('buildReviewPrompt returns a non-empty string', () => {
    const prompt = buildReviewPrompt(
      { reviewPromptFile: '', reviewPromptExtra: '', maxFilesPerBatch: 3, projectContext: '' },
      'PR #1 test',
    );
    expect(prompt).toBeTruthy();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(50);
  });

  it('buildReviewPrompt includes the PR context', () => {
    const prContext = 'Test PR context with specific details';
    const prompt = buildReviewPrompt(
      { reviewPromptFile: '', reviewPromptExtra: '', maxFilesPerBatch: 3, projectContext: '' },
      prContext,
    );
    expect(prompt).toContain(prContext);
  });

  it('buildReviewPrompt appends reviewPromptExtra when set', () => {
    const extra = 'EXTRA_INSTRUCTIONS';
    const prompt = buildReviewPrompt(
      { reviewPromptFile: '', reviewPromptExtra: extra, maxFilesPerBatch: 3, projectContext: '' },
      'PR #1',
    );
    expect(prompt).toContain(extra);
  });

  it('injects learning lessons when provided', () => {
    const prompt = buildReviewPrompt({ maxFilesPerBatch: 3 }, '## PR Context\n...', [
      'Always handle async errors',
      'Use strict equality checks',
    ]);
    expect(prompt).toContain('## Historical Lessons');
    expect(prompt).toContain('Always handle async errors');
  });

  it('buildFixPrompt returns a non-empty string', () => {
    const prompt = buildFixPrompt(
      { reviewPromptFile: '', reviewPromptExtra: '', maxFilesPerBatch: 3, projectContext: '' },
      'PR context with issues',
      1,
    );
    expect(prompt).toBeTruthy();
    expect(typeof prompt).toBe('string');
  });

  it('buildFixPrompt includes the iteration number', () => {
    const prompt = buildFixPrompt(
      { reviewPromptFile: '', reviewPromptExtra: '', maxFilesPerBatch: 3, projectContext: '' },
      'Some context',
      2,
    );
    expect(prompt).toContain('2');
  });

  describe('buildAnalyzePrompt', () => {
    it('returns a non-empty string', () => {
      const prompt = buildAnalyzePrompt({ projectContext: '' }, 'Issue description');
      expect(prompt).toBeTruthy();
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(50);
    });

    it('includes the issue context', () => {
      const issueContext = 'Test issue context with specific details';
      const prompt = buildAnalyzePrompt({ projectContext: '' }, issueContext);
      expect(prompt).toContain(issueContext);
    });

    it('includes output structure instructions', () => {
      const prompt = buildAnalyzePrompt({ projectContext: '' }, 'Issue description');
      expect(prompt).toContain('.opencode/analysis-plan.md');
      expect(prompt).toContain('## 📊 Summary & Priority');
      expect(prompt).toContain('## 📁 Affected Files');
      expect(prompt).toContain('## 🛠️ Step-by-Step Implementation Plan');
      expect(prompt).toContain('### Blocking Questions');
    });

    it('uses provided project context', () => {
      const prompt = buildAnalyzePrompt({ projectContext: 'Custom project context' }, 'Issue');
      expect(prompt).toContain('Custom project context');
    });

    it('uses projectContextStr override when provided', () => {
      const prompt = buildAnalyzePrompt(
        { projectContext: 'Default context' },
        'Issue',
        'Override context',
      );
      expect(prompt).toContain('Override context');
      expect(prompt).not.toContain('Default context');
    });

    it('includes critical rules about read-only analysis', () => {
      const prompt = buildAnalyzePrompt({ projectContext: '' }, 'Issue');
      expect(prompt).toContain('Do NOT run');
      expect(prompt).toContain('git commit');
      expect(prompt).toContain('read-only analysis');
    });
  });

  describe('buildReplyPrompt', () => {
    it('returns a non-empty string', () => {
      const prompt = buildReplyPrompt(
        'src/index.ts',
        42,
        'function foo() { return 1; }',
        'This line has a bug',
        [],
        'Why is this critical?',
      );
      expect(prompt).toBeTruthy();
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(50);
    });

    it('includes code context and file path', () => {
      const prompt = buildReplyPrompt(
        'src/app.ts',
        10,
        'const x = 1;',
        'Consider renaming this variable',
        [],
        'What would you suggest instead?',
      );
      expect(prompt).toContain('src/app.ts');
      expect(prompt).toContain('line 10');
      expect(prompt).toContain('const x = 1;');
    });

    it('includes original review comment', () => {
      const prompt = buildReplyPrompt(
        'src/index.ts',
        undefined,
        'code',
        'This is a security issue',
        [],
        'Why?',
      );
      expect(prompt).toContain('This is a security issue');
      expect(prompt).toContain('## Original Review Comment');
    });

    it('includes thread history when available', () => {
      const threadHistory = [
        { author: 'opencode-bot', body: 'This line has a bug' },
        { author: 'developer', body: 'Why do you think so?' },
      ];
      const prompt = buildReplyPrompt(
        'src/index.ts',
        5,
        'code snippet',
        'This line has a bug',
        threadHistory,
        'Can you explain more?',
      );
      expect(prompt).toContain('## Thread History');
      expect(prompt).toContain('@opencode-bot');
      // The user's own reply (last entry) is shown in Developer's Question instead
      expect(prompt).not.toContain('@developer');
      expect(prompt).toContain('This line has a bug');
    });

    it('includes developers question', () => {
      const prompt = buildReplyPrompt(
        'src/index.ts',
        undefined,
        'code',
        'Nit: use a constant',
        [],
        'Where should I define it?',
      );
      expect(prompt).toContain("Developer's Question");
      expect(prompt).toContain('Where should I define it?');
    });

    it('includes instructions section', () => {
      const prompt = buildReplyPrompt('src/index.ts', undefined, 'code', 'comment', [], 'question');
      expect(prompt).toContain('## Instructions');
      expect(prompt).toContain('Answer concisely');
      expect(prompt).toContain('acknowledge it gracefully');
    });
  });

  describe('buildReviewPrompt linter results', () => {
    it('includes linter results section when provided', () => {
      const linterResults = [
        {
          tool: 'eslint',
          command: 'eslint --format json src/test.ts',
          exitCode: 0,
          stdout: '',
          stderr: '',
          success: true,
          findings: [
            {
              file: 'src/test.ts',
              line: 5,
              severity: 'warning',
              ruleId: 'no-unused-vars',
              message: 'x is unused',
              raw: '',
            },
          ],
        },
      ];

      const prompt = buildReviewPrompt(
        { projectContext: '' },
        'PR context',
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        linterResults,
      );

      expect(prompt).toContain('## Linter Results');
      expect(prompt).toContain('eslint');
      expect(prompt).toContain('src/test.ts:5');
      expect(prompt).toContain('[no-unused-vars]');
      expect(prompt).toContain('x is unused');
      expect(prompt).toContain('DO NOT flag issues that a linter already catches');
    });

    it('omits linter results section when not provided', () => {
      const prompt = buildReviewPrompt({ projectContext: '' }, 'PR context');

      expect(prompt).not.toContain('## Linter Results');
    });

    it('omits linter results section when empty array', () => {
      const prompt = buildReviewPrompt(
        { projectContext: '' },
        'PR context',
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        [],
      );

      expect(prompt).not.toContain('## Linter Results');
    });

    it('caps linter findings at 50 per tool', () => {
      const manyFindings = Array.from({ length: 60 }, (_, i) => ({
        file: 'src/test.ts',
        line: i + 1,
        severity: 'warning',
        ruleId: 'rule',
        message: `finding ${i + 1}`,
        raw: '',
      }));

      const linterResults = [
        {
          tool: 'eslint',
          command: 'eslint src/test.ts',
          exitCode: 0,
          stdout: '',
          stderr: '',
          success: true,
          findings: manyFindings,
        },
      ];

      const prompt = buildReviewPrompt(
        { projectContext: '' },
        'PR context',
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        linterResults,
      );

      // First 50 findings shown
      expect(prompt).toContain('finding 1');
      expect(prompt).toContain('finding 50');
      // Overflow message present
      expect(prompt).toContain('10 more');
    });
  });

  describe('audit categories (IaC security)', () => {
    const iacCategories = ['dockerfile-security', 'terraform-security', 'kubernetes-security'];
    const repoRoot = path.resolve(__dirname, '../../');
    const promptsDir = path.resolve(repoRoot, 'prompts/audit-categories');
    let originalCwd: string;

    beforeAll(() => {
      originalCwd = process.cwd();
      process.chdir(repoRoot);
    });

    afterAll(() => {
      process.chdir(originalCwd);
    });

    it('listAuditCategories includes new IaC categories', () => {
      const categories = listAuditCategories(promptsDir);
      for (const cat of iacCategories) {
        expect(categories).toContain(cat);
      }
    });

    it('listAuditCategories with .audit-prompts dir does NOT include IaC categories', () => {
      const categories = listAuditCategories(path.resolve(repoRoot, '.audit-prompts'));
      for (const cat of iacCategories) {
        expect(categories).not.toContain(cat);
      }
    });

    it('loadAuditCategoryPrompt returns non-null for dockerfile-security', () => {
      const prompt = loadAuditCategoryPrompt('dockerfile-security', promptsDir);
      expect(prompt).not.toBeNull();
      expect(prompt).toContain('Dockerfile');
      expect(prompt).toContain('USER root');
      expect(prompt).toContain('multi-stage');
    });

    it('loadAuditCategoryPrompt returns non-null for terraform-security', () => {
      const prompt = loadAuditCategoryPrompt('terraform-security', promptsDir);
      expect(prompt).not.toBeNull();
      expect(prompt).toContain('Terraform');
      expect(prompt).toContain('### Hardcoded Secrets');
      expect(prompt).toContain('S3');
    });

    it('loadAuditCategoryPrompt returns non-null for kubernetes-security', () => {
      const prompt = loadAuditCategoryPrompt('kubernetes-security', promptsDir);
      expect(prompt).not.toBeNull();
      expect(prompt).toContain('Kubernetes');
      expect(prompt).toContain('privileged');
      expect(prompt).toContain('hostPath');
    });

    it('all IaC prompts contain output format section', () => {
      for (const cat of iacCategories) {
        const prompt = loadAuditCategoryPrompt(cat, promptsDir);
        expect(prompt).toContain('severity');
        expect(prompt).toContain('suggestion');
        expect(prompt).toContain('Output Format');
      }
    });
  });

  describe('extractRelevantLogSnippet', () => {
    it('returns logs intact if under maxLength', () => {
      const shortLogs = 'Short log output';
      expect(extractRelevantLogSnippet(shortLogs, 100)).toBe(shortLogs);
    });

    it('extracts snippet centered around error marker when present', () => {
      const padding = 'A'.repeat(5000);
      const errorSection = 'FAIL tests/engine.test.ts\nError: expected true to be false';
      const trailing = 'B'.repeat(5000);
      const fullLogs = `${padding}\n${errorSection}\n${trailing}`;

      const snippet = extractRelevantLogSnippet(fullLogs, 2000);
      expect(snippet).toContain('FAIL tests/engine.test.ts');
      expect(snippet).toContain('[...truncated leading');
      expect(snippet).toContain('[...truncated trailing');
    });
  });

  describe('buildReviewPrompt budget modes', () => {
    const baseInputs = { projectContext: '' };

    it('injects no budget banner in full mode', () => {
      const prompt = buildReviewPrompt(
        baseInputs,
        'PR context',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'full',
        100,
      );
      expect(prompt).toContain('## Context Window Management');
      expect(prompt).not.toContain('Review Budget Mode');
      expect(prompt).not.toContain('Large PR Detected');
    });

    it('injects the summary budget banner with the diff line count', () => {
      const prompt = buildReviewPrompt(
        baseInputs,
        'PR context',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'summary',
        600,
      );
      expect(prompt).toContain('## Review Budget Mode: SUMMARY');
      expect(prompt).toContain('~600 lines');
      expect(prompt).toContain('focus ONLY on critical patterns');
      expect(prompt).not.toContain('SPLIT RECOMMENDED');
    });

    it('injects the split budget banner with a split recommendation', () => {
      const prompt = buildReviewPrompt(
        baseInputs,
        'PR context',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'split',
        1500,
      );
      expect(prompt).toContain('## Review Budget Mode: SPLIT RECOMMENDED');
      expect(prompt).toContain('~1500 lines');
      expect(prompt).toContain('recommendation to split this PR');
      expect(prompt).toContain('Do NOT perform a line-by-line review');
      expect(prompt).not.toContain('Review Budget Mode: SUMMARY');
    });

    it('omits the line count when totalDiffLines is not provided', () => {
      const prompt = buildReviewPrompt(
        baseInputs,
        'PR context',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'summary',
      );
      expect(prompt).toContain('## Review Budget Mode: SUMMARY');
      expect(prompt).toContain('a very large number of lines');
    });
  });
});
