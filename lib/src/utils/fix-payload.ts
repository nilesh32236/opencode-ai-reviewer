import type { ReviewIssue } from '../types/index.js';
import { looksLikeCode } from './code-heuristic.js';
import { escapeInlineCode, sanitizeMarkdown } from './markdown.js';
import { buildSafetyHoldComment, evaluateFixSafety, isDestructiveFix } from './safe-exec.js';

/**
 * Machine-readable fix payload for one-click Fix-with-AI / coding-agent handoff.
 * Pure template-only construction: no I/O, no network calls, no extra data sent.
 */
export interface FixPayload {
  /** Copy-pasteable Fix-with-AI prompt (template-only, privacy-safe). */
  prompt: string;
  /** Replacement code for a ```suggestion block, when the finding carries code-like content. */
  suggestedChange?: string;
  /** Files touched by the fix (single entry today). */
  files: string[];
}

/**
 * Heuristic to determine if a suggestion string looks like code rather than prose.
 * Canonical implementation lives in `./code-heuristic.js`; this is a
 * backward-compatible alias so existing callers keep working.
 * @param suggestion - The suggestion string to evaluate.
 * @returns True when the suggestion is code-like enough for a suggestion block.
 */
export function isCodeLikeSuggestion(suggestion: string): boolean {
  return looksLikeCode(suggestion);
}

/**
 * Build a template-only Fix-with-AI prompt for a finding. Never performs an API
 * call, so a missing AI key simply yields the template prompt with no error.
 * @param issue - The finding to build a fix prompt for.
 * @returns A copy-pasteable prompt string for coding-agent handoff.
 */
export function buildFixWithAiPrompt(issue: ReviewIssue): string {
  const location = `${issue.file}:${issue.line}`;
  const hint = issue.suggestion?.trim() ? `\nSuggested direction: ${issue.suggestion.trim()}` : '';
  const code = issue.suggestionCode?.trim()
    ? `\nProposed replacement:\n${issue.suggestionCode.trim()}`
    : '';
  return (
    `Fix the ${issue.severity} finding at ${location}: ${issue.message}${hint}${code}\n` +
    `Keep the change minimal, preserve surrounding style, and do not introduce new APIs.`
  );
}

/**
 * Build a one-click Fix-with-AI payload for a finding. Fail-open: never throws
 * for malformed input — returns a prompt-only payload instead.
 * @param issue - The finding to convert into a fix payload.
 * @returns The fix payload with prompt, optional suggestedChange, and files.
 */
export function buildFixPayload(issue: ReviewIssue): FixPayload {
  try {
    const files = [issue.file];
    const trimmedCode = issue.suggestionCode?.trim();
    if (trimmedCode) {
      return { prompt: buildFixWithAiPrompt(issue), suggestedChange: trimmedCode, files };
    }
    const trimmedSuggestion = issue.suggestion?.trim();
    if (trimmedSuggestion && isCodeLikeSuggestion(trimmedSuggestion)) {
      return { prompt: buildFixWithAiPrompt(issue), suggestedChange: trimmedSuggestion, files };
    }
    return { prompt: buildFixWithAiPrompt(issue), files };
  } catch {
    // Fail-open: callers must always get a usable prompt-only payload.
    try {
      return { prompt: buildFixWithAiPrompt(issue), files: [issue.file] };
    } catch {
      return { prompt: 'Fix the reported finding with a minimal change.', files: [] };
    }
  }
}

/**
 * Render a fix payload as markdown: a 'suggestion' fenced block (when the
 * payload carries code-like `suggestedChange`) plus a collapsible Fix-with-AI
 * prompt for coding-agent handoff. All interpolated model text is sanitized
 * except the raw code inside the fenced block. Fail-open: returns '' on any error.
 * @param payload - The payload built by {@link buildFixPayload}.
 * @param anchor - Optional `file:line` anchor rendered into the `<summary>`
 * landmark so screen readers can distinguish repeated disclosures. Defaults
 * to the payload's first file when available.
 * @returns Markdown string, or '' when nothing renderable / on error.
 */
export function formatFixPayloadMarkdown(payload: FixPayload, anchor?: string): string {
  try {
    const lines: string[] = [];
    if (payload.suggestedChange?.trim()) {
      // Neutralize inner fences so model-generated code containing ``` cannot
      // break out of the fenced block and inject markdown/HTML.
      const safe = payload.suggestedChange.trim().replace(/```/g, '``\u200b`');
      lines.push('```suggestion');
      lines.push(safe);
      lines.push('```');
    }
    if (payload.prompt?.trim()) {
      if (lines.length > 0) lines.push('');
      const rawAnchor = anchor ?? payload.files[0] ?? '';
      const summary = rawAnchor
        ? `Fix with AI for <code>${escapeInlineCode(rawAnchor)}</code>`
        : 'Fix with AI';
      lines.push(`<details><summary>${summary}</summary>`);
      lines.push('');
      lines.push(sanitizeMarkdown(payload.prompt.trim()));
      lines.push('');
      lines.push('</details>');
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * Collect the scannable fix text for one finding (message + suggestion +
 * suggestion code). Used by the safety ceiling so destructive payloads are
 * held before they are proposed or applied.
 * @param issue - The finding to collect fix text for.
 * @returns Combined fix text (may be empty for text-only findings).
 */
export function collectFixText(issue: ReviewIssue): string {
  try {
    if (!issue || typeof issue !== 'object') return '';
    return [issue.message ?? '', issue.suggestion ?? '', issue.suggestionCode ?? '']
      .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
      .join('\n');
  } catch {
    return '';
  }
}

/**
 * Check whether a finding's fix payload is destructive under the safety
 * ceiling. Pure local pattern match — no model call. Fail-open: missing or
 * malformed input returns false (treated as safe).
 * @param issue - The finding to classify.
 * @param allowlist - Optional `autofixSafety.destructiveAllowlist` entries.
 * @returns True when the payload matches a destructive pattern without cover.
 */
export function fixPayloadNeedsApproval(
  issue: ReviewIssue,
  allowlist?: readonly string[] | unknown,
): boolean {
  try {
    return isDestructiveFix(collectFixText(issue), allowlist);
  } catch {
    return false;
  }
}

/**
 * Build the manual-approval guidance posted when a fix payload is held.
 * Fail-open: never throws — returns a generic hold note on error.
 * @param issue - The held finding (for file context).
 * @param allowlist - Optional allowlist entries used in the evaluation.
 * @returns Markdown guidance comment body.
 */
export function buildFixApprovalPrompt(
  issue: ReviewIssue,
  allowlist?: readonly string[] | unknown,
): string {
  try {
    const verdict = evaluateFixSafety(collectFixText(issue), {
      destructiveAllowlist: allowlist,
      requireManualApproval: true,
    });
    const files = issue && typeof issue.file === 'string' ? [issue.file] : [];
    return buildSafetyHoldComment(verdict, files);
  } catch {
    return (
      '⚠️ Autofix held for manual approval.\n\n' +
      'Add an `autofix:approved` label or comment `/approve-fix` to proceed.'
    );
  }
}
