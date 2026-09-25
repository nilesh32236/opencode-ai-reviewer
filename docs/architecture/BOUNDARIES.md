# Package & Security Boundaries

## Package dependency directions

| From (wrapper) | To | Via | Status |
|---|---|---|---|
| `@opencode-pr-agent/action` | `@opencode-pr-agent/lib` | `from '@opencode-pr-agent/lib'` (28 import sites) | ALLOWED |
| `@opencode-pr-agent/app` | `@opencode-pr-agent/lib` | `from '@opencode-pr-agent/lib'` (83 import sites) | ALLOWED |
| `opencode-reviewer` (cli) | `@opencode-pr-agent/lib` | `from '@opencode-pr-agent/lib'` (8 import sites) | ALLOWED |
| `@opencode-pr-agent/platform` | `@opencode-pr-agent/lib` | `from '@opencode-pr-agent/lib'` (12 import sites) | ALLOWED |
| `@opencode-pr-agent/lib` | any wrapper | — (none found; remaining hits are string literals/comments only) | FORBIDDEN |

Rules:

- Wrappers import `lib` only through the `@opencode-pr-agent/lib` package
  specifier. Relative imports reaching into another package (`../../lib/...`)
  are forbidden (none exist today).
- `lib` must never import `action`, `app`, `cli`, or `platform`.
  Any such import is a FORBIDDEN finding and must be removed, not worked around.
- Full edge list with example import paths: see `dependency-graph.json`.

## Wrapper-thin-adapter rule

- `action/src` (`index.ts` 975-line dispatcher, `fix.ts` 2043-line autofix loop,
  `inputs.ts` 907-line parser), `app/src` (Probot; `index.ts` + `handlers/` +
  `subscribers/`), `cli/src` (local CLI), `platform/src` (Express + BullMQ +
  `platform/web` Vite dashboard) must stay thin adapters:
  parse/validate inputs → call `lib` → format/deliver outputs.
- Shared domain logic (review orchestration, batching, verification, MCP,
  prompts, verdicts, output formatting, git ops) lives in `lib`
  (`lib/src/engine.ts`, `lib/src/opencode.ts`, `lib/src/config.ts`, …).
- If two wrappers need the same logic, it moves down into `lib`; wrappers never
  import from each other.

## Security-boundary files (changes need regression tests + review)

| File | Boundary enforced |
|---|---|
| `lib/src/utils/safe-exec.ts` | Linter-command allowlists, destructive-fix ceiling, path confinement, SSRF guards |
| `lib/src/utils/validation.ts` | ref/SHA/slug validation, run-checks command validation |
| `lib/src/utils/secret-detect.ts` | Secret/credential detection (values always redacted) |
| `lib/src/utils/sanitize.ts` | Credential-pattern redaction for logs/display |
| `lib/src/utils/prompt-sanitizer.ts` | Untrusted-input wrapping for prompt injection defense |
| `app/src/utils/exec.ts` | `isolateEnv` / `buildRestrictedEnv` restricted-environment model |
| `lib/src/utils/workflow-isolation.ts` | Workflow trust boundary: verify allowlist (zero secrets), single-key agent env, trusted push env with hooks disabled, fail-closed provider mapping (REF-006) |
| `action/src/comment-commands.ts` | Slash-command allowlist + fail-closed authorization gate (action side) |
| `app/src/utils/privilege.ts` | `isPrivilegedAuthor` / `satisfiesPrivilegeGate` fail-closed gating (app side) |

Notes:

- There is no `action/src/privilege.ts`; privilege gating is split between
  `action/src/comment-commands.ts` and `app/src/utils/privilege.ts` as above.
- Any change to these files must ship with regression tests proving the
  boundary still holds, and must be called out explicitly in the PR for
  security review. Never weaken one to simplify a refactor.

## Workflow secret-isolation boundary (REF-006, issue #776)

- Untrusted: same-repo PR checkout tree, `opencode run --auto` tool
  subprocesses, and `pnpm build/typecheck/test/lint` lifecycle scripts.
- Trusted: `gh` API calls, green-checks gate, merge-approval gate, and
  post-agent `git push`/`gh pr create` steps that run no repo-controlled code.
- Rules:
  - Verification env: `buildWorkflowVerifyEnv` allowlist only (zero secrets,
    no runner `HOME`, no `GIT_ASKPASS`, no npm auth material).
  - Agent env: `buildWorkflowAgentEnv` adds exactly one provider key resolved
    by `resolveWorkflowProviderKey` from the configured model; unknown
    provider or missing key fails closed with no fallback/substitution.
  - Trusted push env: `buildTrustedGitEnv` with ephemeral `GIT_ASKPASS`,
    `GIT_TERMINAL_PROMPT=0`, and `git -c core.hooksPath=/dev/null` so
    PR-controlled hooks cannot run under a token-bearing step.
  - Checkout must use `persist-credentials: false`; credentialed git ops use
    ephemeral ask-pass auth in trusted steps only (see `.fix-summary.md` for
    the exact `.github/workflows` step-split patch, which requires CI
    permissions to land).

## No business logic in HTTP routes / event handlers

- `platform/src/routes/*`, `platform/src/webhooks.ts`, `app/src/handlers/*`,
  `app/src/subscribers/*` do transport work only: auth, shape checks, dispatch,
  response mapping. Decisions live in `lib` or, for wrapper-specific policy,
  in the wrapper's `utils/` (e.g. `app/src/utils/privilege.ts`,
  `app/src/utils/repo-filter.ts`).
