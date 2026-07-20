import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, mergeConfigWithInputs, validateConfig } from '../src/config.js';
import { DEFAULT_CONFIG } from '../src/types/index.js';
import { AgentConfigSchema } from '../src/types/schemas.js';

describe('config', () => {
  it('DEFAULT_CONFIG is defined', () => {
    expect(DEFAULT_CONFIG).toBeDefined();
    expect(DEFAULT_CONFIG.reviewModel).toBeTruthy();
  });

  describe('loadConfig', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns null when config file missing', () => {
      const config = loadConfig('/nonexistent');
      expect(config).toBeNull();
    });

    it('returns null for empty working dir', () => {
      const config = loadConfig('');
      expect(config).toBeNull();
    });

    it('returns parsed config when valid YAML file exists', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.opencode-reviewer.yml'),
        `review:
  systemPrompt: "Be thorough"
fix:
  maxIterations: 5
`,
      );
      const config = loadConfig(tmpDir);
      expect(config).not.toBeNull();
      expect(config!.review?.systemPrompt).toBe('Be thorough');
      expect(config!.fix?.maxIterations).toBe(5);
    });

    it('returns null when YAML is malformed', () => {
      fs.writeFileSync(path.join(tmpDir, '.opencode-reviewer.yml'), 'invalid: [yaml: broken');
      const config = loadConfig(tmpDir);
      expect(config).toBeNull();
    });

    it('returns null when YAML is null', () => {
      fs.writeFileSync(path.join(tmpDir, '.opencode-reviewer.yml'), '');
      const config = loadConfig(tmpDir);
      expect(config).toBeNull();
    });

    it('prefers first matching config file in priority order', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.opencode-reviewer.yml'),
        'review:\n  systemPrompt: "first"',
      );
      fs.writeFileSync(
        path.join(tmpDir, '.opencode-reviewer.yaml'),
        'review:\n  systemPrompt: "second"',
      );
      const config = loadConfig(tmpDir);
      expect(config!.review?.systemPrompt).toBe('first');
    });

    it('searches .github subdirectory as fallback', () => {
      const githubDir = path.join(tmpDir, '.github');
      fs.mkdirSync(githubDir);
      fs.writeFileSync(
        path.join(githubDir, 'opencode-reviewer.yml'),
        'review:\n  systemPrompt: "github config"',
      );
      const config = loadConfig(tmpDir);
      expect(config!.review?.systemPrompt).toBe('github config');
    });
  });

  describe('mergeConfigWithInputs', () => {
    it('returns inputs when config is null', () => {
      const result = mergeConfigWithInputs(null, { key: 'val' });
      expect(result).toEqual({ key: 'val' });
    });

    it('returns inputs when config is undefined-like empty object', () => {
      const result = mergeConfigWithInputs({}, { existing: 'value' });
      expect(result.existing).toBe('value');
    });

    it('merges config defaults with inputs, inputs take precedence', () => {
      const config = {
        review: { systemPrompt: 'from config' },
      };
      const result = mergeConfigWithInputs(config, { review_prompt: 'from input' });
      expect(result.review_prompt).toBe('from input');
    });

    it('extracts review systemPrompt as review_prompt', () => {
      const config = { review: { systemPrompt: 'custom prompt' } };
      const result = mergeConfigWithInputs(config, {});
      expect(result.review_prompt).toBe('custom prompt');
    });

    it('extracts review extraContext as review_prompt_extra', () => {
      const config = { review: { extraContext: 'some context' } };
      const result = mergeConfigWithInputs(config, {});
      expect(result.review_prompt_extra).toBe('some context');
    });

    it('extracts fix maxIterations as string', () => {
      const config = { fix: { maxIterations: 7 } };
      const result = mergeConfigWithInputs(config, {});
      expect(result.max_fix_iterations).toBe('7');
    });

    it('extracts first runCheck', () => {
      const config = { fix: { runChecks: ['npm test', 'npm run lint'] } };
      const result = mergeConfigWithInputs(config, {});
      expect(result.run_checks_after_fix).toBe('npm test');
    });

    it('extracts audit config', () => {
      const config = { audit: { promptsDir: './audit', createIssues: false, autoFix: false } };
      const result = mergeConfigWithInputs(config, {});
      expect(result.audit_prompts_dir).toBe('./audit');
      expect(result.audit_create_issues).toBe('false');
      expect(result.audit_auto_fix).toBe('false');
    });

    it('builds project context string with name, description, conventions, and commands', () => {
      const config = {
        project: {
          name: 'TestProj',
          description: 'A test project',
          conventions: ['Use strict mode', 'No any'],
          commandReference: { build: 'npm run build', test: 'npm test' },
        },
      };
      const result = mergeConfigWithInputs(config, {});
      expect(result.project_context).toContain('**Project:** TestProj');
      expect(result.project_context).toContain('A test project');
      expect(result.project_context).toContain('Use strict mode');
      expect(result.project_context).toContain('No any');
      expect(result.project_context).toContain('`build`');
      expect(result.project_context).toContain('`test`');
    });
  });

  describe('validateConfig', () => {
    it('clamps maxIterations to max 10', () => {
      const result = validateConfig({ fix: { maxIterations: 100 } } as never);
      expect(result.fix?.maxIterations).toBe(10);
    });

    it('clamps maxIterations to min 1', () => {
      const result = validateConfig({ fix: { maxIterations: 0 } } as never);
      expect(result.fix?.maxIterations).toBe(1);
    });

    it('preserves valid maxIterations within range', () => {
      const result = validateConfig({ fix: { maxIterations: 5 } } as never);
      expect(result.fix?.maxIterations).toBe(5);
    });

    it('filters non-string custom rules', () => {
      const result = validateConfig({
        review: { customRules: ['valid', null, 123, 'also valid'] },
      } as never);
      expect(result.review?.customRules).toEqual(['valid', 'also valid']);
    });

    it('filters non-string audit categories', () => {
      const result = validateConfig({
        audit: { categories: ['security', null, 42, 'performance'] },
      } as never);
      expect(result.audit?.categories).toEqual(['security', 'performance']);
    });

    it('filters non-string project conventions', () => {
      const result = validateConfig({
        project: { conventions: ['good', null, 'bad'] },
      } as never);
      expect(result.project?.conventions).toEqual(['good', 'bad']);
    });

    it('passes through audit booleans', () => {
      const result = validateConfig({
        audit: { createIssues: true, autoFix: true },
      } as never);
      expect(result.audit?.createIssues).toBe(true);
      expect(result.audit?.autoFix).toBe(true);
    });

    it('applies learning defaults for missing values', () => {
      const result = validateConfig({ learning: {} } as never);
      expect(result.learning?.metaReview?.interval).toBe(5);
      expect(result.learning?.metaReview?.minFindingsForReview).toBe(3);
      expect(result.learning?.patternDiscovery?.minFrequency).toBe(3);
      expect(result.learning?.patternDiscovery?.windowSize).toBe(100);
    });

    it('uses config learning values when provided', () => {
      const result = validateConfig({
        learning: {
          metaReview: { interval: 8, minFindingsForReview: 2 },
          patternDiscovery: { minFrequency: 10, windowSize: 200 },
        },
      } as never);
      expect(result.learning?.metaReview?.interval).toBe(8);
      expect(result.learning?.metaReview?.minFindingsForReview).toBe(2);
      expect(result.learning?.patternDiscovery?.minFrequency).toBe(10);
      expect(result.learning?.patternDiscovery?.windowSize).toBe(200);
    });

    it('returns empty object for empty config', () => {
      const result = validateConfig({});
      expect(result).toEqual({});
    });
  });

  describe('AgentConfigSchema (zod)', () => {
    it('parses learning config via zod schema', () => {
      const result = AgentConfigSchema.parse({
        learning: {
          enabled: true,
          metaReview: { interval: 10 },
          patternDiscovery: { minFrequency: 5 },
        },
      });
      expect(result.learning.metaReview.interval).toBe(10);
      expect(result.learning.patternDiscovery.minFrequency).toBe(5);
    });

    it('applies learning defaults', () => {
      const result = AgentConfigSchema.parse({});
      expect(result.learning.metaReview.interval).toBe(5);
      expect(result.learning.patternDiscovery.minFrequency).toBe(3);
      expect(result.learning.patternDiscovery.windowSize).toBe(100);
    });
  });
});
