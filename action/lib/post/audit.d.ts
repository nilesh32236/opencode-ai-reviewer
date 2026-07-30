import type { AgentConfig, PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
/**
 * Execute a codebase audit: select a random (or named) audit prompt,
 * run the audit engine on a target directory, optionally create a
 * GitHub issue with the findings, and add severity labels.
 * @param inputs - Parsed action inputs.
 * @param config - Full agent configuration.
 * @param engine - Review engine instance.
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 */
export declare function runAudit(inputs: ActionInputs, config: AgentConfig, engine: ReviewEngine, gh: PlatformAdapter): Promise<void>;
