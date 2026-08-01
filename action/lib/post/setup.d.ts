import type { AgentConfig, PlatformAdapter } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
/**
 * Run the setup validation flow: execute all pre-flight checks, emit the
 * markdown report as a step summary and action outputs, optionally post it as
 * a comment on the triggering issue, and fail the action when checks fail.
 * @param inputs - Parsed action inputs.
 * @param config - Full agent configuration.
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 * @param repo - Repository string (owner/repo).
 * @param token - GitHub authentication token.
 */
export declare function runSetup(inputs: ActionInputs, config: AgentConfig, gh: PlatformAdapter, repo: string, token: string): Promise<void>;
