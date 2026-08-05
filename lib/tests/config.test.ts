import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as core from '@actions/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, mergeConfigWithInputs, resolveConfig, validateConfig } from '../src/config.js';
import { DEFAULT_CONFIG } from '../src/types/index.js';
import { AgentConfigSchema, CostTrackingConfigSchema } from '../src/types/schemas.js';

vi.mock('@actions/core', () => {
  const warning = vi.fn();
  const info = vi.fn();
  const debug = vi.fn();
  const setFailed = vi.fn();
  return { warning, info, debug, setFailed };
});

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

    it('parses notifications section with defaults applied', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.opencode-reviewer.yml'),
        `notifications:
  enabled: true
  slack:
    channel: "#code-reviews"
  teams:
    webhookUrl: https://outlook.office.com/webhook/T
`,
      );
      const config = loadConfig(tmpDir);
      expect(config).not.toBeNull();
      expect(config!.notifications?.enabled).toBe(true);
      // minSeverity defaults to 'critical' via the schema.
      expect(config!.notifications?.minSeverity).toBe('critical');
      expect(config!.notifications?.slack?.channel).toBe('#code-reviews');
      expect(config!.notifications?.teams?.webhookUrl).toBe('https://outlook.office.com/webhook/T');
    });

    it('drops invalid notifications fields gracefully', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.opencode-reviewer.yml'),
        `notifications:
  enabled: "not-a-boolean"
  minSeverity: bogus
  slack:
    webhookUrl: 12345
`,
      );
      const config = loadConfig(tmpDir);
      expect(config).not.toBeNull();
      // A malformed notifications block degrades to the schema defaults instead
      // of failing the whole config parse.
      expect(config!.notifications?.enabled).toBe(false);
      expect(config!.notifications?.minSeverity).toBe('critical');
      expect(config!.notifications?.slack).toBeUndefined();
    });

    it('parses a valid multiAgent block with per-agent and synthesis settings', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.opencode-reviewer.yml'),
        `multiAgent:
  enabled: true
  agents:
    security:
      model: "openai/gpt-4o"
      promptFile: "prompts/sec.md"
    quality:
      enabled: false
  synthesis:
    enabled: true
    model: "openai/gpt-4o"
`,
      );
      const config = loadConfig(tmpDir);
      expect(config).not.toBeNull();
      expect(config!.multiAgent?.enabled).toBe(true);
      expect(config!.multiAgent?.agents?.security?.model).toBe('openai/gpt-4o');
      expect(config!.multiAgent?.agents?.security?.promptFile).toBe('prompts/sec.md');
      expect(config!.multiAgent?.agents?.quality?.enabled).toBe(false);
      expect(config!.multiAgent?.synthesis?.model).toBe('openai/gpt-4o');
    });

    it('keeps the config parse alive when multiAgent has a mistyped category key', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.opencode-reviewer.yml'),
        `review:
  systemPrompt: "still loaded"
multiAgent:
  enabled: true
  agents:
    security:
      enabled: true
    secuirty:
      enabled: true
`,
      );
      const config = loadConfig(tmpDir);
      expect(config).not.toBeNull();
      // The typo'd key is dropped (not applied) while valid sibling entries and
      // the master switch survive — the feature stays enabled.
      expect(config!.review?.systemPrompt).toBe('still loaded');
      expect(config!.multiAgent?.enabled).toBe(true);
      expect(config!.multiAgent?.agents?.security?.enabled).toBe(true);
      expect('secuirty' in (config!.multiAgent?.agents ?? {})).toBe(false);
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

    it('chains multiple runChecks with &&', () => {
      const config = { fix: { runChecks: ['npm test', 'npm run lint'] } };
      const result = mergeConfigWithInputs(config, {});
      expect(result.run_checks_after_fix).toBe('npm test && npm run lint');
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

    it('passes through review.suppressLowConfidence', () => {
      const result = validateConfig({
        review: { suppressLowConfidence: true },
      } as never);
      expect(result.review?.suppressLowConfidence).toBe(true);
    });

    it('skips review.suppressLowConfidence when not a boolean', () => {
      const result = validateConfig({ review: { suppressLowConfidence: 'yes' } } as never);
      expect(result.review?.suppressLowConfidence).toBeUndefined();
    });

    it('passes through review.budget values', () => {
      const result = validateConfig({
        review: { budget: { enabled: false, summaryThreshold: 200, splitThreshold: 800 } },
      } as never);
      expect(result.review?.budget).toEqual({
        enabled: false,
        summaryThreshold: 200,
        splitThreshold: 800,
      });
    });

    it('applies review.budget defaults when only partial config given', () => {
      const result = validateConfig({ review: { budget: { summaryThreshold: 300 } } } as never);
      expect(result.review?.budget).toEqual({
        enabled: false,
        summaryThreshold: 300,
        splitThreshold: 1000,
      });
    });

    it('clamps review.budget splitThreshold to be >= summaryThreshold', () => {
      const result = validateConfig({
        review: { budget: { summaryThreshold: 900, splitThreshold: 100 } },
      } as never);
      expect(result.review?.budget?.splitThreshold).toBe(900);
    });

    it('passes through notifications fields', () => {
      const result = validateConfig({
        notifications: {
          enabled: true,
          minSeverity: 'important',
          slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/S', channel: '#reviews' },
          teams: { webhookUrl: 'https://outlook.office.com/webhook/T' },
        },
      } as never);
      expect(result.notifications).toEqual({
        enabled: true,
        minSeverity: 'important',
        slack: { webhookUrl: 'https://hooks.slack.com/services/T/B/S', channel: '#reviews' },
        teams: { webhookUrl: 'https://outlook.office.com/webhook/T' },
      });
    });

    it('skips invalid notifications values', () => {
      const result = validateConfig({
        notifications: {
          enabled: 'yes',
          minSeverity: 'urgent',
          slack: { webhookUrl: '' },
          teams: { webhookUrl: 42 },
        },
      } as never);
      expect(result.notifications).toBeUndefined();
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

  describe('validateConfig linters', () => {
    it('passes through valid linter config', () => {
      const result = validateConfig({
        linters: [{ pattern: '**/*.ts', command: 'eslint', args: ['--format', 'json'] }],
      } as never);
      expect(result.linters).toEqual([
        { pattern: '**/*.ts', command: 'eslint', args: ['--format', 'json'] },
      ]);
    });

    it('filters invalid linter config entries', () => {
      const result = validateConfig({
        linters: [
          { pattern: '**/*.ts', command: 'eslint' },
          null,
          { pattern: '**/*.py' }, // missing command
          { command: 'ruff' }, // missing pattern
          'invalid',
        ],
      } as never);
      expect(result.linters).toHaveLength(1);
      expect(result.linters![0].pattern).toBe('**/*.ts');
      expect(result.linters![0].command).toBe('eslint');
    });

    it('accepts linter config with parseFormat', () => {
      const result = validateConfig({
        linters: [
          { pattern: '**/*.ts', command: 'eslint', parseFormat: 'eslint' as const },
          { pattern: '**/*.py', command: 'ruff', parseFormat: 'ruff' as const },
        ],
      } as never);
      expect(result.linters).toHaveLength(2);
      expect(result.linters![0].parseFormat).toBe('eslint');
      expect(result.linters![1].parseFormat).toBe('ruff');
    });

    it('filters non-object entries in linters array', () => {
      const result = validateConfig({
        linters: [null, undefined, 'string', 42] as never,
      });
      expect(result.linters).toEqual([]);
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

  describe('multiAgent config handling', () => {
    it('normalizes enabled flag and skips unknown agent-category keys', () => {
      const result = validateConfig({
        multiAgent: {
          enabled: true,
          agents: {
            security: { enabled: true },
            bogus: { enabled: true },
          },
        },
      } as never);
      expect(result.multiAgent?.enabled).toBe(true);
      expect(result.multiAgent?.agents?.security?.enabled).toBe(true);
      expect('bogus' in (result.multiAgent?.agents ?? {})).toBe(false);
    });

    it('applies defaults to partial agent configs', () => {
      const result = validateConfig({
        multiAgent: {
          enabled: true,
          agents: {
            quality: { model: 'openai/gpt-4o' },
          },
        },
      } as never);
      expect(result.multiAgent?.agents?.quality?.enabled).toBe(true);
      expect(result.multiAgent?.agents?.quality?.model).toBe('openai/gpt-4o');
    });

    it('normalizes non-boolean enabled values to defaults', () => {
      const result = validateConfig({
        multiAgent: { enabled: 'yes', agents: {} },
      } as never);
      expect(result.multiAgent?.enabled).toBe(false);
    });

    it('defaults synthesis.enabled to true when omitted', () => {
      const result = validateConfig({ multiAgent: { enabled: true } } as never);
      expect(result.multiAgent?.synthesis?.enabled).toBe(true);
    });

    it('trims per-agent model and promptFile values', () => {
      const result = validateConfig({
        multiAgent: {
          enabled: true,
          agents: {
            security: { model: ' openai/gpt-4o ', promptFile: ' prompts/sec.md ' },
          },
        },
      } as never);
      expect(result.multiAgent?.agents?.security?.model).toBe('openai/gpt-4o');
      expect(result.multiAgent?.agents?.security?.promptFile).toBe('prompts/sec.md');
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

    it('parses verificationModel when provided', () => {
      const result = AgentConfigSchema.parse({ verificationModel: 'openai/gpt-4o' });
      expect(result.verificationModel).toBe('openai/gpt-4o');
    });

    it('rejects a reviewModel that is not in provider/model-name format', () => {
      expect(() => AgentConfigSchema.parse({ reviewModel: 'gpt-4o' })).toThrow(
        /provider\/model-name/,
      );
    });

    it('rejects malformed optional model fields', () => {
      expect(() => AgentConfigSchema.parse({ auditModel: 'claude-3-5-sonnet' })).toThrow(
        /provider\/model-name/,
      );
      expect(() => AgentConfigSchema.parse({ verificationModel: 'gpt-4o' })).toThrow(
        /provider\/model-name/,
      );
      expect(() => AgentConfigSchema.parse({ synthesisModel: 'openai/gpt-4/' })).toThrow(
        /provider\/model-name/,
      );
    });

    it('leaves verificationModel undefined when not provided (falls back to reviewModel)', () => {
      const result = AgentConfigSchema.parse({});
      expect(result.verificationModel).toBeUndefined();
    });

    it('defaults enableMetaVerification to false', () => {
      const result = AgentConfigSchema.parse({});
      expect(result.review.enableMetaVerification).toBe(false);
    });

    it('parses enableMetaVerification when provided', () => {
      const result = AgentConfigSchema.parse({ review: { enableMetaVerification: true } });
      expect(result.review.enableMetaVerification).toBe(true);
    });
  });

  describe('costTracking config handling', () => {
    it('keeps enabled/verbosity unset for a partial costTracking section (rates only)', () => {
      const result = validateConfig({
        review: { costTracking: { inputCostPer1K: 0.5 } },
      } as never);
      expect(result.review?.costTracking).toEqual({ inputCostPer1K: 0.5 });
    });

    it('preserves explicitly-set enabled/verbosity', () => {
      const result = validateConfig({
        review: { costTracking: { enabled: true, verbosity: 'detailed' } },
      } as never);
      expect(result.review?.costTracking?.enabled).toBe(true);
      expect(result.review?.costTracking?.verbosity).toBe('detailed');
    });

    it('sanitizes negative cost rates away', () => {
      const result = validateConfig({
        review: { costTracking: { enabled: true, inputCostPer1K: -1, outputCostPer1K: 0.01 } },
      } as never);
      expect(result.review?.costTracking?.inputCostPer1K).toBeUndefined();
      expect(result.review?.costTracking?.outputCostPer1K).toBe(0.01);
    });

    it('does not fail the whole config parse on a malformed costTracking block', () => {
      const result = CostTrackingConfigSchema.parse({ enabled: 'true' });
      expect(result).toEqual({});
    });

    it('does not fail the whole config parse on an invalid verbosity', () => {
      const result = CostTrackingConfigSchema.parse({ verbosity: 'banana' });
      expect(result).toEqual({});
    });

    it('still loads unrelated settings when costTracking is malformed', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-config-costtest-'));
      try {
        fs.writeFileSync(
          path.join(tmpDir, '.opencode-reviewer.yml'),
          `review:
  costTracking:
    enabled: "true"
fix:
  maxIterations: 5
`,
        );
        const config = loadConfig(tmpDir);
        expect(config).not.toBeNull();
        expect(config!.fix?.maxIterations).toBe(5);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('sensitivity config parsing', () => {
    let tmpDir: string;

    beforeEach(() => {
      vi.clearAllMocks();
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-sensitivity-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('loads a full sensitivity block from YAML', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.opencode-reviewer.yml'),
        `review:
  sensitivity:
    minSeverity: error
    confidenceThreshold: medium
    maxFindingsPerCategory: 5
    maxTotalFindings: 20
    focusAreas:
      - security
      - performance
    ignorePatterns:
      - '**/*.test.ts'
      - '**/generated/**'
`,
      );
      const config = loadConfig(tmpDir);
      expect(config?.review?.sensitivity).toEqual({
        minSeverity: 'error',
        confidenceThreshold: 'medium',
        maxFindingsPerCategory: 5,
        maxTotalFindings: 20,
        focusAreas: ['security', 'performance'],
        ignorePatterns: ['**/*.test.ts', '**/generated/**'],
      });
    });

    it('applies defaults for missing sensitivity sub-fields', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.opencode-reviewer.yml'),
        `review:
  sensitivity:
    minSeverity: critical
`,
      );
      const config = loadConfig(tmpDir);
      expect(config?.review?.sensitivity?.minSeverity).toBe('critical');
      expect(config?.review?.sensitivity?.confidenceThreshold).toBe('low');
      expect(config?.review?.sensitivity?.maxTotalFindings).toBeUndefined();
    });

    it('clamps numeric sensitivity fields to the 1-500 range', () => {
      const result = validateConfig({
        review: { sensitivity: { maxTotalFindings: 9999, maxFindingsPerCategory: -3 } },
      } as never);
      expect(result.review?.sensitivity?.maxTotalFindings).toBe(500);
      expect(result.review?.sensitivity?.maxFindingsPerCategory).toBe(1);
    });

    it('clamps out-of-range caps through the real loadConfig path (end-to-end)', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.opencode-reviewer.yml'),
        `review:
  systemPrompt: "Keep unrelated settings"
  sensitivity:
    maxTotalFindings: 1000
    maxFindingsPerCategory: -3
`,
      );
      const config = loadConfig(tmpDir);
      expect(config).not.toBeNull();
      expect(config!.review?.systemPrompt).toBe('Keep unrelated settings');
      expect(config!.review?.sensitivity?.maxTotalFindings).toBe(500);
      expect(config!.review?.sensitivity?.maxFindingsPerCategory).toBe(1);
    });

    it('loads skipLabels and skipActors without unknown-key warnings', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.opencode-reviewer.yml'),
        `review:
  skipLabels:
    - autofix
  skipActors:
    - dependabot[bot]
`,
      );
      const config = loadConfig(tmpDir);
      expect(config?.review?.skipLabels).toEqual(['autofix']);
      expect(config?.review?.skipActors).toEqual(['dependabot[bot]']);
      expect(core.warning).not.toHaveBeenCalledWith(
        expect.stringContaining('Unknown config key "review.skipLabels"'),
      );
      expect(core.warning).not.toHaveBeenCalledWith(
        expect.stringContaining('Unknown config key "review.skipActors"'),
      );
    });

    it('loads review.enableMetaVerification without unknown-key warnings', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.opencode-reviewer.yml'),
        `review:
  enableMetaVerification: true
`,
      );
      const config = loadConfig(tmpDir);
      expect(config?.review?.enableMetaVerification).toBe(true);
      expect(core.warning).not.toHaveBeenCalledWith(
        expect.stringContaining('Unknown config key "review.enableMetaVerification"'),
      );
    });

    it('loads review.suppressLowConfidence end-to-end', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.opencode-reviewer.yml'),
        `review:
  suppressLowConfidence: true
`,
      );
      const config = loadConfig(tmpDir);
      expect(config?.review?.suppressLowConfidence).toBe(true);
      expect(core.warning).not.toHaveBeenCalledWith(
        expect.stringContaining('Unknown config key "review.suppressLowConfidence"'),
      );
    });

    it('rejects invalid minSeverity values', () => {
      const result = validateConfig({
        review: { sensitivity: { minSeverity: 'banana' } },
      } as never);
      expect(result.review?.sensitivity?.minSeverity).toBeUndefined();
    });

    it('rejects invalid confidenceThreshold values', () => {
      const result = validateConfig({
        review: { sensitivity: { confidenceThreshold: 'banana' } },
      } as never);
      expect(result.review?.sensitivity?.confidenceThreshold).toBeUndefined();
    });

    it('filters non-string focusAreas and ignorePatterns', () => {
      const result = validateConfig({
        review: {
          sensitivity: {
            focusAreas: ['security', null, 42],
            ignorePatterns: ['**/*.test.ts', null],
          },
        },
      } as never);
      expect(result.review?.sensitivity?.focusAreas).toEqual(['security']);
      expect(result.review?.sensitivity?.ignorePatterns).toEqual(['**/*.test.ts']);
    });

    it('logs warnings for unknown keys in the config', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.opencode-reviewer.yml'),
        `review:
  sensitivity:
    minSeverity: warning
    bogusKey: 1
unknownSection: true
`,
      );
      const config = loadConfig(tmpDir);
      expect(config).not.toBeNull();
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('Unknown config key "review.sensitivity.bogusKey"'),
      );
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('Unknown config key "unknownSection"'),
      );
    });

    it('loads config from an explicit configPath', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'custom-config.yml'),
        `review:
  sensitivity:
    minSeverity: error
`,
      );
      const config = loadConfig(tmpDir, 'github', 'custom-config.yml');
      expect(config?.review?.sensitivity?.minSeverity).toBe('error');
    });

    it('returns null when explicit configPath does not exist', () => {
      const config = loadConfig(tmpDir, 'github', 'missing.yml');
      expect(config).toBeNull();
    });
  });

  describe('per-category sensitivity overrides', () => {
    it('preserves valid category overrides', () => {
      const result = validateConfig({
        review: {
          categories: {
            security: { minSeverity: 'critical' },
            style: { enabled: false },
            performance: { maxFindings: 3 },
          },
        },
      } as never);
      expect(result.review?.categories).toEqual({
        security: { minSeverity: 'critical' },
        style: { enabled: false },
        performance: { maxFindings: 3 },
      });
    });

    it('loads categories from YAML', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-categories-test-'));
      try {
        fs.writeFileSync(
          path.join(tmpDir, '.opencode-reviewer.yml'),
          `review:
  categories:
    security:
      minSeverity: warning
    style:
      enabled: false
`,
        );
        const config = loadConfig(tmpDir);
        expect(config?.review?.categories).toEqual({
          security: { minSeverity: 'warning' },
          style: { enabled: false },
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('skips invalid category override entries', () => {
      const result = validateConfig({
        review: {
          categories: {
            security: { minSeverity: 'banana' },
            style: 'nope',
            perf: { enabled: 'yes', maxFindings: 2 },
          },
        },
      } as never);
      expect(result.review?.categories).toEqual({
        security: {},
        perf: { maxFindings: 2 },
      });
    });

    it('clamps category maxFindings to the 1-500 range', () => {
      const result = validateConfig({
        review: { categories: { security: { maxFindings: 900 } } },
      } as never);
      expect(result.review?.categories?.security?.maxFindings).toBe(500);
    });
  });

  describe('sensitivity config merge semantics', () => {
    it('DEFAULT_CONFIG ships neutral sensitivity defaults', () => {
      expect(DEFAULT_CONFIG.review.sensitivity).toEqual({
        minSeverity: 'warning',
        confidenceThreshold: 'low',
      });
    });

    it('AgentConfigSchema applies sensitivity defaults for partial blocks', () => {
      const result = AgentConfigSchema.parse({
        review: { sensitivity: { minSeverity: 'error' } },
      });
      expect(result.review.sensitivity).toEqual({
        minSeverity: 'error',
        confidenceThreshold: 'low',
        focusAreas: [],
        ignorePatterns: [],
      });
    });

    it('mergeConfigWithInputs still treats sensitivity as config-only (no input flattening)', () => {
      const config = {
        review: {
          sensitivity: { minSeverity: 'critical' },
        },
      } as never;
      const result = mergeConfigWithInputs(config, {});
      expect(result.review_min_severity).toBeUndefined();
      expect(result.review_prompt).toBeUndefined();
    });
  });

  describe('failOnSeverity config handling', () => {
    it('DEFAULT_CONFIG ships failOnSeverity defaulting to off', () => {
      expect(DEFAULT_CONFIG.review.failOnSeverity).toBe('off');
    });

    it('AgentConfigSchema defaults failOnSeverity to off', () => {
      const result = AgentConfigSchema.parse({});
      expect(result.review.failOnSeverity).toBe('off');
    });

    it('AgentConfigSchema accepts every valid failOnSeverity value', () => {
      for (const value of ['off', 'critical', 'important', 'minor']) {
        const result = AgentConfigSchema.parse({ review: { failOnSeverity: value } });
        expect(result.review.failOnSeverity).toBe(value);
      }
    });

    it('AgentConfigSchema rejects an invalid failOnSeverity value', () => {
      expect(() => AgentConfigSchema.parse({ review: { failOnSeverity: 'blocker' } })).toThrow();
    });

    it('loadConfig parses failOnSeverity from YAML and omits it when not set', () => {
      const withValue = `review:
  failOnSeverity: important
`;
      const dirWithValue = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-fos-'));
      const dirOmitted = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-fos-'));
      try {
        fs.writeFileSync(path.join(dirWithValue, '.opencode-reviewer.yml'), withValue);
        expect(loadConfig(dirWithValue)?.review?.failOnSeverity).toBe('important');

        fs.writeFileSync(
          path.join(dirOmitted, '.opencode-reviewer.yml'),
          'review:\n  inline: true\n',
        );
        expect(loadConfig(dirOmitted)?.review?.failOnSeverity).toBeUndefined();
      } finally {
        fs.rmSync(dirWithValue, { recursive: true, force: true });
        fs.rmSync(dirOmitted, { recursive: true, force: true });
      }
    });
  });
});
