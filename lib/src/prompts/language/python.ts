import type { LanguageModule } from './index.js';

/**
 * Python-specific review guidance: type hints, None handling, context
 * managers, dunder methods, and the Python ecosystem security surface.
 */
export const pythonModule: LanguageModule = {
  language: 'python',
  prompt: `## Python-Specific Review Checklist

This PR contains Python files. Apply the following Python-specific guidance in addition to the generic checklist.

**Type hints:**
- Check for missing type annotations on public functions and APIs.
- Flag misuse of \`Optional[X]\` vs \`Union[X, None]\` and missing generic parameters (\`list[T]\`, \`dict[K, V]\`).
- Verify overloads (\`@overload\`) match the actual runtime behavior.
- Flag type mismatches that a checker like mypy/pyright would catch (assigning \`None\` to non-optional, wrong return types).

**\`None\` vs falsy confusion:**
- Flag \`== None\` / \`!= None\` — must be \`is None\` / \`is not None\`.
- Flag relying on falsy truthiness for \`None\` checks (\`if not x\` when \`x\` can be an empty list/dict/string or 0).
- Check for \`None\` values passed into operations that will raise \`AttributeError\`/\`TypeError\` without a guard.

**Context managers & resource handling:**
- Verify files, sockets, DB connections, and locks are opened with \`with\` statements (not manual \`open()\` without \`close()\`).
- Check custom \`__enter__\`/\`__exit__\` implementations handle exceptions and clean up resources.
- Flag \`contextlib.suppress\`/broad \`except\` that swallows meaningful errors.

**Dunder methods:**
- Verify \`__init__\`, \`__enter__\`, \`__exit__\`, \`__eq__\`/\`__hash__\` have correct signatures and consistent semantics (defining \`__eq__\` without \`__hash__\` breaks dict/set use).
- Check \`__str__\` vs \`__repr__\` — repr should be unambiguous and suitable for debugging.

**Anti-patterns:**
- Mutable default arguments (\`def f(x=[])\` / \`x={}\`) — must default to \`None\`.
- Bare \`except:\` and over-broad \`except Exception\` that hide programming errors.
- \`import *\` — pollutes namespace and hides the source of names.
- Unused imports and dead code left behind after refactors.

**Performance:**
- List comprehensions over explicit loops where clarity is unchanged; generator expressions over building large intermediate lists.
- Repeated attribute/function lookups in hot loops (hoist out of loop).
- Prefer f-strings over \`%\` formatting and \`+\` concatenation.

**Security (Python ecosystem):**
- \`eval()\` / \`exec()\` on any untrusted input — flag as critical.
- \`pickle\`/\`shelve\` deserialization of untrusted data (arbitrary code execution) — flag as critical.
- SQL injection via f-strings or \`format()\` building SQL — require parameterized queries.
- \`os.system\`/\`subprocess\` with \`shell=True\` on untrusted input.`,
};

export default pythonModule;
