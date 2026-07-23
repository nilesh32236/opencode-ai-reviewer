import type { AgentConfig, GitHubHelper, ReviewEngine } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
/**
 * Execute an issue analysis: gather issue context, run the analysis engine,
 * and post the implementation plan as a comment on the issue.
 * @param inputs - Parsed action inputs.
 * @param config - Full agent configuration.
 * @param engine - Review engine instance.
 * @param gh - GitHub API helper.
 * @param repo - Repository string (owner/repo).
 * @param token - GitHub authentication token.
 */
export declare function runAnalyze(_inputs: ActionInputs, _config: AgentConfig, engine: ReviewEngine, gh: GitHubHelper, _repo: string, _token: string): Promise<void>;
