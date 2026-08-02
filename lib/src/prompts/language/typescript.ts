import type { LanguageModule } from './index.js';

/**
 * TypeScript/JavaScript-specific review guidance: strict mode, null safety,
 * discriminated unions, generics, and the JS/TS ecosystem security surface.
 * Applies to .ts, .tsx, .js, .jsx, .mjs, and .cjs files.
 */
export const typescriptModule: LanguageModule = {
  language: 'typescript',
  prompt: `## TypeScript-Specific Review Checklist

This PR contains TypeScript/JavaScript files. Apply the following language-specific guidance in addition to the generic checklist. Items that mention \`strict mode\` apply to \`.ts\`/\`.tsx\` files under \`strict: true\` only; plain \`.js\`/\`.jsx\` files should still be checked for the runtime-safe patterns below.

**Strict mode & type safety (TypeScript only):**
- Flag \`noImplicitAny\` violations — parameters/returns relying on implicit \`any\`.
- Flag \`strictNullChecks\` violations — assigning \`null\`/\`undefined\` to non-nullable types.
- Flag \`any\` leakage: functions returning \`any\` that erode type safety across module boundaries; prefer \`unknown\` for external/untrusted data and narrow it.
- Check \`@ts-ignore\`/\`@ts-expect-error\` usage — are the underlying issues addressed rather than suppressed?

**\`null\` vs \`undefined\` handling:**
- Flag mixing \`null\` and \`undefined\` semantics inconsistently across an API surface.
- Prefer optional chaining (\`a?.b\`) over non-null assertions (\`a!.b\`) unless the invariant is proven.
- Flag \`!\` non-null assertions on values derived from untrusted or runtime input.
- Use \`??\` (nullish coalescing) instead of \`||\` when falsy values (0, \`''\`, \`false\`) are meaningful.

**Discriminated unions & state machines:**
- Verify state transitions are modeled with discriminated unions (\`type: 'idle' | 'loading' | ...\`) rather than loose boolean flags.
- Check exhaustive \`switch\`/conditional handling — is there a default that silently swallows unknown states?
- Flag overlapping/ambiguous discriminant values.

**Generics:**
- Avoid over-constraining generics that force \`as\` casts on callers; avoid under-constraining that loses type info.
- Check generic constraints match runtime usage (e.g. \`T extends\` bounds honored).
- Flag unnecessary type assertions that could be expressed through generics.

**Framework & idioms (when applicable):**
- Next.js App Router: correct \`'use client'\`/\`'use server'\` boundaries, no server-only data/secret exposure to client components.
- React: keys on list items, stable \`useMemo\`/\`useCallback\` deps, avoiding setState in render.

**Performance:**
- \`useMemo\`/\`useCallback\` correctness — deps arrays accurate, no stale closures.
- Bundle size: large synchronous imports where dynamic import would help; unused exports/imports.
- Avoid heavy work in render/hot paths; avoid blocking the main thread in the browser.

**Security (JS/TS ecosystem):**
- XSS via \`dangerouslySetInnerHTML\`/innerHTML with untrusted content — flag as critical.
- SQL injection via raw string-built queries — require parameterized queries.
- \`eval()\`, \`new Function()\`, \`child_process\` with untrusted input.
- Secrets/tokens in client bundles or committed files.
- \`npm\`/dependency issues: malformed \`package.json\` versions, vulnerable patterns (no obvious versions pinned where required).`,
};

export default typescriptModule;
