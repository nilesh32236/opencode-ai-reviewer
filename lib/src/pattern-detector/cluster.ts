import {
  LSH_BANDS,
  LSH_ROWS,
  MINHASH_SIGNATURE_SIZE,
  computeMinHashSignature,
  lshCandidates,
} from './minhash.js';

const NON_ALPHANUMERIC_REGEX = /[^a-z0-9\s]/g;
const WHITESPACE_REGEX = /\s+/;

/** Maximum number of messages clustered with the exact O(N²) all-pairs path. */
export const EXACT_CLUSTER_LIMIT = 100;
/** Default hard safety-net cap on the number of messages clustered in a single call. */
export const MAX_CLUSTER_INPUT = 500;
/**
 * Similarity at which the LSH band/row configuration is calibrated:
 * (1/LSH_BANDS)^(1/LSH_ROWS) ≈ 0.29. Below this, the LSH pre-filter would
 * drop genuinely similar pairs, so the exact path is used instead.
 */
const LSH_BAND_THRESHOLD = (1 / LSH_BANDS) ** (1 / LSH_ROWS);

/**
 * Tokenize a message into a set of lowercase alphanumeric tokens (length > 2).
 * @param message - The message to tokenize.
 * @returns A set of alphanumeric tokens from the message.
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
 * @param a - First set.
 * @param b - Second set.
 * @returns The Jaccard similarity score between 0 and 1.
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
        if (jaccardSimilarity(tokens[i], tokens[j]) >= threshold) {
          cluster.push(messages[j]);
          assigned[j] = true;
        }
      }
    } else {
      for (let j = i + 1; j < messages.length; j++) {
        if (assigned[j]) continue;
        if (jaccardSimilarity(tokens[i], tokens[j]) >= threshold) {
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
  /** True when the input was truncated to the configured maxInput cap. */
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

  const tokens = messages.map((m) => tokenize(m));
  return greedyCluster(tokens, messages, threshold, null);
}

/**
 * Build per-index candidate lists for the LSH path using MinHash signatures.
 * Messages whose token set is empty are skipped: their Jaccard similarity to
 * every other message is 0, so they can never be clustered, and skipping them
 * avoids the all-pairs candidate blow-up that all-zero signatures would cause.
 * @param tokens - Token sets for each message.
 * @returns Per-index candidate lists (index > i), with indices remapped back
 * to the full token array.
 */
function buildLshCandidatesByIndex(tokens: Set<string>[]): number[][] {
  const candidatesByIndex: number[][] = Array.from({ length: tokens.length }, () => []);
  const nonEmptyIndices: number[] = [];
  const signatures: number[][] = [];

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].size === 0) continue;
    nonEmptyIndices.push(i);
    signatures.push(computeMinHashSignature(tokens[i], MINHASH_SIGNATURE_SIZE));
  }

  const candidatePairs = lshCandidates(signatures, LSH_BANDS, LSH_ROWS);
  for (const [a, b] of candidatePairs) {
    candidatesByIndex[nonEmptyIndices[a]].push(nonEmptyIndices[b]);
  }
  for (const candidates of candidatesByIndex) {
    candidates.sort((a, b) => a - b);
  }
  return candidatesByIndex;
}

/**
 * Cluster finding messages with an adaptive strategy:
 * - Inputs larger than `maxInput` are truncated to the cap (safety net).
 * - Inputs up to EXACT_CLUSTER_LIMIT use the exact all-pairs greedy algorithm.
 * - Larger inputs use MinHash LSH candidate pre-filtering followed by exact
 *   Jaccard verification on the candidate pairs (near-linear in practice).
 *   The LSH path is calibrated for thresholds at or above ~0.29; for lower
 *   thresholds the exact path is used so no similar pairs are dropped.
 * @param messages - Array of finding message strings.
 * @param threshold - Jaccard similarity threshold (default 0.3).
 * @param maxInput - Hard cap on the number of messages clustered (default MAX_CLUSTER_INPUT).
 * @returns Clusters plus whether the input was truncated.
 */
export function clusterFindingsWithStatus(
  messages: string[],
  threshold = 0.3,
  maxInput: number = MAX_CLUSTER_INPUT,
): ClusterResult {
  if (messages.length === 0) return { clusters: [], truncated: false };

  const truncated = messages.length > maxInput;
  const input = truncated ? messages.slice(0, maxInput) : messages;

  const tokens = input.map((m) => tokenize(m));

  let clusters: Array<{ centroid: string; messages: string[] }>;
  if (input.length <= EXACT_CLUSTER_LIMIT || threshold < LSH_BAND_THRESHOLD) {
    clusters = greedyCluster(tokens, input, threshold, null);
  } else {
    clusters = greedyCluster(tokens, input, threshold, buildLshCandidatesByIndex(tokens));
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
 * candidate set (near-linear) with a hard cap of `maxInput` (default
 * MAX_CLUSTER_INPUT = 500). Inputs above the cap are truncated to it; when
 * that happens a warning is emitted on the console. The LSH path is calibrated
 * for thresholds at or above ~0.29 — for lower thresholds the exact O(N²) path
 * is used so no similar pairs are dropped.
 *
 * @param messages - Array of finding message strings.
 * @param threshold - Jaccard similarity threshold (default 0.3).
 * @param maxInput - Hard cap on the number of messages clustered (default MAX_CLUSTER_INPUT).
 * @returns Array of clusters, each with a centroid and member messages.
 */
export function clusterFindings(
  messages: string[],
  threshold = 0.3,
  maxInput: number = MAX_CLUSTER_INPUT,
): Array<{ centroid: string; messages: string[] }> {
  const { clusters, truncated } = clusterFindingsWithStatus(messages, threshold, maxInput);
  if (truncated) {
    console.warn(
      `clusterFindings: input of ${messages.length} messages exceeds the cap of ${maxInput}; ` +
        `${messages.length - maxInput} message(s) were not clustered`,
    );
  }
  return clusters;
}
