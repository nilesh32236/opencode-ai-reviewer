import type { GitHubHelper } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs';
export declare function runPost(inputs: ActionInputs, gh: GitHubHelper, repo: string, token: string): Promise<void>;
