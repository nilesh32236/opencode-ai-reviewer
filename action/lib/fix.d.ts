import type { AgentConfig, GitHubHelper, ReviewEngine } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
export declare function runFix(inputs: ActionInputs, config: AgentConfig, engine: ReviewEngine, gh: GitHubHelper, _repo: string, _token: string): Promise<void>;
export declare function runFixIssue(_inputs: ActionInputs, _config: AgentConfig, engine: ReviewEngine, gh: GitHubHelper, repo: string, token: string): Promise<void>;
export declare function runAutofixLoop(inputs: ActionInputs, config: AgentConfig, engine: ReviewEngine, gh: GitHubHelper, _repo: string, _token: string): Promise<void>;
