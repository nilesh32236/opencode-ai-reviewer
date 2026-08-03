import {
  type ChangedFile,
  type CodeReference,
  type ConversationConfig,
  type ConversationContext,
  type ConversationMessage,
  type ConversationState,
  DEFAULT_CONVERSATION_CONFIG,
} from '../types/index.js';
import { estimateTokens } from '../utils/token-estimate.js';

/**
 * Intent detection keywords for classifying user requests.
 * Each category maps to a set of trigger words that indicate the user's intent.
 */
const FIX_KEYWORDS = [
  'fix',
  'change',
  'update',
  'refactor',
  'replace',
  'modify',
  'rewrite',
  'use',
  'switch to',
  'convert',
  'add',
  'remove',
  'delete',
  'rename',
  'move',
  'extract',
  'inline',
  'apply',
  'implement',
];

const EXPLAIN_KEYWORDS = [
  'why',
  'explain',
  'what',
  'how',
  'describe',
  'clarify',
  'elaborate',
  'meaning',
  'purpose',
  'reason',
  'understand',
  'tell me',
  'walk me through',
  'help me understand',
];

// ⚡ Bolt: Pre-compile regexes outside of detectIntent loop for better performance
const FIX_REGEXES = FIX_KEYWORDS.map((kw) => {
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i');
});

const EXPLAIN_REGEXES = EXPLAIN_KEYWORDS.map((kw) => {
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i');
});

/**
 * Detect the intent of a user's message based on keyword matching.
 *
 * @param message - The user's comment body.
 * @returns The detected intent: 'fix', 'explain', or 'general'.
 */
export function detectIntent(message: string): 'explain' | 'fix' | 'general' {
  const lower = message.toLowerCase();

  // Check fix intent first (stronger signal — user wants action)
  const hasFixKeyword = FIX_REGEXES.some(
    (regex) => regex.test(lower) && !lower.startsWith('why') && !lower.startsWith('what'),
  );
  if (hasFixKeyword) return 'fix';

  // Check explain intent
  const hasExplainKeyword = EXPLAIN_REGEXES.some((regex) => regex.test(lower));
  if (hasExplainKeyword) return 'explain';

  return 'general';
}

/**
 * Normalize a partial conversation config to a fully defaulted object.
 * @param config - Optional user-provided conversation config.
 * @returns The effective conversation config with defaults applied.
 */
export function normalizeConversationConfig(config?: ConversationConfig): ConversationConfig {
  if (!config) return DEFAULT_CONVERSATION_CONFIG;
  return {
    ...DEFAULT_CONVERSATION_CONFIG,
    ...config,
  };
}

/**
 * Regex matching `file:line` and `file:start-end` code references. Requires a
 * file-like token containing a dot extension that starts with a letter (so
 * version numbers like `1.0:5` and bare `word:10` are rejected) and a line
 * number. The path may include `/`, `.`, `@`, `-`, and `_` separators.
 */
const CODE_REF_RE = /\b([A-Za-z0-9_@./-]+\.(?:[A-Za-z]\w{0,15})):(\d+)(?:-(\d+))?/g;

/**
 * Extract `file:line` and `file:start-end` code references from a message body.
 * References inside URLs or schema prefixes (e.g. `https://…`) are skipped.
 *
 * @param body - The message body to scan.
 * @returns Array of extracted code references in the order they appear.
 */
export function extractCodeReferences(body: string): CodeReference[] {
  if (!body) return [];
  const refs: CodeReference[] = [];
  CODE_REF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CODE_REF_RE.exec(body)) !== null) {
    const file = match[1];
    // Scan back to the start of the token containing the match so URLs
    // (`https://example.com/file.ts:42`, `https://host:8080/x.ts:42`) and
    // email addresses (`alice@example.com:42`) are rejected even when the
    // match is not anchored immediately after the scheme.
    let tokenStart = match.index;
    while (tokenStart > 0 && !/[\s([<"'`,]/.test(body[tokenStart - 1])) {
      tokenStart--;
    }
    const token = body.slice(tokenStart, match.index) + file;
    if (
      /^[a-z][a-z0-9+.-]*:\/\//i.test(token) ||
      /^[a-z][a-z0-9+.-]*:/i.test(token) ||
      /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(token)
    ) {
      continue;
    }
    const line = Number.parseInt(match[2], 10);
    const endLine = match[3] ? Number.parseInt(match[3], 10) : undefined;
    refs.push({
      file,
      line,
      ...(endLine !== undefined && endLine > line ? { endLine } : {}),
    });
  }
  return refs;
}

/**
 * Resolve a set of extracted code references against the PR's changed files.
 * A reference is kept when its file path matches a changed file exactly (by
 * path) or by basename. Duplicate file references are collapsed, and only the
 * first `maxRefs` distinct files are retained to bound the injected context.
 *
 * @param refs - Raw code references extracted from a message.
 * @param changedFiles - Changed files of the PR (for validation).
 * @param maxRefs - Maximum number of distinct files to retain (default: 5).
 * @returns References that point at files present in the PR diff.
 */
export function resolveCodeReferences(
  refs: CodeReference[],
  changedFiles: ChangedFile[],
  maxRefs = 5,
): CodeReference[] {
  if (!refs || refs.length === 0) return [];
  const changed = changedFiles || [];
  const byPath = new Map(changed.map((f) => [f.path, f]));
  const byBasename = new Map<string, ChangedFile[]>();
  for (const f of changed) {
    const base = f.path.split('/').pop();
    if (!base) continue;
    const list = byBasename.get(base) ?? [];
    list.push(f);
    byBasename.set(base, list);
  }

  const resolved: CodeReference[] = [];
  const seenFiles = new Set<string>();
  for (const ref of refs) {
    if (resolved.length >= maxRefs) break;
    let target: ChangedFile | undefined = byPath.get(ref.file);
    if (!target) {
      const base = ref.file.split('/').pop();
      const candidates = base ? (byBasename.get(base) ?? []) : [];
      // Ambiguous basenames (multiple changed files sharing a name) are dropped
      // rather than guessing the wrong file.
      target = candidates.length === 1 ? candidates[0] : undefined;
    }
    if (!target) continue;
    const canonical = target.path;
    if (seenFiles.has(canonical)) continue;
    seenFiles.add(canonical);
    resolved.push({
      file: canonical,
      line: ref.line,
      ...(ref.endLine !== undefined && ref.endLine > (ref.line ?? 0)
        ? { endLine: ref.endLine }
        : {}),
    });
  }
  return resolved;
}

/** Unified diff hunk header regex: extracts the new-file start line and line count. */
const PATCH_HUNK_RE = /^@@\s+-[0-9,]+\s+\+([0-9]+)(?:,([0-9]+))?\s+@@/;

/**
 * Select the patch region that contains a referenced line range so the model
 * can answer about lines outside the triggering hunk. Returns the hunk block
 * whose new-file range covers `refLine..refEndLine`, truncated to 800
 * characters, or the first 800 characters of the patch when no hunk covers the
 * reference (mirroring the previous behavior).
 *
 * @param patch - Unified diff patch content for a changed file.
 * @param refLine - Referenced starting line (1-indexed, new file).
 * @param refEndLine - Referenced end line, when a range was given.
 * @returns The selected patch window.
 */
function selectPatchWindow(patch: string, refLine?: number, refEndLine?: number): string {
  if (!patch) return '';
  if (refLine !== undefined) {
    const lines = patch.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = PATCH_HUNK_RE.exec(lines[i]);
      if (!m) continue;
      const start = Number.parseInt(m[1], 10);
      const count = m[2] !== undefined ? Number.parseInt(m[2], 10) : 1;
      const hunkEnd = start + Math.max(count, 1) - 1;
      if (start <= refLine && (refEndLine ?? refLine) <= hunkEnd) {
        let block = lines[i];
        for (let j = i + 1; j < lines.length; j++) {
          if (/^@@\s+/.test(lines[j])) break;
          block += `\n${lines[j]}`;
        }
        return block.slice(0, 800);
      }
    }
  }
  return patch.slice(0, 800);
}

/**
 * Estimate the current 1-indexed turn number from tracked state, falling back
 * to counting assistant messages in the thread when state is unavailable.
 * @param thread - Full conversation thread.
 * @param state - Optional tracked conversation state.
 * @returns The current 1-indexed turn number.
 */
function currentTurnNumber(thread: ConversationMessage[], state?: ConversationState): number {
  const tracked = state?.turnCount ?? 0;
  if (tracked > 0) return tracked + 1;
  const assistantCount = thread.filter((m) => m.role === 'assistant').length;
  return assistantCount + 1;
}

/**
 * Build a prompt for the LLM to respond to an interactive conversation in a PR comment.
 * The prompt includes file context, diff hunks, a sliding window of recent
 * conversation messages (with a condensed summary of older context), and
 * specific output format instructions based on the detected intent.
 *
 * Long threads are managed via a sliding window: messages older than
 * `config.slidingWindowSize` are replaced by a summary snapshot (when one has
 * been produced) so the prompt stays within the configured token budget. A
 * context-usage footer reports the current turn and estimated token usage, and
 * warnings are appended when the conversation approaches its turn limit.
 *
 * The token budget is enforced: when the assembled prompt (with warnings and
 * the context footer) exceeds `contextTokenBudget`, the recent-window size is
 * halved and the prompt rebuilt until it fits or only the newest message
 * remains.
 *
 * @param context - Full conversation context including thread, file, diff, and intent.
 * @param config - Optional conversation configuration (defaults applied).
 * @param state - Optional tracked conversation state (turn count, summary snapshot).
 * @returns The formatted prompt string for the LLM.
 */
export function buildConversationPrompt(
  context: ConversationContext,
  config?: ConversationConfig,
  state?: ConversationState,
): string {
  const effectiveConfig = normalizeConversationConfig(config);
  const budget = effectiveConfig.contextTokenBudget;

  /**
   * Assemble the prompt sections for a given recent-window size.
   * @param winSize - Number of most recent messages kept in full.
   * @returns The assembled sections plus the estimated token count computed
   * after all content sections and warnings are appended.
   */
  const buildSections = (winSize: number): { sections: string[]; estimatedTokens: number } => {
    const sections: string[] = [];

    sections.push('# Interactive Code Conversation');
    sections.push('');
    sections.push(
      'You are an AI code reviewer assistant responding to a developer in a GitHub PR conversation.',
    );
    sections.push(
      'The developer has @mentioned you in a comment thread. Respond helpfully and concisely.',
    );
    sections.push('');

    // PR context
    sections.push('## PR Context');
    sections.push('');
    sections.push(`- **Title:** ${context.prContext.title}`);
    sections.push(`- **Author:** ${context.prContext.author}`);
    sections.push(`- **Base:** ${context.prContext.baseRef} ← ${context.prContext.headRef}`);
    if (context.prContext.body) {
      sections.push(`- **Description:** ${context.prContext.body.slice(0, 500)}`);
    }
    sections.push('');

    // File context (for review comments)
    if (context.filePath) {
      sections.push('## File Context');
      sections.push('');
      sections.push(`**File:** \`${context.filePath}\``);
      sections.push('');
    }

    if (context.diffHunk) {
      sections.push('### Diff Hunk');
      sections.push('');
      sections.push('```diff');
      sections.push(context.diffHunk);
      sections.push('```');
      sections.push('');
    }

    // Resolved code references from the latest message (e.g. `src/foo.ts:42`).
    // Render the referenced file(s) and, when available, the matching PR diff
    // patch so the model can answer about lines outside the triggering hunk.
    if (context.codeReferences && context.codeReferences.length > 0) {
      sections.push('## Referenced Code');
      sections.push('');
      sections.push(
        'The developer referenced the following file(s) with `file:line` syntax. Use these for context:',
      );
      sections.push('');
      const changedFiles = context.prContext.changedFiles || [];
      for (const ref of context.codeReferences) {
        const changedFile = changedFiles.find((f) => f.path === ref.file);
        const range =
          ref.endLine !== undefined ? `${ref.line}-${ref.endLine}` : `${ref.line ?? '?'}`;
        sections.push(`### \`${ref.file}:${range}\``);
        sections.push('');
        if (changedFile?.patch) {
          sections.push('```diff');
          sections.push(selectPatchWindow(changedFile.patch, ref.line, ref.endLine));
          sections.push('```');
        } else {
          sections.push(
            '_(No diff available for this file in the PR — treat it as external context.)_',
          );
        }
        sections.push('');
      }
    }

    // Sliding window: split the thread into older messages (summarized) and the
    // most recent messages kept in full.
    let olderMessages: ConversationMessage[] = [];
    let recentMessages = context.thread;
    if (context.thread.length > winSize) {
      const splitAt = context.thread.length - winSize;
      olderMessages = context.thread.slice(0, splitAt);
      recentMessages = context.thread.slice(splitAt);
    }

    // Condensed summary of earlier context, when one is available.
    const covered = state?.summarizedCount ?? 0;
    const uncoveredOlderMessages = state?.summarySnapshot ? olderMessages.slice(covered) : [];

    if (state?.summarySnapshot) {
      sections.push('## Conversation Summary');
      sections.push('');
      sections.push(
        'Summary of earlier discussion (older messages were condensed to stay within context limits):',
      );
      sections.push('');
      sections.push(state.summarySnapshot);
      sections.push('');
    }

    // Messages that rolled out of the window between summarization passes but
    // are not yet covered by the snapshot — render them so nothing is silently
    // dropped from the model's context.
    if (uncoveredOlderMessages.length > 0) {
      sections.push('## Conversation Context (recently rolled out)');
      sections.push('');
      sections.push(
        'These earlier messages have rolled out of the recent window but are not yet reflected in the summary above. Keep them in mind:',
      );
      sections.push('');
      for (const msg of uncoveredOlderMessages) {
        const roleLabel = msg.role === 'user' ? `👤 ${msg.author || 'Developer'}` : '🤖 Assistant';
        sections.push(`### ${roleLabel}`);
        sections.push('');
        sections.push(msg.body);
        sections.push('');
      }
    }

    // Conversation thread (recent messages only)
    sections.push('## Conversation Thread');
    sections.push('');
    if (olderMessages.length > 0 && !state?.summarySnapshot) {
      sections.push(
        `> Note: ${olderMessages.length} earlier message(s) have been omitted to stay within context limits and will be summarized on the next turn.`,
      );
      sections.push('');
    }
    for (const msg of recentMessages) {
      const roleLabel = msg.role === 'user' ? `👤 ${msg.author || 'Developer'}` : '🤖 Assistant';
      sections.push(`### ${roleLabel}`);
      sections.push('');
      sections.push(msg.body);
      sections.push('');
    }

    // Intent-specific instructions
    sections.push('## Response Instructions');
    sections.push('');

    switch (context.intent) {
      case 'fix':
        sections.push('The developer is requesting a **code change**. You should:');
        sections.push('');
        sections.push('1. Understand exactly what change they want.');
        sections.push(
          '2. Provide the fix as a GitHub suggestion block so they can commit it directly:',
        );
        sections.push('');
        sections.push('~~~markdown');
        sections.push('```suggestion');
        sections.push('// replacement code here');
        sections.push('```');
        sections.push('~~~');
        sections.push('');
        sections.push(
          '3. Briefly explain what the change does and why it addresses their request.',
        );
        sections.push(
          '4. If the fix requires changes across multiple files, explain the full scope and provide the suggestion for the current file only.',
        );
        break;

      case 'explain':
        sections.push('The developer is asking for an **explanation**. You should:');
        sections.push('');
        sections.push('1. Provide a clear, concise explanation.');
        sections.push(
          '2. Reference specific lines from the diff when relevant, using `L{number}` notation.',
        );
        sections.push('3. If relevant, explain the broader architectural context.');
        sections.push(
          '4. Keep your response focused and avoid unnecessary boilerplate or disclaimers.',
        );
        break;

      case 'general':
        sections.push('The developer has a **general question or request**. You should:');
        sections.push('');
        sections.push('1. Answer their question directly and concisely.');
        sections.push('2. If code changes would help, provide them as suggestion blocks.');
        sections.push('3. Reference the PR diff and file context when relevant.');
        break;
    }

    sections.push('');
    sections.push('## Output Format');
    sections.push('');
    sections.push('Write your response message directly to `.opencode/conversation-output.txt`.');
    sections.push('Do NOT wrap your response in JSON or any other structure.');
    sections.push('Do NOT include greeting lines like "Hi!" or sign-off lines.');
    sections.push('Be direct, technical, and helpful.');

    // Warnings are decided against the pre-warning estimate so the token-budget
    // warning reflects the content above, then the estimate is recomputed after
    // warnings are appended so the reported usage matches the real prompt size.
    const turnNumber = currentTurnNumber(context.thread, state);
    const maxTurns = effectiveConfig.maxTurns;
    const preliminaryEstimate = estimateTokens(sections.join('\n'));

    const warnings: string[] = [];
    if (maxTurns > 0 && turnNumber > 0.8 * maxTurns) {
      warnings.push(
        `This conversation is approaching its ${maxTurns}-turn limit (turn ${turnNumber}). The next few turns will be the last; please wrap up or start a new thread.`,
      );
    }
    if (preliminaryEstimate > 0.9 * budget) {
      warnings.push(
        `The conversation context is approaching its token budget (~${budget.toLocaleString()} tokens). Older context may be condensed further to stay within limits.`,
      );
    }

    if (warnings.length > 0) {
      sections.push('');
      sections.push('## ⚠️ Warnings');
      sections.push('');
      for (const warning of warnings) {
        sections.push(`- ${warning}`);
      }
      sections.push('');
    }

    // Estimated usage is computed after all content sections and warnings are
    // appended so the reported number is not an undercount.
    const estimatedTokens = estimateTokens(sections.join('\n'));

    sections.push('## Context Usage');
    sections.push('');
    sections.push(
      `- Turn: ${Math.min(turnNumber, maxTurns > 0 ? maxTurns : turnNumber)}/${maxTurns > 0 ? maxTurns : '∞'}`,
    );
    sections.push(
      `- Context: ~${estimatedTokens.toLocaleString()} / ${budget.toLocaleString()} tokens (~${Math.round((estimatedTokens / budget) * 100)}%)`,
    );

    return { sections, estimatedTokens };
  };

  // Enforce the token budget: shrink the recent-window size until the fully
  // assembled prompt fits within the budget (or only the newest message fits).
  let windowSize = effectiveConfig.slidingWindowSize;
  let built = buildSections(windowSize);
  while (built.estimatedTokens > budget && windowSize > 1) {
    windowSize = Math.max(1, Math.floor(windowSize / 2));
    built = buildSections(windowSize);
  }

  return built.sections.join('\n');
}

/**
 * Build a prompt that condenses the older portion of a long-running conversation
 * into a dense summary. The summary is written to
 * `.opencode/conversation-summary.txt` so it does not collide with the main
 * conversation response output file.
 *
 * Summarization is incremental: when `previousSummary` is supplied, the model
 * is asked to merge only the newly-rolled-out messages into the existing
 * snapshot instead of condensing the full history again, keeping the summary
 * prompt bounded to O(window) rather than O(thread length).
 *
 * @param messages - The older messages to condense (ideally only those added
 * since the previous summary was produced).
 * @param config - Optional conversation configuration (used for model-aware wording).
 * @param turnCount - The current 1-indexed turn number (for context).
 * @param previousSummary - Optional previously generated summary to merge into.
 * @returns The formatted summarization prompt string.
 */
export function buildConversationSummaryPrompt(
  messages: ConversationMessage[],
  config?: ConversationConfig,
  turnCount?: number,
  previousSummary?: string,
): string {
  const effectiveConfig = normalizeConversationConfig(config);
  const sections: string[] = [];

  sections.push('# Conversation Summarization');
  sections.push('');
  sections.push('You are condensing the older part of a long-running code review conversation.');
  if (previousSummary) {
    sections.push(
      'A summary of the earliest messages already exists. Merge any NEW information from the messages below into it rather than rewriting from scratch.',
    );
  } else {
    sections.push(
      'Summarize the messages below into a concise but information-dense paragraph (2-6 sentences).',
    );
  }
  sections.push(
    'Preserve: the file/line(s) being discussed, decisions reached, agreed-upon changes, open questions, and any key references.',
  );
  sections.push('Do NOT include greetings, sign-offs, or markdown headings.');
  sections.push(
    'The most recent messages remain available to the main conversation — only summarize what is listed below.',
  );
  sections.push('');
  if (turnCount !== undefined && effectiveConfig.maxTurns > 0) {
    sections.push(
      `This is turn ${Math.min(turnCount, effectiveConfig.maxTurns)} of up to ${effectiveConfig.maxTurns}.`,
    );
    sections.push('');
  }
  if (previousSummary) {
    sections.push('## Existing Summary');
    sections.push('');
    sections.push(previousSummary);
    sections.push('');
    sections.push('## Newer Messages to Merge In');
    sections.push('');
  } else {
    sections.push('## Messages');
    sections.push('');
  }
  for (const msg of messages) {
    const roleLabel = msg.role === 'user' ? `👤 ${msg.author || 'Developer'}` : '🤖 Assistant';
    sections.push(`### ${roleLabel}`);
    sections.push('');
    sections.push(msg.body);
    sections.push('');
  }
  sections.push('## Output');
  sections.push('');
  sections.push(
    'Write ONLY the full merged summary as plain text, directly to `.opencode/conversation-summary.txt`.',
  );
  sections.push('Do NOT wrap it in JSON or markdown code fences.');

  return sections.join('\n');
}
