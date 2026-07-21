import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import yaml from 'js-yaml';
import type { ConfigOverride, PromptConfig } from './types/index.js';

export interface ResolveConfigOptions {
  /** File paths being reviewed (for path-based overrides) */
  paths?: string[];
  /** Current branch name (for branch-based overrides) */
  branch?: string;
}

const CONFIG_FILENAMES = [
  '.opencode-reviewer.yml',
  '.opencode-reviewer.yaml',
  '.github/opencode-reviewer.yml',
  '.github/opencode-reviewer.yaml',
];

/**
 * Load configuration from one of the known config file paths.
 * Searches for .opencode-reviewer.yml/yaml and .github/opencode-reviewer.yml/yaml.
 * @param workingDir - Directory to search from (defaults to current working directory).
 * @returns Parsed and validated PromptConfig, or null if no config file exists or parsing fails.
 */
export function loadConfig(workingDir = '.'): PromptConfig | null {
  for (const filename of CONFIG_FILENAMES) {
    const fullPath = path.resolve(workingDir, filename);
    if (fs.existsSync(fullPath)) {
      core.info(`Loading config from ${filename}`);
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const config = yaml.load(content) as PromptConfig;
        if (!config) return null;
        return validateConfig(config);
      } catch (error) {
        core.warning(`Failed to parse ${filename}: ${String(error)}`);
        return null;
      }
    }
  }
  return null;
}

/**
 * Merge a loaded PromptConfig with raw action inputs.
 * Config values serve as defaults; inputs take precedence.
 * @param config - Optional loaded config (null if no config file found).
 * @param inputs - Raw action input key-value pairs.
 * @returns Merged flat record of config defaults overlaid with inputs.
 */
export function mergeConfigWithInputs(
  config: PromptConfig | null,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  if (!config) return inputs;

  return {
    ...extractDefaultsFromConfig(config),
    ...inputs,
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesGlob(pattern: string, value: string): boolean {
  const result: string[] = [];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      result.push(escapeRegex(pattern[i + 1]));
      i += 2;
    } else if (ch === '*') {
      if (i + 1 < pattern.length && pattern[i + 1] === '*') {
        result.push('.*');
        i += 2;
      } else {
        result.push('[^/]*');
        i += 1;
      }
    } else if (ch === '?') {
      result.push('.');
      i += 1;
    } else {
      result.push(escapeRegex(ch));
      i += 1;
    }
  }
  return new RegExp(`^${result.join('')}$`).test(value);
}

/**
 * Resolve a PromptConfig with path- and branch-based overrides.
 * Overrides matching the given file paths or branch are merged into the base config.
 * @param config - The base PromptConfig (must be validated first).
 * @param options - ResolveConfigOptions containing paths (files being reviewed) and/or branch name.
 * @returns A new PromptConfig with applicable overrides applied.
 */
export function resolveConfig(config: PromptConfig, options: ResolveConfigOptions): PromptConfig {
  if (!config.overrides?.length) return config;

  const { paths = [], branch } = options;
  const result: PromptConfig = { ...config, overrides: undefined };

  for (const override of config.overrides) {
    let matches = false;

    if (override.path && paths.length > 0) {
      matches = paths.some((p) => matchesGlob(override.path!, p));
    }

    if (!matches && override.branch && branch) {
      matches = matchesGlob(override.branch, branch);
    }

    if (!matches) continue;

    if (override.review?.customRules || override.review?.inline !== undefined) {
      const existingRules = result.review?.customRules || [];
      result.review = {
        ...result.review,
        ...(override.review.customRules
          ? { customRules: [...existingRules, ...override.review.customRules] }
          : {}),
        ...(override.review.inline !== undefined ? { inline: override.review.inline } : {}),
      };
    }

    if (override.fix?.maxIterations !== undefined) {
      result.fix = {
        ...result.fix,
        maxIterations: override.fix.maxIterations,
      };
    }

    if (override.audit?.categories) {
      result.audit = {
        ...result.audit,
        categories: override.audit.categories,
      };
    }
  }

  return result;
}

/**
 * Validate and sanitize a PromptConfig, clamping numeric values and filtering arrays.
 * Warns on invalid check allowlist entries. Applies bounds to fix iterations (1-10).
 * @param config - Raw config parsed from YAML.
 * @returns Sanitized PromptConfig with only valid fields preserved.
 */
export function validateConfig(config: PromptConfig): PromptConfig {
  const result: PromptConfig = {};

  if (config.review) {
    result.review = {};
    if (typeof config.review.systemPrompt === 'string') {
      result.review.systemPrompt = config.review.systemPrompt;
    }
    if (typeof config.review.extraContext === 'string') {
      result.review.extraContext = config.review.extraContext;
    }
    if (Array.isArray(config.review.customRules)) {
      result.review.customRules = config.review.customRules.filter((r) => typeof r === 'string');
    }
    if (typeof config.review.inline === 'boolean') {
      result.review.inline = config.review.inline;
    }
  }

  if (config.fix) {
    result.fix = {};
    if (typeof config.fix.maxIterations === 'number') {
      result.fix.maxIterations = Math.min(Math.max(config.fix.maxIterations, 1), 10);
    }
    const defaultAllowlist = ['pnpm', 'npm', 'yarn', 'node'];
    const allowlist = Array.isArray(config.fix.checkAllowlist)
      ? config.fix.checkAllowlist.filter((c) => typeof c === 'string')
      : defaultAllowlist;
    if (allowlist.length === 0) {
      result.fix.checkAllowlist = defaultAllowlist;
    } else {
      result.fix.checkAllowlist = allowlist;
    }
    if (Array.isArray(config.fix.runChecks)) {
      const allowedPrograms = result.fix.checkAllowlist;
      result.fix.runChecks = config.fix.runChecks.filter((c) => {
        if (typeof c !== 'string') return false;
        const program = c.trim().split(/\s+/)[0];
        if (!allowedPrograms.includes(program)) {
          core.warning(
            `Command "${c}" uses "${program}" which is not in the check allowlist [${allowedPrograms.join(', ')}]. Skipping.`,
          );
          return false;
        }
        return true;
      });
    }
  }

  if (config.audit) {
    result.audit = {};
    if (typeof config.audit.promptsDir === 'string') {
      result.audit.promptsDir = config.audit.promptsDir;
    }
    if (Array.isArray(config.audit.categories)) {
      result.audit.categories = config.audit.categories.filter((c) => typeof c === 'string');
    }
    if (typeof config.audit.createIssues === 'boolean') {
      result.audit.createIssues = config.audit.createIssues;
    }
    if (typeof config.audit.autoFix === 'boolean') {
      result.audit.autoFix = config.audit.autoFix;
    }
  }

  if (config.learning) {
    const rawInterval = config.learning.metaReview?.interval;
    const rawMinFindings = config.learning.metaReview?.minFindingsForReview;
    const rawMinFreq = config.learning.patternDiscovery?.minFrequency;
    const rawWindowSize = config.learning.patternDiscovery?.windowSize;

    const interval =
      typeof rawInterval === 'number' && rawInterval >= 1 ? Math.round(rawInterval) : 5;
    const minFindings =
      typeof rawMinFindings === 'number' && rawMinFindings >= 0 ? Math.round(rawMinFindings) : 3;
    const minFrequency =
      typeof rawMinFreq === 'number' && rawMinFreq >= 1 ? Math.round(rawMinFreq) : 3;
    const windowSize =
      typeof rawWindowSize === 'number' && rawWindowSize >= 1 ? Math.round(rawWindowSize) : 100;

    result.learning = {
      enabled: config.learning.enabled,
      feedbackSignals: config.learning.feedbackSignals,
      metaReview: {
        enabled: config.learning.metaReview?.enabled ?? true,
        interval,
        minFindingsForReview: minFindings,
      },
      patternDiscovery: {
        enabled: config.learning.patternDiscovery?.enabled ?? true,
        minFrequency,
        windowSize,
      },
    };
  }

  if (config.project) {
    result.project = {};
    if (typeof config.project.name === 'string') {
      result.project.name = config.project.name;
    }
    if (typeof config.project.description === 'string') {
      result.project.description = config.project.description;
    }
    if (Array.isArray(config.project.conventions)) {
      result.project.conventions = config.project.conventions.filter((c) => typeof c === 'string');
    }
    if (config.project.commandReference && typeof config.project.commandReference === 'object') {
      result.project.commandReference = { ...config.project.commandReference };
    }
  }

  if (Array.isArray(config.overrides)) {
    result.overrides = [];
    for (const o of config.overrides) {
      if (!o || typeof o !== 'object') continue;
      const validated: Record<string, unknown> = {};
      if (typeof o.path === 'string') validated.path = o.path;
      if (typeof o.branch === 'string') validated.branch = o.branch;
      if (
        o.review &&
        (Array.isArray(o.review.customRules) || typeof o.review.inline === 'boolean')
      ) {
        validated.review = {};
        if (Array.isArray(o.review.customRules)) {
          (validated.review as Record<string, unknown>).customRules = o.review.customRules.filter(
            (r: unknown) => typeof r === 'string',
          );
        }
        if (typeof o.review.inline === 'boolean') {
          (validated.review as Record<string, unknown>).inline = o.review.inline;
        }
      }
      if (o.fix && typeof o.fix.maxIterations === 'number') {
        validated.fix = {
          maxIterations: Math.min(Math.max(o.fix.maxIterations, 1), 10),
        };
      }
      if (o.audit && Array.isArray(o.audit.categories)) {
        validated.audit = {
          categories: o.audit.categories.filter((c: unknown) => typeof c === 'string'),
        };
      }
      result.overrides.push(validated as ConfigOverride);
    }
  }

  return result;
}

function extractDefaultsFromConfig(config: PromptConfig): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};

  if (config.review?.systemPrompt) {
    defaults.review_prompt = config.review.systemPrompt;
  }
  if (config.review?.extraContext) {
    defaults.review_prompt_extra = config.review.extraContext;
  }
  if (config.review?.inline !== undefined) {
    defaults.review_inline = String(config.review.inline);
  }
  if (config.fix?.maxIterations) {
    defaults.max_fix_iterations = String(config.fix.maxIterations);
  }
  if (config.fix?.runChecks?.length) {
    if (config.fix.runChecks.length > 1) {
      core.warning(
        `config.fix.runChecks has ${config.fix.runChecks.length} entries but only the first will be executed. Use a single command or wrap multiple checks in a script.`,
      );
    }
    defaults.run_checks_after_fix = config.fix.runChecks[0];
  }
  if (config.audit?.promptsDir) {
    defaults.audit_prompts_dir = config.audit.promptsDir;
  }
  if (config.audit?.createIssues === false) {
    defaults.audit_create_issues = 'false';
  }
  if (config.audit?.autoFix === false) {
    defaults.audit_auto_fix = 'false';
  }
  if (config.project?.description) {
    defaults.project_context = [
      config.project.name ? `**Project:** ${config.project.name}` : '',
      config.project.description,
      config.project?.conventions?.length
        ? '\n## Conventions\n' + config.project.conventions.map((c) => `- ${c}`).join('\n')
        : '',
      config.project?.commandReference
        ? '\n## Commands\n' +
          Object.entries(config.project.commandReference)
            .map(([k, v]) => `- \`${k}\`: ${v}`)
            .join('\n')
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  return defaults;
}
