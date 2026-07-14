import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import * as tc from '@actions/tool-cache';

let opencodePath: string | null = null;

function detectArch(): string {
  const arch = os.arch();
  switch (arch) {
    case 'x64':
      return 'linux-x64';
    case 'arm64':
      return 'linux-arm64';
    default:
      throw new Error(`Unsupported architecture: ${arch}. Only x64 and arm64 are supported.`);
  }
}

async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (response.ok) return response;
      if (response.status === 403 && attempt < retries) {
        const wait = Math.pow(2, attempt) * 1000;
        core.warning(`GitHub API rate limited. Retrying in ${wait}ms... (attempt ${attempt}/${retries})`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (err) {
      if (attempt === retries) throw err;
      const wait = Math.pow(2, attempt) * 1000;
      core.warning(`Fetch failed: ${err}. Retrying in ${wait}ms... (attempt ${attempt}/${retries})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error('Max retries exceeded');
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

  const assetName = `opencode-${arch}.tar.gz`;
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    throw new Error(
      `Could not find asset "${assetName}" in release ${release.tag_name || version}`,
    );
  }

  core.info(`Downloading from: ${asset.browser_download_url}`);

  let downloadPath = '';
  let extractPath = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      downloadPath = await tc.downloadTool(asset.browser_download_url);
      extractPath = await tc.extractTar(downloadPath);
      break;
    } catch (err) {
      if (attempt === 3) {
        core.error(`Failed to download/extract OpenCode after 3 attempts: ${String(err)}`);
        throw err;
      }
      const wait = Math.pow(2, attempt) * 1000;
      core.warning(`Download attempt ${attempt} failed, retrying in ${wait}ms: ${String(err)}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  const semver = (release.tag_name || version).replace(/^v/, '');
  const cachedPath = await tc.cacheDir(extractPath, 'opencode', semver);
  const binPath = path.join(cachedPath, 'opencode');

  fs.chmodSync(binPath, 0o755);

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
  return JSON.stringify(config);
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
    '--auto',              // approve all non-denied permissions automatically
    '--model', options.model,
    prompt,
  ];

  core.info(`Running OpenCode (model: ${options.model}, timeout: ${options.timeoutMinutes ?? 10}m)...`);

  const githubToken = process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN || '';
  const openaiApiKey = process.env.OPENAI_API_KEY || process.env.INPUT_OPENAI_API_KEY || '';
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY || process.env.INPUT_ANTHROPIC_API_KEY || '';
  const geminiApiKey = process.env.GEMINI_API_KEY || process.env.INPUT_GEMINI_API_KEY || '';

  const childProcess = cp.execFile(
    binaryPath,
    args,
    {
      cwd,
      env: {
        ...process.env,
        ...options.env,
        GITHUB_TOKEN: githubToken,
        GH_TOKEN: githubToken,
        OPENAI_API_KEY: openaiApiKey,
        ANTHROPIC_API_KEY: anthropicApiKey,
        GEMINI_API_KEY: geminiApiKey,
        OPENCODE_CONFIG_CONTENT: buildCIConfig(),
        OPENCODE_DISABLE_AUTOUPDATE: 'true',
      } as { [key: string]: string },
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    },
    (err) => {
      if (err && err.killed) {
        core.warning(`OpenCode was terminated after ${options.timeoutMinutes ?? 10}m timeout.`);
      }
    },
  );

  const timeoutHandle = setTimeout(() => {
    core.warning(`OpenCode exceeded ${options.timeoutMinutes ?? 10}m timeout — killing process.`);
    childProcess.kill('SIGTERM');
    setTimeout(() => {
      if (childProcess.exitCode === null) childProcess.kill('SIGKILL');
    }, 5000);
  }, timeoutMs);

  try {
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      childProcess.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
      childProcess.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
      childProcess.on('error', reject);
      childProcess.on('close', (code) => {
        if (code === 0 || code === null) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`OpenCode exited with code ${code}: ${stderr.slice(0, 500)}`));
        }
      });
    });

    const durationMs = Date.now() - startTime;
    core.info(`OpenCode finished in ${(durationMs / 1000).toFixed(1)}s`);
    return { success: true, output: stdout, durationMs };
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

  cp.execFileSync('git', ['config', '--global', 'user.name', name]);
  cp.execFileSync('git', ['config', '--global', 'user.email', email]);

  if (token) {
    cp.execFileSync('git', [
      'config', '--global',
      `url.https://x-access-token:${token}@github.com/.insteadOf`,
      'https://github.com/',
    ]);
  }

  core.info(`Git configured: ${name} <${email}>`);
}

export function getGitStatus(): string {
  try {
    return cp.execSync('git status --porcelain').toString();
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
        cp.execSync('npm install -g pnpm', { stdio: 'inherit' });
        core.info('pnpm installed successfully.');
      } catch (err) {
        core.warning(`Failed to install pnpm globally: ${String(err)}. Trying with sudo...`);
        try {
          cp.execSync('sudo npm install -g pnpm', { stdio: 'inherit' });
          core.info('pnpm installed successfully with sudo.');
        } catch (sudoErr) {
          core.error(`Failed to install pnpm globally: ${String(sudoErr)}. Checks using pnpm might fail.`);
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
