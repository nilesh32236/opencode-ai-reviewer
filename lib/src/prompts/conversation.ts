import type { ConversationContext } from '../types/index.js';

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

/**
 * Detect the intent of a user's message based on keyword matching.
 *
 * @param message - The user's comment body.
 * @returns The detected intent: 'fix', 'explain', or 'general'.
 */
export function detectIntent(message: string): 'explain' | 'fix' | 'general' {
  const lower = message.toLowerCase();

  // Check fix intent first (stronger signal — user wants action)
  const hasFixKeyword = FIX_KEYWORDS.some(
    (kw) =>
      lower.includes(kw) &&
      // Ensure it's not just mentioning the word in a question context
      !lower.startsWith('why') &&
      !lower.startsWith('what'),
  );
  if (hasFixKeyword) return 'fix';

  // Check explain intent
  const hasExplainKeyword = EXPLAIN_KEYWORDS.some((kw) => lower.includes(kw));
  if (hasExplainKeyword) return 'explain';

  return 'general';
}

/**
 * Build a prompt for the LLM to respond to an interactive conversation in a PR comment.
 * The prompt includes file context, diff hunks, the full conversation thread,
 * and specific output format instructions based on the detected intent.
 *
 * @param context - Full conversation context including thread, file, diff, and intent.
 * @returns The formatted prompt string for the LLM.
 */
export function buildConversationPrompt(context: ConversationContext): string {
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

  // Conversation thread
  sections.push('## Conversation Thread');
  sections.push('');
  for (const msg of context.thread) {
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
      sections.push('```');
      sections.push('```suggestion');
      sections.push('// replacement code here');
      sections.push('```');
      sections.push('```');
      sections.push('');
      sections.push('3. Briefly explain what the change does and why it addresses their request.');
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
  sections.push('Respond with a single markdown message suitable for posting as a GitHub comment.');
  sections.push('Do NOT wrap your response in JSON or any other structure.');
  sections.push('Do NOT include greeting lines like "Hi!" or sign-off lines.');
  sections.push('Be direct, technical, and helpful.');

  return sections.join('\n');
}
