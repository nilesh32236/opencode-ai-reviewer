import {
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
