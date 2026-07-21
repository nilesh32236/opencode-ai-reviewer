import type { AgentConfig, GitHubHelper, ReviewEngine } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
export declare function runAudit(inputs: ActionInputs, config: AgentConfig, engine: ReviewEngine, gh: GitHubHelper): Promise<void>;
