import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import * as tc from '@actions/tool-cache';
import { withRetry } from './utils/retry.js';

let opencodePath: string | null = null;
let cachedCIConfig: string | null = null;

function detectArch(): string {
  const platform = os.platform();
  const arch = os.arch();

  let osName = '';
  if (platform === 'linux') {
    osName = 'linux';
  } else if (platform === 'darwin') {
    osName = 'darwin';
  } else if (platform === 'win32') {
    osName = 'windows';
  } else {
    throw new Error(
      `Unsupported platform: ${platform}. Only Linux, macOS, and Windows are supported.`,
    );
  }

  let archName = '';
  if (arch === 'x64') {
    archName = 'x64';
  } else if (arch === 'arm64') {
    archName = 'arm64';
  } else {
    throw new Error(`Unsupported architecture: ${arch}. Only x64 and arm64 are supported.`);
  }

  return `${osName}-${archName}`;
}

async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  return withRetry(
    async () => {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (response.ok) return response;
      const err = new Error(`HTTP ${response.status}: ${response.statusText}`);
      (err as Error & { status: number }).status = response.status;
      throw err;
    },
    {
      maxRetries: retries,
      retryableStatuses: [403, 429, 500, 502, 503, 504],
    },
  );
}

export async function setupOpenCode(version = 'latest'): Promise<string> {
  const existingPath = await io.which('opencode', false);
  if (existingPath) {
    core.info(`OpenCode already available at: ${existingPath}`);
    opencodePath = existingPath;
    return existingPath;
  }

  const arch = detectArch();
  core.info(`Setting up OpenCode ${version} (${arch})...`);

  let releaseUrl: string;
  if (version === 'latest') {
    releaseUrl = 'https://api.github.com/repos/anomalyco/opencode/releases/latest';
  } else {
    const tag = version.startsWith('v') ? version : `v${version}`;
    releaseUrl = `https://api.github.com/repos/anomalyco/opencode/releases/tags/${tag}`;
  }

  const response = await fetchWithRetry(releaseUrl);
  const release = (await response.json()) as {
    tag_name?: string;
    assets: Array<{ name: string; browser_download_url: string }>;
  };

  const platform = os.platform();
  const extension = platform === 'win32' ? 'zip' : 'tar.gz';
  const assetName = `opencode-${arch}.${extension}`;
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    throw new Error(
      `Could not find asset "${assetName}" in release ${release.tag_name || version}`,
    );
  }

  core.info(`Downloading from: ${asset.browser_download_url}`);
  const { cachedPath } = await withRetry(
    async () => {
      let downloadTimeoutHandle: ReturnType<typeof setTimeout> | undefined = undefined;
      const dlPath = await Promise.race([
        tc.downloadTool(asset.browser_download_url),
        new Promise<never>((_, reject) => {
          downloadTimeoutHandle = setTimeout(
            () => reject(new Error('Download timed out after 120s')),
            120_000,
          );
        }),
      ]).finally(() => downloadTimeoutHandle !== undefined && clearTimeout(downloadTimeoutHandle));
      let extPath: string;
      if (extension === 'zip') {
        extPath = await tc.extractZip(dlPath);
      } else {
        extPath = await tc.extractTar(dlPath);
      }
      const semver = (release.tag_name || version).replace(/^v/, '');
      const cachePath = await tc.cacheDir(extPath, 'opencode', semver);
      return { cachedPath: cachePath };
    },
    { maxRetries: 3, baseDelayMs: 2000 },
  );

  const binName = platform === 'win32' ? 'opencode.exe' : 'opencode';
  const binPath = path.join(cachedPath, binName);

  if (platform !== 'win32') {
    fs.chmodSync(binPath, 0o755);
  }

  core.addPath(cachedPath);

  try {
    const output = await exec.getExecOutput(binPath, ['--version']);
    core.info(`OpenCode installed: ${output.stdout.trim()}`);
  } catch {
    core.warning('OpenCode installed but version check failed');
  }

  opencodePath = binPath;
  return binPath;
}

/**
 * Build the OpenCode CI config object.
 *
 * Based on https://opencode.ai/docs/permissions and https://opencode.ai/docs/config:
 *
 * - "permission": "allow"  →  shorthand that sets ALL tools to allow at once
 * - external_directory     →  gates access to paths outside the working dir;
 *                             defaults to "ask" which blocks CI sub-agents that
 *                             read files in /tmp or other external locations
 * - doom_loop              →  triggered when the same tool call repeats 3×;
 *                             defaults to "ask" which would hang CI
 * - task                   →  controls sub-agent invocation (task tool)
 *
 * The old `tools: { bash: true, ... }` block is deprecated since v1.1.1 —
 * the permission system now controls tool access entirely.
 *
 * We inject this as OPENCODE_CONFIG_CONTENT (highest-precedence env var,
 * overrides even a project-level opencode.json) so no file needs to be written
 * and the config can never be overridden by a repo's own config.
 */
function buildCIConfig(): string {
  if (cachedCIConfig) return cachedCIConfig;
  const config = {
    $schema: 'https://opencode.ai/config.json',
    // "allow" as a string is the shorthand that enables every tool without
    // prompting. Docs: https://opencode.ai/docs/permissions#configuration
    permission: 'allow',
    // Disable auto-update and sharing — irrelevant in CI and slow things down.
    autoupdate: false,
    share: 'disabled',
    // Clear MCP and plugins to prevent downloading external dependencies in CI
    mcp: {},
    plugin: [],
  };
  cachedCIConfig = JSON.stringify(config);
  return cachedCIConfig;
}

export async function runOpenCode(
  prompt: string,
  options: {
    model: string;
    workingDirectory?: string;
    /** Timeout in minutes before killing OpenCode. Default: 10. */
    timeoutMinutes?: number;
    env?: Record<string, string>;
  },
): Promise<{ success: boolean; output: string; durationMs: number }> {
  const binaryPath = opencodePath || (await setupOpenCode());
  const startTime = Date.now();
  const cwd = options.workingDirectory || process.cwd();
  const timeoutMs = (options.timeoutMinutes ?? 10) * 60 * 1000;

  // --auto  → auto-approves any permission that is not explicitly "deny".
  //           This is the documented CI mechanism for opencode run.
  //           Docs: https://opencode.ai/docs/permissions#auto-mode
  const args = [
    'run',
    '--auto', // approve all non-denied permissions automatically
    '--model',
    options.model,
    prompt,
  ];

  core.info(
    `Running OpenCode (model: ${options.model}, timeout: ${options.timeoutMinutes ?? 10}m)...`,
  );

  // SECURITY: These API keys are forwarded as env vars to the OpenCode child process.
  // They are accessible to any subprocess spawned by OpenCode. Consider using short-lived
  // tokens or a secrets-injecting sidecar if this is a concern in your environment.
  const githubToken = process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN || '';
  const openaiApiKey = process.env.OPENAI_API_KEY || process.env.INPUT_OPENAI_API_KEY || '';
  const anthropicApiKey =
    process.env.ANTHROPIC_API_KEY || process.env.INPUT_ANTHROPIC_API_KEY || '';
  const geminiApiKey = process.env.GEMINI_API_KEY || process.env.INPUT_GEMINI_API_KEY || '';

  const safeEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      safeEnv[key] = value;
    }
  }
  safeEnv.GITHUB_TOKEN = githubToken;
  safeEnv.GH_TOKEN = githubToken;
  safeEnv.OPENAI_API_KEY = openaiApiKey;
  safeEnv.ANTHROPIC_API_KEY = anthropicApiKey;
  safeEnv.GEMINI_API_KEY = geminiApiKey;
  safeEnv.OPENCODE_CONFIG_CONTENT = buildCIConfig();
  safeEnv.OPENCODE_DISABLE_AUTOUPDATE = 'true';
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      if (value !== undefined) {
        safeEnv[key] = value;
      }
    }
  }

  const childProcess = cp.spawn(binaryPath, args, {
    cwd,
    stdio: 'inherit',
    env: safeEnv,
  });

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    core.warning(
      `OpenCode timeout of ${options.timeoutMinutes ?? 10}m exceeded — killing process.`,
    );
    childProcess.kill();
  }, timeoutMs);

  let exitCode: number | null = null;
  let processError: string | undefined;

  try {
    await new Promise<void>((resolve) => {
      childProcess.on('exit', (code) => {
        exitCode = code;
        resolve();
      });
      childProcess.on('error', (err) => {
        processError = err.message;
        resolve();
      });
    });

    const durationMs = Date.now() - startTime;

    if (timedOut || exitCode !== 0 || processError) {
      core.warning(
        `OpenCode did not complete successfully (timedOut: ${timedOut}, exitCode: ${exitCode}, error: ${processError ?? 'none'})`,
      );
      return { success: false, output: '', durationMs };
    }

    core.info(`OpenCode finished in ${(durationMs / 1000).toFixed(1)}s`);
    return { success: true, output: '', durationMs };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    core.error(`OpenCode execution failed: ${String(err)}`);
    return { success: false, output: '', durationMs };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export function configureGit(userName?: string, userEmail?: string, token?: string): void {
  const name = userName || process.env.GITHUB_ACTOR || 'opencode-ai-reviewer[bot]';
  const email = userEmail || `${name}@users.noreply.github.com`;

  try {
    cp.execFileSync('git', ['config', '--global', 'user.name', name]);
    cp.execFileSync('git', ['config', '--global', 'user.email', email]);

    if (token) {
      // Remove ALL http.extraheader entries from every git config file
      // (including those from actions/checkout@v6+ stored via includeIf).
      // Without this, git sends duplicate Authorization headers on push.
      let origins = '';
      try {
        origins = cp.execFileSync('git', ['config', '--list', '--show-origin'], {
          encoding: 'utf-8',
        });
      } catch {
        /* git config --list failed entirely */
      }
      for (const line of origins.split('\n')) {
        if (!line.includes('http.') || !line.includes('.extraheader')) continue;
        const tabIdx = line.indexOf('\t');
        if (tabIdx <= 0) continue;
        const prefix = line.substring(0, tabIdx);
        if (!prefix.startsWith('file:')) continue;
        const cfg = prefix.substring(5);
        const resolvedCfg = path.resolve(cfg);
        // Only modify config files in trusted locations
        if (!resolvedCfg.startsWith(os.homedir()) && !resolvedCfg.startsWith(process.cwd())) {
          continue;
        }
        try {
          cp.execFileSync('git', [
            'config',
            '--file',
            resolvedCfg,
            '--unset-all',
            'http.https://github.com/.extraheader',
          ]);
        } catch {
          /* key not in this file */
        }
      }

      // Use GIT_ASKPASS instead of a shell-function credential helper so the token
      // is never embedded in git config output (visible via git config --list).
      // The token is read from an env var by the askpass script at credential time.
      try {
        cp.execFileSync('git', [
          'config',
          '--local',
          '--unset-all',
          'credential.https://github.com/.helper',
        ]);
      } catch {
        /* no previous helper to clear */
      }
      const askPassDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-askpass-'));
      const askPassPath = path.join(askPassDir, 'credential.sh');
      fs.writeFileSync(
        askPassPath,
        [
          '#!/bin/sh',
          'case "$1" in',
          '  *Username*) echo "x-access-token" ;;',
          '  *Password*) echo "${OPENCODE_CREDENTIAL_TOKEN}" ;;',
          'esac',
        ].join('\n'),
        'utf-8',
      );
      fs.chmodSync(askPassPath, 0o755);
      process.env.GIT_ASKPASS = askPassPath;
      process.env.OPENCODE_CREDENTIAL_TOKEN = token;
    }
  } catch (err) {
    core.warning(`configureGit failed: ${String(err)}`);
  }

  core.info(`Git configured: ${name} <${email}>`);
}

export function getGitStatus(): string {
  try {
    return cp.execFileSync('git', ['status', '--porcelain'], { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

export async function setupWorkspaceDependencies(cwd: string): Promise<void> {
  core.info('Checking workspace package manager and dependencies...');

  const hasPnpmLock = fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'));
  const hasYarnLock = fs.existsSync(path.join(cwd, 'yarn.lock'));
  const hasPackageJson = fs.existsSync(path.join(cwd, 'package.json'));

  if (!hasPackageJson) {
    core.info('No package.json found in workspace root. Skipping package manager setup.');
    return;
  }

  // 1. Install package manager if needed
  if (hasPnpmLock) {
    try {
      cp.execSync('pnpm --version', { stdio: 'ignore' });
      core.info('pnpm is already installed.');
    } catch {
      core.info('pnpm not found. Installing pnpm globally...');
      try {
        cp.execSync('corepack enable && corepack prepare pnpm@latest --activate', {
          stdio: 'inherit',
        });
        core.info('pnpm enabled successfully via corepack.');
      } catch (err) {
        core.info(`Corepack failed: ${String(err)}. Installing pnpm globally without sudo...`);
        try {
          cp.execSync('npm install -g pnpm', { stdio: 'inherit' });
          core.info('pnpm installed successfully.');
        } catch (npmErr) {
          core.error(
            `Failed to install pnpm globally: ${String(npmErr)}. Checks using pnpm might fail.`,
          );
        }
      }
    }
  } else if (hasYarnLock) {
    try {
      cp.execSync('yarn --version', { stdio: 'ignore' });
      core.info('yarn is already installed.');
    } catch {
      core.info('yarn not found. Installing yarn globally...');
      try {
        cp.execSync('npm install -g yarn', { stdio: 'inherit' });
        core.info('yarn installed successfully.');
      } catch (err) {
        core.warning(`Failed to install yarn globally: ${String(err)}`);
      }
    }
  }

  // 2. Install workspace dependencies if node_modules does not exist
  const hasNodeModules = fs.existsSync(path.join(cwd, 'node_modules'));
  if (!hasNodeModules) {
    core.info('node_modules not found. Installing dependencies...');
    try {
      if (hasPnpmLock) {
        core.info('Running pnpm install...');
        cp.execSync('pnpm install', { cwd, stdio: 'inherit' });
      } else if (hasYarnLock) {
        core.info('Running yarn install...');
        cp.execSync('yarn install', { cwd, stdio: 'inherit' });
      } else {
        core.info('Running npm install...');
        cp.execSync('npm install', { cwd, stdio: 'inherit' });
      }
      core.info('Workspace dependencies installed successfully.');
    } catch (err) {
      core.error(`Failed to install workspace dependencies: ${String(err)}`);
    }
  } else {
    core.info('node_modules directory already exists. Skipping dependency installation.');
  }
}

export function ensureOutputDir(outputFile: string): void {
  const dir = path.dirname(path.resolve(outputFile));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
