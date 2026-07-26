import type { AgentConfig, GitHubHelper, ReviewEngine } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
/**
 * Execute an issue analysis: gather issue context, run the analysis engine,
 * parse blocking questions, apply appropriate labels, and post the plan.
 * @param _inputs - Parsed action inputs (unused, retained for interface compatibility).
 * @param _config - Full agent configuration (unused, retained for interface compatibility).
 * @param engine - Review engine instance.
 * @param gh - GitHub API helper.
 * @param _repo - Repository string (owner/repo, unused).
 * @param _token - GitHub authentication token (unused).
 */
export declare function runAnalyze(_inputs: ActionInputs, _config: AgentConfig, engine: ReviewEngine, gh: GitHubHelper, _repo: string, _token: string): Promise<void>;
