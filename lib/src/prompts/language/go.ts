import type { LanguageModule } from './index.js';

/**
 * Go-specific review guidance: goroutine lifecycle, errcheck, interface
 * design, defer usage, and the Go ecosystem security surface.
 */
export const goModule: LanguageModule = {
  language: 'go',
  prompt: `## Go-Specific Review Checklist

This PR contains Go files. Apply the following Go-specific guidance in addition to the generic checklist.

**Goroutine lifecycle:**
- Verify every goroutine launched has a defined shutdown path — missing \`sync.WaitGroup\`/\`Done()\` calls, or goroutines that outlive their scope.
- Check channel usage for leaks: sends that block forever because the receiver is gone, receivers never closed.
- Flag goroutines spawned per-request without cancellation (\`context.Context\` ignored or not propagated).
- Check \`go\` statements in loops capturing the loop variable (Go < 1.22 semantics) or incorrect closures.

**Error handling (\`errcheck\`):**
- Flag ignored errors from function calls — \`_, _ = ...\`, bare \`_ = f()\`, or missing checks on \`io.Copy\`, \`rows.Close()\`, \`file.Close()\`, \`http.Client.Do\`.
- Verify \`defer\` on closers also handles the returned error (e.g. \`defer func() { err = c.Close() }\` patterns where the error matters).
- Check error wrapping — use \`fmt.Errorf(... %w ...)\` with \`errors.Is\`/\`errors.As\`, not string matching on \`err.Error()\`.

**Interface design:**
- Flag overly large interfaces (interface pollution) that force implementers to stub unused methods.
- Verify interfaces are defined at the consumer side rather than the producer side (Go idiom).
- Check unnecessary abstraction where a concrete type suffices.

**\`defer\` usage:**
- Flag \`defer\` inside loops (deferred work accumulates until function return) — move to a helper function.
- Check \`defer\` placement: resources deferred after the error path that should be deferred immediately after acquisition.
- Beware \`defer\` in hot loops affecting performance.

**Slices & nil semantics:**
- Flag relying on \`nil\` slice vs empty slice distinctions where behavior differs (e.g. JSON marshaling, ranging).
- Check \`append\` reuse/capacity assumptions and aliasing bugs (\`s = append(s1, ...)\` sharing backing arrays).

**Performance:**
- \`string\` ↔ \`[]byte\` conversions in hot paths (each conversion allocates).
- Flag excessive allocations in loops; consider builder patterns for concatenation.
- Check \`sync.Mutex\` vs \`sync.RWMutex\` choice for read-heavy workloads.

**Security (Go ecosystem):**
- Cryptographic randomness: \`math/rand\` for secrets/tokens/IDs — must use \`crypto/rand\`.
- SQL injection via string concatenation/fmt building queries — require parameterized queries (\`?\\\` placeholders).
- \`unsafe\` package usage without clear justification.
- \`os/exec\`/shell invocation with untrusted input; path traversal in file operations.`,
};

export default goModule;
