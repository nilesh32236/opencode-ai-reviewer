const fs = require('fs');
const filePath = 'lib/src/jsonl-parser.ts';
let code = fs.readFileSync(filePath, 'utf-8');

// The reviewer told me: "Memory win is overstated... Keep native split for string path or drop rawLines retention if memory is the goal; no regression, just no win to claim."
// and "Fuse stamping into a single parse pass... instead of parse-stringify-join-parse."
// So I will REVERT my changes to `parseJsonlString` to use `content.split('\n')`.
// AND I will modify `parseAgentJsonlString` to do the stamping directly!

const parseAgentPattern = `export function parseAgentJsonlString(content: string, agent: AgentCategory): AgentResult {
  const processed = preprocessAgentJsonl(content, agent);
  const result = parseJsonlString(processed);
  return toAgentResult(result, agent, content);
}`;

const preprocessPattern = `function preprocessAgentJsonl(content: string, agent: AgentCategory): string {
  const lines: string[] = [];
  forEachLine(content, (rawLine) => {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('\`\`\`')) {
      lines.push(rawLine);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (record.type === 'issue') {
          const confidence = normalizeAgentConfidence(record.confidence);
          const stamped: Record<string, unknown> = {
            ...record,
            agent: typeof record.agent === 'string' ? record.agent : agent,
          };
          if (confidence !== undefined) stamped.confidence = confidence;
          lines.push(JSON.stringify(stamped));
          return;
        }
      }
    } catch {
      // Leave unparseable lines as-is; the shared parser counts them as failed.
    }
    lines.push(rawLine);
  });
  return lines.join('\\n');
}`;

// I need to change parseJsonlString, parseAgentJsonlString, JsonlParserState, and preprocessAgentJsonl.
// Wait! If I change JsonlParserState.addLine to accept an optional `agent`, then I can just iterate lines, and pass `agent` to `addLine`.
// That means `parseAgentJsonlString` can just do:
//   const state = new JsonlParserState(agent);
//   for (const line of content.split('\n')) {
//      state.addLine(line);
//   }
//   const result = state.finish();
//   return toAgentResult(result, agent, content);
// This is exactly "fuse stamping into a single parse pass".
// Let's modify JsonlParserState!

code = code.replace(
  'class JsonlParserState {',
  'class JsonlParserState {\n  constructor(private readonly fallbackAgent?: AgentCategory) {}',
);

code = code.replace(
  /const parsed = JSON\.parse\(content\);/g,
  `const parsed = JSON.parse(content) as Record<string, unknown>;
      if (this.fallbackAgent && parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.type === 'issue') {
        parsed.agent = typeof parsed.agent === 'string' ? parsed.agent : this.fallbackAgent;
        const confidence = normalizeAgentConfidence(parsed.confidence);
        if (confidence !== undefined) parsed.confidence = confidence;
      }`,
);

const newParseAgentPattern = `export function parseAgentJsonlString(content: string, agent: AgentCategory): AgentResult {
  const state = new JsonlParserState(agent);
  for (const line of content.split('\\n')) {
    state.addLine(line);
  }
  const result = state.finish();
  return toAgentResult(result, agent, content);
}`;

code = code.replace(parseAgentPattern, newParseAgentPattern);
code = code.replace(preprocessPattern, ''); // Remove preprocessAgentJsonl entirely!

const parseJsonlStringPattern = `/**
 * Iterate over lines in a string without allocating massive intermediate arrays.
 */
function forEachLine(content: string, cb: (line: string) => void): void {
  let index = 0;
  while (true) {
    const nextIndex = content.indexOf('\\n', index);
    if (nextIndex === -1) {
      cb(content.substring(index));
      break;
    }
    cb(content.substring(index, nextIndex));
    index = nextIndex + 1;
  }
}

/**
 * Parse a JSONL string containing review findings and return a structured ReviewResult.
 *
 * Line handling contract (shared with parseJsonlFile):
 * - Each line is trimmed with \`String.prototype.trim()\` before parsing, so a UTF-8
 *   BOM (U+FEFF) prefix on any line is removed and the line parses normally.
 * - Lines that are blank after trimming are skipped entirely.
 * - Zero-width characters such as U+200B (ZWSP) are NOT part of ECMAScript's
 *   WhiteSpace set, so \`.trim()\` leaves them in place; a line consisting only of
 *   such characters fails \`JSON.parse\` and is counted as a failed line.
 *
 * @param content - The JSONL string to parse.
 * @returns A ReviewResult with parsed findings.
 */
export function parseJsonlString(content: string): ReviewResult {
  const state = new JsonlParserState();
  forEachLine(content, (line) => state.addLine(line));
  return state.finish();
}`;

const parseJsonlStringReplacement = `/**
 * Parse a JSONL string containing review findings and return a structured ReviewResult.
 *
 * Line handling contract (shared with parseJsonlFile):
 * - Each line is trimmed with \`String.prototype.trim()\` before parsing, so a UTF-8
 *   BOM (U+FEFF) prefix on any line is removed and the line parses normally.
 * - Lines that are blank after trimming are skipped entirely.
 * - Zero-width characters such as U+200B (ZWSP) are NOT part of ECMAScript's
 *   WhiteSpace set, so \`.trim()\` leaves them in place; a line consisting only of
 *   such characters fails \`JSON.parse\` and is counted as a failed line.
 *
 * @param content - The JSONL string to parse.
 * @returns A ReviewResult with parsed findings.
 */
export function parseJsonlString(content: string): ReviewResult {
  const state = new JsonlParserState();
  for (const line of content.split('\\n')) {
    state.addLine(line);
  }
  return state.finish();
}`;

code = code.replace(parseJsonlStringPattern, parseJsonlStringReplacement);

fs.writeFileSync(filePath, code);
