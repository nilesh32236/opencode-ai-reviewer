import type { LanguageModule } from './index.js';

/**
 * Rust-specific review guidance: ownership, borrowing, unsafe, unwrap,
 * Send + Sync bounds, and the Rust ecosystem security surface.
 */
export const rustModule: LanguageModule = {
  language: 'rust',
  prompt: `## Rust-Specific Review Checklist

This PR contains Rust files. Apply the following Rust-specific guidance in addition to the generic checklist.

**Ownership & borrowing:**
- Check \`&T\` vs \`&mut T\` — is the borrow actually needed, and is it held longer than necessary?
- Flag borrowed data returned from functions that own it (dangling references / borrow-after-move).
- Check for \`clone()\` on large data structures in hot paths where a borrow would do.
- Verify \`Rc\`/\`RefCell\` usage — prefer \`Arc\` for shared ownership across threads and check for \`RefCell\` borrow panics.

**\`unwrap\` / \`expect\` / panic safety:**
- Flag unconditional \`unwrap()\` / \`expect()\` on values that can fail at runtime (network, IO, parse, deserialization, arithmetic overflow).
- Prefer \`ok()\`, \`map_err()\`, \`?/Result\`, or explicit \`match\` for recoverable errors.
- Check \`panic!\`, \`assert!\`, indexing (which panics) on untrusted or runtime input.

**\`unsafe\` blocks:**
- Verify every \`unsafe\` block has a comment justifying why it is safe and what invariant it upholds.
- Flag \`unsafe\` dereferencing raw pointers derived from untrusted input.
- Check \`transmute\` / \`from_utf8_unchecked\` / \`get_unchecked\` — are the invariants genuinely proven?

**Concurrency (\`Send\` + \`Sync\`):**
- Check that types crossing threads are \`Send\`/\`Sync\`; flag \`static mut\`, non-\`Sync\` statics, or \`thread_local\` misuse.
- Verify lock usage (\`Mutex\`, \`RwLock\`) — no lock held across async/await points, no obvious deadlock ordering.
- Check \`mpsc\`/channel usage for senders never dropped or receivers never drained (resource/thread leaks).

**\`Result\` vs \`Option\` confusion:**
- Flag \`ok_or_else\` / \`unwrap_or\` misuse that hides the actual error.
- Check \`?/\` on \`Option\` where the caller expects a \`Result\` with context.

**Performance:**
- Redundant allocations: \`Vec<String>\` where \`&[&str]\` suffices, \`String\` concat in loops (\`+=\`), \`to_owned()\` in hot paths.
- \`HashMap\` default hasher in hot loops; \`BTreeMap\` vs \`HashMap\` selection.
- \`Box\`/indirection where inline layout is cheaper.

**Security (Rust ecosystem):**
- \`unsafe\` pointer arithmetic and buffer handling (buffer overflow risk in unsafe code).
- Parsing untrusted data (serde) — check \`deny_unknown_fields\`, no \`from_json\`-style implicit expansion.
- Cryptographic randomness — reject \`rand\` crate's non-crypto RNG for secrets/tokens; require \`getrandom\`/\`rand::rngs::OsRng\`.
- Secrets: no keys/tokens in source or logs.`,
};

export default rustModule;
