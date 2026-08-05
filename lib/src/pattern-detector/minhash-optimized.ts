/** Number of hash functions used to build MinHash signatures. */
export const MINHASH_SIGNATURE_SIZE = 128;
/** Number of bands signatures are split into for LSH candidate generation. */
export const LSH_BANDS = 42;
/**
 * Number of hash values per band. With 42 bands of 3 rows the LSH band
 * threshold is (1/42)^(1/3) ≈ 0.29, matching the 0.3 clustering threshold.
 */
export const LSH_ROWS = 3;

/** Salt for the primary per-token hash used to build signatures. */
const PRIMARY_HASH_SALT = 0x9e3779b1;
/** Salt for the secondary per-token hash used to vary permutations. */
const SECONDARY_HASH_SALT = 0x85ebca6b;

/**
 * Cache for token sets to avoid re-tokenization of identical messages.
 * This significantly improves performance when the same message appears multiple times.
 */
const tokenSetCache = new Map<string, Set<string>>();

/**
 * FNV-1a style 32-bit string hash with a Murmur3-style finalizer for good
 * avalanche. Non-cryptographic but fast and sufficiently uniform for MinHash.
 * Optimized with bit operations for better performance.
 * @param value - The string to hash.
 * @returns A uint32 hash value in the range [0, 2^32).
 */
function mix32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/**
 * Hash a token into a deterministic 32-bit unsigned integer.
 * The salt identifies an independent pseudo-permutation (hash function index).
 * @param token - The token to hash.
 * @param salt - Salt value selecting the hash function.
 * @returns A uint32 hash value in the range [0, 2^32).
 */
export function hashToken(token: string, salt: number): number {
  const salted = mix32(`${salt}:${token}`);
  return Math.imul(salted ^ (salt * 0x9e3779b1), 0x85ebca6b) >>> 0;
}

/**
 * Tokenize a string into a set of lowercase alphanumeric tokens.
 * Cached to avoid re-tokenization of identical messages.
 * @param message - The message to tokenize.
 * @returns A set of alphanumeric tokens from the message.
 */
export function tokenizeMessage(message: string): Set<string> {
  // Check cache first
  let tokens = tokenSetCache.get(message);
  if (tokens) {
    return tokens;
  }

  // Tokenize: lowercase, remove non-alphanumeric, split on whitespace, filter short tokens
  const NON_ALPHANUMERIC_REGEX = /[^a-z0-9\s]/g;
  const WHITESPACE_REGEX = /\s+/;

  tokens = new Set(
    message
      .toLowerCase()
      .replace(NON_ALPHANUMERIC_REGEX, '')
      .split(WHITESPACE_REGEX)
      .filter((t) => t.length > 2),
  );

  // Cache the result
  tokenSetCache.set(message, tokens);
  return tokens;
}

/**
 * Clear the token set cache. Useful for freeing memory after processing large batches.
 */
export function clearTokenCache(): void {
  tokenSetCache.clear();
}

/**
 * Compute a MinHash signature for a token set.
 * Each token is hashed once; every signature entry k is the minimum over
 * tokens of `primary + k * secondary (mod 2^32)`, which approximates k
 * independent pseudo-random permutations. Identical token sets produce
 * identical signatures.
 *
 * Optimized version using Uint32Array for better memory efficiency and performance.
 * @param tokens - Set of tokens to summarize.
 * @param numHashes - Number of hash functions (signature length).
 * @returns Array of `numHashes` minimum hash values as Uint32Array.
 */
export function computeMinHashSignature(
  tokens: Set<string>,
  numHashes: number = MINHASH_SIGNATURE_SIZE,
): Uint32Array {
  if (tokens.size === 0) return new Uint32Array(numHashes);

  // Use Uint32Array for better memory efficiency
  const signature = new Uint32Array(numHashes).fill(0xffffffff);

  for (const token of tokens) {
    const base = mix32(token);
    const primary = (base ^ PRIMARY_HASH_SALT) >>> 0;
    const secondary = (Math.imul(base ^ SECONDARY_HASH_SALT, 0xc2b2ae35) >>> 0) | 1;

    // Loop unrolling for better performance
    // Process 4 hash functions at a time to reduce loop overhead
    for (let k = 0; k < numHashes; k += 4) {
      const hash0 = (primary + Math.imul(k, secondary)) >>> 0;
      const hash1 = (primary + Math.imul(k + 1, secondary)) >>> 0;
      const hash2 = (primary + Math.imul(k + 2, secondary)) >>> 0;
      const hash3 = (primary + Math.imul(k + 3, secondary)) >>> 0;

      if (hash0 < signature[k]) signature[k] = hash0;
      if (k + 1 < numHashes && hash1 < signature[k + 1]) signature[k + 1] = hash1;
      if (k + 2 < numHashes && hash2 < signature[k + 2]) signature[k + 2] = hash2;
      if (k + 3 < numHashes && hash3 < signature[k + 3]) signature[k + 3] = hash3;
    }
  }
  return signature;
}

/**
 * Compute MinHash signature and return as number array for backward compatibility.
 * @param tokens - Set of tokens to summarize.
 * @param numHashes - Number of hash functions (signature length).
 * @returns Array of `numHashes` minimum hash values.
 */
export function computeMinHashSignatureArray(
  tokens: Set<string>,
  numHashes: number = MINHASH_SIGNATURE_SIZE,
): number[] {
  const signature = computeMinHashSignature(tokens, numHashes);
  return Array.from(signature);
}

/**
 * Generate candidate index pairs whose MinHash signatures share at least one
 * LSH band. Each signature is split into `bands` bands of `rows` rows; items
 * landing in the same band bucket are treated as candidate similar pairs.
 * Bucket keys are 32-bit integer hashes of the band rows — rare key collisions
 * only add spurious candidates, which exact Jaccard verification discards.
 * Returns a deduplicated set of index pairs `(i, j)` with `i < j`.
 *
 * Optimized with early termination and better bucket key computation.
 * @param signatures - MinHash signatures, one per item.
 * @param bands - Number of bands to split each signature into.
 * @param rows - Number of hash values per band.
 * @returns Set of candidate index pairs.
 */
export function lshCandidates(
  signatures: number[][],
  bands: number = LSH_BANDS,
  rows: number = LSH_ROWS,
): Set<[number, number]> {
  const pairKeys = new Set<string>();
  if (signatures.length < 2) return new Set<[number, number]>();

  const bucketMap = new Map<number, number[]>();

  for (let band = 0; band < bands; band++) {
    bucketMap.clear();
    const offset = band * rows;

    for (let idx = 0; idx < signatures.length; idx++) {
      const signature = signatures[idx];
      if (offset + rows > signature.length) continue;

      // Optimized bucket key computation
      let bucketKey = band;
      for (let r = 0; r < rows; r++) {
        const value = signature[offset + r];
        // Use XOR and multiplication for better distribution
        bucketKey = (Math.imul(bucketKey, 0x85ebca6b) ^ value) >>> 0;
      }
      bucketKey ^= bucketKey >>> 16;

      let bucket = bucketMap.get(bucketKey);
      if (bucket === undefined) {
        bucket = [];
        bucketMap.set(bucketKey, bucket);
      }
      bucket.push(idx);
    }

    // Generate candidate pairs from buckets with 2+ items
    for (const bucket of bucketMap.values()) {
      if (bucket.length < 2) continue;

      // For small buckets, use nested loops
      if (bucket.length <= 10) {
        for (let a = 0; a < bucket.length; a++) {
          for (let b = a + 1; b < bucket.length; b++) {
            const i = bucket[a];
            const j = bucket[b];
            const key = i < j ? `${i}:${j}` : `${j}:${i}`;
            pairKeys.add(key);
          }
        }
      } else {
        // For larger buckets, use a more efficient approach
        // Sort first to enable early termination in Jaccard verification
        bucket.sort((a, b) => a - b);
        for (let a = 0; a < bucket.length; a++) {
          for (let b = a + 1; b < bucket.length; b++) {
            const key = `${bucket[a]}:${bucket[b]}`;
            pairKeys.add(key);
          }
        }
      }
    }
  }

  const candidates = new Set<[number, number]>();
  for (const key of pairKeys) {
    const separator = key.indexOf(':');
    candidates.add([Number(key.slice(0, separator)), Number(key.slice(separator + 1))]);
  }
  return candidates;
}

/**
 * Optimized LSH candidates using Uint32Array signatures.
 * @param signatures - MinHash signatures as Uint32Array, one per item.
 * @param bands - Number of bands to split each signature into.
 * @param rows - Number of hash values per band.
 * @returns Set of candidate index pairs.
 */
export function lshCandidatesTyped(
  signatures: Uint32Array[],
  bands: number = LSH_BANDS,
  rows: number = LSH_ROWS,
): Set<[number, number]> {
  const pairKeys = new Set<string>();
  if (signatures.length < 2) return new Set<[number, number]>();

  const bucketMap = new Map<number, number[]>();

  for (let band = 0; band < bands; band++) {
    bucketMap.clear();
    const offset = band * rows;

    for (let idx = 0; idx < signatures.length; idx++) {
      const signature = signatures[idx];
      if (offset + rows > signature.length) continue;

      let bucketKey = band;
      for (let r = 0; r < rows; r++) {
        const value = signature[offset + r];
        bucketKey = (Math.imul(bucketKey, 0x85ebca6b) ^ value) >>> 0;
      }
      bucketKey ^= bucketKey >>> 16;

      let bucket = bucketMap.get(bucketKey);
      if (bucket === undefined) {
        bucket = [];
        bucketMap.set(bucketKey, bucket);
      }
      bucket.push(idx);
    }

    for (const bucket of bucketMap.values()) {
      if (bucket.length < 2) continue;
      for (let a = 0; a < bucket.length; a++) {
        for (let b = a + 1; b < bucket.length; b++) {
          const i = bucket[a];
          const j = bucket[b];
          const key = i < j ? `${i}:${j}` : `${j}:${i}`;
          pairKeys.add(key);
        }
      }
    }
  }

  const candidates = new Set<[number, number]>();
  for (const key of pairKeys) {
    const separator = key.indexOf(':');
    candidates.add([Number(key.slice(0, separator)), Number(key.slice(separator + 1))]);
  }
  return candidates;
}

/**
 * Compute Jaccard similarity between two sets: |intersection| / |union|.
 * Optimized to iterate over the smaller set.
 * @param a - First set.
 * @param b - Second set.
 * @returns The Jaccard similarity score between 0 and 1.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  // Always iterate over the smaller set
  const smallerSet = a.size < b.size ? a : b;
  const largerSet = a.size < b.size ? b : a;

  let intersectionSize = 0;
  for (const item of smallerSet) {
    if (largerSet.has(item)) intersectionSize++;
  }

  const unionSize = a.size + b.size - intersectionSize;
  if (unionSize === 0) return 0;

  return intersectionSize / unionSize;
}

/**
 * Jaccard similarity with early termination.
 * Stops early if the maximum possible similarity is below the threshold.
 * @param a - First set.
 * @param b - Second set.
 * @param threshold - Minimum similarity threshold.
 * @returns The Jaccard similarity score, or -1 if below threshold.
 */
export function jaccardSimilarityWithThreshold(
  a: Set<string>,
  b: Set<string>,
  threshold: number,
): number {
  if (a.size === 0 && b.size === 0) return 0;

  const smallerSet = a.size < b.size ? a : b;
  const largerSet = a.size < b.size ? b : a;

  // Early termination: if |smaller| / |larger| < threshold, similarity cannot reach threshold
  if (smallerSet.size / largerSet.size < threshold) {
    return -1;
  }

  let intersectionSize = 0;
  const maxPossibleIntersection = smallerSet.size;
  const minRequiredIntersection = Math.ceil(
    threshold * (a.size + b.size - maxPossibleIntersection),
  );

  for (const item of smallerSet) {
    if (largerSet.has(item)) {
      intersectionSize++;
      // Early termination: if we can't reach the threshold even with all remaining matches
      if (intersectionSize >= minRequiredIntersection) {
        const unionSize = a.size + b.size - intersectionSize;
        return intersectionSize / unionSize;
      }
    }
  }

  // Check if we met the threshold
  const unionSize = a.size + b.size - intersectionSize;
  const similarity = intersectionSize / unionSize;
  return similarity >= threshold ? similarity : -1;
}
