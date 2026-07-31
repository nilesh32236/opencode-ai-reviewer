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
 * FNV-1a style 32-bit string hash with a Murmur3-style finalizer for good
 * avalanche. Non-cryptographic but fast and sufficiently uniform for MinHash.
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
 * Uses the same mix32-based primary/secondary construction as
 * `computeMinHashSignature` so the public primitive is consistent with the
 * production path; `Math.imul` keeps every multiply a true 32-bit operation
 * regardless of salt magnitude.
 * @param token - The token to hash.
 * @param salt - Salt value selecting the hash function.
 * @returns A uint32 hash value in the range [0, 2^32).
 */
export function hashToken(token: string, salt: number): number {
  const base = mix32(token);
  const primary = (base ^ Math.imul(salt, PRIMARY_HASH_SALT)) >>> 0;
  const secondary = (Math.imul(base ^ Math.imul(salt, SECONDARY_HASH_SALT), 0xc2b2ae35) >>> 0) | 1;
  return (primary + secondary) >>> 0;
}

/**
 * Compute a MinHash signature for a token set.
 * Each token is hashed once; every signature entry k is the minimum over
 * tokens of `primary + k * secondary (mod 2^32)`, which approximates k
 * independent pseudo-random permutations. Identical token sets produce
 * identical signatures.
 *
 * Note: empty token sets produce all-zero signatures. Because every empty or
 * identically-tokenized message then shares every LSH band, such messages all
 * become candidates for one another (up to C(n,2) pairs). Exact Jaccard
 * verification discards those candidates, so this is a performance concern,
 * not a correctness one; callers should skip empty token sets before
 * signature computation where large such inputs are expected.
 * @param tokens - Set of tokens to summarize.
 * @param numHashes - Number of hash functions (signature length).
 * @returns Array of `numHashes` minimum hash values.
 */
export function computeMinHashSignature(
  tokens: Set<string>,
  numHashes: number = MINHASH_SIGNATURE_SIZE,
): number[] {
  if (tokens.size === 0) return new Array<number>(numHashes).fill(0);

  const signature = new Array<number>(numHashes).fill(0xffffffff);
  for (const token of tokens) {
    const base = mix32(token);
    const primary = (base ^ PRIMARY_HASH_SALT) >>> 0;
    const secondary = (Math.imul(base ^ SECONDARY_HASH_SALT, 0xc2b2ae35) >>> 0) | 1;
    for (let k = 0; k < numHashes; k++) {
      const hash = (primary + Math.imul(k, secondary)) >>> 0;
      if (hash < signature[k]) signature[k] = hash;
    }
  }
  return signature;
}

/**
 * Generate candidate index pairs whose MinHash signatures share at least one
 * LSH band. Each signature is split into `bands` bands of `rows` rows; items
 * landing in the same band bucket are treated as candidate similar pairs.
 * Bucket keys are 32-bit integer hashes of the band rows — rare key collisions
 * only add spurious candidates, which exact Jaccard verification discards.
 * All-zero signatures (e.g. from empty token sets) all land in the same bucket,
 * so large sets of them degrade to all-pairs candidates; see
 * `computeMinHashSignature`.
 * Returns a deduplicated set of index pairs `(i, j)` with `i < j`.
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
          pairKeys.add(i < j ? `${i}:${j}` : `${j}:${i}`);
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
