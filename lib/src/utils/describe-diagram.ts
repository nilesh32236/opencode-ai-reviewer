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
 * Build a text alternative for a validated Mermaid flowchart body so
 * screen-reader and text-only users get an equivalent of the visual diagram.
 * Lists the diagram direction plus one `source -> target` line per edge-like
 * row (node labels sanitized to plain text); falls back to a one-sentence
 * flow summary when no edges are detected.
 *
 * @param body - Validated Mermaid diagram body (flowchart/graph source).
 * @returns Markdown lines forming the text alternative.
 */
export function buildDiagramTextAlternative(body: string): string {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('%%'));
  const direction = /^(flowchart|graph)\s+(TD|TB|BT|RL|LR)\b/i.exec(body)?.[2]?.toUpperCase();
  // Keep only edge-like rows; sanitize node labels to plain text so a
  // prompt-injected label cannot smuggle markdown/HTML into the alternative.
  const edges = lines
    .filter((l) => /--|==|->/.test(l))
    .map((l) =>
      l
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/[%#[\]()`*_~|]/g, '')
        .trim(),
    )
    .filter((l) => l.length > 0);
  const out: string[] = [
    '<details>',
    '<summary>Text version of the diagram (screen-reader friendly)</summary>',
    '',
  ];
  if (direction) out.push(`Flow direction: ${direction}.`);
  if (edges.length > 0) {
    out.push('', 'Flow steps:');
    for (const e of edges) out.push(`- ${e}`);
  } else {
    out.push('', `Flow with ${lines.length} step(s): ${lines.slice(0, 12).join(' → ')}.`);
  }
  out.push('', '</details>');
  return out.join('\n');
}

/**
 * Fail-open post-processing for describe output with diagrams.
 *
 * Returns the content with an auto-generated text alternative appended after
 * a valid diagram; strips the Diagram section (heading + fenced block) when
 * the diagram is invalid so the description still posts cleanly. Diagrams
 * that ship without a text equivalent are flagged by appending one — a valid
 * fence never posts without its screen-reader alternative.
 *
 * @param content - Full describe markdown output.
 * @returns Content with a text alternative ensured, or with an invalid
 * Diagram section removed.
 */
export function sanitizeDescribeDiagram(content: string): string {
  const body = extractValidMermaidDiagram(content);
  if (body === null) {
    // Remove a trailing "## Diagram" section with its mermaid fence (or any fence).
    const stripped = content.replace(
      /\n?##\s+Diagram\s*\n(?:```mermaid[\s\S]*?```|```[\s\S]*?```)/,
      '',
    );
    return stripped.trimEnd();
  }
  // A valid diagram posts only with a text alternative alongside the fence.
  if (content.includes('Text version of the diagram')) return content;
  const alternative = buildDiagramTextAlternative(body);
  return `${content.trimEnd()}\n\n${alternative}`;
}
