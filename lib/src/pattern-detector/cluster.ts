import {
  LSH_BANDS,
  LSH_ROWS,
  MINHASH_SIGNATURE_SIZE,
  computeMinHashSignature,
  jaccardSimilarityWithThreshold,
  lshCandidatesTyped,
  tokenizeMessage,
} from './minhash-optimized.js';

/** Maximum number of messages clustered with the exact O(N²) all-pairs path. */
export const EXACT_CLUSTER_LIMIT = 100;
/** Hard safety-net cap on the number of messages clustered in a single call. */
export const MAX_CLUSTER_INPUT = 500;

/**
 * Greedy single-pass clustering shared by the exact and LSH candidate paths.
 * Each unassigned message becomes a centroid and claims all similar unassigned
 * messages. When `candidatesByIndex` is provided, only those candidate indices
 * (ascending) are evaluated instead of every later index.
 * @param tokens - Token sets for each message.
 * @param messages - Finding message strings.
 * @param threshold - Jaccard similarity threshold for grouping.
 * @param candidatesByIndex - Per-index candidate lists (index > i), or null for all pairs.
 * @returns Array of clusters, each with a centroid and member messages.
 */
function greedyCluster(
  tokens: Set<string>[],
  messages: string[],
  threshold: number,
  candidatesByIndex: number[][] | null,
): Array<{ centroid: string; messages: string[] }> {
  const assigned = new Array(messages.length).fill(false);
  const clusters: Array<{ centroid: string; messages: string[] }> = [];

  for (let i = 0; i < messages.length; i++) {
    if (assigned[i]) continue;

    const cluster: string[] = [messages[i]];
    assigned[i] = true;

    if (candidatesByIndex !== null) {
      for (const j of candidatesByIndex[i]) {
        if (assigned[j]) continue;
        if (jaccardSimilarityWithThreshold(tokens[i], tokens[j], threshold) >= threshold) {
          cluster.push(messages[j]);
          assigned[j] = true;
        }
      }
    } else {
      for (let j = i + 1; j < messages.length; j++) {
        if (assigned[j]) continue;
        if (jaccardSimilarityWithThreshold(tokens[i], tokens[j], threshold) >= threshold) {
          cluster.push(messages[j]);
          assigned[j] = true;
        }
      }
    }

    if (cluster.length >= 2) {
      clusters.push({ centroid: messages[i], messages: cluster });
    }
  }

  return clusters;
}

/**
 * Result of clustering with truncation status.
 */
export interface ClusterResult {
  clusters: Array<{ centroid: string; messages: string[] }>;
  /** True when the input was truncated to MAX_CLUSTER_INPUT. */
  truncated: boolean;
}

/**
 * Cluster finding messages with the exact all-pairs greedy algorithm (O(N²)).
 * Provided for benchmarking and quality comparison against the approximate path.
 * @param messages - Array of finding message strings.
 * @param threshold - Jaccard similarity threshold (default 0.3).
 * @returns Array of clusters, each with a centroid and member messages.
 */
export function clusterFindingsExact(
  messages: string[],
  threshold = 0.3,
): Array<{ centroid: string; messages: string[] }> {
  if (messages.length === 0) return [];

  const tokens = messages.map((m) => tokenizeMessage(m));
  return greedyCluster(tokens, messages, threshold, null);
}

/**
 * Cluster finding messages with an adaptive strategy:
 * - Inputs larger than MAX_CLUSTER_INPUT are truncated to the cap (safety net).
 * - Inputs up to EXACT_CLUSTER_LIMIT use the exact all-pairs greedy algorithm.
 * - Larger inputs use MinHash LSH candidate pre-filtering followed by exact
 *   Jaccard verification on the candidate pairs (near-linear in practice).
 * @param messages - Array of finding message strings.
 * @param threshold - Jaccard similarity threshold (default 0.3).
 * @returns Clusters plus whether the input was truncated.
 */
export function clusterFindingsWithStatus(messages: string[], threshold = 0.3): ClusterResult {
  if (messages.length === 0) return { clusters: [], truncated: false };

  const truncated = messages.length > MAX_CLUSTER_INPUT;
  const input = truncated ? messages.slice(0, MAX_CLUSTER_INPUT) : messages;

  const tokens = input.map((m) => tokenizeMessage(m));

  let clusters: Array<{ centroid: string; messages: string[] }>;
  if (input.length <= EXACT_CLUSTER_LIMIT) {
    clusters = greedyCluster(tokens, input, threshold, null);
  } else {
    const signatures = tokens.map((t) => computeMinHashSignature(t, MINHASH_SIGNATURE_SIZE));
    const candidatePairs = lshCandidatesTyped(signatures, LSH_BANDS, LSH_ROWS);

    const candidatesByIndex: number[][] = Array.from({ length: input.length }, () => []);
    for (const [i, j] of candidatePairs) {
      candidatesByIndex[i].push(j);
    }
    for (const candidates of candidatesByIndex) {
      candidates.sort((a, b) => a - b);
    }

    clusters = greedyCluster(tokens, input, threshold, candidatesByIndex);
  }

  return { clusters, truncated };
}

/**
 * Cluster finding messages by Jaccard token similarity.
 * Messages with similarity >= threshold are grouped together.
 * Uses a greedy single-pass algorithm: each unassigned message becomes
 * a cluster centroid and collects all similar unassigned messages.
 * Only clusters with 2+ messages are returned.
 *
 * For large inputs the clustering switches to a MinHash LSH pre-filtered
 * candidate set (near-linear) with a hard cap of MAX_CLUSTER_INPUT.
 *
 * @param messages - Array of finding message strings.
 * @param threshold - Jaccard similarity threshold (default 0.3).
 * @returns Array of clusters, each with a centroid and member messages.
 */
export function clusterFindings(
  messages: string[],
  threshold = 0.3,
): Array<{ centroid: string; messages: string[] }> {
  return clusterFindingsWithStatus(messages, threshold).clusters;
}
