import type { PlatformAdapter } from '@opencode-pr-agent/lib';
import type { ActionInputs } from './inputs.js';
/**
 * State key written by the main fix step (`core.saveState` in fix.ts) and
 * exposed to this post process as `STATE_fix_exit_reason`. Must stay in sync
 * with `FIX_EXIT_REASON_STATE_KEY` in fix.ts (duplicated here to keep the
 * post bundle free of the fix module's engine/exec dependency chain).
 */
export declare const FIX_EXIT_REASON_STATE_KEY = "fix_exit_reason";
/**
 * True when a fix exit reason means no clean fix landed, so verification
 * would measure the agent's mutated working tree rather than the base branch
 * or PR head (issue #942). Such runs must skip `run_checks_after_fix`.
 * @param reason - Fix exit reason from `core.getState`, when any.
 * @returns True for 'no-changes' and 'git-failure' (case-insensitive).
 */
export declare function shouldSkipPostVerification(reason: string | undefined | null): boolean;
/**
 * Best-effort check for uncommitted working-tree changes. When the fix step
 * failed after editing files, the tree is dirty and verification would
 * measure those agent edits — not the base. A probe failure fails open to
 * running verification (preserving today's behavior) rather than silently
 * skipping a configured gate.
 * @returns True when `git status --porcelain` reports any output.
 */
export declare function hasUncommittedChanges(): Promise<boolean>;
/**
 * Run post-processing after a review/fix action: optionally run a
 * verification command, and post a review summary comment to the PR.
 * @param inputs - Parsed action inputs.
 * @param gh - Platform adapter (GitHubHelper or GitLabAdapter).
 * @param _repo - Repository string (owner/repo, unused).
 * @param _token - GitHub authentication token (unused).
 * @param signal - Optional per-run AbortSignal; races verification timeouts.
 *   Advisory-only: no engine calls run on this path.
 */
export declare function runPost(inputs: ActionInputs, gh: PlatformAdapter, _repo: string, _token: string, signal?: AbortSignal): Promise<void>;
/**
 * Parse a saved STATE_* metric value, returning undefined (with a warning)
 * when the value is not a finite, non-negative number instead of propagating
 * NaN/Infinity/negatives into the rendered token-usage summary. Saved STATE_*
 * values are untrusted strings, so the warning is sanitized to block log-line
 * or workflow-command injection via newlines or `::` sequences.
 * @param name - State key (for the warning message).
 * @param raw - Raw state string.
 * @returns The finite non-negative number, or undefined when invalid.
 */
export declare function parseFiniteState(name: string, raw: string): number | undefined;
