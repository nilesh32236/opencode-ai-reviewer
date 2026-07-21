import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, mergeConfigWithInputs, resolveConfig, validateConfig } from '../src/config.js';
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

    it('extracts review.inline as review_inline string', () => {
      const config = { review: { inline: true } as never };
      const result = mergeConfigWithInputs(config, {});
      expect(result.review_inline).toBe('true');
    });

    it('extracts review.inline false as review_inline string', () => {
      const config = { review: { inline: false } as never };
      const result = mergeConfigWithInputs(config, {});
      expect(result.review_inline).toBe('false');
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

    it('passes through review.inline boolean', () => {
      const result = validateConfig({ review: { inline: false } } as never);
      expect(result.review?.inline).toBe(false);
    });

    it('passes through review.inline true', () => {
      const result = validateConfig({ review: { inline: true } } as never);
      expect(result.review?.inline).toBe(true);
    });

    it('skips review.inline when not a boolean', () => {
      const result = validateConfig({ review: { inline: 'yes' } } as never);
      expect(result.review?.inline).toBeUndefined();
    });

    it('returns empty object for empty config', () => {
      const result = validateConfig({});
      expect(result).toEqual({});
    });

    it('uses default allowlist when checkAllowlist not set', () => {
      const result = validateConfig({ fix: { runChecks: ['pnpm build'] } } as never);
      expect(result.fix?.checkAllowlist).toEqual(['pnpm', 'npm', 'yarn', 'node']);
    });

    it('accepts custom checkAllowlist', () => {
      const result = validateConfig({
        fix: { checkAllowlist: ['cargo', 'make'], runChecks: ['cargo build'] },
      } as never);
      expect(result.fix?.checkAllowlist).toEqual(['cargo', 'make']);
      expect(result.fix?.runChecks).toEqual(['cargo build']);
    });

    it('filters non-string entries from checkAllowlist', () => {
      const result = validateConfig({
        fix: { checkAllowlist: ['cargo', null, 42] as never },
      } as never);
      expect(result.fix?.checkAllowlist).toEqual(['cargo']);
    });

    it('falls back to default allowlist when checkAllowlist is empty', () => {
      const result = validateConfig({
        fix: { checkAllowlist: [] },
      } as never);
      expect(result.fix?.checkAllowlist).toEqual(['pnpm', 'npm', 'yarn', 'node']);
    });

    it('skips runChecks with program not in checkAllowlist', () => {
      const result = validateConfig({
        fix: {
          checkAllowlist: ['pnpm', 'npm'],
          runChecks: ['pnpm build', 'cargo test', 'npm lint'],
        },
      } as never);
      expect(result.fix?.runChecks).toEqual(['pnpm build', 'npm lint']);
    });
  });

  describe('resolveConfig', () => {
    const baseConfig = {
      review: { customRules: ['base-rule'] },
      fix: { maxIterations: 3 },
      audit: { categories: ['security'] },
    };

    it('returns config unchanged when no overrides exist', () => {
      const result = resolveConfig(baseConfig, { paths: ['src/main.ts'] });
      expect(result.review?.customRules).toEqual(['base-rule']);
      expect(result.fix?.maxIterations).toBe(3);
    });

    it('returns config unchanged when overrides is empty array', () => {
      const result = resolveConfig({ ...baseConfig, overrides: [] }, { paths: ['src/main.ts'] });
      expect(result.review?.customRules).toEqual(['base-rule']);
    });

    it('applies override on exact path match', () => {
      const config = {
        ...baseConfig,
        overrides: [
          {
            path: 'src/main.ts',
            review: { customRules: ['path-specific'] },
          },
        ],
      };
      const result = resolveConfig(config, { paths: ['src/main.ts'] });
      expect(result.review?.customRules).toContain('path-specific');
      expect(result.review?.customRules).toContain('base-rule');
    });

    it('applies override on glob path match', () => {
      const config = {
        ...baseConfig,
        overrides: [
          {
            path: 'packages/frontend/**',
            review: { customRules: ['react-rule'] },
          },
        ],
      };
      const result = resolveConfig(config, {
        paths: ['packages/frontend/src/Button.tsx', 'packages/frontend/src/App.tsx'],
      });
      expect(result.review?.customRules).toContain('react-rule');
    });

    it('applies override on branch match', () => {
      const config = {
        ...baseConfig,
        overrides: [
          {
            branch: 'feature/*',
            fix: { maxIterations: 5 },
          },
        ],
      };
      const result = resolveConfig(config, {
        branch: 'feature/add-login',
        paths: [],
      });
      expect(result.fix?.maxIterations).toBe(5);
    });

    it('does not apply override when branch does not match', () => {
      const config = {
        ...baseConfig,
        overrides: [
          {
            branch: 'feature/*',
            fix: { maxIterations: 5 },
          },
        ],
      };
      const result = resolveConfig(config, {
        branch: 'main',
        paths: [],
      });
      expect(result.fix?.maxIterations).toBe(3);
    });

    it('does not apply override when path does not match', () => {
      const config = {
        ...baseConfig,
        overrides: [
          {
            path: 'packages/api/**',
            review: { customRules: ['api-rule'] },
          },
        ],
      };
      const result = resolveConfig(config, {
        paths: ['packages/frontend/src/App.tsx'],
      });
      expect(result.review?.customRules).toEqual(['base-rule']);
    });

    it('applies inline override from review config', () => {
      const config = {
        ...baseConfig,
        overrides: [
          {
            path: 'packages/frontend/**',
            review: { inline: false },
          },
        ],
      };
      const result = resolveConfig(config, {
        paths: ['packages/frontend/src/Button.tsx'],
      });
      expect(result.review?.inline).toBe(false);
    });

    it('does not apply inline override when path does not match', () => {
      const config = {
        ...baseConfig,
        overrides: [
          {
            path: 'packages/api/**',
            review: { inline: false },
          },
        ],
      };
      const result = resolveConfig(config, {
        paths: ['packages/frontend/src/App.tsx'],
      });
      expect(result.review?.inline).toBeUndefined();
    });

    it('returns base config when no paths or branch provided', () => {
      const config = {
        ...baseConfig,
        overrides: [
          {
            path: 'src/**',
            review: { customRules: ['should-not-apply'] },
          },
        ],
      };
      const result = resolveConfig(config, {});
      expect(result.review?.customRules).toEqual(['base-rule']);
    });

    it('merges multiple matching overrides', () => {
      const config = {
        ...baseConfig,
        overrides: [
          {
            path: 'packages/frontend/**',
            review: { customRules: ['react-rule'] },
            fix: { maxIterations: 5 },
          },
          {
            path: 'packages/frontend/**',
            audit: { categories: ['ui-ux-accessibility'] },
          },
        ],
      };
      const result = resolveConfig(config, {
        paths: ['packages/frontend/src/Button.tsx'],
      });
      expect(result.review?.customRules).toContain('react-rule');
      expect(result.review?.customRules).toContain('base-rule');
      expect(result.fix?.maxIterations).toBe(5);
      expect(result.audit?.categories).toEqual(['ui-ux-accessibility']);
    });

    it('applies path and branch overrides together', () => {
      const config = {
        ...baseConfig,
        overrides: [
          {
            path: 'packages/frontend/**',
            review: { customRules: ['react-rule'] },
          },
          {
            branch: 'feature/*',
            fix: { maxIterations: 7 },
          },
        ],
      };
      const result = resolveConfig(config, {
        paths: ['packages/frontend/src/Button.tsx'],
        branch: 'feature/add-login',
      });
      expect(result.review?.customRules).toContain('react-rule');
      expect(result.fix?.maxIterations).toBe(7);
    });

    it('override audit categories replace base categories', () => {
      const config = {
        ...baseConfig,
        overrides: [
          {
            path: 'packages/frontend/**',
            audit: { categories: ['ui-ux-accessibility', 'performance'] },
          },
        ],
      };
      const result = resolveConfig(config, {
        paths: ['packages/frontend/src/App.tsx'],
      });
      expect(result.audit?.categories).toEqual(['ui-ux-accessibility', 'performance']);
    });
  });

  describe('validateConfig overrides', () => {
    it('passes through valid overrides', () => {
      const result = validateConfig({
        overrides: [
          {
            path: 'packages/frontend/**',
            review: { customRules: ['react-rule'] },
            fix: { maxIterations: 7 },
            audit: { categories: ['ui-ux'] },
          },
        ],
      } as never);
      expect(result.overrides).toHaveLength(1);
      expect(result.overrides![0].path).toBe('packages/frontend/**');
      expect(result.overrides![0].review?.customRules).toEqual(['react-rule']);
      expect(result.overrides![0].fix?.maxIterations).toBe(7);
      expect(result.overrides![0].audit?.categories).toEqual(['ui-ux']);
    });

    it('clamps maxIterations in overrides', () => {
      const result = validateConfig({
        overrides: [{ fix: { maxIterations: 100 } }],
      } as never);
      expect(result.overrides![0].fix?.maxIterations).toBe(10);
    });

    it('filters non-string override custom rules', () => {
      const result = validateConfig({
        overrides: [{ review: { customRules: ['valid', null, 123] } }],
      } as never);
      expect(result.overrides![0].review?.customRules).toEqual(['valid']);
    });

    it('filters non-string override audit categories', () => {
      const result = validateConfig({
        overrides: [{ audit: { categories: ['security', null, 42] } }],
      } as never);
      expect(result.overrides![0].audit?.categories).toEqual(['security']);
    });

    it('passes through override review.inline boolean', () => {
      const result = validateConfig({
        overrides: [{ path: 'src/', review: { inline: false } }],
      } as never);
      expect(result.overrides![0].review?.inline).toBe(false);
    });

    it('skips override review.inline when not a boolean', () => {
      const result = validateConfig({
        overrides: [{ path: 'src/', review: { inline: 'maybe' } }],
      } as never);
      expect(result.overrides![0].review?.inline).toBeUndefined();
    });

    it('skips invalid override entries', () => {
      const result = validateConfig({
        overrides: [null, undefined, 'string', { path: 'src/' }],
      } as never);
      expect(result.overrides).toHaveLength(1);
      expect(result.overrides![0].path).toBe('src/');
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
