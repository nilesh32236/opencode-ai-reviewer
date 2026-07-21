import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import * as tc from '@actions/tool-cache';
import {
  computeSha256,
  findChecksumAsset,
  getKnownChecksum,
  parseChecksumFile,
  verifyChecksum,
} from './utils/checksum.js';
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

/**
 * Ensure the OpenCode CLI binary is available.
 * Checks PATH first; if not found, downloads and caches the specified version.
 * @param version - Version tag to download (defaults to 'latest').
 * @returns A Promise resolving to the path of the OpenCode binary.
 */
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

  const semver = (release.tag_name || version).replace(/^v/, '');
  const platform = os.platform();
  const extension = platform === 'win32' ? 'zip' : 'tar.gz';
  const assetName = `opencode-${arch}.${extension}`;

  const cachedToolDir = tc.find('opencode', semver);
  if (cachedToolDir) {
    const binName = platform === 'win32' ? 'opencode.exe' : 'opencode';
    const cachedBinPath = path.join(cachedToolDir, binName);
    const checksumFile = path.join(cachedToolDir, '.checksum');
    if (fs.existsSync(cachedBinPath) && fs.existsSync(checksumFile)) {
      const storedChecksum = fs.readFileSync(checksumFile, 'utf-8').trim();
      const actualChecksum = await computeSha256(cachedBinPath);
      if (actualChecksum === storedChecksum) {
        core.info(`Using cached OpenCode ${semver} from ${cachedBinPath}`);
        if (platform !== 'win32') fs.chmodSync(cachedBinPath, 0o755);
        core.addPath(cachedToolDir);
        opencodePath = cachedBinPath;
        return cachedBinPath;
      }
      core.info('Cached binary checksum mismatch, re-downloading...');
    } else {
      core.info('Cached binary lacks checksum verification file, re-downloading...');
    }
  }

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

      await verifyDownloadedArchive(
        dlPath,
        release.assets,
        assetName,
        release.tag_name || version,
        arch,
      );

      let extPath: string;
      if (extension === 'zip') {
        extPath = await tc.extractZip(dlPath);
      } else {
        extPath = await tc.extractTar(dlPath);
      }
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

  const binChecksum = await computeSha256(binPath);
  fs.writeFileSync(path.join(cachedPath, '.checksum'), `${binChecksum}\n`, 'utf-8');

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

async function verifyDownloadedArchive(
  dlPath: string,
  assets: Array<{ name: string; browser_download_url: string }>,
  assetName: string,
  version: string,
  arch: string,
): Promise<void> {
  const checksumAsset = findChecksumAsset(assets, assetName);

  if (checksumAsset) {
    core.info(`Downloading checksum file: ${checksumAsset.name}`);
    const checksumPath = await tc.downloadTool(checksumAsset.browser_download_url);
    const checksumContent = fs.readFileSync(checksumPath, 'utf-8');
    const expectedHash = parseChecksumFile(checksumContent, assetName);

    if (expectedHash) {
      await verifyChecksum(dlPath, expectedHash);
      core.info(`Checksum verified for ${assetName}`);
      return;
    }
    core.warning(`Could not extract checksum for ${assetName} from ${checksumAsset.name}`);
  }

  const knownChecksum = getKnownChecksum(version, arch);
  if (knownChecksum) {
    await verifyChecksum(dlPath, knownChecksum);
    core.info(`Checksum verified using known-good checksum for ${version}`);
    return;
  }

  core.warning(
    `No checksum file found for ${assetName}. Skipping integrity verification — this could be a security concern.`,
  );
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

/**
 * Execute the OpenCode CLI with a given prompt.
 * Spawns the binary with a sandboxed environment (only whitelisted env vars are forwarded)
 * and enforces a timeout via SIGTERM/SIGKILL.
 *
 * @param prompt - The prompt text to pass to OpenCode.
 * @param options.model - Model identifier (e.g. "gpt-4", "claude-3-opus").
 * @param options.workingDirectory - Working directory for the subprocess (default: cwd).
 * @param options.timeoutMinutes - Max runtime before forced termination (default: 20).
 * @param options.env - Additional environment variables to forward.
 * @returns Object indicating success, output text, and wall-clock duration in ms.
 */
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
  const timeoutMs = (options.timeoutMinutes ?? 20) * 60 * 1000;

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
    `Running OpenCode (model: ${options.model}, timeout: ${options.timeoutMinutes ?? 20}m)...`,
  );

  // Only forward the API key required for the active model, not all keys unconditionally.
  // This limits the blast radius if a subprocess is compromised.
  const githubToken = process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN || '';

  const model = options.model.toLowerCase();
  const openaiApiKey =
    model.startsWith('gpt') ||
    model.startsWith('o1') ||
    model.startsWith('o3') ||
    model.startsWith('o-')
      ? process.env.OPENAI_API_KEY || process.env.INPUT_OPENAI_API_KEY || ''
      : '';
  const anthropicApiKey = model.startsWith('claude')
    ? process.env.ANTHROPIC_API_KEY || process.env.INPUT_ANTHROPIC_API_KEY || ''
    : '';
  const geminiApiKey = model.startsWith('gemini')
    ? process.env.GEMINI_API_KEY || process.env.INPUT_GEMINI_API_KEY || ''
    : '';

  const safeEnv: Record<string, string> = {};
  const WHITELISTED_KEYS = [
    'PATH',
    'HOME',
    'CI',
    'GITHUB_ACTIONS',
    'GITHUB_ACTOR',
    'GITHUB_REPOSITORY',
    'GITHUB_REPOSITORY_OWNER',
    'GITHUB_SHA',
    'GITHUB_REF',
    'GITHUB_BASE_REF',
    'GITHUB_HEAD_REF',
    'GITHUB_WORKSPACE',
    'GITHUB_ACTION',
    'GITHUB_EVENT_NAME',
    'GITHUB_EVENT_PATH',
    'GITHUB_OUTPUT',
    'GITHUB_STEP_SUMMARY',
    'GITHUB_ENV',
    'GITHUB_PATH',
    'RUNNER_OS',
    'RUNNER_ARCH',
    'RUNNER_TEMP',
    'RUNNER_TOOL_CACHE',
    'NODE_PATH',
    'DATABASE_URL',
    'GIT_ASKPASS',
    'OPENCODE_CREDENTIAL_TOKEN',
  ];
  for (const key of WHITELISTED_KEYS) {
    const val = process.env[key];
    if (val !== undefined) safeEnv[key] = val;
  }
  safeEnv.GITHUB_TOKEN = githubToken;
  safeEnv.GH_TOKEN = githubToken;
  if (openaiApiKey) safeEnv.OPENAI_API_KEY = openaiApiKey;
  if (anthropicApiKey) safeEnv.ANTHROPIC_API_KEY = anthropicApiKey;
  if (geminiApiKey) safeEnv.GEMINI_API_KEY = geminiApiKey;
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
  let childExited = false;
  let forceKillHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    core.warning(
      `OpenCode timeout of ${options.timeoutMinutes ?? 20}m exceeded — sending SIGTERM.`,
    );
    childProcess.kill('SIGTERM');
    // If SIGTERM is ignored or too slow, force-kill after 5 seconds
    forceKillHandle = setTimeout(() => {
      if (!childExited) {
        core.warning('OpenCode did not exit after SIGTERM — sending SIGKILL.');
        childProcess.kill('SIGKILL');
      }
    }, 5_000);
  }, timeoutMs);

  let exitCode: number | null = null;
  let processError: string | undefined;

  try {
    await new Promise<void>((resolve) => {
      childProcess.on('exit', (code) => {
        childExited = true;
        exitCode = code;
        resolve();
      });
      childProcess.on('error', (err) => {
        childExited = true;
        processError = err.message;
        resolve();
      });
    });

    const durationMs = Date.now() - startTime;

    if (exitCode === 0 && !processError) {
      core.info(`OpenCode finished in ${(durationMs / 1000).toFixed(1)}s`);
      return { success: true, output: '', durationMs };
    }

    core.warning(
      `OpenCode did not complete successfully (timedOut: ${timedOut}, exitCode: ${exitCode}, error: ${processError ?? 'none'})`,
    );
    return { success: false, output: '', durationMs };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    core.error(`OpenCode execution failed: ${String(err)}`);
    return { success: false, output: '', durationMs };
  } finally {
    clearTimeout(timeoutHandle);
    if (forceKillHandle !== undefined) {
      clearTimeout(forceKillHandle);
    }
  }
}

/**
 * Configure git user name, email, and authentication for the CI environment.
 * Strips any existing http.extraheader entries to avoid duplicate auth headers,
 * and sets up GIT_ASKPASS for token-based authentication without leaking
 * credentials into git config.
 *
 * @param userName - Git user name (defaults to GITHUB_ACTOR or "opencode-ai-reviewer[bot]").
 * @param userEmail - Git user email (defaults to user name @ users.noreply.github.com).
 * @param token - GitHub token for authentication via GIT_ASKPASS.
 */
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

/**
 * Get the current git working-tree status as a porcelain string.
 *
 * @returns Porcelain git status output, or empty string if git is not available.
 */
export function getGitStatus(): string {
  try {
    return cp.execFileSync('git', ['status', '--porcelain'], { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

/**
 * Detect the workspace package manager (pnpm/yarn/npm) and install dependencies
 * if node_modules is missing. Installs the package manager binary itself if not found.
 *
 * @param cwd - Workspace root directory.
 */
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
      cp.execFileSync('pnpm', ['--version'], { stdio: 'ignore' });
      core.info('pnpm is already installed.');
    } catch {
      core.info('pnpm not found. Installing pnpm globally...');
      try {
        cp.execFileSync('corepack', ['enable'], { stdio: 'inherit' });
        cp.execFileSync('corepack', ['prepare', 'pnpm@latest', '--activate'], { stdio: 'inherit' });
        core.info('pnpm enabled successfully via corepack.');
      } catch (err) {
        core.info(`Corepack failed: ${String(err)}. Installing pnpm globally without sudo...`);
        try {
          cp.execFileSync('npm', ['install', '-g', 'pnpm'], { stdio: 'inherit' });
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
      cp.execFileSync('yarn', ['--version'], { stdio: 'ignore' });
      core.info('yarn is already installed.');
    } catch {
      core.info('yarn not found. Installing yarn globally...');
      try {
        cp.execFileSync('npm', ['install', '-g', 'yarn'], { stdio: 'inherit' });
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
        cp.execFileSync('pnpm', ['install'], { cwd, stdio: 'inherit' });
      } else if (hasYarnLock) {
        core.info('Running yarn install...');
        cp.execFileSync('yarn', ['install'], { cwd, stdio: 'inherit' });
      } else {
        core.info('Running npm install...');
        cp.execFileSync('npm', ['install'], { cwd, stdio: 'inherit' });
      }
      core.info('Workspace dependencies installed successfully.');
    } catch (err) {
      core.error(`Failed to install workspace dependencies: ${String(err)}`);
    }
  } else {
    core.info('node_modules directory already exists. Skipping dependency installation.');
  }
}

/**
 * Ensure the parent directory of a file path exists, creating it recursively if needed.
 *
 * @param outputFile - Path to a file whose parent directory should exist.
 */
export function ensureOutputDir(outputFile: string): void {
  const dir = path.dirname(path.resolve(outputFile));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
