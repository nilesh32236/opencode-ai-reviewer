import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import yaml from 'js-yaml';
import type { PromptConfig } from './types/index.js';

const CONFIG_FILENAMES = [
  '.opencode-reviewer.yml',
  '.opencode-reviewer.yaml',
  '.github/opencode-reviewer.yml',
  '.github/opencode-reviewer.yaml',
];

export function loadConfig(workingDir = '.'): PromptConfig | null {
  for (const filename of CONFIG_FILENAMES) {
    const fullPath = path.resolve(workingDir, filename);
    if (fs.existsSync(fullPath)) {
      core.info(`Loading config from ${filename}`);
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const config = yaml.load(content) as PromptConfig;
        return validateConfig(config);
      } catch (error) {
        core.warning(`Failed to parse ${filename}: ${String(error)}`);
        return null;
      }
    }
  }
  return null;
}

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

function validateConfig(config: PromptConfig): PromptConfig {
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
  }

  if (config.fix) {
    result.fix = {};
    if (typeof config.fix.maxIterations === 'number') {
      result.fix.maxIterations = Math.min(Math.max(config.fix.maxIterations, 1), 10);
    }
    if (Array.isArray(config.fix.runChecks)) {
      result.fix.runChecks = config.fix.runChecks.filter((c) => typeof c === 'string');
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
    result.learning = {
      enabled: config.learning.enabled,
      feedbackSignals: config.learning.feedbackSignals,
      metaReview: {
        enabled: config.learning.metaReview?.enabled ?? true,
        interval: config.learning.metaReview?.interval ?? 5,
        minFindingsForReview: config.learning.metaReview?.minFindingsForReview ?? 3,
      },
      patternDiscovery: {
        enabled: config.learning.patternDiscovery?.enabled ?? true,
        minFrequency: config.learning.patternDiscovery?.minFrequency ?? 3,
        windowSize: config.learning.patternDiscovery?.windowSize ?? 100,
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
  if (config.fix?.maxIterations) {
    defaults.max_fix_iterations = String(config.fix.maxIterations);
  }
  if (config.fix?.runChecks?.length) {
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
