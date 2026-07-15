import type { GitHubHelper } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
export declare function runPost(inputs: ActionInputs, gh: GitHubHelper, _repo: string, _token: string): Promise<void>;
