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
 * Base `\/ask` command pattern. Rejects hyphenated lookalikes like `/ask-me`
 * by requiring that the character after `ask` is not a letter, digit,
 * underscore, or hyphen. Shared by `parseCommand` and the conversation
 * handler's `extractAskQuestion` so both sites agree on what counts as `/ask`.
 */
export const ASK_COMMAND_PATTERN = /^\s*\/(?:oc\s+)?ask(?![A-Za-z0-9_-])/i;

const COMMAND_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'review', regex: /^\s*\/(?:oc\s+)?review(?![A-Za-z0-9_-])/i },
  { name: 'fix', regex: /^\s*\/(?:oc\s+)?fix(?![A-Za-z0-9_-])/i },
  { name: 'audit', regex: /^\s*\/(?:oc\s+)?audit(?![A-Za-z0-9_-])/i },
  { name: 'analyze', regex: /^\s*\/(?:oc\s+)?analy[sz]e(?![A-Za-z0-9_-])/i },
  { name: 'explain', regex: /^\s*\/(?:oc\s+)?explain(?![A-Za-z0-9_-])/i },
  { name: 'describe', regex: /^\s*\/(?:oc\s+)?describe(?![A-Za-z0-9_-])/i },
  { name: 'ask', regex: ASK_COMMAND_PATTERN },
  { name: 'discover', regex: /^\s*\/(?:oc\s+)?discover(?![A-Za-z0-9_-])/i },
  { name: 'dismiss', regex: /^\s*\/(?:oc\s+)?dismiss(?![A-Za-z0-9_-])/i },
  { name: 'reconcile-comments', regex: /^\s*\/(?:oc\s+)?reconcile-comments(?![A-Za-z0-9_-])/i },
  { name: 'rate-limits-reset', regex: /^\s*\/(?:oc\s+)?rate-limits-reset(?![A-Za-z0-9_-])/i },
  { name: 'rate-limits', regex: /^\s*\/(?:oc\s+)?rate-limits(?![A-Za-z0-9_-])/i },
  { name: 'help', regex: /^\s*\/(?:oc\s+)?help(?![A-Za-z0-9_-])/i },
  { name: 'metrics', regex: /^\s*\/(?:oc\s+)?metrics(?![A-Za-z0-9_-])/i },
  { name: 'setup', regex: /^\s*\/(?:oc\s+)?setup(?![A-Za-z0-9_-])/i },
  // `docs` shares the hyphen-proof negative lookahead with every other
  // command, plus `.` so filename lookalikes like `/docs.ts` never dispatch.
  { name: 'docs', regex: /^\s*\/(?:oc\s+)?docs(?![A-Za-z0-9_.-])/i },
  { name: 'changelog', regex: /^\s*\/(?:oc\s+)?changelog(?![A-Za-z0-9_-])/i },
];

const FLAG_PATTERN = /--([a-zA-Z0-9-]+)(?:=(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;

/**
 * Parse a comment body string for an anchored slash command at line start.
 *
 * Lines inside fenced code blocks (``` / ~~~) and blockquote lines (`> ...`)
 * never dispatch a command: quoted prior messages, pasted snippets, and bot
 * comments quoting a user are attacker-suppliable content, not author intent.
 *
 * Fences are paired before scanning: an unclosed fence (a single ``` or ~~~
 * with no matching closer) is treated as ordinary text so one malformed or
 * quoted fence cannot suppress every later legitimate command in the body.
 * @param body - The full markdown body of the issue or PR comment.
 * @returns ParsedCommand object if a valid slash command was found, or null otherwise.
 */
export function parseCommand(body: string): ParsedCommand | null {
  if (!body) return null;

  const lines = body.split('\n');
  // Pair fence markers up front so a lone unclosed fence does not swallow
  // the rest of the body. Lines from a matched opener through its closer
  // (inclusive — the fence lines themselves never carry a command) are
  // suppressed; an unpaired trailing fence is ignored as ordinary text.
  const fenceIdx: number[] = [];
  lines.forEach((line, i) => {
    if (/^\s{0,3}(```|~~~)/.test(line)) fenceIdx.push(i);
  });
  const suppressed = new Set<number>();
  for (let k = 0; k + 1 < fenceIdx.length; k += 2) {
    const open = fenceIdx[k]!;
    const close = fenceIdx[k + 1]!;
    for (let i = open; i <= close; i++) suppressed.add(i);
  }

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!;
    if (suppressed.has(idx)) continue;
    // Blockquote lines quote prior content rather than authoring a command.
    if (/^\s*>/.test(line)) continue;
    const matched = COMMAND_PATTERNS.find((p) => p.regex.test(line));
    if (!matched) continue;

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
      const camelName = flagName.replace(/-([a-z])/g, (_, g1) => g1.toUpperCase());
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
      raw: line.trim(),
    };
  }

  return null;
}
