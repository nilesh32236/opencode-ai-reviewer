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

export async function setupOpenCode(version = 'latest'): Promise<string> {
  await ensurePnpm();

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
    releaseUrl = `https://api.github.com/repos/anomalyco/opencode/releases/tags/${version}`;
  }

  const response = await fetch(releaseUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch release info: ${response.status} ${response.statusText}`);
  }
  const release = (await response.json()) as {
    assets: Array<{ name: string; browser_download_url: string }>;
  };

  const assetName = `opencode-${arch}.tar.gz`;
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    throw new Error(`Could not find asset "${assetName}" in release`);
  }

  core.info(`Downloading from: ${asset.browser_download_url}`);
  const downloadPath = await tc.downloadTool(asset.browser_download_url);
  const extractPath = await tc.extractTar(downloadPath);

  const cachedPath = await tc.cacheDir(extractPath, 'opencode', version.replace(/^v/, ''));
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

export async function runOpenCode(
  prompt: string,
  options: {
    model: string;
    workingDirectory?: string;
    timeoutMinutes?: number;
    env?: Record<string, string>;
  },
): Promise<{ success: boolean; output: string; durationMs: number }> {
  const binaryPath = opencodePath || (await setupOpenCode());
  const startTime = Date.now();

  const args = ['run', '--model', options.model, prompt];
  const cwd = options.workingDirectory || process.cwd();

  core.info(`Running OpenCode in ${cwd}...`);

  let output = '';
  let error = '';

  try {
    const result = await exec.getExecOutput(binaryPath, args, {
      cwd,
      env: { ...process.env, ...options.env } as { [key: string]: string },
      silent: false,
      ignoreReturnCode: true,
    });

    output = result.stdout;
    error = result.stderr;

    const durationMs = Date.now() - startTime;
    const success = result.exitCode === 0;

    if (!success) {
      core.warning(`OpenCode exited with code ${result.exitCode}`);
      if (error) {
        core.warning(`stderr: ${error.substring(0, 500)}`);
      }
    }

    return { success, output, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    core.error(`OpenCode execution failed: ${String(err)}`);
    return { success: false, output, durationMs };
  }
}

export function configureGit(userName?: string, userEmail?: string, token?: string): void {
  const name = userName || process.env.GITHUB_ACTOR || 'github-actions[bot]';
  const email = userEmail || `${name}@users.noreply.github.com`;

  cp.execSync('git config --global user.name "' + name + '"');
  cp.execSync('git config --global user.email "' + email + '"');

  if (token) {
    cp.execSync(
      'git config --global url.https://x-access-token:' +
        token +
        '@github.com/.insteadOf https://github.com/',
    );
  }

  core.info(`Git configured: ${name} <${email}>`);
}

export async function ensurePnpm(pnpmVersion = '10.8.0'): Promise<void> {
  try {
    cp.execSync('corepack enable', { stdio: 'pipe' });
    core.info('Corepack enabled');
  } catch {
    core.warning('Could not enable corepack — continuing');
  }

  const existingPnpm = await io.which('pnpm', false);
  if (existingPnpm) {
    const version = cp.execSync('pnpm --version', { encoding: 'utf-8' }).trim();
    core.info(`pnpm already available: ${version}`);
    return;
  }

  try {
    cp.execSync(`corepack prepare pnpm@${pnpmVersion} --activate`, { stdio: 'pipe' });
    core.info(`pnpm ${pnpmVersion} installed via corepack`);
  } catch {
    try {
      cp.execSync('npm install -g pnpm', { stdio: 'pipe' });
      core.info('pnpm installed via npm');
    } catch {
      core.warning('Could not install pnpm — continuing without it');
    }
  }
}

export function getGitStatus(): string {
  try {
    return cp.execSync('git status --porcelain').toString();
  } catch {
    return '';
  }
}

export function ensureOutputDir(outputFile: string): void {
  const dir = path.dirname(path.resolve(outputFile));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
