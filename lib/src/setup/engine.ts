import * as fs from 'fs';
import * as path from 'path';
import * as exec from '@actions/exec';
import { loadConfig } from '../config.js';
import { resolveOpenCodePath, runOpenCode } from '../opencode.js';
import type { AgentConfig } from '../types/index.js';
import { GitHubHelper } from '../utils/github.js';
import { withRetryAndTimeout } from '../utils/retry.js';
import type { SetupCheck, SetupEngineOptions, SetupResult } from './types.js';

/** Default minimum OpenCode CLI version the current code is known to work with. */
const DEFAULT_MINIMUM_OPENCODE_VERSION = '1.1.1';
/** Default per-model connectivity probe timeout in milliseconds. */
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

/** A parsed semantic version. */
interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(text: string): ParsedVersion | null {
  const match = text.match(/\bv?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

function compareVersions(a: string, b: string): number {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  if (!av || !bv) return 0;
  if (av.major !== bv.major) return av.major - bv.major;
  if (av.minor !== bv.minor) return av.minor - bv.minor;
  return av.patch - bv.patch;
}

const CONFIG_FILENAMES: Array<(platformDir: string) => string> = [
  () => '.opencode-reviewer.yml',
  () => '.opencode-reviewer.yaml',
  (platformDir) => `${platformDir}/opencode-reviewer.yml`,
  (platformDir) => `${platformDir}/opencode-reviewer.yaml`,
];

const MODEL_PROVIDER_KEYS: Array<{ label: string; envs: string[] }> = [
  { label: 'OpenAI (OPENAI_API_KEY)', envs: ['OPENAI_API_KEY', 'INPUT_OPENAI_API_KEY'] },
  {
    label: 'Anthropic (ANTHROPIC_API_KEY)',
    envs: ['ANTHROPIC_API_KEY', 'INPUT_ANTHROPIC_API_KEY'],
  },
  { label: 'Gemini (GEMINI_API_KEY)', envs: ['GEMINI_API_KEY', 'INPUT_GEMINI_API_KEY'] },
  { label: 'OpenCode (OPENCODE_API_KEY)', envs: ['OPENCODE_API_KEY', 'INPUT_OPENCODE_API_KEY'] },
];

/**
 * Pre-flight setup validation engine.
 *
 * Runs independent, non-destructive checks that tell a new user whether their
 * deployment is wired up correctly before the first review/audit hits a cryptic
 * error deep in the pipeline:
 *
 * 1. Secrets — required tokens are present (presence only, not validity).
 * 2. Permissions — the GitHub token/App can read & write the target repository.
 * 3. OpenCode CLI — installed and at an acceptable version.
 * 4. Model connectivity — a lightweight probe against the configured model(s).
 * 5. Config — `.opencode-reviewer.yml` parses and referenced paths exist.
 *
 * The engine deliberately does NOT depend on {@link ReviewEngine}: setup must
 * work even when the main engine would fail (e.g. missing model keys). All
 * checks run independently and every result is collected so the user gets a
 * complete picture even when several things are broken.
 */
export class SetupEngine {
  private lastResult: SetupResult | null = null;

  /**
   * Create a new setup validation engine.
   *
   * @param config - Resolved agent configuration (used to pick probe models and platform).
   * @param options - Setup engine options (working directory, token, repo, thresholds).
   */
  constructor(
    private config: AgentConfig,
    private options: SetupEngineOptions = {},
  ) {}

  /**
   * Run every setup check and aggregate the results.
   *
   * @returns A SetupResult with all checks, overall status, and run duration.
   */
  async runAll(): Promise<SetupResult> {
    const start = Date.now();
    const checks: SetupCheck[] = [];
    checks.push(this.checkSecrets());
    checks.push(await this.checkPermissions());
    checks.push(await this.checkOpenCodeCLI());
    checks.push(await this.checkModelConnectivity());
    checks.push(await this.checkConfig());
    const durationMs = Date.now() - start;
    const failed = checks.filter((c) => c.status === 'fail');
    this.lastResult = {
      checks,
      overall: failed.length === 0 ? 'pass' : 'fail',
      timestamp: Date.now(),
      durationMs,
    };
    return this.lastResult;
  }

  /**
   * Check that all required secrets/tokens are present in the environment.
   * Verifies a GitHub token exists and, when non-default models are configured,
   * that at least one model provider key is set. `opencode/*` models are served
   * by OpenCode itself and need no external API key.
   *
   * @returns The check result.
   */
  checkSecrets(): SetupCheck {
    const start = Date.now();
    const present: string[] = [];
    const missing: string[] = [];

    const githubToken =
      this.options.githubToken || process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN || '';
    if (githubToken) {
      present.push('GitHub token');
    } else {
      missing.push('GITHUB_TOKEN / INPUT_GITHUB_TOKEN');
    }

    const foundProviders: string[] = [];
    for (const provider of MODEL_PROVIDER_KEYS) {
      const value = provider.envs.map((env) => process.env[env]).find((v) => v?.trim());
      if (value) foundProviders.push(provider.label);
    }
    present.push(...foundProviders);

    const probeModels = this.getProbeModels();
    const needsProviderKey = probeModels.some((m) => !m.startsWith('opencode/'));
    if (needsProviderKey && foundProviders.length === 0) {
      missing.push(
        'at least one model provider key (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, or OPENCODE_API_KEY) for models: ' +
          probeModels.join(', '),
      );
    }

    const durationMs = Date.now() - start;
    if (missing.length === 0) {
      return this.pass(
        'Secrets',
        foundProviders.length > 0
          ? `All required tokens present (${present.length})`
          : 'GitHub token present; default opencode model needs no API key',
        present.join('\n') || undefined,
        durationMs,
      );
    }
    return this.fail(
      'Secrets',
      `Missing required secrets: ${missing.join('; ')}`,
      present.length > 0 ? `Present: ${present.join(', ')}` : 'No secrets found in the environment',
      durationMs,
    );
  }

  /**
   * Verify the GitHub deployment has the permissions needed to review PRs and
   * issues. For a GitHub App (APP_ID set) verifies the private key is present.
   * When a repository is known, probes `GET /repos/{owner}/{repo}` to confirm
   * the token actually has read/write (`push`) access.
   *
   * @returns The check result.
   */
  async checkPermissions(): Promise<SetupCheck> {
    const start = Date.now();
    const notes: string[] = [];
    const failures: string[] = [];

    const appId = process.env.APP_ID;
    const privateKey =
      process.env.PRIVATE_KEY || process.env.APP_PRIVATE_KEY || process.env.PRIVATE_KEY_PATH;
    if (appId) {
      notes.push(`GitHub App configured (APP_ID=${appId})`);
      if (privateKey) {
        notes.push('GitHub App private key present');
      } else {
        failures.push(
          'APP_ID is set but no private key was found (PRIVATE_KEY or PRIVATE_KEY_PATH)',
        );
      }
    }

    const token =
      this.options.githubToken || process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN || '';
    if (!token) {
      failures.push(
        'No GitHub token found — set GITHUB_TOKEN (or APP_ID/PRIVATE_KEY for a GitHub App)',
      );
    }

    const platform = this.options.platform ?? this.config.platform ?? 'github';
    const repo = this.options.repo;
    let repoPermissions: Record<string, boolean> | null = null;
    let apiUnreachable = false;
    if (token && repo && platform === 'github') {
      try {
        const gh = new GitHubHelper(token, repo, this.options.apiBaseUrl);
        repoPermissions = await gh.getRepositoryPermissions();
      } catch (err) {
        // Network/transport failure — degrade gracefully instead of failing the
        // whole setup for what is not a configuration problem.
        apiUnreachable = true;
        notes.push(
          `GitHub API unreachable — permission verification skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (repoPermissions) {
      const write = repoPermissions.push === true;
      notes.push(`Token has ${write ? 'read/write (push)' : 'read-only'} access to ${repo}`);
      if (!write) {
        failures.push(
          `Token has read-only access to ${repo} — grant pull-requests: write and issues: write`,
        );
      }
    } else if (apiUnreachable) {
      return this.skip(
        'Permissions',
        `Could not verify permissions — GitHub API unreachable`,
        notes.join('\n') || undefined,
        Date.now() - start,
      );
    } else if (token && repo && platform === 'github') {
      failures.push(
        `Could not verify access to ${repo} — ensure the token can read the repository`,
      );
    }

    const durationMs = Date.now() - start;
    if (failures.length === 0) {
      return this.pass(
        'Permissions',
        repoPermissions
          ? `Read/write access verified for ${repo}`
          : 'Authentication present; no repository probe requested',
        notes.join('\n') || undefined,
        durationMs,
      );
    }
    return this.fail(
      'Permissions',
      failures[0] ?? 'Permission check failed',
      [...notes, ...failures].join('\n'),
      durationMs,
    );
  }

  /**
   * Verify the OpenCode CLI is installed and at or above the minimum version.
   * Resolves the binary via PATH or installs the requested version, then parses
   * the `opencode --version` output and compares against the minimum.
   *
   * @returns The check result.
   */
  async checkOpenCodeCLI(): Promise<SetupCheck> {
    const start = Date.now();
    const minimum = this.options.minimumOpenCodeVersion || DEFAULT_MINIMUM_OPENCODE_VERSION;

    let binaryPath: string;
    try {
      binaryPath = await resolveOpenCodePath(this.options.opencodeVersion || 'latest');
    } catch (err) {
      return this.fail(
        'OpenCode CLI',
        'OpenCode CLI is not installed and could not be downloaded',
        err instanceof Error ? err.message : String(err),
        Date.now() - start,
      );
    }

    try {
      const output = await exec.getExecOutput(binaryPath, ['--version']);
      const versionText = (output.stdout || output.stderr).trim();
      const parsed = parseVersion(versionText);
      if (!parsed) {
        return this.fail(
          'OpenCode CLI',
          'OpenCode CLI version could not be parsed',
          `Binary at ${binaryPath} returned: ${versionText || '(empty output)'}`,
          Date.now() - start,
        );
      }
      const version = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
      if (compareVersions(version, minimum) < 0) {
        return this.fail(
          'OpenCode CLI',
          `OpenCode CLI v${version} is below the minimum supported version v${minimum}`,
          `Upgrade opencode or set opencode_version to a newer tag (binary: ${binaryPath})`,
          Date.now() - start,
        );
      }
      return this.pass(
        'OpenCode CLI',
        `OpenCode CLI v${version} installed`,
        `Path: ${binaryPath}`,
        Date.now() - start,
      );
    } catch (err) {
      return this.fail(
        'OpenCode CLI',
        'OpenCode CLI version check failed',
        `Binary at ${binaryPath}: ${err instanceof Error ? err.message : String(err)}`,
        Date.now() - start,
      );
    }
  }

  /**
   * Probe model connectivity with a trivial prompt against every configured
   * model (the review model by default, all distinct configured models when
   * `probeAllModels` is set). Each probe is bounded by the configured timeout.
   *
   * @returns The check result.
   */
  async checkModelConnectivity(): Promise<SetupCheck> {
    const start = Date.now();
    const models = this.getProbeModels();
    if (models.length === 0) {
      return this.skip('Model Connectivity', 'No models configured to probe');
    }

    const successes: string[] = [];
    const failures: string[] = [];
    const timeoutMs = this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

    for (const model of models) {
      try {
        const result = await withRetryAndTimeout(
          async (signal) =>
            runOpenCode('Reply with a single word: ok', {
              model,
              workingDirectory: this.options.workingDirectory,
              timeoutMinutes: 1,
              signal,
            }),
          timeoutMs,
          { maxRetries: 1, operationName: 'setup-model-probe' },
        );
        if (result.success) {
          successes.push(`- \`${model}\` responded in ${(result.durationMs / 1000).toFixed(1)}s`);
        } else {
          const snippet = (result.output || '').trim().replace(/\s+/g, ' ').slice(0, 300);
          failures.push(`- \`${model}\` returned an error${snippet ? `: ${snippet}` : ''}`);
        }
      } catch (err) {
        failures.push(
          `- \`${model}\` probe failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const durationMs = Date.now() - start;
    if (failures.length === 0) {
      return this.pass(
        'Model Connectivity',
        `Model connectivity OK (${models.length} model${models.length === 1 ? '' : 's'} probed)`,
        successes.join('\n') || undefined,
        durationMs,
      );
    }
    return this.fail(
      'Model Connectivity',
      `${failures.length} of ${models.length} model probe(s) failed — check your API keys and model names`,
      [...successes, ...failures].join('\n'),
      durationMs,
    );
  }

  /**
   * Validate the `.opencode-reviewer.yml` config file: parse it with the schema
   * and verify referenced paths (audit prompts directory, audit target
   * directories, audit category prompt files) actually exist on disk. A missing
   * config file is valid — the schema defaults take over.
   *
   * @returns The check result.
   */
  async checkConfig(): Promise<SetupCheck> {
    const start = Date.now();
    const wd = this.options.workingDirectory || process.cwd();
    const platform = this.options.platform ?? this.config.platform ?? 'github';
    const platformDir = platform === 'gitlab' ? '.gitlab' : '.github';

    const existing = CONFIG_FILENAMES.map((make) => make(platformDir)).find((filename) =>
      fs.existsSync(path.resolve(wd, filename)),
    );

    if (!existing) {
      return this.pass(
        'Config',
        'No config file found — the default configuration will be used',
        `Searched: ${CONFIG_FILENAMES.map((make) => make(platformDir)).join(', ')}`,
        Date.now() - start,
      );
    }

    const config = loadConfig(wd, platform);
    if (!config) {
      return this.fail(
        'Config',
        `Config file ${existing} is invalid — fix its YAML syntax or schema and re-run /setup`,
        `Checked: ${path.resolve(wd, existing)}`,
        Date.now() - start,
      );
    }

    const pathNotes: string[] = [];
    const pathIssues: string[] = [];

    if (config.audit?.promptsDir) {
      const resolved = path.resolve(wd, config.audit.promptsDir);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        pathIssues.push(
          `audit.promptsDir "${config.audit.promptsDir}" does not exist (expected ${resolved})`,
        );
      } else {
        pathNotes.push(`audit.promptsDir resolves to ${resolved}`);
      }
    }

    for (const dir of config.audit?.targetDirs ?? []) {
      if (!fs.existsSync(path.resolve(wd, dir))) {
        pathIssues.push(`audit.targetDirs entry "${dir}" does not exist`);
      }
    }

    for (const category of config.audit?.categories ?? []) {
      const candidates = config.audit?.promptsDir
        ? [path.resolve(wd, config.audit.promptsDir, `${category}.md`)]
        : [
            path.resolve(wd, '.audit-prompts', `${category}.md`),
            path.resolve(wd, 'prompts', 'audit-categories', `${category}.md`),
          ];
      if (!candidates.some((p) => fs.existsSync(p))) {
        pathIssues.push(
          `audit.categories entry "${category}" has no prompt file (checked: ${candidates.join(', ')})`,
        );
      }
    }

    const durationMs = Date.now() - start;
    if (pathIssues.length === 0) {
      return this.pass(
        'Config',
        `Config file ${existing} is valid`,
        pathNotes.join('\n') || `Parsed ${existing} successfully`,
        durationMs,
      );
    }
    return this.fail(
      'Config',
      `Config file ${existing} is valid but has ${pathIssues.length} invalid path reference(s): ${pathIssues[0]}`,
      pathIssues.join('\n'),
      durationMs,
    );
  }

  /**
   * Format the setup results as a structured markdown report with a clear
   * pass/fail summary and actionable messages for each check.
   *
   * @param result - The setup result to render (defaults to the last runAll result).
   * @returns Markdown report string.
   */
  formatReport(
    result: SetupResult = this.lastResult ?? {
      checks: [],
      overall: 'fail',
      timestamp: Date.now(),
      durationMs: 0,
    },
  ): string {
    const lines: string[] = ['## 🚀 Setup Validation Report', ''];
    for (const check of result.checks) {
      const icon = check.status === 'pass' ? '✅' : check.status === 'fail' ? '❌' : '⚠️';
      lines.push(`### ${icon} ${check.name} — ${check.status.toUpperCase()}`, '');
      lines.push(check.message, '');
      if (check.details) {
        lines.push(
          '<details>',
          '<summary>Details</summary>',
          '',
          '',
          check.details,
          '',
          '</details>',
          '',
        );
      }
    }
    const failed = result.checks.filter((c) => c.status === 'fail').length;
    lines.push('---', '');
    lines.push(
      `**Overall: ${result.overall === 'pass' ? '✅ PASS' : '❌ FAIL'}** — ${failed} of ${result.checks.length} check(s) failed.`,
      '',
    );
    lines.push(`_Setup completed in ${(result.durationMs / 1000).toFixed(1)}s._`, '');
    return lines.join('\n');
  }

  /**
   * Determine the set of models to probe for connectivity.
   * @returns A de-duplicated list of model identifiers to probe.
   */
  private getProbeModels(): string[] {
    const explicit = (this.options.probeModels ?? []).filter(
      (m) => typeof m === 'string' && m.trim(),
    );
    if (explicit.length > 0) return explicit;

    const models = new Set<string>();
    if (this.options.probeAllModels) {
      const candidates = [
        this.config.reviewModel,
        this.config.fixModel,
        this.config.auditModel,
        this.config.synthesisModel,
        this.config.verificationModel,
        this.config.metaReviewModel,
        this.config.explanationModel,
        this.config.conversationModel,
        this.config.analysisModel,
      ];
      for (const model of candidates) {
        if (typeof model === 'string' && model.trim()) models.add(model.trim());
      }
    } else {
      models.add(this.config.reviewModel);
    }
    return [...models].filter(Boolean);
  }

  private pass(name: string, message: string, details?: string, durationMs?: number): SetupCheck {
    return { name, status: 'pass', message, details, durationMs };
  }

  private fail(name: string, message: string, details?: string, durationMs?: number): SetupCheck {
    return { name, status: 'fail', message, details, durationMs };
  }

  private skip(name: string, message: string, details?: string, durationMs?: number): SetupCheck {
    return { name, status: 'skip', message, details, durationMs };
  }
}
