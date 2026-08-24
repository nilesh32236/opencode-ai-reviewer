## 2026-07-21 - Optimize jaccardSimilarity and regex instantiation
**Learning:** Found that recreating array/set unions in `jaccardSimilarity` creates high GC pressure in loops. Computing union mathematically via `size` and iterating on the smaller set yields ~6x speedup. Furthermore, regexes inside heavily used functions (like `tokenize`) should be hoisted.
**Action:** Always compute Jaccard similarity without allocating temporary Sets or Arrays. Hoist regex pre-compilation.
**Refs:** `lib/src/pattern-detector/cluster.ts:39` (`jaccardSimilarity`), `lib/src/pattern-detector/cluster.ts:22` (`tokenize`), `lib/src/pattern-detector/minhash-optimized.ts:300` (`jaccardSimilarity`), `lib/src/pattern-detector/minhash-optimized.ts:66` (`tokenizeMessage`).
## 2026-07-22 - Optimize PatternDetector discoveries
**Learning:** Found that finding file extensions inside `PatternDetector.discover` used inefficient `.map().filter()` chains and nested `.some()` loops, creating O(N*M) complexity and redundant allocations. Additionally, regex compilation in the loop was un-hoisted.
**Action:** Replaced array chains with a single `Set` iteration and O(1) lookup. Hoisted the non-alphanumeric regex.
**Refs:** `lib/src/pattern-detector/cluster.ts:61-110` (`PatternDetector.discover` file-extension discovery and cluster loop).
## 2026-07-24 - Use Promise.all for concurrent async operations
**Learning:** Found sequential `await` loops inside `MetaReviewEngine.runMetaReview` when adding custom rules. Sequential awaits add unnecessary latency, especially since each DB/API insert operation is independent and can be safely batched.
**Action:** Replace `for (const item of items) { await asyncOp(item) }` with `await Promise.all(items.map(asyncOp))` for independent asynchronous tasks to reduce execution time.
**Refs:** `lib/src/meta-review/engine.ts:145` (bounded `Promise.all` for pattern/rule additions).
## 2026-07-26 - Optimize RegExp in conversation detectIntent
**Learning:** Found that recreating regular expressions inside a `.some()` loop dynamically from constants causes unnecessary allocation and compile time upon every `detectIntent` execution.
**Action:** Always hoist and pre-compile regular expressions from static data arrays outside of functions executing on the hot path.
**Refs:** `lib/src/prompts/conversation.ts:55` (hoisted regexes), `lib/src/prompts/conversation.ts:72` (`detectIntent`).
## 2026-07-27 - Optimize JSONL parsing (Regex Hoisting & Async I/O)
**Learning:** Found that `codePatterns` in `looksLikeCode` and markdown regexes in `stripMarkdownFences` were being recompiled and reallocated on every function call. Also found synchronous `fs.readFileSync` inside an async function (`parseJsonlFile`) which blocks the event loop on large files.
**Action:** Always hoist regular expressions to module scope to avoid recompilation overhead. Always use asynchronous file I/O operations (`fs.promises.readFile`) inside async functions.
**Refs:** `lib/src/jsonl-parser.ts:30` (`stripMarkdownFences`), `lib/src/jsonl-parser.ts:54` (`parseJsonlFile`), `lib/src/jsonl-parser.ts:578` (`looksLikeCode`).
## 2026-07-30 - Optimize JsonDatabase save() with debounced async I/O
**Learning:** Found that `JsonDatabase.save()` called `this.flushSync()` which performed synchronous file writing blocking the main thread on every mutation. By using `setTimeout` to debounce the call by 100ms and writing asynchronously using `writeToDisk()`, we drastically reduce redundant I/O operations and prevent blocking during batch processing.
**Action:** Always debounce repeated write operations and use async file APIs like `fs.promises.writeFile` rather than synchronous alternatives like `fs.writeFileSync`.
**Refs:** `lib/src/learning/json-db.ts:195` (`save()`), `lib/src/learning/json-db.ts:177` (`flushSync()`), `lib/src/learning/json-db.ts:173` (`writeToDisk()`).
## 2026-08-09 - Optimize clustering tokenization and Jaccard similarity
**Learning:** Found that `cluster.ts` was redundantly tokenizing strings and computing exhaustive Jaccard similarities, despite an optimized, cached `tokenizeMessage` and early-terminating `jaccardSimilarityWithThreshold` existing in `minhash-optimized.ts`.
**Action:** Replaced the local `tokenize` and `jaccardSimilarity` functions in `cluster.ts` with the optimized imports from `minhash-optimized.ts` to reduce redundant string allocation and early-exit exhaustive set comparisons.
**Refs:** `lib/src/pattern-detector/cluster.ts:22,39` (`tokenize`, `jaccardSimilarity` replaced by `lib/src/pattern-detector/minhash-optimized.ts:66,300`).
## 2026-08-12 - Optimize truncateUtf8Bytes allocation overhead
**Learning:** Found that iterating over strings using `for (const codePoint of text)` allocates iterators and strings inside a loop causing high GC pressure. While Buffer.from(text, "utf8") is still O(N) over the full string for the encode, the per-codepoint iteration and allocations are eliminated and the boundary scan walk-back is O(1). It is much faster to allocate a Buffer from the string, jump to the `maxBytes` length, and walk backwards to the start of the UTF-8 character boundary (checking `(buf[end] & 0xc0) === 0x80`).
**Action:** Always compute string truncations on a Buffer view directly rather than character by character.
## 2026-08-16 - Optimize Set allocation in pattern discovery
**Learning:** Found that `[...new Set(findings.map((f) => f.message).filter(Boolean))]` iterates over the `findings` array multiple times and creates intermediate arrays for mapping and filtering before initializing the Set. This causes unnecessary memory allocations and GC pressure.
**Action:** Always use a single iteration loop over the original array to populate a Set directly without intermediate map/filter chains.
**Refs:** `lib/src/pattern-detector/engine.ts:74` (deduplicating messages for clustering).
## 2026-08-17 - Optimize PatternDetector discoveries sets
**Learning:** Found that finding file extensions inside `PatternDetector.discover` created unnecessary nested sets and loops over findings. Computing file types alongside frequencies with `Map<string, Set<string>>` reduces `findings.filter` iterations. Found that `[...new Set(clusters.flatMap((c) => c.messages))]` created unneeded allocations by flatMapping an intermediate array, converting it to Set. We can directly iterate over the original clusters to add to the set.
**Action:** Always combine frequency maps and metadata tracking where feasible, and use single-iteration manual nested loops instead of `flatMap` on sets for efficiency.
**Refs:** `lib/src/pattern-detector/engine.ts:85` (deduplicating messages for clustering).
## 2026-08-20 - Optimize Map allocation in blame data filtering
**Learning:** Found that `new Map(batch.map().filter().flatMap())` in `Engine.runReviewPipeline` iterates over the batch multiple times and creates intermediate arrays, causing unnecessary memory allocations and GC pressure in a hot path.
**Action:** Always use a single iteration loop over the original array to populate a Map directly without intermediate array allocation chains.
**Refs:** `lib/src/engine.ts:1250` (batchBlameData population).
## 2026-08-21 - Use typed arrays for MinHash clustering
**Learning:** Found that `cluster.ts` was using the older MinHash implementation which computes `number[]` arrays and uses `number[][]` for signatures. By switching to `Uint32Array` signatures from `minhash-optimized.ts` (`computeMinHashSignature` and `lshCandidatesTyped`), memory allocation is more efficient and we avoid creating millions of standard array items on large inputs, reducing GC pressure and speeding up clustering.
**Action:** Always prefer `Uint32Array` or typed arrays for purely numerical processing like hash arrays or clustering signatures to minimize GC pressure and memory usage overhead.
**Refs:** `lib/src/pattern-detector/cluster.ts`
## 2026-08-24 - Optimize Set/Array allocation in mapping and filtering
**Learning:** Found multiple instances where `.map().filter()` chains were used to extract specific data from arrays (e.g. `batch.map((f) => f?.path).filter(Boolean)`). These chains iterate over the array multiple times and create intermediate array allocations. Converting these to single-pass loops that directly populate the target `Set` or `Array` avoids this overhead and reduces GC pressure.
**Action:** Replace `.map().filter()` chains with single-pass loops (`for...of` or `for (let i = 0...)`) when extracting and filtering data into Sets or Arrays.
**Refs:** `lib/src/engine.ts`, `lib/src/utils/github.ts`, `lib/src/sca/osv-client.ts`.
