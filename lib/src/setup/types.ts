/**
 * Result status of a single setup validation check.
 */
export type SetupCheckStatus = 'pass' | 'fail' | 'skip';

/**
 * Result of a single setup validation check.
 */
export interface SetupCheck {
  /** Human-readable name of the check (e.g. "Secrets", "Permissions"). */
  name: string;
  /** Whether the check passed, failed, or was skipped. */
  status: SetupCheckStatus;
  /** Short actionable summary of the result. */
  message: string;
  /** Optional detailed context (e.g. error output, versions found). */
  details?: string;
  /** Wall-clock time the check took in milliseconds. */
  durationMs?: number;
}

/**
 * Aggregate result of a full setup validation run.
 */
export interface SetupResult {
  /** Individual check results, in execution order. */
  checks: SetupCheck[];
  /** Overall status: 'pass' when every check passed, 'fail' otherwise. */
  overall: 'pass' | 'fail';
  /** Unix timestamp (ms) when the run completed. */
  timestamp: number;
  /** Total wall-clock time of the run in milliseconds. */
  durationMs: number;
}

/**
 * Options for the setup validation engine.
 */
export interface SetupEngineOptions {
  /** Working directory for config loading and path validation (default: process.cwd()). */
  workingDirectory?: string;
  /** Platform identifier ('github' or 'gitlab'). Defaults to 'github'. */
  platform?: 'github' | 'gitlab';
  /** GitHub token used for the permissions probe. Defaults to GITHUB_TOKEN/INPUT_GITHUB_TOKEN. */
  githubToken?: string;
  /** Repository in owner/repo format, used for the permissions probe. */
  repo?: string;
  /** GitHub API base URL (default: https://api.github.com). */
  apiBaseUrl?: string;
  /** Models to probe for connectivity. Defaults to the configured reviewModel. */
  probeModels?: string[];
  /**
   * When true, probes every distinct configured model
   * (review, fix, audit, etc.) instead of only the review model.
   */
  probeAllModels?: boolean;
  /** Minimum acceptable OpenCode CLI version (default: '1.1.1'). */
  minimumOpenCodeVersion?: string;
  /** OpenCode CLI version to install when missing (default: 'latest'). */
  opencodeVersion?: string;
  /** Per-model connectivity probe timeout in milliseconds (default: 30000). */
  probeTimeoutMs?: number;
}
