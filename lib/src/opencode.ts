import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as core from '@actions/core';
import * as io from '@actions/io';
import * as tc from '@actions/tool-cache';
import {
  computeSha256,
  findChecksumAsset,
  getKnownChecksum,
  parseChecksumFile,
  verifyChecksum,
} from './utils/checksum.js';
import { validateModelString } from './utils/model-string.js';
import { withRetry } from './utils/retry.js';
import {
  MINIMUM_OPENCODE_VERSION,
  UNPARSEABLE_VERSION,
  compareVersions,
  formatVersion,
  parseVersion,
} from './utils/version.js';

export { MINIMUM_OPENCODE_VERSION } from './utils/version.js';

/** Default timeout for the `opencode --version` health probe, in milliseconds. */
export const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

let opencodePath: string | null = null;
/** Path of the opencode binary most recently confirmed compatible by checkHealth(). */
let validatedOpenCodePath: string | null = null;
let cachedCIConfig: string | null = null;
const askPassDirs: string[] = [];

/** Overrides for how OpenCode CLI runs are invoked (used by the local CLI). */
export interface OpenCodeRunMode {
  /**
   * Custom OpenCode config JSON injected as OPENCODE_CONFIG_CONTENT. Replaces the
   * CI config (which clears MCP/plugins and forces every tool to allow).
   */
  opencodeConfig?: string;
  /**
   * Whether to pass `--auto` to auto-approve tool permissions. CI behavior is
   * `true`; interactive local use should set this to `false` so the user can
   * approve permissions at the prompt. Defaults to `true`.
   */
  autoApprove?: boolean;
}

let runModeOverride: OpenCodeRunMode | undefined;

/**
 * Configure how the OpenCode CLI is invoked for the current process.
 *
 * The GitHub Action and App never call this and keep the default CI behavior
 * (`--auto` + CI config). The local CLI sets a mode with `autoApprove: false`
 * and a non-CI config so interactive permission prompts are possible.
 * @param mode - The run mode to apply, or `undefined` to restore CI defaults.
 */
export function setOpenCodeRunMode(mode: OpenCodeRunMode | undefined): void {
  runModeOverride = mode;
}

/**
 * Build the OpenCode config object for interactive local use.
 *
 * Unlike {@link buildCIConfig}, this keeps MCP servers and plugins enabled
 * (nothing is cleared) so a developer's own opencode.json / plugins work
 * locally, and it does not force every tool to "allow". Combined with
 * `autoApprove: false` on `setOpenCodeRunMode`, tool usage is prompted for
 * approval during a local review.
 * @returns A JSON string of the local OpenCode config.
 */
export function buildLocalOpenCodeConfig(): string {
  const config = {
    $schema: 'https://opencode.ai/config.json',
    // Disable auto-update and sharing — irrelevant for one-shot local reviews.
    autoupdate: false,
    share: 'disabled',
  };
  return JSON.stringify(config);
}

/**
 * Reset the module-level OpenCode state (cached binary path, validation cache,
 * and CI config cache). Used by tests and by long-lived processes that re-run
 * setup against a changed environment.
 */
export function resetOpenCodeState(): void {
  opencodePath = null;
  validatedOpenCodePath = null;
  cachedCIConfig = null;
  runModeOverride = undefined;
}

function cleanupAskPassDirs(): void {
  for (const dir of askPassDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  }
}

process.on('exit', cleanupAskPassDirs);
process.on('SIGINT', () => {
  cleanupAskPassDirs();
  process.exit(2);
});
process.on('SIGTERM', () => {
  cleanupAskPassDirs();
  process.exit(15);
});

/**
 * Parsed OpenCode CLI version, with the raw text matched from `--version` output.
 */
export interface OpenCodeVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifier (e.g. "rc.1") or null for a release version. */
  prerelease: string | null;
}

/**
 * Parse an OpenCode CLI version from `opencode --version` output.
 * Handles output like "opencode v1.1.1", "1.1.1-rc.1", or plain "v1.2.3".
 *
 * The version token must be standalone (bounded by whitespace or the start/end
 * of the output) so version-like numbers embedded in error text, stack traces,
 * or file paths are not accepted as the CLI version.
 * @param output - The raw output from `opencode --version`.
 * @returns A parsed version, or null when no standalone semver token is found.
 */
export function parseOpenCodeVersion(output: string): OpenCodeVersion | null {
  const match = output.match(
    /(?:^|\s)(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=\s|$)/,
  );
  if (!match) return null;
  const raw = match[1];
  const parsed = parseVersion(raw);
  if (!parsed) return null;
  return {
    raw,
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    prerelease: parsed.prerelease,
  };
}

/**
 * Compare a parsed OpenCode version against a minimum semver string.
 * @param version - The parsed OpenCode version.
 * @param minimum - Minimum acceptable version (default: {@link MINIMUM_OPENCODE_VERSION}).
 * @returns True when the version is at or above the minimum.
 */
export function isVersionCompatible(
  version: OpenCodeVersion,
  minimum: string = MINIMUM_OPENCODE_VERSION,
): boolean {
  const cmp = compareVersions(formatVersion(version), minimum);
  if (cmp === UNPARSEABLE_VERSION) return false;
  return cmp >= 0;
}

/**
 * Structured health status of the OpenCode CLI integration.
 */
export interface OpenCodeHealth {
  /** Whether an opencode binary is present and executable. */
  available: boolean;
  /** Parsed version from `opencode --version`, or null when unavailable/unparseable. */
  version: OpenCodeVersion | null;
  /** Whether the installed version meets the minimum supported version. */
  compatible: boolean;
  /** Human-readable status with install/upgrade instructions when needed. */
  message: string;
}

/**
 * Options for {@link checkHealth}.
 */
export interface CheckHealthOptions {
  /** Absolute path to the opencode binary. Defaults to the cached path or a PATH lookup. */
  binPath?: string;
  /** Minimum acceptable version (default: {@link MINIMUM_OPENCODE_VERSION}). */
  minimumVersion?: string;
  /** Timeout for the `--version` probe in milliseconds (default: 5000). */
  timeoutMs?: number;
  /**
   * Optional replacement for the generic npm upgrade hint shown when the
   * installed version is below the minimum. Used by the download/cached setup
   * paths, where a global npm upgrade would not fix the installed binary.
   */
  upgradeHint?: string;
}

const INSTALL_MESSAGE =
  'OpenCode CLI not found. Install it via: npm install -g opencode-ai\n' +
  'Or download from: https://github.com/anomalyco/opencode/releases';

/**
 * Run `opencode --version` asynchronously, bounded by a timeout.
 * The probe is deliberately non-blocking (unlike execFileSync) so a slow or
 * hung binary cannot stall the event loop for concurrent batch processing.
 * @param binPath - Absolute path to the opencode binary.
 * @param timeoutMs - Timeout before the probe is killed (SIGKILL).
 * @returns The raw stdout of the version command.
 * @throws The underlying execFile error (ENOENT, ETIMEDOUT, etc.).
 */
function execVersion(binPath: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile(
      binPath,
      ['--version'],
      {
        encoding: 'utf-8',
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
      },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Pre-flight health check for the OpenCode CLI integration.
 * Runs `opencode --version` with a short timeout and verifies the installed
 * version meets the minimum supported version. External consumers can call
 * this before issuing commands to surface a clear, actionable error instead of
 * an opaque ENOENT/parse failure.
 *
 * The probe is asynchronous (never blocks the event loop) and bounded by
 * `timeoutMs`. On success the checked binary path is recorded so that
 * {@link runOpenCode} can skip the redundant probe for an already-validated
 * binary.
 * @param options - Health check options.
 * @returns A structured health result.
 */
export async function checkHealth(options: CheckHealthOptions = {}): Promise<OpenCodeHealth> {
  const minimumVersion = options.minimumVersion ?? MINIMUM_OPENCODE_VERSION;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const binPath = options.binPath ?? opencodePath ?? (await io.which('opencode', false));
  if (!binPath) {
    return {
      available: false,
      version: null,
      compatible: false,
      message: INSTALL_MESSAGE,
    };
  }
  try {
    const stdout = await execVersion(binPath, timeoutMs);
    const version = parseOpenCodeVersion(stdout || '');
    if (!version) {
      return {
        available: true,
        version: null,
        compatible: false,
        message: `OpenCode binary found at ${binPath} but version could not be determined from output: ${(stdout || '').trim()}`,
      };
    }
    const compatible = isVersionCompatible(version, minimumVersion);
    if (compatible) {
      validatedOpenCodePath = binPath;
      return {
        available: true,
        version,
        compatible: true,
        message: `OpenCode ${version.raw} is available and compatible`,
      };
    }
    const hint = options.upgradeHint ?? 'Upgrade with: npm install -g opencode-ai@latest';
    return {
      available: true,
      version,
      compatible: false,
      message: `OpenCode ${version.raw} is installed but version ${minimumVersion}+ is required.\n${hint}`,
    };
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
      return {
        available: false,
        version: null,
        compatible: false,
        message: `OpenCode binary at ${binPath} could not be executed (${code}). Reinstall it via: npm install -g opencode-ai, or download from: https://github.com/anomalyco/opencode/releases`,
      };
    }
    return {
      available: true,
      version: null,
      compatible: false,
      message: `OpenCode binary found at ${binPath} but version check failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

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

async function fetchWithRetry(url: string, retries = 3, token?: string): Promise<Response> {
  return withRetry(
    async () => {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (response.ok) return response;
      const err = new Error(`HTTP ${response.status}: ${response.statusText}`);
      (err as Error & { status: number }).status = response.status;
      throw err;
    },
    {
      maxRetries: retries,
      // 403 is NOT retryable here: on the authenticated attempt a rejected
      // repo-scoped token deterministically returns 403, and burning three
      // backoff retries (~7-10s) before the anonymous fallback is wasteful. A
      // 403 also never becomes transiently successful, so failing fast is safe.
      retryableStatuses: [429, 500, 502, 503, 504],
    },
  );
}

/**
 * Build an actionable, user-facing error message for a failed OpenCode binary
 * download, classifying the underlying cause (network, HTTP status, checksum
 * mismatch, or unknown) so users get guidance on how to recover instead of a
 * raw stack trace.
 * @param error - The error thrown during download (network, HTTP, or checksum).
 * @param version - The semver tag of the OpenCode release being downloaded.
 * @param downloadUrl - The asset URL that failed to download.
 * @returns A human-friendly message explaining the failure and next steps.
 */
function classifyDownloadError(error: unknown, version: string, downloadUrl: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (
    /checksum mismatch|does not match|integrity check|hash.*(mismatch|does not match)/i.test(
      message,
    )
  ) {
    return (
      `The downloaded OpenCode binary (${version}) failed checksum verification.\n` +
      `Details: ${message}\n` +
      `This usually indicates a corrupted download or an intercepted network transfer. ` +
      `Re-run the workflow to retry with a fresh download; if the error persists, ` +
      `contact support or verify the release assets at:\n${downloadUrl}`
    );
  }

  if (
    /timed out|timeout|fetch failed|network|econnrefused|econnreset|enotfound|etimedout|eai_again|socket/i.test(
      lower,
    )
  ) {
    return (
      `Failed to download the OpenCode binary (${version}) — network error.\n` +
      `Details: ${message}\n` +
      `Download URL: ${downloadUrl}\n` +
      `Check your network connectivity and firewall/proxy settings, then re-run the workflow.`
    );
  }

  const http4xx = message.match(/HTTP (4\d\d)/i);
  if (http4xx) {
    return (
      `Failed to download the OpenCode binary (${version}) — HTTP ${http4xx[1]}.\n` +
      `Details: ${message}\n` +
      `Download URL: ${downloadUrl}\n` +
      `Verify that the requested version tag exists and that the release assets are ` +
      `publicly accessible, then re-run the workflow.`
    );
  }

  const http5xx = message.match(/HTTP (5\d\d)/i);
  if (http5xx) {
    return (
      `Failed to download the OpenCode binary (${version}) — HTTP ${http5xx[1]}.\n` +
      `Details: ${message}\n` +
      `Download URL: ${downloadUrl}\n` +
      `This looks like a transient server error on GitHub's side — re-run the workflow to retry.`
    );
  }

  return (
    `Failed to download the OpenCode binary (${version}).\n` +
    `Details: ${message}\n` +
    `Download URL: ${downloadUrl}\n` +
    `Please re-run the workflow to retry; if the issue persists, contact support.`
  );
}

/**
 * Ensure the OpenCode CLI binary is available.
 * Checks PATH first; if not found, downloads and caches the specified version.
 * @param version - Version tag to download (defaults to 'latest').
 * @param token - Optional GitHub token used for the authenticated release lookup.
 * @param minimumVersion - Minimum acceptable installed version (default: {@link MINIMUM_OPENCODE_VERSION}).
 * @returns A Promise resolving to the path of the OpenCode binary.
 */
export async function setupOpenCode(
  version = 'latest',
  token?: string,
  minimumVersion: string = MINIMUM_OPENCODE_VERSION,
): Promise<string> {
  const existingPath = await io.which('opencode', false);
  if (existingPath) {
    core.info(`OpenCode already available at: ${existingPath}`);
    opencodePath = existingPath;
    const health = await checkHealth({ binPath: existingPath, minimumVersion });
    if (!health.compatible) {
      throw new Error(health.message);
    }
    return existingPath;
  }

  // Fail fast for explicitly pinned versions below the minimum: the downloaded
  // binary would immediately fail the post-install health check, so surface a
  // clear error before spending time and bandwidth on a doomed download.
  const requestedVersion = version !== 'latest' ? parseVersion(version) : null;
  if (requestedVersion) {
    const cmp = compareVersions(formatVersion(requestedVersion), minimumVersion);
    if (cmp === UNPARSEABLE_VERSION) {
      throw new Error(
        `minimumOpenCodeVersion "${minimumVersion}" is not a valid semantic version — set it to a value like "${MINIMUM_OPENCODE_VERSION}"`,
      );
    }
    if (cmp < 0) {
      throw new Error(
        `Requested OpenCode version ${version} is below the minimum supported version ${minimumVersion}. ` +
          `Set opencode_version to a tag >= ${minimumVersion} and re-run.`,
      );
    }
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

  let response: Response;
  const ambientToken =
    token ||
    (process.env.GITHUB_ACTIONS === 'true'
      ? process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN || undefined
      : undefined);
  try {
    response = await fetchWithRetry(releaseUrl, 3, ambientToken);
  } catch (err) {
    const status =
      err instanceof Error && 'status' in err ? (err as Error & { status: number }).status : 0;
    if (status === 401 || status === 403 || status === 404) {
      core.warning(`Authenticated release lookup failed (HTTP ${status}) — retrying anonymously`);
      response = await fetchWithRetry(releaseUrl, 3);
    } else {
      throw err;
    }
  }
  const status = response.status;
  const release = (await response.json()) as {
    tag_name?: string;
    assets?: Array<{ name: string; browser_download_url: string }>;
  };

  if (!Array.isArray(release.assets)) {
    // A 404 from the (possibly anonymous) lookup means the requested tag does
    // not exist rather than an auth failure — surface a clear error naming the
    // tag so setup failures are diagnosable instead of a confusing TypeError
    // from release.assets.find below.
    const requested =
      version === 'latest' ? 'latest' : version.startsWith('v') ? version : `v${version}`;
    throw new Error(
      `Release${version === 'latest' ? '' : ` ${requested}`} not found on anomalyco/opencode (HTTP ${status}) — cannot download opencode`,
    );
  }
  const releaseAssets = release.assets;

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
        const health = await checkHealth({
          binPath: cachedBinPath,
          minimumVersion,
          upgradeHint: `The cached binary for requested tag ${version} is below the minimum. Set opencode_version to a tag >= ${minimumVersion} and re-run, or install the CLI via: npm install -g opencode-ai`,
        });
        if (!health.compatible) {
          throw new Error(health.message);
        }
        return cachedBinPath;
      }
      core.info('Cached binary checksum mismatch, re-downloading...');
    } else {
      core.info('Cached binary lacks checksum verification file, re-downloading...');
    }
  }

  const asset = releaseAssets.find((a) => a.name === assetName);
  if (!asset) {
    const message = `Could not find asset "${assetName}" in release ${release.tag_name || version}`;
    core.error(message);
    throw new Error(message);
  }

  core.info(`Downloading from: ${asset.browser_download_url}`);
  let cachedPath: string;
  try {
    const result = await withRetry(
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
        ]).finally(
          () => downloadTimeoutHandle !== undefined && clearTimeout(downloadTimeoutHandle),
        );

        await verifyDownloadedArchive(
          dlPath,
          releaseAssets,
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
    cachedPath = result.cachedPath;
  } catch (error) {
    const message = classifyDownloadError(error, semver, asset.browser_download_url);
    core.error(message);
    throw new Error(message);
  }

  const binName = platform === 'win32' ? 'opencode.exe' : 'opencode';
  const binPath = path.join(cachedPath, binName);

  if (platform !== 'win32') {
    fs.chmodSync(binPath, 0o755);
  }

  const binChecksum = await computeSha256(binPath);
  fs.writeFileSync(path.join(cachedPath, '.checksum'), `${binChecksum}\n`, 'utf-8');

  core.addPath(cachedPath);

  opencodePath = binPath;
  const health = await checkHealth({
    binPath,
    minimumVersion,
    upgradeHint: `The downloaded binary for requested tag ${version} reports a version below the minimum. Set opencode_version to a tag >= ${minimumVersion} and re-run, or install the CLI via: npm install -g opencode-ai`,
  });
  if (!health.compatible) {
    throw new Error(health.message);
  }
  core.info(`OpenCode installed: ${health.version?.raw ?? binPath}`);
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
 * Resolve the path to the OpenCode CLI binary, installing it if necessary.
 * Prefers an existing PATH binary; otherwise downloads the requested version
 * via `setupOpenCode`.
 *
 * @param version - Version to install when opencode is missing (defaults to 'latest').
 * @param minimumVersion - Minimum acceptable installed version (default: {@link MINIMUM_OPENCODE_VERSION}).
 * @returns The absolute path to the opencode binary.
 */
export async function resolveOpenCodePath(
  version = 'latest',
  minimumVersion: string = MINIMUM_OPENCODE_VERSION,
): Promise<string> {
  const existingPath = await io.which('opencode', false);
  if (existingPath) {
    opencodePath = existingPath;
    return existingPath;
  }
  return setupOpenCode(version, undefined, minimumVersion);
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
 * @returns A JSON string of the CI config.
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
 * Breakdown of token usage parsed from OpenCode CLI output.
 */
export interface TokenUsageBreakdown {
  /** Total tokens consumed, or 0 if no pattern matched. */
  totalTokens: number;
  /** Prompt (input) tokens when explicitly reported. */
  promptTokens?: number;
  /** Completion (output) tokens when explicitly reported. */
  completionTokens?: number;
}

function extractSingleToken(output: string, pattern: RegExp): number | undefined {
  const match = output.match(pattern);
  if (!match) return undefined;
  // Strip thousands separators so localized numbers like "12,345" parse fully.
  const parsed = Number.parseInt(match[1].replace(/,/g, ''), 10);
  if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  return undefined;
}

/**
 * Parse token usage from OpenCode CLI output, capturing the prompt/completion
 * breakdown in addition to the total.
 * Looks for common LLM token patterns (total_tokens, total tokens, the
 * Anthropic/Gemini input_tokens + output_tokens pair, and the OpenAI-style
 * prompt_tokens + completion_tokens pair).
 * @param output - The CLI output string to parse for token usage.
 * @returns An object with the total token count (0 if no pattern matches) and
 * optional prompt/completion token counts.
 */
export function parseTokenUsageDetailed(output: string): TokenUsageBreakdown {
  // Prioritize total_tokens patterns to avoid matching prompt_tokens or completion_tokens.
  // Use word-bounded key matches so suffixes like prompt_total_tokens are not accepted.
  const totalPatterns = [
    /\btotal_tokens\b["\s]*[:=]\s*([\d,]+)/i,
    /\btotal\s+tokens\b["\s]*[:=]\s*([\d,]+)/i,
  ];
  for (const pattern of totalPatterns) {
    const match = output.match(pattern);
    if (match) {
      const parsed = Number.parseInt(match[1].replace(/,/g, ''), 10);
      if (Number.isSafeInteger(parsed) && parsed >= 0) {
        // Prefer the OpenAI-style prompt/completion pair, but some providers
        // (e.g. proxies/OpenRouter) report total_tokens together with the
        // Anthropic/Gemini input/output pair. Fall back to that pair so the
        // breakdown is not silently dropped for cost estimation.
        let promptTokens = extractSingleToken(output, /\bprompt_tokens\b["\s]*[:=]\s*([\d,]+)/i);
        if (promptTokens === undefined) {
          promptTokens = extractSingleToken(output, /\binput_tokens\b["\s]*[:=]\s*([\d,]+)/i);
        }
        let completionTokens = extractSingleToken(
          output,
          /\bcompletion_tokens\b["\s]*[:=]\s*([\d,]+)/i,
        );
        if (completionTokens === undefined) {
          completionTokens = extractSingleToken(output, /\boutput_tokens\b["\s]*[:=]\s*([\d,]+)/i);
        }
        return { totalTokens: parsed, promptTokens, completionTokens };
      }
    }
  }
  // Fallback 1: sum input_tokens + output_tokens (used by Anthropic, Gemini)
  const inputTokens = extractSingleToken(output, /\binput_tokens\b["\s]*[:=]\s*([\d,]+)/i);
  const outputTokens = extractSingleToken(output, /\boutput_tokens\b["\s]*[:=]\s*([\d,]+)/i);
  if (inputTokens !== undefined || outputTokens !== undefined) {
    return {
      totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
      promptTokens: inputTokens,
      completionTokens: outputTokens,
    };
  }
  // Fallback 2: sum prompt_tokens + completion_tokens (OpenAI-style JSON that
  // omits total_tokens). Without this, such usage blocks would be lost entirely.
  const promptTokens = extractSingleToken(output, /\bprompt_tokens\b["\s]*[:=]\s*([\d,]+)/i);
  const completionTokens = extractSingleToken(
    output,
    /\bcompletion_tokens\b["\s]*[:=]\s*([\d,]+)/i,
  );
  if (promptTokens !== undefined || completionTokens !== undefined) {
    return {
      totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0),
      promptTokens,
      completionTokens,
    };
  }
  return { totalTokens: 0 };
}

/**
 * Parse token usage from OpenCode CLI output.
 * Looks for common LLM token patterns. Returns 0 if no pattern matches.
 * @param output - The CLI output string to parse for token usage.
 * @returns The number of tokens used, or 0 if no pattern matches.
 */
export function parseTokenUsage(output: string): number {
  return parseTokenUsageDetailed(output).totalTokens;
}

export {
  KNOWN_PROVIDERS,
  MODEL_STRING_REGEX,
  validateModelString,
} from './utils/model-string.js';

/**
 * Execute the OpenCode CLI with a given prompt.
 * Spawns the binary with a sandboxed environment (only whitelisted env vars are forwarded)
 * and enforces a timeout via SIGTERM/SIGKILL.
 *
 * @param prompt - The prompt text to pass to OpenCode.
 * @param options - Execution options for the OpenCode process.
 * @param options.model - Model identifier (e.g. "openai/gpt-4", "anthropic/claude-sonnet-4").
 * @param options.workingDirectory - Working directory for the subprocess (default: cwd).
 * @param options.timeoutMinutes - Max runtime before forced termination (default: 20).
 * @param options.signal - Optional AbortSignal to cancel the OpenCode process externally.
 * @param options.env - Additional environment variables to forward.
 * @param options.quiet - When true, suppress forwarding the process transcript to
 * stdout/stderr (output is still captured for parsing/returning).
 * @param options.opencodeConfig - Custom OpenCode config JSON injected as
 * OPENCODE_CONFIG_CONTENT. When set, replaces the CI config for this run.
 * @param options.autoApprove - When true (default), pass `--auto` to auto-approve
 * tool permissions. Set to false for interactive local use.
 * @returns Object indicating success, output text, wall-clock duration in ms, and tokens used.
 */
export async function runOpenCode(
  prompt: string,
  options: {
    model: string;
    workingDirectory?: string;
    /** Timeout in minutes before killing OpenCode. Default: 10. */
    timeoutMinutes?: number;
    /** Optional AbortSignal to cancel the OpenCode process externally. */
    signal?: AbortSignal;
    env?: Record<string, string>;
    /** When true, do not stream the transcript to the CI logs. */
    quiet?: boolean;
    /** Custom OpenCode config JSON to inject as OPENCODE_CONFIG_CONTENT. */
    opencodeConfig?: string;
    /** Pass `--auto` to auto-approve tool permissions (default: true). */
    autoApprove?: boolean;
  },
): Promise<{
  success: boolean;
  output: string;
  durationMs: number;
  tokensUsed: number;
  promptTokens?: number;
  completionTokens?: number;
}> {
  validateModelString(options.model);
  // Normalize whitespace-padded model values before they reach the CLI.
  const model = options.model.trim();
  const binaryPath = opencodePath || (await setupOpenCode());
  // setupOpenCode() already validates (and throws on) an incompatible binary in
  // the same call, so only probe again when the binary was pre-set without
  // validation (e.g. a PATH binary resolved by resolveOpenCodePath, or an
  // externally pre-set opencodePath in a long-lived process). This avoids a
  // redundant `opencode --version` spawn on the fresh-setup hot path.
  if (binaryPath !== validatedOpenCodePath) {
    const health = await checkHealth({ binPath: binaryPath });
    if (!health.compatible) {
      throw new Error(health.message);
    }
  }
  const startTime = Date.now();
  const cwd = options.workingDirectory || process.cwd();
  if (!fs.existsSync(cwd)) {
    fs.mkdirSync(cwd, { recursive: true });
  }
  const timeoutMs = (options.timeoutMinutes ?? 20) * 60 * 1000;

  // --auto  → auto-approves any permission that is not explicitly "deny".
  //           This is the documented CI mechanism for opencode run.
  //           Docs: https://opencode.ai/docs/permissions#auto-mode
  // The local CLI disables auto-approval so interactive permission prompts work.
  const autoApprove = options.autoApprove ?? runModeOverride?.autoApprove ?? true;
  const args = ['run'];
  if (autoApprove) {
    args.push('--auto');
  }
  args.push('--model', model, prompt);

  core.info(`Running OpenCode (model: ${model}, timeout: ${options.timeoutMinutes ?? 20}m)...`);

  // Forward configured API keys to OpenCode process environment.
  const githubToken = process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN || '';
  const openaiApiKey = process.env.OPENAI_API_KEY || process.env.INPUT_OPENAI_API_KEY || '';
  const anthropicApiKey =
    process.env.ANTHROPIC_API_KEY || process.env.INPUT_ANTHROPIC_API_KEY || '';
  const geminiApiKey = process.env.GEMINI_API_KEY || process.env.INPUT_GEMINI_API_KEY || '';
  const opencodeApiKey = process.env.OPENCODE_API_KEY || process.env.INPUT_OPENCODE_API_KEY || '';

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
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
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
  if (opencodeApiKey) safeEnv.OPENCODE_API_KEY = opencodeApiKey;
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      if (value !== undefined && key !== 'OPENCODE_CONFIG_CONTENT') {
        safeEnv[key] = value;
      }
    }
  }
  safeEnv.OPENCODE_CONFIG_CONTENT =
    options.opencodeConfig ?? runModeOverride?.opencodeConfig ?? buildCIConfig();
  safeEnv.OPENCODE_DISABLE_AUTOUPDATE = 'true';

  const childProcess = cp.spawn(binaryPath, args, {
    cwd,
    // Forward the caller's stdin when interactive (autoApprove off) so the
    // user can approve tool permissions at the prompt. CI auto-approve runs
    // keep stdin ignored, exactly as before.
    stdio: autoApprove ? ['ignore', 'pipe', 'pipe'] : ['inherit', 'pipe', 'pipe'],
    env: safeEnv,
    detached: true,
  });

  // Cap retained output to prevent memory exhaustion on verbose or stuck runs.
  // We keep only the last 50 KB which is sufficient for token parsing while
  // still forwarding all output to CI logs.
  const MAX_CAPTURED_BYTES = 50 * 1024;
  let capturedOutput = '';
  let tokenUsageResult = 0;
  let promptTokensResult = 0;
  let completionTokensResult = 0;

  function appendCaptured(text: string): void {
    capturedOutput += text;
    if (capturedOutput.length > MAX_CAPTURED_BYTES) {
      capturedOutput = capturedOutput.slice(-MAX_CAPTURED_BYTES);
    }
    const parsed = parseTokenUsageDetailed(text);
    if (parsed.totalTokens > 0) {
      tokenUsageResult = parsed.totalTokens;
    }
    if (parsed.promptTokens !== undefined && parsed.promptTokens > 0) {
      promptTokensResult = parsed.promptTokens;
    }
    if (parsed.completionTokens !== undefined && parsed.completionTokens > 0) {
      completionTokensResult = parsed.completionTokens;
    }
  }

  let timedOut = false;
  let childExited = false;
  let forceKillHandle: ReturnType<typeof setTimeout> | undefined;

  function killProcessGroup(signal: 'SIGTERM' | 'SIGKILL'): void {
    if (!childProcess.pid) return;
    try {
      if (os.platform() === 'win32') {
        cp.execFileSync('taskkill', ['/PID', String(childProcess.pid), '/T', '/F'], {
          stdio: 'ignore',
        });
      } else {
        process.kill(-childProcess.pid, signal);
      }
    } catch (err) {
      core.debug(`Failed to send ${signal} to process group: ${err}`);
    }
  }

  // Listen for external abort signal (e.g. from EventBus subscriber timeout)
  if (options.signal) {
    options.signal.addEventListener(
      'abort',
      () => {
        if (!childExited) {
          killProcessGroup('SIGTERM');
        }
      },
      { once: true },
    );
  }

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    core.warning(
      `OpenCode timeout of ${options.timeoutMinutes ?? 20}m exceeded — sending SIGTERM.`,
    );
    killProcessGroup('SIGTERM');
    // If SIGTERM is ignored or too slow, force-kill after 5 seconds
    forceKillHandle = setTimeout(() => {
      if (!childExited) {
        core.warning('OpenCode did not exit after SIGTERM — sending SIGKILL.');
        killProcessGroup('SIGKILL');
      }
    }, 5_000);
  }, timeoutMs);

  childProcess.stdout?.on('data', (data: Buffer) => {
    const text = data.toString();
    appendCaptured(text);
    if (!options.quiet) {
      try {
        process.stdout.write(data);
      } catch {
        // Stream closed
      }
    }
  });
  childProcess.stderr?.on('data', (data: Buffer) => {
    const text = data.toString();
    appendCaptured(text);
    if (!options.quiet) {
      try {
        process.stderr.write(data);
      } catch {
        // Stream closed
      }
    }
  });

  let exitCode: number | null = null;
  let processError: string | undefined;

  try {
    await new Promise<void>((resolve) => {
      childProcess.on('close', (code) => {
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
    const finalBreakdown = resolveTokenBreakdown(
      capturedOutput,
      tokenUsageResult,
      promptTokensResult,
      completionTokensResult,
    );

    if (exitCode === 0 && !processError) {
      core.info(`OpenCode finished in ${(durationMs / 1000).toFixed(1)}s`);
      return {
        success: true,
        output: capturedOutput,
        durationMs,
        tokensUsed: finalBreakdown.tokensUsed,
        promptTokens: finalBreakdown.promptTokens,
        completionTokens: finalBreakdown.completionTokens,
      };
    }

    core.warning(
      `OpenCode did not complete successfully (timedOut: ${timedOut}, exitCode: ${exitCode}, error: ${processError ?? 'none'})`,
    );
    return {
      success: false,
      output: capturedOutput,
      durationMs,
      tokensUsed: finalBreakdown.tokensUsed,
      promptTokens: finalBreakdown.promptTokens,
      completionTokens: finalBreakdown.completionTokens,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const finalBreakdown = resolveTokenBreakdown(
      capturedOutput,
      tokenUsageResult,
      promptTokensResult,
      completionTokensResult,
    );
    core.error(`OpenCode execution failed: ${String(err)}`);
    return {
      success: false,
      output: capturedOutput,
      durationMs,
      tokensUsed: finalBreakdown.tokensUsed,
      promptTokens: finalBreakdown.promptTokens,
      completionTokens: finalBreakdown.completionTokens,
    };
  } finally {
    clearTimeout(timeoutHandle);
    if (forceKillHandle !== undefined) {
      clearTimeout(forceKillHandle);
    }
  }
}

/**
 * Compute the final token breakdown, preferring a full parse of the retained
 * output and falling back to the incremental per-chunk totals.
 * @param capturedOutput - The retained CLI output string.
 * @param incrementalTotal - Total token count accumulated from chunk parsing.
 * @param incrementalPrompt - Prompt token count accumulated from chunk parsing.
 * @param incrementalCompletion - Completion token count accumulated from chunk parsing.
 * @returns The merged token breakdown.
 */
function resolveTokenBreakdown(
  capturedOutput: string,
  incrementalTotal: number,
  incrementalPrompt: number,
  incrementalCompletion: number,
): {
  tokensUsed: number;
  promptTokens?: number;
  completionTokens?: number;
} {
  const parsed = parseTokenUsageDetailed(capturedOutput);
  return {
    tokensUsed: parsed.totalTokens || incrementalTotal,
    promptTokens: parsed.promptTokens ?? (incrementalPrompt || undefined),
    completionTokens: parsed.completionTokens ?? (incrementalCompletion || undefined),
  };
}

/**
 * Configure git user name, email, and authentication for the CI environment.
 * Strips any existing http.extraheader entries to avoid duplicate auth headers,
 * and sets up GIT_ASKPASS for token-based authentication without leaking
 * credentials into git config.
 *
 * When `cwd` is provided (app tempDir context), env vars are returned instead of
 * setting global process.env, avoiding cross-contamination between concurrent
 * webhook events. The caller should pass the returned env to execFileSync.
 *
 * @param userName - Git user name (defaults to GITHUB_ACTOR or "opencode-ai-reviewer[bot]").
 * @param userEmail - Git user email (defaults to user name @ users.noreply.github.com).
 * @param token - GitHub token for authentication via GIT_ASKPASS.
 * @param cwd - Optional working directory. When set, env vars are returned (not set globally).
 * @returns Process env vars when cwd is provided; empty object otherwise.
 */
export function configureGit(
  userName?: string,
  userEmail?: string,
  token?: string,
  cwd?: string,
): Record<string, string> {
  const name = userName || process.env.GITHUB_ACTOR || 'opencode-ai-reviewer[bot]';
  const email = userEmail || `${name}@users.noreply.github.com`;

  const execOptions: cp.ExecFileSyncOptions = cwd ? { cwd } : {};

  try {
    cp.execFileSync('git', ['config', '--local', 'user.name', name], execOptions);
    cp.execFileSync('git', ['config', '--local', 'user.email', email], execOptions);

    if (cwd) {
      // Isolation mode: return env vars for the caller to pass explicitly,
      // avoiding global process.env mutation that would conflict between
      // concurrent webhook events.
      if (token) {
        const askPassPath = path.join(cwd, '.git-askpass.sh');
        fs.writeFileSync(
          askPassPath,
          [
            '#!/bin/sh',
            'case "$1" in',
            '  *Username*) echo "x-access-token" ;;',
            '  *Password*) echo "${OPENCODE_CREDENTIAL_TOKEN}" ;;',
            'esac',
          ].join('\n'),
          { encoding: 'utf-8', mode: 0o700, flag: 'w' },
        );
        const gitEnv: Record<string, string> = {
          GIT_ASKPASS: askPassPath,
          OPENCODE_CREDENTIAL_TOKEN: token,
          GIT_AUTHOR_NAME: name,
          GIT_AUTHOR_EMAIL: email,
          GIT_COMMITTER_NAME: name,
          GIT_COMMITTER_EMAIL: email,
        };
        core.info(`Git configured (isolated): ${name} <${email}>`);
        return gitEnv;
      }
      core.info(`Git configured (isolated): ${name} <${email}>`);
      return {
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
      };
    }

    // Legacy global mode (action package, no cwd)
    process.env.GIT_AUTHOR_NAME = name;
    process.env.GIT_AUTHOR_EMAIL = email;
    process.env.GIT_COMMITTER_NAME = name;
    process.env.GIT_COMMITTER_EMAIL = email;

    if (token) {
      // Remove ALL http.extraheader entries from every git config file
      // (including those from actions/checkout@v6+ stored via includeIf).
      // Without this, git sends duplicate Authorization headers on push.
      let origins = '';
      try {
        origins = cp.execFileSync('git', ['config', '--list', '--show-origin'], {
          ...execOptions,
          encoding: 'utf-8',
        });
      } catch {
        /* git config --list failed entirely */
      }
      const cwdForCheck = cwd || process.cwd();
      for (const line of origins.split('\n')) {
        if (!line.includes('http.') || !line.includes('.extraheader')) continue;
        const tabIdx = line.indexOf('\t');
        if (tabIdx <= 0) continue;
        const prefix = line.substring(0, tabIdx);
        if (!prefix.startsWith('file:')) continue;
        const cfg = prefix.substring(5);
        let resolvedCfg: string;
        try {
          resolvedCfg = fs.realpathSync(cfg);
        } catch {
          resolvedCfg = path.resolve(cfg);
        }
        // Only modify config files in trusted locations
        const relHome = path.relative(os.homedir(), resolvedCfg);
        const relCwd = path.relative(cwdForCheck, resolvedCfg);
        if (relHome.startsWith('..') && relCwd.startsWith('..')) {
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
        cp.execFileSync(
          'git',
          ['config', '--local', '--unset-all', 'credential.https://github.com/.helper'],
          execOptions,
        );
      } catch {
        /* no previous helper to clear */
      }
      const askPassDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-askpass-'));
      askPassDirs.push(askPassDir);
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
        { encoding: 'utf-8', mode: 0o700 },
      );
      process.env.GIT_ASKPASS = askPassPath;
      process.env.OPENCODE_CREDENTIAL_TOKEN = token;
    }
  } catch (err) {
    core.warning(`configureGit failed: ${String(err)}`);
    return {};
  }

  core.info(`Git configured: ${name} <${email}>`);
  return {};
}

/**
 * Get the current git working-tree status as a porcelain string.
 *
 * @param cwd - Optional working directory to run git status in.
 * @returns Porcelain git status output, or empty string if git is not available.
 */
export function getGitStatus(cwd?: string): string {
  try {
    return cp.execFileSync('git', ['status', '--porcelain'], {
      encoding: 'utf-8',
      ...(cwd ? { cwd } : {}),
    });
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
