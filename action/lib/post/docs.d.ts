import type { AgentConfig, PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
/**
 * Run documentation generation on a PR: resolve the PR, gather context, run the
 * docs engine to add documentation comments to changed code, and push the
 * generated docs directly onto the PR's head branch (mirrors the Action's fix
 * mode behavior).
 *
 * Honors `config.docs.enabled` and returns early without touching the PR when
 * docs generation is disabled. Platform reads (`isMR`, `getMR`, `gatherContext`)
 * are retried on transient failures. Git publishing failures are rethrown so
 * the action fails loudly, and `changes_made` is only reported true after the
 * push actually reaches the PR.
 *
 * @param inputs - Parsed action inputs.
 * @param config - Full agent configuration.
 * @param engine - Review engine instance.
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 * @returns A promise that resolves once docs generation and (on success) the
 * push to the PR head branch complete. When the PR number cannot be resolved,
 * the target is not a pull request, or docs are disabled, the function reports
 * failure/skip via `core` and returns early instead of rejecting. Rejects only
 * when platform reads fail after retries or the git commit/push fails.
 */
export declare function runDocs(inputs: ActionInputs, config: AgentConfig, engine: ReviewEngine, gh: PlatformAdapter): Promise<void>;
