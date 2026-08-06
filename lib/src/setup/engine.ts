import * as fs from 'fs';
import * as path from 'path';
import * as io from '@actions/io';
import { getConfigFilenames, loadConfig } from '../config.js';
import { checkHealth, resolveOpenCodePath, runOpenCode } from '../opencode.js';
import type { AgentConfig } from '../types/index.js';
import { GitHubHelper } from '../utils/github.js';
import { withRetryAndTimeout } from '../utils/retry.js';
import { sanitizeString } from '../utils/sanitize.js';
import { MINIMUM_OPENCODE_VERSION, parseVersion } from '../utils/version.js';
import type { SetupCheck, SetupEngineOptions, SetupResult } from './types.js';

/** Default per-model connectivity probe timeout in milliseconds. */
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

/** Timeout for the OpenCode CLI `--version` health probe, in milliseconds. */
const OPENCODE_VERSION_CHECK_TIMEOUT_MS = 15_000;

const MODEL_PROVIDER_KEYS: Array<{ label: string; envs: string[] }> = [
  { label: 'OpenAI (OPENAI_API_KEY)', envs: ['OPENAI_API_KEY', 'INPUT_OPENAI_API_KEY'] },
  {
    label: 'Anthropic (ANTHROPIC_API_KEY)',
    envs: ['ANTHROPIC_API_KEY', 'INPUT_ANTHROPIC_API_KEY'],
  },
  { label: 'Gemini (GEMINI_API_KEY)', envs: ['GEMINI_API_KEY', 'INPUT_GEMINI_API_KEY'] },
  { label: 'OpenCode (OPENCODE_API_KEY)', envs: ['OPENCODE_API_KEY', 'INPUT_OPENCODE_API_KEY'] },
  {
    label: 'Azure OpenAI (AZURE_OPENAI_API_KEY)',
    envs: ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_RESOURCE_NAME'],
  },
  {
    label: 'AWS Bedrock (AWS_ACCESS_KEY_ID / AWS_PROFILE / AWS_ROLE_ARN)',
    envs: [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_PROFILE',
      'AWS_BEARER_TOKEN_BEDROCK',
      'AWS_WEB_IDENTITY_TOKEN_FILE',
      'AWS_ROLE_ARN',
    ],
  },
  { label: 'Ollama (OLLAMA_MODEL)', envs: ['OLLAMA_MODEL'] },
  {
    label: 'Custom OpenAI-compatible (LLM_BASE_URL)',
    envs: ['LLM_BASE_URL', 'LLM_API_KEY'],
  },
];

/**
 * Pre-flight setup validation engine.
 *
 * Runs independent, non-destructive checks that tell a new user whether their
 * deployment is wired up correctly before the first review/audit hits a cryptic
 * error deep in the pipeline:
 *
 * 1. Secrets — required tokens are present (presence only, not validity).
 * 2. Permissions — the GitHub token/App can read the target repository (write
 *    scopes are reported as informational, not verifiable via the repo endpoint).
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
      const appCredential = this.resolveAppCredential();
      if (appCredential.present) {
        present.push('GitHub App credential (APP_ID + private key)');
      } else {
        missing.push(
          appCredential.failure ||
            'GITHUB_TOKEN / INPUT_GITHUB_TOKEN (or APP_ID + private key for a GitHub App)',
        );
      }
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
   * issues. For a GitHub App (APP_ID + private key) verifies the credential is
   * present. When a repository is known, probes `GET /repos/{owner}/{repo}` to
   * confirm the token can at least read the repository. The repo `permissions`
   * endpoint only exposes contents access — `push` (write) is reported as an
   * informational note, not a hard failure, because the reviewer's actual
   * requirements (`issues: write` / `pull-requests: write`) are not surfaced
   * by that endpoint for fine-grained tokens.
   *
   * @returns The check result.
   */
  async checkPermissions(): Promise<SetupCheck> {
    const start = Date.now();
    const notes: string[] = [];
    const failures: string[] = [];

    const appCredential = this.resolveAppCredential();
    if (process.env.APP_ID) {
      notes.push(`GitHub App configured (APP_ID=${process.env.APP_ID})`);
      if (appCredential.present) {
        notes.push('GitHub App private key present');
      } else {
        failures.push(appCredential.failure ?? 'APP_ID is set but the private key is invalid');
      }
    }

    const token =
      this.options.githubToken || process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN || '';
    if (!token && !appCredential.present) {
      failures.push(
        'No GitHub credentials found — set GITHUB_TOKEN (or APP_ID + private key for a GitHub App)',
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
      const read = repoPermissions.pull === true || repoPermissions.push === true;
      const write = repoPermissions.push === true;
      notes.push(`Token has ${write ? 'read/write' : read ? 'read-only' : 'no'} access to ${repo}`);
      if (!write) {
        notes.push(
          `Note: contents "push" is false for ${repo} — the reviewer's issues: write / pull-requests: write scopes are not surfaced by the repo permissions endpoint and are assumed to be granted.`,
        );
      }
      if (!read) {
        failures.push(`Token cannot read ${repo} — ensure the token can read the repository`);
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
          ? `Repository access verified for ${repo}`
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
   * Resolves the binary via PATH or installs the requested version, then runs
   * the shared {@link checkHealth} probe against it.
   *
   * Note: when opencode is not already on PATH this check auto-installs the
   * requested version as a side effect — that is intentional so the check is
   * also the installer for the setup workflow.
   *
   * @returns The check result.
   */
  async checkOpenCodeCLI(): Promise<SetupCheck> {
    const start = Date.now();
    const minimum = this.options.minimumOpenCodeVersion || MINIMUM_OPENCODE_VERSION;

    if (parseVersion(minimum) === null) {
      return this.fail(
        'OpenCode CLI',
        `minimumOpenCodeVersion "${minimum}" is not a valid semantic version`,
        `Set minimumOpenCodeVersion to a value like "1.1.1"`,
        Date.now() - start,
      );
    }

    const preinstalled = Boolean(await io.which('opencode', false));

    let binaryPath: string;
    try {
      binaryPath = await resolveOpenCodePath(this.options.opencodeVersion || 'latest', minimum);
    } catch (err) {
      return this.fail(
        'OpenCode CLI',
        'OpenCode CLI is not installed and could not be downloaded',
        err instanceof Error ? err.message : String(err),
        Date.now() - start,
      );
    }
    const installNote = preinstalled
      ? `Path: ${binaryPath}`
      : `Path: ${binaryPath} (opencode was not on PATH and was auto-installed)`;

    // Reuse the shared health check so the version/parse/timeout handling is
    // identical to the runtime path in opencode.ts — the two checks cannot
    // disagree. A longer timeout than the default is kept so a slow first run
    // on a cold cache is not misreported as a failure.
    const health = await checkHealth({
      binPath: binaryPath,
      minimumVersion: minimum,
      timeoutMs: OPENCODE_VERSION_CHECK_TIMEOUT_MS,
    });

    if (!health.available) {
      return this.fail(
        'OpenCode CLI',
        'OpenCode CLI is not available',
        health.message,
        Date.now() - start,
      );
    }
    if (!health.compatible) {
      return this.fail(
        'OpenCode CLI',
        health.version
          ? `OpenCode CLI v${health.version.raw} is below the minimum supported version v${minimum}`
          : `OpenCode CLI version check failed: ${health.message}`,
        health.message,
        Date.now() - start,
      );
    }
    return this.pass(
      'OpenCode CLI',
      `OpenCode CLI v${health.version?.raw ?? 'unknown'} installed`,
      installNote,
      Date.now() - start,
    );
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
          async (signal) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const probe = runOpenCode('Reply with a single word: ok', {
              model,
              workingDirectory: this.options.workingDirectory,
              timeoutMinutes: 1,
              signal,
              quiet: true,
              llm: this.config.llm,
            });
            const guard = new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`probe timed out after ${timeoutMs}ms`)),
                timeoutMs,
              );
            });
            try {
              return await Promise.race([probe, guard]);
            } finally {
              if (timer) clearTimeout(timer);
            }
          },
          timeoutMs,
          { maxRetries: 1, operationName: 'setup-model-probe' },
        );
        if (result.success) {
          successes.push(`- \`${model}\` responded in ${(result.durationMs / 1000).toFixed(1)}s`);
        } else {
          // Redact likely secret patterns (e.g. echoed API keys) and sanitize
          // before embedding raw CLI output in a public comment.
          const raw = (result.output || '').trim().replace(/\s+/g, ' ');
          const snippet = sanitizeString(raw.replace(/sk-[a-zA-Z0-9_-]{8,}/gi, 'sk-***')).slice(
            0,
            300,
          );
          failures.push(`- \`${model}\` returned an error:\n\n\`\`\`\n${snippet}\n\`\`\``);
        }
      } catch (err) {
        failures.push(
          `- \`${model}\` probe failed: ${sanitizeString(err instanceof Error ? err.message : String(err))}`,
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

    const filenames = getConfigFilenames(platform);
    const existing = filenames.find((filename) => fs.existsSync(path.resolve(wd, filename)));

    if (!existing) {
      return this.pass(
        'Config',
        'No config file found — the default configuration will be used',
        `Searched: ${filenames.join(', ')}`,
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
      const resolved = path.resolve(wd, dir);
      const exists = fs.existsSync(resolved);
      const isDir =
        exists &&
        (() => {
          try {
            return fs.statSync(resolved).isDirectory();
          } catch {
            return false;
          }
        })();
      if (!isDir) {
        pathIssues.push(
          `audit.targetDirs entry "${dir}" does not exist or is not a directory (expected ${resolved})`,
        );
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

  /**
   * Determine whether a GitHub App credential is present and usable.
   * An App credential is satisfied by APP_ID plus a private key supplied
   * inline (PRIVATE_KEY / APP_PRIVATE_KEY) or via PRIVATE_KEY_PATH.
   *
   * @returns `present: true` when the credential is complete, otherwise a
   * human-readable reason for the failure.
   */
  private resolveAppCredential(): { present: boolean; failure?: string } {
    if (!process.env.APP_ID) return { present: false };
    const rawKey =
      process.env.PRIVATE_KEY || process.env.APP_PRIVATE_KEY || process.env.PRIVATE_KEY_PATH;
    if (!rawKey) {
      return {
        present: false,
        failure:
          'APP_ID is set but no private key was found (PRIVATE_KEY, APP_PRIVATE_KEY, or PRIVATE_KEY_PATH)',
      };
    }
    const keyMaterial = process.env.PRIVATE_KEY_PATH
      ? (() => {
          try {
            return fs.readFileSync(process.env.PRIVATE_KEY_PATH, 'utf-8');
          } catch {
            return '';
          }
        })()
      : rawKey;
    if (!keyMaterial.includes('PRIVATE KEY')) {
      return {
        present: false,
        failure: process.env.PRIVATE_KEY_PATH
          ? `PRIVATE_KEY_PATH "${process.env.PRIVATE_KEY_PATH}" does not contain a PEM private key`
          : 'The configured GitHub App private key does not look like a PEM key',
      };
    }
    return { present: true };
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
