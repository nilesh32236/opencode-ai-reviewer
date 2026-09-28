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
| `action/src/comment-commands.ts` | Slash-command allowlist + fail-closed authorization gate (action side) |
| `app/src/utils/privilege.ts` | `isPrivilegedAuthor` / `satisfiesPrivilegeGate` fail-closed gating (app side) |
| `.github/scripts/sec001-artifact.sh` | Cross-job patch/status metadata, checksum, base-SHA, path, symlink, and scope validation |
| `.github/scripts/sec001-supervisor.sh` / `sec001-run-gates.sh` | Root-owned verification supervisor; non-sudo candidate UID, immutable snapshots, fresh per-gate copies, and protected worktree state |
| `.github/scripts/sec001-finalize-status.sh` | Fresh-job status finalization; successful supervisor conclusion, task/result/head binding, and checksummed status/log artifacts |
| `.github/scripts/sec001-trusted-publish.sh` | Fresh-clone, exact-repository, scrubbed-environment, hook-suppressed, lease-protected GitHub publishing |
| `.github/scripts/sec001-hourly-*.sh` | Provider-only hourly agent work and secret-free verification/publish handoff |
| `.github/workflows/self-improvement.yml` / `hourly-orchestrator.yml` | Separate agent, verification, repair, and credentialed publish runners; human merge gates remain authoritative |

Notes:

- There is no `action/src/privilege.ts`; privilege gating is split between
  `action/src/comment-commands.ts` and `app/src/utils/privilege.ts` as above.
- Any change to these files must ship with regression tests proving the
  boundary still holds, and must be called out explicitly in the PR for
  security review. Never weaken one to simplify a refactor.
- SEC-001's job boundary removes GitHub credentials from model and lifecycle
  process trees. Verification authority is the trusted workflow shell's actual
  gate exit/job conclusion; model-writable raw status files are diagnostic only
  and cannot promote a failed job. Raw agent/repair artifacts are revalidated
  and repackaged in fresh no-secret jobs, while finalizers bind complete
  task/result/head sets and produce the canonical status consumed by publish.
- Candidate gate code runs as a distinct non-sudo UID under a root-owned
  supervisor. Each normal gate receives a fresh copy of an immutable snapshot;
  inode/worktree replacement, cross-gate writes, supervisor-script rewrites, and
  sudo escalation are rejected.
- The selected provider credential remains inside the OpenCode process and may
  be inherited by OpenCode's own model/tool subprocesses; this residual is
  documented rather than claimed to be sandboxed.

## No business logic in HTTP routes / event handlers

- `platform/src/routes/*`, `platform/src/webhooks.ts`, `app/src/handlers/*`,
  `app/src/subscribers/*` do transport work only: auth, shape checks, dispatch,
  response mapping. Decisions live in `lib` or, for wrapper-specific policy,
  in the wrapper's `utils/` (e.g. `app/src/utils/privilege.ts`,
  `app/src/utils/repo-filter.ts`).
