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

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    core.warning(`OpenCode has been running for ${options.timeoutMinutes ?? 10}m — possible hang.`);
  }, timeoutMs);

  const githubToken = process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN || '';
  const openaiApiKey = process.env.OPENAI_API_KEY || process.env.INPUT_OPENAI_API_KEY || '';
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY || process.env.INPUT_ANTHROPIC_API_KEY || '';
  const geminiApiKey = process.env.GEMINI_API_KEY || process.env.INPUT_GEMINI_API_KEY || '';

  try {
    await exec.exec(binaryPath, args, {
      cwd,
      input: Buffer.from(''),
      env: {
        ...process.env,
        ...options.env,
        GITHUB_TOKEN: githubToken,
        GH_TOKEN: githubToken,
        OPENAI_API_KEY: openaiApiKey,
        ANTHROPIC_API_KEY: anthropicApiKey,
        GEMINI_API_KEY: geminiApiKey,
        // OPENCODE_CONFIG_CONTENT is the highest-precedence config source.
        // It overrides remote, global, and project opencode.json configs.
        // We use it to guarantee all permissions are "allow" and autoupdate
        // is disabled regardless of what the target repo's config says.
        // Docs: https://opencode.ai/docs/config#locations
        OPENCODE_CONFIG_CONTENT: buildCIConfig(),
        // Disable auto-update checks — irrelevant in CI, wastes time.
        OPENCODE_DISABLE_AUTOUPDATE: 'true',
      } as { [key: string]: string },
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
    clearTimeout(timeoutHandle);
    if (timedOut) {
      core.warning(`OpenCode may have hung — exceeded the ${options.timeoutMinutes ?? 10}m timeout.`);
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
