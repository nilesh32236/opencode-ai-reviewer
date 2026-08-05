import type { AgentConfig, PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
/**
 * Run documentation generation on a PR: resolve the PR, gather context, run the
 * docs engine to add documentation comments to changed code, and push the
 * generated docs directly onto the PR's head branch (mirrors the Action's fix
 * mode behavior).
 * @param inputs - Parsed action inputs.
 * @param config - Full agent configuration.
 * @param engine - Review engine instance.
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 */
export declare function runDocs(inputs: ActionInputs, config: AgentConfig, engine: ReviewEngine, gh: PlatformAdapter): Promise<void>;
