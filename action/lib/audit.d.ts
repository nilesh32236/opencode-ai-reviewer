import type { AgentConfig, GitHubHelper, ReviewEngine } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs';
export declare function runAudit(inputs: ActionInputs, config: AgentConfig, engine: ReviewEngine, gh: GitHubHelper, repo: string, token: string): Promise<void>;
