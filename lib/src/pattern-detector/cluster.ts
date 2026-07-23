const NON_ALPHANUMERIC_REGEX = /[^a-z0-9\s]/g;
const WHITESPACE_REGEX = /\s+/;

/**
 * Tokenize a message into a set of lowercase alphanumeric tokens (length > 2).
 */
function tokenize(message: string): Set<string> {
  return new Set(
    message
      .toLowerCase()
      .replace(NON_ALPHANUMERIC_REGEX, '')
      .split(WHITESPACE_REGEX)
      .filter((t) => t.length > 2),
  );
}

/**
 * Compute Jaccard similarity between two sets: |intersection| / |union|.
 * Optimized to iterate over the smaller set.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersectionSize = 0;
  const smallerSet = a.size < b.size ? a : b;
  const largerSet = a.size < b.size ? b : a;

  for (const item of smallerSet) {
    if (largerSet.has(item)) intersectionSize++;
  }

  const unionSize = a.size + b.size - intersectionSize;
  if (unionSize === 0) return 0;

  return intersectionSize / unionSize;
}

/**
 * Cluster finding messages by Jaccard token similarity.
 * Messages with similarity >= threshold are grouped together.
 * Uses a greedy single-pass algorithm: each unassigned message becomes
 * a cluster centroid and collects all similar unassigned messages.
 * Only clusters with 2+ messages are returned.
 *
 * @param messages - Array of finding message strings.
 * @param threshold - Jaccard similarity threshold (default 0.3).
 * @returns Array of clusters, each with a centroid and member messages.
 */
export function clusterFindings(
  messages: string[],
  threshold = 0.3,
): Array<{ centroid: string; messages: string[] }> {
  if (messages.length === 0) return [];

  const tokens = messages.map((m) => tokenize(m));
  const assigned = new Array(messages.length).fill(false);
  const clusters: Array<{ centroid: string; messages: string[] }> = [];

  for (let i = 0; i < messages.length; i++) {
    if (assigned[i]) continue;

    const cluster: string[] = [messages[i]];
    assigned[i] = true;

    for (let j = i + 1; j < messages.length; j++) {
      if (assigned[j]) continue;
      const sim = jaccardSimilarity(tokens[i], tokens[j]);
      if (sim >= threshold) {
        cluster.push(messages[j]);
        assigned[j] = true;
      }
    }

    if (cluster.length >= 2) {
      clusters.push({ centroid: messages[i], messages: cluster });
    }
  }

  return clusters;
}
