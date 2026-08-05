import * as fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import {
  buildAnalyzePrompt,
  buildDocsPrompt,
  buildFixPrompt,
  buildReplyPrompt,
  buildReviewPrompt,
  listAuditCategories,
  loadAuditCategoryPrompt,
} from '../src/prompts/builder.js';
import { extractRelevantLogSnippet } from '../src/prompts/heal.js';
import { goModule } from '../src/prompts/language/go.js';
import { detectLanguages, getLanguagePrompts } from '../src/prompts/language/index.js';
import type { LanguageModule } from '../src/prompts/language/index.js';
import { pythonModule } from '../src/prompts/language/python.js';
import { rustModule } from '../src/prompts/language/rust.js';
import { typescriptModule } from '../src/prompts/language/typescript.js';

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
    const prompt = buildReviewPrompt({ maxFilesPerBatch: 3 }, '## PR Context\n...', {
      lessons: ['Always handle async errors', 'Use strict equality checks'],
    });
    expect(prompt).toContain('## Historical Lessons');
    expect(prompt).toContain('Always handle async errors');
  });

  it('supports the legacy string[] lessons shorthand', () => {
    const prompt = buildReviewPrompt({ maxFilesPerBatch: 3 }, '## PR Context\n...', [
      'Always handle async errors',
      'Use strict equality checks',
    ]);
    expect(prompt).toContain('## Historical Lessons');
    expect(prompt).toContain('Always handle async errors');
    expect(prompt).toContain('Use strict equality checks');
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

  describe('buildDocsPrompt', () => {
    it('returns a non-empty string', () => {
      const prompt = buildDocsPrompt(
        { reviewPromptFile: '', reviewPromptExtra: '', maxFilesPerBatch: 3, projectContext: '' },
        'PR context with changed code',
      );
      expect(prompt).toBeTruthy();
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(50);
    });

    it('includes the PR context', () => {
      const prContext = 'Test PR context with specific details';
      const prompt = buildDocsPrompt({ projectContext: '' }, prContext);
      expect(prompt).toContain(prContext);
    });

    it('instructs the agent to only document changed code', () => {
      const prompt = buildDocsPrompt({ projectContext: '' }, 'PR context');
      expect(prompt).toMatch(/only.*changed/i);
      expect(prompt).toContain('.docs-summary.md');
    });

    it('instructs the agent to preserve existing documentation', () => {
      const prompt = buildDocsPrompt({ projectContext: '' }, 'PR context');
      expect(prompt).toMatch(/do not modify.*(existing|correct)/i);
      expect(prompt).toMatch(/preserve existing/i);
    });

    it('renders the requested doc style', () => {
      const prompt = buildDocsPrompt({ projectContext: '' }, 'PR context', 'tsdoc');
      expect(prompt).toContain('tsdoc');
    });

    it('defaults to inferring the style when auto', () => {
      const prompt = buildDocsPrompt({ projectContext: '' }, 'PR context', 'auto');
      expect(prompt).toContain('infer');
    });

    it('includes critical rules forbidding git push and PR creation', () => {
      const prompt = buildDocsPrompt({ projectContext: '' }, 'PR context');
      expect(prompt).toContain('git commit');
      expect(prompt).toContain('git push');
      expect(prompt).toContain('gh pr create');
    });
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

      const prompt = buildReviewPrompt({ projectContext: '' }, 'PR context', { linterResults });

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
      const prompt = buildReviewPrompt({ projectContext: '' }, 'PR context', {
        linterResults: [],
      });

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

      const prompt = buildReviewPrompt({ projectContext: '' }, 'PR context', { linterResults });

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
      const prompt = buildReviewPrompt(baseInputs, 'PR context', {
        budgetMode: 'full',
        totalDiffLines: 100,
      });
      expect(prompt).toContain('## Context Window Management');
      expect(prompt).not.toContain('Review Budget Mode');
      expect(prompt).not.toContain('Large PR Detected');
    });

    it('injects the summary budget banner with the diff line count', () => {
      const prompt = buildReviewPrompt(baseInputs, 'PR context', {
        budgetMode: 'summary',
        totalDiffLines: 600,
      });
      expect(prompt).toContain('## Review Budget Mode: SUMMARY');
      expect(prompt).toContain('~600 lines');
      expect(prompt).toContain('critical patterns only');
      expect(prompt).toContain(
        'structured `summary`, `verdict`, `strength`, and `issue` JSONL lines',
      );
      expect(prompt).not.toContain('SPLIT RECOMMENDED');
    });

    it('injects the split budget banner without a prose split recommendation', () => {
      const prompt = buildReviewPrompt(baseInputs, 'PR context', {
        budgetMode: 'split',
        totalDiffLines: 1500,
      });
      expect(prompt).toContain('## Review Budget Mode: SPLIT RECOMMENDED');
      expect(prompt).toContain('~1500 lines');
      expect(prompt).toContain('critical security issues, breaking changes, and API misuse');
      expect(prompt).toContain('A split recommendation is added to the final review automatically');
      expect(prompt).not.toContain('Review Budget Mode: SUMMARY');
      expect(prompt).not.toContain('Do NOT perform a line-by-line review');
    });

    it('omits the line count when totalDiffLines is not provided', () => {
      const prompt = buildReviewPrompt(baseInputs, 'PR context', { budgetMode: 'summary' });
      expect(prompt).toContain('## Review Budget Mode: SUMMARY');
      expect(prompt).toContain('a very large number of lines');
    });

    it('appends the budget banner to a custom prompt file when not in full mode', () => {
      const customFile = path.join(process.cwd(), `.tmp-budget-prompt-${Date.now()}.md`);
      fs.writeFileSync(customFile, 'CUSTOM_REVIEW_PROMPT_CONTENT');
      try {
        const prompt = buildReviewPrompt(
          { projectContext: '', reviewPromptFile: path.basename(customFile) },
          'PR context',
          { budgetMode: 'summary', totalDiffLines: 600 },
        );
        expect(prompt).toContain('CUSTOM_REVIEW_PROMPT_CONTENT');
        expect(prompt).toContain('## Review Budget Mode: SUMMARY');
      } finally {
        fs.unlinkSync(customFile);
      }
    });

    it('does not append the budget banner to a custom prompt file in full mode', () => {
      const customFile = path.join(process.cwd(), `.tmp-budget-prompt-${Date.now()}.md`);
      fs.writeFileSync(customFile, 'CUSTOM_REVIEW_PROMPT_CONTENT');
      try {
        const prompt = buildReviewPrompt(
          { projectContext: '', reviewPromptFile: path.basename(customFile) },
          'PR context',
          { budgetMode: 'full' },
        );
        expect(prompt).toContain('CUSTOM_REVIEW_PROMPT_CONTENT');
        expect(prompt).not.toContain('## Review Budget Mode:');
      } finally {
        fs.unlinkSync(customFile);
      }
    });

    it('injects the PR context into a custom prompt file', () => {
      const customFile = path.join(process.cwd(), `.tmp-custom-prcontext-${Date.now()}.md`);
      fs.writeFileSync(customFile, 'CUSTOM_REVIEW_PROMPT_CONTENT');
      try {
        const prompt = buildReviewPrompt(
          { projectContext: '', reviewPromptFile: path.basename(customFile) },
          'PR context',
          {},
        );
        expect(prompt).toContain('CUSTOM_REVIEW_PROMPT_CONTENT');
        expect(prompt).toContain('## PR & Issue Context');
        expect(prompt).toContain('PR context');
      } finally {
        fs.unlinkSync(customFile);
      }
    });

    it('appends the Git Blame Awareness section to a custom prompt file', () => {
      const customFile = path.join(process.cwd(), `.tmp-custom-blame-${Date.now()}.md`);
      fs.writeFileSync(customFile, 'CUSTOM_REVIEW_PROMPT_CONTENT');
      try {
        const prompt = buildReviewPrompt(
          { projectContext: '', reviewPromptFile: path.basename(customFile) },
          'PR context',
          { blameAware: true },
        );
        expect(prompt).toContain('CUSTOM_REVIEW_PROMPT_CONTENT');
        expect(prompt).toContain('## PR & Issue Context');
        expect(prompt).toContain('## Git Blame Awareness');
        expect(prompt).toContain('[PR CHANGE]');
      } finally {
        fs.unlinkSync(customFile);
      }
    });
  });

  describe('buildReviewPrompt git blame awareness', () => {
    const baseInputs = { projectContext: '' };

    it('injects the Git Blame Awareness section when blameAware is set', () => {
      const prompt = buildReviewPrompt(baseInputs, 'PR context', { blameAware: true });
      expect(prompt).toContain('## Git Blame Awareness');
      expect(prompt).toContain('[PR CHANGE]');
      expect(prompt).toContain('pre-existing');
      expect(prompt).toContain(
        'Prioritize findings on lines introduced in this PR (`[PR CHANGE]`)',
      );
    });

    it('omits the Git Blame Awareness section when blameAware is not set', () => {
      const prompt = buildReviewPrompt(baseInputs, 'PR context');
      expect(prompt).not.toContain('## Git Blame Awareness');
      expect(prompt).not.toContain('A line can be `pre-existing`');
    });
  });

  describe('language-specific prompts', () => {
    const baseInputs = { projectContext: '' };

    describe('detectLanguages', () => {
      it('maps file extensions to languages', () => {
        expect(detectLanguages(['foo.rs', 'bar.rs'])).toEqual(['rust']);
        expect(detectLanguages(['a.py', 'b.ts', 'c.go'])).toEqual(['python', 'typescript', 'go']);
        expect(detectLanguages(['component.tsx'])).toEqual(['typescript']);
      });

      it('maps JS-family extensions to the typescript module', () => {
        for (const ext of ['.js', '.jsx', '.mjs', '.cjs']) {
          expect(detectLanguages([`file${ext}`])).toEqual(['typescript']);
        }
      });

      it('matches extensions case-insensitively', () => {
        expect(detectLanguages(['Foo.RS'])).toEqual(['rust']);
        expect(detectLanguages(['src/APP.PY'])).toEqual(['python']);
      });

      it('returns empty array for unknown extensions', () => {
        expect(detectLanguages(['foo.rb', 'bar.java'])).toEqual([]);
        expect(detectLanguages(['Dockerfile', 'README.md'])).toEqual([]);
      });

      it('returns empty array for empty input', () => {
        expect(detectLanguages([])).toEqual([]);
      });

      it('deduplicates languages across files', () => {
        expect(detectLanguages(['a.rs', 'b.ts', 'c.rs', 'd.tsx'])).toEqual(['rust', 'typescript']);
      });

      it('ignores falsy entries', () => {
        expect(detectLanguages(['a.rs', '', undefined as unknown as string])).toEqual(['rust']);
      });

      it('supports an optional custom extension map', () => {
        const map = { '.rb': 'rust' as const };
        expect(detectLanguages(['a.rb'], map)).toEqual(['rust']);
      });
    });

    describe('getLanguagePrompts', () => {
      it('returns a section for each registered language', () => {
        const sections = getLanguagePrompts(['rust', 'python', 'typescript', 'go']);
        expect(sections).toHaveLength(4);
        expect(sections[0]).toContain('## Rust-Specific Review Checklist');
        expect(sections[1]).toContain('## Python-Specific Review Checklist');
        expect(sections[2]).toContain('## TypeScript-Specific Review Checklist');
        expect(sections[3]).toContain('## Go-Specific Review Checklist');
      });

      it('returns empty array for unknown languages', () => {
        expect(getLanguagePrompts(['ruby' as never])).toEqual([]);
        expect(getLanguagePrompts([])).toEqual([]);
      });
    });

    describe('LanguageModule registration', () => {
      it('validates each module language field matches its registry key', () => {
        const modules: Array<{ key: string; module: LanguageModule }> = [
          { key: 'rust', module: rustModule },
          { key: 'python', module: pythonModule },
          { key: 'typescript', module: typescriptModule },
          { key: 'go', module: goModule },
        ];
        for (const { key, module } of modules) {
          expect(module.language).toBe(key);
        }
      });
    });

    describe('buildReviewPrompt language injection', () => {
      it('injects a language section when languages are provided', () => {
        const prompt = buildReviewPrompt(baseInputs, 'PR context', {
          languages: ['rust', 'typescript'],
        });
        expect(prompt).toContain('## Rust-Specific Review Checklist');
        expect(prompt).toContain('## TypeScript-Specific Review Checklist');
        expect(prompt).not.toContain('## Python-Specific Review Checklist');
      });

      it('omits language sections when no languages are provided', () => {
        const prompt = buildReviewPrompt(baseInputs, 'PR context');
        expect(prompt).not.toContain('## Rust-Specific Review Checklist');
        expect(prompt).not.toContain('## Go-Specific Review Checklist');
      });

      it('omits language sections when the languages array is empty', () => {
        const prompt = buildReviewPrompt(baseInputs, 'PR context', { languages: [] });
        expect(prompt).not.toContain('## Rust-Specific Review Checklist');
      });

      it('injects all four language sections together', () => {
        const prompt = buildReviewPrompt(baseInputs, 'PR context', {
          languages: ['go', 'python', 'rust', 'typescript'],
        });
        expect(prompt).toContain('## Rust-Specific Review Checklist');
        expect(prompt).toContain('## Python-Specific Review Checklist');
        expect(prompt).toContain('## TypeScript-Specific Review Checklist');
        expect(prompt).toContain('## Go-Specific Review Checklist');
      });

      it('places language sections after the generic checklist', () => {
        const prompt = buildReviewPrompt(baseInputs, 'PR context', { languages: ['rust'] });
        const whatToCheckIdx = prompt.indexOf('## What to Check');
        const rustIdx = prompt.indexOf('## Rust-Specific Review Checklist');
        expect(whatToCheckIdx).toBeGreaterThan(-1);
        expect(rustIdx).toBeGreaterThan(whatToCheckIdx);
      });

      it('leaves the generic prompt usable as a fallback for unlisted languages', () => {
        const prompt = buildReviewPrompt(baseInputs, 'PR context', { languages: [] });
        expect(prompt).toContain('## What to Check');
        expect(prompt).toContain('## Calibration');
        expect(prompt).toContain('## Output Format: JSON Lines');
      });

      it('injects language sections into a custom prompt file when languages are provided', () => {
        const customFile = path.join(process.cwd(), `.tmp-custom-lang-${Date.now()}.md`);
        fs.writeFileSync(customFile, 'CUSTOM_REVIEW_PROMPT_CONTENT');
        try {
          const prompt = buildReviewPrompt(
            { projectContext: '', reviewPromptFile: path.basename(customFile) },
            'PR context',
            { languages: ['rust', 'go'] },
          );
          expect(prompt).toContain('CUSTOM_REVIEW_PROMPT_CONTENT');
          expect(prompt).toContain('## Rust-Specific Review Checklist');
          expect(prompt).toContain('## Go-Specific Review Checklist');
          expect(prompt).not.toContain('## Python-Specific Review Checklist');
        } finally {
          fs.unlinkSync(customFile);
        }
      });

      it('omits language sections from a custom prompt file when no languages are provided', () => {
        const customFile = path.join(process.cwd(), `.tmp-custom-nolang-${Date.now()}.md`);
        fs.writeFileSync(customFile, 'CUSTOM_REVIEW_PROMPT_CONTENT');
        try {
          const prompt = buildReviewPrompt(
            { projectContext: '', reviewPromptFile: path.basename(customFile) },
            'PR context',
            {},
          );
          expect(prompt).toContain('CUSTOM_REVIEW_PROMPT_CONTENT');
          expect(prompt).not.toContain('## Rust-Specific Review Checklist');
          expect(prompt).not.toContain('## Go-Specific Review Checklist');
        } finally {
          fs.unlinkSync(customFile);
        }
      });
    });
  });
});
