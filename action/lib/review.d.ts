import type { AgentConfig, PlatformAdapter, ReviewEngine } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
/**
 * Execute a code review on a pull request and post results.
 * Determines the PR number from input or event context, fetches the PR,
 * checks skip-labels/actors, runs the review engine, and posts
 * the review to GitHub.
 * @param inputs - Parsed action inputs.
 * @param config - Full agent configuration.
 * @param engine - Review engine instance.
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 * @param repo - Repository string (owner/repo).
 */
export declare function runReview(inputs: ActionInputs, config: AgentConfig, engine: ReviewEngine, gh: PlatformAdapter, repo: string): Promise<void>;
/**
 * Secret-specific predicate for the `secrets.failCI` gate: a finding only
 * counts when its message carries the hardcoded-secret prefix. The structured
 * `category === 'security' && severity === 'critical'` check (set by
 * mergeSecretFindings) is required alongside the prefix so the gate gains the
 * structured signal without firing on unrelated critical security findings
 * (SQLi, XSS, auth bypass); the bare-prefix clause keeps findings produced by
 * older lib versions (without structured fields) covered.
 * @param issue - A review finding with optional structured fields and a message.
 * @returns True when the finding is a hardcoded-secret finding.
 */
export declare function isHardcodedSecretFinding(issue: {
    category?: string;
    severity?: string;
    message: string;
}): boolean;
