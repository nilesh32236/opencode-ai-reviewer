# Workflow Secret-Isolation Boundary (REF-006 / Issue #776)

## Status

Blocked on human design approval for the separate-job/artifact redesign
(SEC-001). Same-job `env -i` is NOT an approved boundary on a same-UID
runner. This note records the intended end state and the additive primitives
that end state can share. It does not claim isolation that is not proven.

## Trust boundary (precise)

- The OpenCode model process receives exactly ONE credential: the provider key
  required for the selected `vars.OPENCODE_MODEL` (default
  `opencode/muse-spark-1.3-contributor-free` → `OPENCODE_API_KEY`). No
  `GITHUB_TOKEN`/`GH_TOKEN`, no unrelated provider keys.
- Lifecycle/verification commands (`pnpm build`, `pnpm typecheck`, `pnpm test`,
  `pnpm lint`, self-heal prompts executed outside the model process) receive NO
  GitHub/provider secret. Their child environment is BUILT from
  `WORKFLOW_VERIFY_ENV_ALLOWLIST` (`lib/src/utils/workflow-isolation.ts`), uses
  a fresh non-credential-bearing `HOME`/XDG location, pins
  `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` to `/dev/null`, sets
  `GIT_CONFIG_NOSYSTEM=1` and `GIT_TERMINAL_PROMPT=0`, and never forwards
  `GITHUB_ENV`/`GITHUB_PATH`/`BASH_ENV`, `GIT_ASKPASS`, or secret-shaped
  `NPM_CONFIG_*`/`PNPM_*` keys.
- Checkout uses `persist-credentials: false`. Any required post-agent git/API
  operation is an explicit trusted step/job with ephemeral auth
  (`GIT_ASKPASS` helper, never a persisted credential), `GIT_NO_REPLACE_OBJECTS=1`,
  a clean git execution context, and `git -c core.hooksPath=/dev/null` (or an
  equivalent separate clean workspace) so repository-controlled hooks cannot
  run under a token-bearing step. Tokens are never printed, embedded in
  prompts/files, or written to git config.
- Provider selection is deterministic: `resolveWorkflowProviderKeyName()` maps
  `opencode→OPENCODE_API_KEY`, `openai→OPENAI_API_KEY`,
  `anthropic→ANTHROPIC_API_KEY`, `google/gemini→GEMINI_API_KEY`, and returns
  null (fail closed) for anything else. No paid fallback, no silent
  substitution, no guessing from an untrusted model string. Model routing and
  free-model policy are unchanged.

## Why same-job `env -i` was rejected

Independent review of the first manual revision reproduced four blockers that
any same-job allowlist inherits:

1. PR-controlled gate scripts ran while a parent shell retained secrets.
2. Same-UID code can inspect a secret-bearing parent through `/proc` even when
   the direct child uses `env -i`.
3. Untrusted code can poison `GITHUB_ENV`/`GITHUB_PATH`/`BASH_ENV` and local git
   config for later credentialed steps in the same job.
4. `git replace` can substitute the object returned by `$GITHUB_SHA`.

The approved direction is SEC-001: agent, verification, and publish run on
isolated runners (separate jobs), passing patch/bundle artifacts — never a
shared workspace with ambient secrets.

## Residual risk (explicit, queued)

When the OpenCode model process holds its one provider key, OpenCode's own
internal model/tool subprocesses inherit that key. These helpers do not
sandbox OpenCode internals and make no claim to the contrary. Measuring or
mitigating that inheritance (supported config or job-level credential
scoping) is queued under SEC-001.

## Required workflow changes (not applied here — `.github/` edits need CI permissions)

Applied by a maintainer with workflow-edit permission; preserved behaviors:
triggers, concurrency, fork rejection, SHA pinning, retry, model selection,
and human merge-approval gates stay untouched.

### `hourly-orchestrator.yml`

- Checkout: `persist-credentials: false`.
- Split `Process Open PRs` (and the same treatment for `Process Open Issue`
  secret-bearing env plus the inline `Trigger Inline Fix for Issue` action
  inputs) into: (a) trusted fetch/pin steps with `GH_TOKEN` only;
  (b) agent steps with the single resolved provider key only (fail closed when
  unresolvable); (c) verification via an allowlist-built env with zero secrets
  on a separate job/runner with artifact handoff.
- Trusted push/merge steps: ephemeral askpass auth, `GIT_NO_REPLACE_OBJECTS=1`,
  clean git context, `git -c core.hooksPath=/dev/null`, `--force-with-lease`
  against the pinned SHA. Never run repo-controlled gate scripts in a
  secret-bearing step.

### `self-improvement.yml`

- Checkout: `persist-credentials: false`.
- `Run OpenCode Self-Improvement`: single resolved provider key only.
- `Verify and self-heal`: zero secrets, allowlist env, separate job/runner.
- `Commit and Create PR`: separate trusted step/job with ephemeral auth, hook
  suppression, and replace-object protection as above.

## Shared primitives (this patch, additive)

- `lib/src/utils/workflow-isolation.ts` — pure helpers + `TRUSTED_GIT_CONFIG_ARGS`.
- `lib/tests/utils/workflow-isolation.test.ts` — allow/deny matrix: secret
  absence, safe forwarding, single-key model env, trusted-push env, hook
  suppression, fail-closed setup failures.
