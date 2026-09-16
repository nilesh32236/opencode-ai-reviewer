import { type AgentConfig, type PlatformAdapter, type ReviewEngine } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
/**
 * Reset the per-process audit-issue registry. Exported for tests.
 */
export declare function resetAuditIssueRegistry(): void;
/**
 * Execute a codebase audit: select a random (or named) audit prompt,
 * run the audit engine on a target directory, optionally create a
 * GitHub issue with the findings, and add severity labels.
 * @param inputs - Parsed action inputs.
 * @param config - Full agent configuration.
 * @param engine - Review engine instance.
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 * @param signal - Optional per-run AbortSignal; abort pre-checks fail visibly.
 *   Advisory-only: engine calls themselves are not yet cancellable.
 */
export declare function runAudit(inputs: ActionInputs, config: AgentConfig, engine: ReviewEngine, gh: PlatformAdapter, signal?: AbortSignal): Promise<void>;
