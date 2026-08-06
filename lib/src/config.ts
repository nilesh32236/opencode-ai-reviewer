import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import yaml from 'js-yaml';
import { minimatch } from 'minimatch';
import type {
  AgentCategory,
  CategoryOverride,
  ConfigOverride,
  DocsConfig,
  LLMConfig,
  LLMProviderConfig,
  LinterConfig,
  MultiAgentAgentConfig,
  MultiAgentConfig,
  NotificationsConfig,
  PromptConfig,
  ReviewSensitivityConfig,
  SlackConfig,
  TeamsConfig,
} from './types/index.js';
import type { Platform } from './types/index.js';
import { isDocStyle } from './types/index.js';
import { PromptConfigSchema } from './types/schemas.js';
import { DEFAULT_ALLOWLIST } from './utils/command.js';
import { Logger } from './utils/logger.js';

/**
 * Shape descriptor used to detect unknown keys in a raw config object.
 * - `null` means "accept anything" (leaf or opaque container).
 * - An object means "recurse into these keys".
 * - An array `[shape]` means "arbitrary keys, each value follows `shape`".
 */
type ConfigShape = null | ConfigShapeObject | [ConfigShapeObject];

/** Object whose values are nested ConfigShape descriptors. */
interface ConfigShapeObject {
  [key: string]: ConfigShape;
}

const CATEGORY_OVERRIDE_SHAPE: Record<string, ConfigShape> = {
  minSeverity: null,
  enabled: null,
  maxFindings: null,
};

const KNOWN_CONFIG_SHAPE: Record<string, ConfigShape> = {
  platform: null,
  review: {
    skipLabels: null,
    skipActors: null,
    systemPrompt: null,
    extraContext: null,
    customRules: null,
    inline: null,
    suppressLowConfidence: null,
    excludePatterns: null,
    enableReachability: null,
    enableMetaVerification: null,
    enableCodebaseIndex: null,
    includePreExisting: null,
    failOnSeverity: null,
    tokenBudget: null,
    budget: null,
    costTracking: null,
    sensitivity: {
      minSeverity: null,
      confidenceThreshold: null,
      maxFindingsPerCategory: null,
      maxTotalFindings: null,
      focusAreas: null,
      ignorePatterns: null,
    },
    categories: [CATEGORY_OVERRIDE_SHAPE],
  },
  fix: {
    systemPrompt: null,
    maxIterations: null,
    runChecks: null,
    checkAllowlist: null,
  },
  audit: {
    promptsDir: null,
    categories: null,
    targetDirs: null,
    createIssues: null,
    autoFix: null,
  },
  docs: {
    enabled: null,
    style: null,
  },
  learning: {
    enabled: null,
    feedbackSignals: null,
    metaReview: null,
    patternDiscovery: null,
  },
  project: {
    name: null,
    description: null,
    conventions: null,
    commandReference: null,
  },
  conversation: {
    maxTurns: null,
    slidingWindowSize: null,
    contextTokenBudget: null,
    summarizationModel: null,
    askCommandEnabled: null,
    maxCodeReferences: null,
  },
  overrides: null,
  linters: null,
  eventLogging: {
    enabled: null,
    path: null,
  },
  eventSubscribers: null,
  notifications: {
    enabled: null,
    minSeverity: null,
    slack: {
      webhookUrl: null,
      channel: null,
    },
    teams: {
      webhookUrl: null,
    },
  },
  multiAgent: {
    enabled: null,
    agents: [
      {
        enabled: null,
        model: null,
        promptFile: null,
      },
    ],
    synthesis: {
      enabled: null,
      model: null,
    },
  },
  secrets: {
    enabled: null,
    entropyThreshold: null,
    minLength: null,
    allowlist: null,
    failCI: null,
    excludePatterns: null,
  },
  llm: {
    defaultProvider: null,
    providers: [
      {
        type: null,
        baseUrl: null,
        apiKey: null,
        endpoint: null,
        resourceName: null,
        apiVersion: null,
        deployment: null,
        modelId: null,
        region: null,
        model: null,
        models: null,
      },
    ],
  },
};

/**
 * Recursively walk a raw (pre-schema) config object and log a warning for every
 * key that is not part of the known config shape. Zod strips unknown keys by
 * default during `PromptConfigSchema.parse`, so this must run on the raw YAML
 * object before parsing to satisfy the "config validation reports unknown keys"
 * requirement.
 *
 * @param raw - Raw config value (e.g. from js-yaml).
 * @param shape - Known shape descriptor to validate against.
 * @param prefix - Dot-prefix for the current level, used in warning messages.
 */
function warnUnknownKeys(raw: unknown, shape: ConfigShape, prefix: string): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  if (shape === null) return;

  const entries = Object.entries(raw);

  if (Array.isArray(shape)) {
    // Record shape: arbitrary keys, each value validated against shape[0].
    for (const [key, value] of entries) {
      warnUnknownKeys(value, shape[0], `${prefix}${key}.`);
    }
    return;
  }

  for (const [key, value] of entries) {
    const childShape = shape[key];
    if (childShape === undefined) {
      core.warning(`Unknown config key "${prefix}${key}" will be ignored`);
      continue;
    }
    warnUnknownKeys(value, childShape, `${prefix}${key}.`);
  }
}

/** Options for resolving configuration values. */
export interface ResolveConfigOptions {
  /** File paths being reviewed (for path-based overrides) */
  paths?: string[];
  /** Current branch name (for branch-based overrides) */
  branch?: string;
}

/**
 * Build platform-specific config filenames.
 * For 'github' (default): checks .opencode-reviewer.yml/yaml and .github/opencode-reviewer.yml/yaml.
 * For 'gitlab': checks .opencode-reviewer.yml/yaml and .gitlab/opencode-reviewer.yml/yaml.
 * @param platform - Platform identifier ('github' or 'gitlab', defaults to 'github').
 * @returns Array of config filenames to search.
 */
export function getConfigFilenames(platform?: Platform): string[] {
  const platformDir = platform === 'gitlab' ? '.gitlab' : '.github';
  return [
    '.opencode-reviewer.yml',
    '.opencode-reviewer.yaml',
    `${platformDir}/opencode-reviewer.yml`,
    `${platformDir}/opencode-reviewer.yaml`,
  ];
}

/**
 * Load the first matching config file from well-known paths, or from an explicit
 * `configPath` when provided (e.g. a `--config` CLI flag / `config` action input).
 * Searches for .opencode-reviewer.yml/yaml in the working directory and platform-specific directory.
 *
 * @param workingDir - Directory to start searching from (default: current working directory).
 * @param platform - Platform identifier ('github' or 'gitlab', defaults to 'github').
 * @param configPath - Optional explicit config file path (relative to workingDir). When set,
 * only this file is loaded and the well-known filename search is skipped.
 * @returns Parsed and validated PromptConfig, or null if no config file is found.
 */
export function loadConfig(
  workingDir = '.',
  platform?: Platform,
  configPath?: string,
): PromptConfig | null {
  if (configPath) {
    const fullPath = path.resolve(workingDir, configPath);
    if (!fs.existsSync(fullPath)) {
      core.warning(`Config file not found at ${fullPath}`);
      return null;
    }
    core.info(`Loading config from ${configPath}`);
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const raw = yaml.load(content) as Record<string, unknown>;
      warnUnknownKeys(raw, KNOWN_CONFIG_SHAPE, '');
      const config = PromptConfigSchema.parse(raw);
      return validateConfig(config);
    } catch (error) {
      core.warning(`Failed to parse ${configPath}: ${String(error)}`);
      return null;
    }
  }

  const configFilenames = getConfigFilenames(platform);
  for (const filename of configFilenames) {
    const fullPath = path.resolve(workingDir, filename);
    if (fs.existsSync(fullPath)) {
      core.info(`Loading config from ${filename}`);
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const raw = yaml.load(content) as Record<string, unknown>;
        warnUnknownKeys(raw, KNOWN_CONFIG_SHAPE, '');
        const config = PromptConfigSchema.parse(raw);
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
 * Merge a parsed config with action inputs. Config values serve as defaults
 * and are overridden by any explicit inputs.
 *
 * @param config - Parsed PromptConfig (may be null).
 * @param inputs - Raw action input key-value pairs.
 * @returns Merged config-object with input values taking precedence.
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

function matchesGlob(pattern: string, value: string): boolean {
  return minimatch(value, pattern);
}

/**
 * Apply path- and branch-based config overrides to produce the final effective config.
 * Overrides are matched by glob patterns on file paths or branch names.
 *
 * @param config - Base PromptConfig.
 * @param options - Resolution options including file paths and current branch.
 * @returns A new PromptConfig with applicable overrides merged in.
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

    if (override.review) {
      const existingRules = result.review?.customRules || [];
      result.review = { ...result.review, ...override.review };
      if (override.review.customRules) {
        result.review.customRules = [...existingRules, ...override.review.customRules];
      }
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
 * Validate and sanitize a PromptConfig object.
 * Filters unknown properties, clamps numeric values to allowed ranges,
 * and applies allowlist filtering on check commands.
 *
 * @param config - Raw PromptConfig to validate.
 * @returns A sanitized PromptConfig with only recognized, valid fields.
 */
export function validateConfig(config: PromptConfig): PromptConfig {
  const result: PromptConfig = {};

  if (config.review) {
    result.review = {};
    if (Array.isArray(config.review.skipLabels)) {
      result.review.skipLabels = config.review.skipLabels.filter((l) => typeof l === 'string');
    }
    if (Array.isArray(config.review.skipActors)) {
      result.review.skipActors = config.review.skipActors.filter((a) => typeof a === 'string');
    }
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
    if (typeof config.review.suppressLowConfidence === 'boolean') {
      result.review.suppressLowConfidence = config.review.suppressLowConfidence;
    }
    if (Array.isArray(config.review.excludePatterns)) {
      result.review.excludePatterns = config.review.excludePatterns.filter(
        (p) => typeof p === 'string',
      );
    }
    if (typeof config.review.enableReachability === 'boolean') {
      result.review.enableReachability = config.review.enableReachability;
    }
    if (typeof config.review.enableMetaVerification === 'boolean') {
      result.review.enableMetaVerification = config.review.enableMetaVerification;
    }
    if (typeof config.review.enableCodebaseIndex === 'boolean') {
      result.review.enableCodebaseIndex = config.review.enableCodebaseIndex;
    }
    if (typeof config.review.includePreExisting === 'boolean') {
      result.review.includePreExisting = config.review.includePreExisting;
    }
    if (
      config.review.failOnSeverity === 'off' ||
      config.review.failOnSeverity === 'critical' ||
      config.review.failOnSeverity === 'important' ||
      config.review.failOnSeverity === 'minor'
    ) {
      result.review.failOnSeverity = config.review.failOnSeverity;
    }
    if (config.review.tokenBudget && typeof config.review.tokenBudget === 'object') {
      const tb = config.review.tokenBudget;
      result.review.tokenBudget = {
        enabled: typeof tb.enabled === 'boolean' ? tb.enabled : false,
        maxLinesComplex:
          typeof tb.maxLinesComplex === 'number'
            ? Math.min(Math.max(Math.round(tb.maxLinesComplex), 50), 5000)
            : 200,
        maxLinesSimple:
          typeof tb.maxLinesSimple === 'number'
            ? Math.min(Math.max(Math.round(tb.maxLinesSimple), 5), 100)
            : 20,
        complexityThreshold:
          typeof tb.complexityThreshold === 'number'
            ? Math.min(Math.max(tb.complexityThreshold, 0), 100)
            : 30,
        simpleThreshold:
          typeof tb.simpleThreshold === 'number'
            ? Math.min(Math.max(tb.simpleThreshold, 0), 100)
            : 10,
      };
      if (
        result.review.tokenBudget.simpleThreshold > result.review.tokenBudget.complexityThreshold
      ) {
        result.review.tokenBudget.simpleThreshold = result.review.tokenBudget.complexityThreshold;
      }
    }
    if (config.review.budget && typeof config.review.budget === 'object') {
      const budget = config.review.budget;
      const summaryThreshold =
        typeof budget.summaryThreshold === 'number'
          ? Math.max(Math.round(budget.summaryThreshold), 1)
          : 500;
      const splitThreshold =
        typeof budget.splitThreshold === 'number'
          ? Math.max(Math.round(budget.splitThreshold), 1)
          : 1000;
      result.review.budget = {
        enabled: typeof budget.enabled === 'boolean' ? budget.enabled : false,
        summaryThreshold,
        splitThreshold: Math.max(splitThreshold, summaryThreshold),
      };
    }
    if (config.review.costTracking && typeof config.review.costTracking === 'object') {
      const ct = config.review.costTracking;
      const inputCostPer1K =
        typeof ct.inputCostPer1K === 'number' && ct.inputCostPer1K >= 0
          ? ct.inputCostPer1K
          : undefined;
      const outputCostPer1K =
        typeof ct.outputCostPer1K === 'number' && ct.outputCostPer1K >= 0
          ? ct.outputCostPer1K
          : undefined;
      result.review.costTracking = {
        // Only set enabled/verbosity when the key is explicitly present so
        // action inputs (the primary opt-in mechanism) win via the `??`
        // fallback when the config file defines only a partial costTracking
        // section (e.g. just rates).
        ...(typeof ct.enabled === 'boolean' && { enabled: ct.enabled }),
        ...(ct.verbosity === 'off' || ct.verbosity === 'summary' || ct.verbosity === 'detailed'
          ? { verbosity: ct.verbosity }
          : {}),
        ...(inputCostPer1K !== undefined && { inputCostPer1K }),
        ...(outputCostPer1K !== undefined && { outputCostPer1K }),
      };
    }
    if (config.review.sensitivity && typeof config.review.sensitivity === 'object') {
      const s = config.review.sensitivity;
      const sensitivity: ReviewSensitivityConfig = {};
      if (
        s.minSeverity === 'warning' ||
        s.minSeverity === 'error' ||
        s.minSeverity === 'critical'
      ) {
        sensitivity.minSeverity = s.minSeverity;
      }
      if (
        s.confidenceThreshold === 'low' ||
        s.confidenceThreshold === 'medium' ||
        s.confidenceThreshold === 'high'
      ) {
        sensitivity.confidenceThreshold = s.confidenceThreshold;
      }
      if (
        typeof s.maxFindingsPerCategory === 'number' &&
        Number.isFinite(s.maxFindingsPerCategory)
      ) {
        sensitivity.maxFindingsPerCategory = Math.min(
          Math.max(Math.round(s.maxFindingsPerCategory), 1),
          500,
        );
      }
      if (typeof s.maxTotalFindings === 'number' && Number.isFinite(s.maxTotalFindings)) {
        sensitivity.maxTotalFindings = Math.min(Math.max(Math.round(s.maxTotalFindings), 1), 500);
      }
      if (Array.isArray(s.focusAreas)) {
        sensitivity.focusAreas = s.focusAreas.filter((a): a is string => typeof a === 'string');
      }
      if (Array.isArray(s.ignorePatterns)) {
        sensitivity.ignorePatterns = s.ignorePatterns.filter(
          (p): p is string => typeof p === 'string',
        );
      }
      result.review.sensitivity = sensitivity;
    }
    if (config.review.categories && typeof config.review.categories === 'object') {
      const categories: Record<string, CategoryOverride> = {};
      for (const [name, override] of Object.entries(config.review.categories)) {
        if (!override || typeof override !== 'object') continue;
        const validated: CategoryOverride = {};
        if (
          override.minSeverity === 'warning' ||
          override.minSeverity === 'error' ||
          override.minSeverity === 'critical'
        ) {
          validated.minSeverity = override.minSeverity;
        }
        if (typeof override.enabled === 'boolean') {
          validated.enabled = override.enabled;
        }
        if (typeof override.maxFindings === 'number' && Number.isFinite(override.maxFindings)) {
          validated.maxFindings = Math.min(Math.max(Math.round(override.maxFindings), 1), 500);
        }
        categories[name] = validated;
      }
      result.review.categories = categories;
    }
  }

  if (config.fix) {
    result.fix = {};
    if (typeof config.fix.maxIterations === 'number') {
      result.fix.maxIterations = Math.min(Math.max(config.fix.maxIterations, 1), 10);
    }
    const allowlist = Array.isArray(config.fix.checkAllowlist)
      ? config.fix.checkAllowlist.filter((c) => typeof c === 'string')
      : DEFAULT_ALLOWLIST;
    if (allowlist.length === 0) {
      result.fix.checkAllowlist = DEFAULT_ALLOWLIST;
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
    if (Array.isArray(config.audit.targetDirs)) {
      result.audit.targetDirs = config.audit.targetDirs.filter((d) => typeof d === 'string');
    }
  }

  if (config.docs && typeof config.docs === 'object') {
    const d = config.docs;
    const docs: DocsConfig = { enabled: false, style: 'auto' };
    if (typeof d.enabled === 'boolean') {
      docs.enabled = d.enabled;
    }
    if (typeof d.style === 'string' && isDocStyle(d.style)) {
      docs.style = d.style;
    } else if (typeof d.style !== 'undefined') {
      new Logger('Config').warn(`Invalid docs.style "${String(d.style)}" — falling back to "auto"`);
      docs.style = 'auto';
    }
    result.docs = docs;
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

  if (config.conversation && typeof config.conversation === 'object') {
    const conv = config.conversation;
    const maxTurns =
      typeof conv.maxTurns === 'number' && Number.isFinite(conv.maxTurns)
        ? Math.min(Math.max(Math.round(conv.maxTurns), 0), 1000)
        : undefined;
    const slidingWindowSize =
      typeof conv.slidingWindowSize === 'number' && Number.isFinite(conv.slidingWindowSize)
        ? Math.min(Math.max(Math.round(conv.slidingWindowSize), 1), 500)
        : undefined;
    const contextTokenBudget =
      typeof conv.contextTokenBudget === 'number' && Number.isFinite(conv.contextTokenBudget)
        ? Math.min(Math.max(Math.round(conv.contextTokenBudget), 1000), 1000000)
        : undefined;
    const summarizationModel =
      typeof conv.summarizationModel === 'string' && conv.summarizationModel.trim() !== ''
        ? conv.summarizationModel.trim()
        : undefined;
    const askCommandEnabled =
      typeof conv.askCommandEnabled === 'boolean' ? conv.askCommandEnabled : undefined;
    const maxCodeReferences =
      typeof conv.maxCodeReferences === 'number' && Number.isFinite(conv.maxCodeReferences)
        ? Math.min(Math.max(Math.round(conv.maxCodeReferences), 1), 20)
        : undefined;
    if (
      maxTurns !== undefined ||
      slidingWindowSize !== undefined ||
      contextTokenBudget !== undefined ||
      summarizationModel !== undefined ||
      askCommandEnabled !== undefined ||
      maxCodeReferences !== undefined
    ) {
      result.conversation = {};
      if (maxTurns !== undefined) result.conversation.maxTurns = maxTurns;
      if (slidingWindowSize !== undefined)
        result.conversation.slidingWindowSize = slidingWindowSize;
      if (contextTokenBudget !== undefined)
        result.conversation.contextTokenBudget = contextTokenBudget;
      if (summarizationModel !== undefined) {
        result.conversation.summarizationModel = summarizationModel;
      }
      if (askCommandEnabled !== undefined) {
        result.conversation.askCommandEnabled = askCommandEnabled;
      }
      if (maxCodeReferences !== undefined) {
        result.conversation.maxCodeReferences = maxCodeReferences;
      }
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

  if (Array.isArray(config.linters)) {
    result.linters = config.linters.filter((l): l is LinterConfig => {
      if (!l || typeof l !== 'object') return false;
      if (typeof l.pattern !== 'string' || typeof l.command !== 'string') return false;
      if (l.args && !Array.isArray(l.args)) return false;
      if (l.parseFormat && !['eslint', 'ruff', 'generic'].includes(l.parseFormat)) return false;
      return true;
    });
  }

  if (config.eventLogging && typeof config.eventLogging === 'object') {
    const el = config.eventLogging;
    result.eventLogging = {
      enabled: typeof el.enabled === 'boolean' ? el.enabled : false,
      path:
        typeof el.path === 'string' && el.path.trim() !== '' ? el.path : '.opencode/events.ndjson',
    };
  }

  if (Array.isArray(config.eventSubscribers)) {
    result.eventSubscribers = config.eventSubscribers
      .filter(
        (s): s is { name: string; path: string } =>
          !!s &&
          typeof s === 'object' &&
          typeof s.name === 'string' &&
          s.name.trim() !== '' &&
          typeof s.path === 'string' &&
          s.path.trim() !== '',
      )
      .map((s) => ({ name: s.name.trim(), path: s.path.trim() }));
  }

  if (config.notifications && typeof config.notifications === 'object') {
    const n = config.notifications;
    const notifications: NotificationsConfig = {};
    if (typeof n.enabled === 'boolean') {
      notifications.enabled = n.enabled;
    }
    if (
      n.minSeverity === 'critical' ||
      n.minSeverity === 'important' ||
      n.minSeverity === 'minor'
    ) {
      notifications.minSeverity = n.minSeverity;
    }
    if (n.slack && typeof n.slack === 'object') {
      const slack: SlackConfig = {};
      if (typeof n.slack.webhookUrl === 'string' && n.slack.webhookUrl.trim() !== '') {
        slack.webhookUrl = n.slack.webhookUrl.trim();
      }
      if (typeof n.slack.channel === 'string' && n.slack.channel.trim() !== '') {
        slack.channel = n.slack.channel.trim();
      }
      if (Object.keys(slack).length > 0) {
        notifications.slack = slack;
      }
    }
    if (n.teams && typeof n.teams === 'object') {
      const teams: TeamsConfig = {};
      if (typeof n.teams.webhookUrl === 'string' && n.teams.webhookUrl.trim() !== '') {
        teams.webhookUrl = n.teams.webhookUrl.trim();
      }
      if (Object.keys(teams).length > 0) {
        notifications.teams = teams;
      }
    }
    if (Object.keys(notifications).length > 0) {
      result.notifications = notifications;
    }
  }

  if (config.multiAgent && typeof config.multiAgent === 'object') {
    const ma = config.multiAgent;
    const multiAgent: MultiAgentConfig = {
      enabled: typeof ma.enabled === 'boolean' ? ma.enabled : false,
      agents: {},
      synthesis: {
        enabled: typeof ma.synthesis?.enabled === 'boolean' ? ma.synthesis.enabled : true,
        ...(typeof ma.synthesis?.model === 'string' && ma.synthesis.model.trim() !== ''
          ? { model: ma.synthesis.model.trim() }
          : {}),
      },
    };
    if (ma.agents && typeof ma.agents === 'object') {
      for (const [category, agent] of Object.entries(ma.agents)) {
        if (
          !['security', 'performance', 'quality', 'logic'].includes(category) ||
          !agent ||
          typeof agent !== 'object'
        ) {
          continue;
        }
        const validatedAgent: MultiAgentAgentConfig = {
          enabled: typeof agent.enabled === 'boolean' ? agent.enabled : true,
          ...(typeof agent.model === 'string' && agent.model.trim() !== ''
            ? { model: agent.model.trim() }
            : {}),
          ...(typeof agent.promptFile === 'string' && agent.promptFile.trim() !== ''
            ? { promptFile: agent.promptFile.trim() }
            : {}),
        };
        multiAgent.agents[category as AgentCategory] = validatedAgent;
      }
    }
    result.multiAgent = multiAgent;
  }

  if (config.secrets && typeof config.secrets === 'object') {
    const s = config.secrets;
    const entropyThreshold =
      typeof s.entropyThreshold === 'number' && Number.isFinite(s.entropyThreshold)
        ? Math.min(Math.max(s.entropyThreshold, 0), 8)
        : 4.5;
    const minLength =
      typeof s.minLength === 'number' && Number.isFinite(s.minLength)
        ? Math.min(Math.max(Math.round(s.minLength), 1), 1024)
        : 32;
    result.secrets = {
      enabled: typeof s.enabled === 'boolean' ? s.enabled : true,
      entropyThreshold,
      minLength,
      allowlist: Array.isArray(s.allowlist)
        ? s.allowlist.filter((entry): entry is string => typeof entry === 'string')
        : [],
      failCI: typeof s.failCI === 'boolean' ? s.failCI : false,
      excludePatterns: Array.isArray(s.excludePatterns)
        ? s.excludePatterns.filter((p): p is string => typeof p === 'string')
        : [],
    };
  }

  if (config.llm && typeof config.llm === 'object') {
    const raw = config.llm;
    const llmConfig: LLMConfig = {};
    if (typeof raw.defaultProvider === 'string' && raw.defaultProvider.trim() !== '') {
      llmConfig.defaultProvider = raw.defaultProvider.trim();
    }
    if (raw.providers && typeof raw.providers === 'object') {
      const providers: Record<string, LLMProviderConfig> = {};
      const knownTypes = ['openai-compatible', 'azure', 'bedrock', 'ollama'] as const;
      for (const [id, provider] of Object.entries(raw.providers)) {
        if (
          !provider ||
          typeof provider !== 'object' ||
          !provider.type ||
          !(knownTypes as readonly string[]).includes(provider.type)
        ) {
          continue;
        }
        const validated: LLMProviderConfig = {
          type: provider.type as LLMProviderConfig['type'],
        };
        for (const field of [
          'baseUrl',
          'apiKey',
          'endpoint',
          'resourceName',
          'apiVersion',
          'deployment',
          'modelId',
          'region',
          'model',
        ] as const) {
          const value = provider[field];
          if (typeof value === 'string' && value.trim() !== '') {
            validated[field] = value.trim();
          }
        }
        if (Array.isArray(provider.models)) {
          const models = provider.models.filter((m): m is string => typeof m === 'string');
          if (models.length > 0) validated.models = models;
        }
        providers[id] = validated;
      }
      if (Object.keys(providers).length > 0) llmConfig.providers = providers;
    }
    if (llmConfig.defaultProvider !== undefined || llmConfig.providers !== undefined) {
      result.llm = llmConfig;
    }
  }

  return result;
}

/**
 * Extract default values from a PromptConfig and map them to GitHub Action input names.
 * This bridges the config file's naming convention (camelCase) with the action's
 * input naming convention (snake_case). For example, `config.review.systemPrompt`
 * maps to the action input `review_prompt`.
 *
 * @param config - Parsed PromptConfig with optional sections.
 * @returns Flat record of action input key-value pairs derived from the config.
 */
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
    defaults.run_checks_after_fix = config.fix.runChecks.join(' && ');
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
  if (config.docs?.style) {
    defaults.docs_style = config.docs.style;
  }
  if (config.docs?.enabled !== undefined) {
    defaults.docs_enabled = String(config.docs.enabled);
  }
  if (config.linters?.length) {
    defaults.linters = JSON.stringify(config.linters);
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
