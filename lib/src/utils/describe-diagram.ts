/** Maximum number of diagram nodes allowed in a describe Mermaid flowchart. */
export const MAX_DESCRIBE_DIAGRAM_NODES = 12;

const MERMAID_FENCE_RE = /```mermaid\s*\n([\s\S]*?)```/;

const NODE_ID_RE = /\b([A-Za-z][A-Za-z0-9_]*)\s*[\[\({]/g;

const EDGE_RE = /--|==|->/;

/**
 * Validate a fenced Mermaid flowchart and return the diagram body when valid.
 *
 * Fail-open: returns `null` when the content has no fenced mermaid block,
 * the body does not start with `flowchart`/`graph`, or the node count
 * exceeds {@link MAX_DESCRIBE_DIAGRAM_NODES}.
 *
 * @param content - Full describe markdown output.
 * @returns The validated diagram body, or `null` when invalid/missing.
 */
export function extractValidMermaidDiagram(content: string): string | null {
  const match = MERMAID_FENCE_RE.exec(content);
  if (!match?.[1]) return null;
  const body = match[1].trim();
  if (!/^(flowchart|graph)\s+(TD|TB|BT|RL|LR)\b/i.test(body)) return null;
  if (/^\s*```/.test(body)) return null;
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('%%'));
  if (lines.length === 0) return null;
  const nodeIds = new Set<string>();
  for (const line of lines) {
    // Reject suspicious content (script tags, nested fences, raw HTML).
    if (/[<>&]{1}.*(script|iframe|object)/i.test(line)) return null;
    if (line.includes('```')) return null;
    NODE_ID_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NODE_ID_RE.exec(line)) !== null) {
      nodeIds.add(m[1]);
    }
    void EDGE_RE;
  }
  // Count distinct node ids; fall back to non-empty line count when ids are sparse.
  const nodeCount = Math.max(nodeIds.size, lines.length - 1);
  if (nodeCount > MAX_DESCRIBE_DIAGRAM_NODES) return null;
  return body;
}

/**
 * Fail-open post-processing for describe output with diagrams.
 *
 * Returns the content unchanged when it contains a valid diagram; strips the
 * Diagram section (heading + fenced block) when the diagram is invalid so the
 * description still posts cleanly.
 *
 * @param content - Full describe markdown output.
 * @returns Content with an invalid Diagram section removed, or unchanged.
 */
export function sanitizeDescribeDiagram(content: string): string {
  if (extractValidMermaidDiagram(content) !== null) return content;
  // Remove a trailing "## Diagram" section with its mermaid fence (or any fence).
  const stripped = content.replace(
    /\n?##\s+Diagram\s*\n(?:```mermaid[\s\S]*?```|```[\s\S]*?```)/,
    '',
  );
  return stripped.trimEnd();
}
