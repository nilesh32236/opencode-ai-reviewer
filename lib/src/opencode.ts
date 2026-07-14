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
  const downloadPath = await tc.downloadTool(asset.browser_download_url);
  const extractPath = await tc.extractTar(downloadPath);

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
 * Write an opencode.json config in the working directory that sets all
 * permissions to "allow" so OpenCode never pauses waiting for user input.
 * Without this, any tool call (edit/bash/webfetch) that defaults to "ask"
 * will block forever in a non-interactive CI environment.
 */
function writeOpencodeConfig(cwd: string): void {
  const configDir = path.join(cwd, '.opencode');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const config = {
    permission: {
      edit: 'allow',
      bash: 'allow',
      webfetch: 'allow',
    },
  };

  const configPath = path.join(configDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  core.info(`OpenCode config written: ${configPath}`);
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

  // Write permissions config so OpenCode never blocks on permission prompts.
  writeOpencodeConfig(cwd);

  // Write the prompt to a temp file and pass it via --file so the full prompt
  // text doesn't appear in the GitHub Actions command-echo log.
  const promptFile = path.join(os.tmpdir(), `opencode-prompt-${Date.now()}.txt`);
  fs.writeFileSync(promptFile, prompt, 'utf-8');

  // --print-logs streams OpenCode's internal progress to stderr, making it
  // visible in the Actions log instead of appearing completely silent.
  const args = [
    '--print-logs',
    'run',
    '--model', options.model,
    '--file', promptFile,
    'Review the attached file and produce the output as instructed.',
  ];

  core.info(`Running OpenCode (model: ${options.model}, timeout: ${options.timeoutMinutes ?? 10}m)...`);

  try {
    await exec.exec(binaryPath, args, {
      cwd,
      env: {
        ...process.env,
        ...options.env,
        // Belt-and-suspenders: also set permissions via env var so they apply
        // even if a project-level config overrides the file we wrote above.
        OPENCODE_PERMISSION: JSON.stringify({ edit: 'allow', bash: 'allow', webfetch: 'allow' }),
      } as { [key: string]: string },
      outStream: process.stdout,
      errStream: process.stderr,
      // silent: true keeps the command line from being echoed (which would
      // dump the full --file path and prompt message into the log).
      silent: true,
      ignoreReturnCode: true,
    });

    const durationMs = Date.now() - startTime;
    core.info(`OpenCode finished in ${(durationMs / 1000).toFixed(1)}s`);

    return { success: true, output: '', durationMs };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    core.error(`OpenCode execution failed: ${String(err)}`);
    return { success: false, output: '', durationMs };
  } finally {
    // Clean up temp prompt file — best effort.
    try { fs.unlinkSync(promptFile); } catch { /* ignore */ }

    // Warn if we're over budget (helps diagnose future hangs).
    const elapsed = Date.now() - startTime;
    if (elapsed >= timeoutMs) {
      core.warning(`OpenCode hit the ${options.timeoutMinutes ?? 10}m timeout — it may have hung.`);
    }
  }
}

export function configureGit(userName?: string, userEmail?: string, token?: string): void {
  const name = userName || process.env.GITHUB_ACTOR || 'opencode-ai-reviewer[bot]';
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
