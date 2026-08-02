/**
 * Deterministic seeded pseudo-random helpers for fuzz/property tests.
 *
 * All fuzz inputs are derived from a fixed constant seed so CI failures are
 * reproducible. Do NOT use `Date.now()` or other non-deterministic seeds here.
 */

/** A seeded pseudo-random number generator returning values in [0, 1). */
export type SeededRandom = () => number;

/**
 * Create a mulberry32 PRNG from a fixed seed. Fully deterministic: the same
 * seed always produces the same sequence, making fuzz failures reproducible.
 * @param seed - Fixed integer seed.
 * @returns A function returning pseudo-random values in [0, 1).
 */
export function mulberry32(seed: number): SeededRandom {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate a random string of `length` bytes drawn from the full 0x00-0xFF
 * range, including control characters and binary data.
 * @param rand - A seeded random function.
 * @param length - Number of characters to generate.
 * @returns A random byte-string.
 */
export function randomBytes(rand: SeededRandom, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(Math.floor(rand() * 256));
  }
  return out;
}
