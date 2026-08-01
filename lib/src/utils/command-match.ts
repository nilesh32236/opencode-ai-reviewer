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

const COMMAND_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'review', regex: /^\s*\/(?:oc\s+)?review\b/i },
  { name: 'fix', regex: /^\s*\/(?:oc\s+)?fix\b/i },
  { name: 'audit', regex: /^\s*\/(?:oc\s+)?audit\b/i },
  { name: 'analyze', regex: /^\s*\/(?:oc\s+)?analy[sz]e\b/i },
  { name: 'explain', regex: /^\s*\/(?:oc\s+)?explain\b/i },
  { name: 'discover', regex: /^\s*\/(?:oc\s+)?discover\b/i },
  { name: 'reconcile-comments', regex: /^\s*\/(?:oc\s+)?reconcile-comments\b/i },
  { name: 'help', regex: /^\s*\/(?:oc\s+)?help\b/i },
  { name: 'metrics', regex: /^\s*\/(?:oc\s+)?metrics\b/i },
  { name: 'setup', regex: /^\s*\/(?:oc\s+)?setup\b/i },
];

const FLAG_PATTERN = /--([a-zA-Z0-9-]+)(?:=(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;

/**
 * Parse a comment body string for an anchored slash command at line start.
 *
 * @param body - The full markdown body of the issue or PR comment.
 * @returns ParsedCommand object if a valid slash command was found, or null otherwise.
 */
export function parseCommand(body: string): ParsedCommand | null {
  if (!body) return null;

  for (const line of body.split('\n')) {
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
