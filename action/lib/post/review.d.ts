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
 * counts when its message carries the hardcoded-secret prefix (emitted by
 * mergeSecretFindings). Structured `category`/`severity` fields are
 * intentionally not required here so findings produced by older lib versions
 * (without structured fields) stay covered and the gate never fires on
 * unrelated critical security findings (SQLi, XSS, auth bypass).
 * @param issue - A review finding with optional structured fields and a message.
 * @param issue.category - Optional finding category (e.g. `security`).
 * @param issue.severity - Optional finding severity (e.g. `critical`).
 * @param issue.message - The finding message; secret findings start with `Hardcoded`.
 * @returns True when the finding is a hardcoded-secret finding.
 */
export declare function isHardcodedSecretFinding(issue: {
    category?: string;
    severity?: string;
    message: string;
}): boolean;
