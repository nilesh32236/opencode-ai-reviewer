/**
 * A parsed slash command extracted from a comment body.
 */
export interface ParsedCommand {
  /** The command name (e.g. 'fix', 'analyze', 'review', 'discover', 'answer', etc.) */
  command: string;
  /** Positional arguments passed to the command */
  args: string[];
  /** Parsed flags (e.g. { force: true, dryRun: true, reason: 'foo' }) */
  flags: Record<string, string | boolean>;
  /** Raw line containing the command */
  raw: string;
}

/**
 * Suffix guard shared by every command pattern: the character right after the
 * command name must not be a letter, digit, underscore, or hyphen.
 *
 * `\b` is NOT sufficient. `-` is a non-word character, so `\b` matches at that
 * boundary and `/fix-everything`, `/audit-trail` and `/review-old-branch` all
 * parsed as the corresponding privileged command.
 */
const COMMAND_SUFFIX = '(?![A-Za-z0-9_-])';

/**
 * Base `\/ask` command pattern. Rejects hyphenated lookalikes like `/ask-me`
 * by requiring that the character after `ask` is not a letter, digit,
 * underscore, or hyphen. Shared by `parseCommand` and the conversation
 * handler's `extractAskQuestion` so both sites agree on what counts as `/ask`.
 */
export const ASK_COMMAND_PATTERN = /^\s*\/(?:oc\s+)?ask(?![A-Za-z0-9_-])/i;

const COMMAND_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'review', regex: new RegExp(`^\\s*/(?:oc\\s+)?review${COMMAND_SUFFIX}`, 'i') },
  { name: 'fix', regex: new RegExp(`^\\s*/(?:oc\\s+)?fix${COMMAND_SUFFIX}`, 'i') },
  { name: 'audit', regex: new RegExp(`^\\s*/(?:oc\\s+)?audit${COMMAND_SUFFIX}`, 'i') },
  { name: 'analyze', regex: new RegExp(`^\\s*/(?:oc\\s+)?analy[sz]e${COMMAND_SUFFIX}`, 'i') },
  { name: 'explain', regex: new RegExp(`^\\s*/(?:oc\\s+)?explain${COMMAND_SUFFIX}`, 'i') },
  { name: 'describe', regex: new RegExp(`^\\s*/(?:oc\\s+)?describe${COMMAND_SUFFIX}`, 'i') },
  { name: 'ask', regex: ASK_COMMAND_PATTERN },
  { name: 'discover', regex: new RegExp(`^\\s*/(?:oc\\s+)?discover${COMMAND_SUFFIX}`, 'i') },
  { name: 'dismiss', regex: new RegExp(`^\\s*/(?:oc\\s+)?dismiss${COMMAND_SUFFIX}`, 'i') },
  {
    name: 'reconcile-comments',
    regex: new RegExp(`^\\s*/(?:oc\\s+)?reconcile-comments${COMMAND_SUFFIX}`, 'i'),
  },
  {
    name: 'rate-limits-reset',
    regex: new RegExp(`^\\s*/(?:oc\\s+)?rate-limits-reset${COMMAND_SUFFIX}`, 'i'),
  },
  { name: 'rate-limits', regex: new RegExp(`^\\s*/(?:oc\\s+)?rate-limits${COMMAND_SUFFIX}`, 'i') },
  { name: 'help', regex: new RegExp(`^\\s*/(?:oc\\s+)?help${COMMAND_SUFFIX}`, 'i') },
  { name: 'metrics', regex: new RegExp(`^\\s*/(?:oc\\s+)?metrics${COMMAND_SUFFIX}`, 'i') },
  { name: 'setup', regex: new RegExp(`^\\s*/(?:oc\\s+)?setup${COMMAND_SUFFIX}`, 'i') },
  // `/docs` is the one command whose terminator is stricter than the shared
  // guard: it also backs the documentation paths (`/docs.ts`), so a `.` must
  // not terminate it either.
  { name: 'docs', regex: /^\s*\/(?:oc\s+)?docs(?=\s|$)/i },
  { name: 'changelog', regex: new RegExp(`^\\s*/(?:oc\\s+)?changelog${COMMAND_SUFFIX}`, 'i') },
];

const FLAG_PATTERN = /--([a-zA-Z0-9-]+)(?:=(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;

/**
 * Return the first non-blank line of a comment body, trimmed.
 *
 * Only that line may carry a command. A command must be something the author
 * wrote *at the top of their own comment*: scanning every line let a
 * privileged author's pasted snippet, quoted prior message, or a bot comment
 * quoting them dispatch a privileged, LLM-cost-incurring handler.
 *
 * Requiring the first non-blank line also covers the two content-injection
 * shapes without a separate code-block parser: a fenced block cannot be the
 * first non-blank line (its opener is), and a blockquote line starts with `>`,
 * which no line-anchored command pattern matches.
 * @param body - The full markdown body of the issue or PR comment.
 * @returns The trimmed first non-blank line, or `undefined` for an empty body.
 */
function firstCommandLine(body: string): string | undefined {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return undefined;
}

/**
 * Parse a comment body string for an anchored slash command on its first
 * non-blank line.
 *
 * @param body - The full markdown body of the issue or PR comment.
 * @returns ParsedCommand object if a valid slash command was found, or null otherwise.
 */
export function parseCommand(body: string): ParsedCommand | null {
  if (!body) return null;

  const line = firstCommandLine(body);
  if (line === undefined) return null;

  const matched = COMMAND_PATTERNS.find((p) => p.regex.test(line));
  if (!matched) return null;

  const rest = line.replace(matched.regex, '').trim();
  const flags: Record<string, string | boolean> = {};
  const args: string[] = [];

  FLAG_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null = FLAG_PATTERN.exec(rest);
  let firstFlagIndex = -1;

  while (m !== null) {
    if (firstFlagIndex === -1) {
      firstFlagIndex = m.index;
    }
    const flagName = m[1];
    const camelName = flagName.replace(/-([a-z])/g, (_, g1: string) => g1.toUpperCase());
    const flagVal = m[2] ?? m[3] ?? m[4] ?? true;
    flags[camelName] = flagVal;
    m = FLAG_PATTERN.exec(rest);
  }

  const positionalText = firstFlagIndex >= 0 ? rest.slice(0, firstFlagIndex).trim() : rest.trim();

  if (positionalText) {
    args.push(...positionalText.split(/\s+/).filter(Boolean));
  }

  return {
    command: matched.name,
    args,
    flags,
    raw: line,
  };
}
