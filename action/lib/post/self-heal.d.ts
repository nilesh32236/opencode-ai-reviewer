import type { AgentConfig, PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
/**
 * Run the self-heal workflow: diagnose a CI failure, apply a fix,
 * verify it, and open a PR on a heal branch.
 *
 * Implements a "Detect → Diagnose → Fix → Verify → Learn" loop:
 * 1. Reads CI failure logs from inputs or a file (via CI_FAILURE_LOGS_FILE env var)
 * 2. Runs the engine's runSelfHeal() to diagnose and apply a fix
 * 3. Runs verification (build, typecheck, test, lint) with retry loop
 * 4. Creates a branch and PR with the fix
 *
 * @param inputs - Parsed action inputs (includes ciFailureLogs, failedStep, failedWorkflow).
 * @param config - Full agent configuration.
 * @param engine - Review engine instance.
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 * @param _repo - Repository string (owner/repo).
 * @param _token - GitHub authentication token.
 */
export declare function runSelfHeal(inputs: ActionInputs, config: AgentConfig, engine: ReviewEngine, gh: PlatformAdapter, _repo: string, _token: string): Promise<void>;
