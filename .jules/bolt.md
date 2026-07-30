## 2026-07-21 - Optimize jaccardSimilarity and regex instantiation
**Learning:** Found that recreating array/set unions in `jaccardSimilarity` creates high GC pressure in loops. Computing union mathematically via `size` and iterating on the smaller set yields ~6x speedup. Furthermore, regexes inside heavily used functions (like `tokenize`) should be hoisted.
**Action:** Always compute Jaccard similarity without allocating temporary Sets or Arrays. Hoist regex pre-compilation.
## 2026-07-22 - Optimize PatternDetector discoveries
**Learning:** Found that finding file extensions inside `PatternDetector.discover` used inefficient `.map().filter()` chains and nested `.some()` loops, creating O(N*M) complexity and redundant allocations. Additionally, regex compilation in the loop was un-hoisted.
**Action:** Replaced array chains with a single `Set` iteration and O(1) lookup. Hoisted the non-alphanumeric regex.
## 2026-07-24 - Use Promise.all for concurrent async operations
**Learning:** Found sequential `await` loops inside `MetaReviewEngine.runMetaReview` when adding custom rules. Sequential awaits add unnecessary latency, especially since each DB/API insert operation is independent and can be safely batched.
**Action:** Replace `for (const item of items) { await asyncOp(item) }` with `await Promise.all(items.map(asyncOp))` for independent asynchronous tasks to reduce execution time.
## 2026-07-26 - Optimize RegExp in conversation detectIntent
**Learning:** Found that recreating regular expressions inside a `.some()` loop dynamically from constants causes unnecessary allocation and compile time upon every `detectIntent` execution.
**Action:** Always hoist and pre-compile regular expressions from static data arrays outside of functions executing on the hot path.
## 2026-07-27 - Optimize JSONL parsing (Regex Hoisting & Async I/O)
**Learning:** Found that `codePatterns` in `looksLikeCode` and markdown regexes in `stripMarkdownFences` were being recompiled and reallocated on every function call. Also found synchronous `fs.readFileSync` inside an async function (`parseJsonlFile`) which blocks the event loop on large files.
**Action:** Always hoist regular expressions to module scope to avoid recompilation overhead. Always use asynchronous file I/O operations (`fs.promises.readFile`) inside async functions.
## 2026-07-30 - Optimize JsonDatabase save() with debounced async I/O
**Learning:** Found that `JsonDatabase.save()` called `this.flushSync()` which performed synchronous file writing blocking the main thread on every mutation. By using `setTimeout` to debounce the call by 100ms and writing asynchronously using `writeToDisk()`, we drastically reduce redundant I/O operations and prevent blocking during batch processing.
**Action:** Always debounce repeated write operations and use async file APIs like `fs.promises.writeFile` rather than synchronous alternatives like `fs.writeFileSync`.
