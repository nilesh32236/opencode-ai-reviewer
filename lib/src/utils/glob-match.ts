import { Minimatch } from 'minimatch';

/**
 * A pre-compiled glob predicate. Returns true when `value` matches any of the
 * patterns it was compiled from.
 */
export type CompiledGlobMatcher = (value: string) => boolean;

/**
 * Compile a list of globs into a single reusable predicate.
 *
 * `minimatch()`'s top-level helper constructs a fresh `Minimatch` (a full
 * brace-expand → glob-to-regex compile) on **every** call, so the idiomatic
 * `patterns.some((p) => minimatch(value, p))` inside a per-file loop recompiles
 * every pattern for every value — O(files × patterns) compiles, all of it
 * synchronous CPU on the event loop. Compiling once per call site turns that
 * into O(patterns) compiles plus O(files × patterns) cheap regex tests.
 *
 * Unparseable patterns are dropped (a malformed glob must not fail the scan)
 * and an empty pattern list yields a predicate that never matches.
 *
 * @param patterns - Glob patterns to compile.
 * @returns A predicate matching any of `patterns`.
 */
export function compileGlobPatterns(patterns: readonly string[] | undefined): CompiledGlobMatcher {
  const compiled: Minimatch[] = [];
  for (const pattern of patterns ?? []) {
    if (typeof pattern !== 'string' || pattern.length === 0) continue;
    try {
      compiled.push(new Minimatch(pattern));
    } catch {
      // Malformed glob: ignore it rather than throwing from a filter path.
    }
  }
  if (compiled.length === 0) return () => false;
  return (value: string): boolean => {
    for (const matcher of compiled) {
      if (matcher.match(value)) return true;
    }
    return false;
  };
}
