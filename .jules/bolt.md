## 2024-07-21 - Optimize jaccardSimilarity and regex instantiation
**Learning:** Found that recreating array/set unions in `jaccardSimilarity` creates high GC pressure in loops. Computing union mathematically via `size` and iterating on the smaller set yields ~6x speedup. Furthermore, regexes inside heavily used functions (like `tokenize`) should be hoisted.
**Action:** Always compute Jaccard similarity without allocating temporary Sets or Arrays. Hoist regex pre-compilation.
## 2026-07-22 - Optimize PatternDetector discoveries
**Learning:** Found that finding file extensions inside `PatternDetector.discover` used inefficient `.map().filter()` chains and nested `.some()` loops, creating O(N*M) complexity and redundant allocations. Additionally, regex compilation in the loop was un-hoisted.
**Action:** Replaced array chains with a single `Set` iteration and O(1) lookup. Hoisted the non-alphanumeric regex.
