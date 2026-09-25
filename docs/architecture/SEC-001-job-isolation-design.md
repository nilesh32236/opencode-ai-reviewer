# SEC-001: isolated self-improvement job design

**Status:** approved implementation baseline — REF-006 / issue #776
**Date:** 2026-09-25
**Scope:** both `self-improvement.yml` and `hourly-orchestrator.yml`

## Why same-job isolation was rejected

The first manual revision of #776 passed ordinary CI but did not establish a security boundary. On a same-UID runner, untrusted code can inspect secret-bearing ancestors through `/proc`, write `GITHUB_ENV`/`GITHUB_PATH`/`BASH_ENV`, alter local Git configuration, and create `refs/replace/*`. A later step in the same job is therefore not a trusted process. `env -i` only sanitizes the direct child. Credential-free reproductions are recorded in [SEC-001-threat-model-evidence.md](SEC-001-threat-model-evidence.md).

The required invariant is stronger:

> No process with a secret may be an ancestor, peer, or writable configuration source for a process that runs repository-controlled code.

## Proposed job graph

```text
agent (provider key only)
  └─ raw patch/result artifact (untrusted)
       └─ package-agent (fresh no-secret revalidation/repackaging)
            └─ verify-initial (no secrets; job conclusion is authoritative)
                 └─ raw diagnostic log/status (never a success authority)
                      └─ finalize-initial (fresh no-secret canonical status)
                           └─ repair on failed job conclusion (provider key only)
                                └─ raw repair artifact (untrusted)
                                     └─ package-repair (fresh revalidation/repackaging)
                                          └─ verify-final (no secrets; job conclusion)
                                               └─ finalize-final (fresh canonical status)
       └─ publish (GitHub token only, canonical status + exact patch)
```

### `agent`

- Permissions: `contents: read`; no `issues`, `pull-requests`, or write permission.
- Environment: model/provider credentials required by the configured model only; no `GITHUB_TOKEN`, `GH_TOKEN`, or `GITLAB_TOKEN`. `CONTEXT7_API_KEY` is forwarded only when the configured adapter explicitly uses Context7; the model wrapper strips every other inherited runtime credential and action-path variable.
- Checkout: default-branch `main`, `persist-credentials: false`.
- Runs the existing bounded self-improvement prompt and creates a deterministic patch artifact plus metadata (`base_sha`, `run_id`, summary, changed-file list, artifact checksum).
- Never pushes, creates a PR, or writes to a shared workspace that a credentialed job will reuse.

### `verify-initial`

- Permissions: `contents: read`; no write permission and no secrets.
- Fresh checkout of `main`; download and validate the patch metadata/checksum before applying it.
- Apply the patch without running repository hooks or lifecycle scripts, then install the patched dependency graph and run `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm lint`, and `pnpm doc:check`.
- The gate supervisor is a root-owned script outside the candidate UID. It runs the frozen install and each gate through `sec001-run-gates.sh`, a dedicated non-sudo UID, with immutable root-owned snapshots and a fresh writable copy per gate. Candidate code cannot rewrite the supervisor, invoke sudo, replace the worktree, or poison a later gate. Its actual job conclusion, rather than a model-writable status file, is the success/failure signal. Raw status/log files are diagnostic artifacts only.
- A fresh `finalize-initial`/`finalize-final` job validates the patch, task/result bindings, status/log checksums, and the successful GitHub job conclusion before publishing a canonical status artifact. A failed supervisor conclusion is never converted into a successful status.

### `repair`

- Runs only when the `verify-initial` GitHub job conclusion is failure. A status file written by patch code cannot trigger repair or publish.
- Permissions: `contents: read`; provider credential only; no GitHub token.
- Fresh checkout and a fresh copy of the patch; feed the bounded redacted diagnostic log into one bounded repair attempt.
- Emit a new patch artifact with a new attempt identifier. No direct git push or PR creation.

### `verify-final`

- No secrets and no write permission.
- Fresh checkout; apply the repaired patch; run the full gate again.
- If it fails, publish a manual-review status and do not invoke another model automatically.

### `publish`

- Permissions: only the minimum `contents: write`, `pull-requests: write`, and `issues: write` needed for branch/PR/label operations.
- Environment: GitHub token only; no provider/model credential and no `CONTEXT7_API_KEY`.
- Do not run `pnpm`, OpenCode, or any patch-controlled script in this job.
- Use a clean checkout or a verified Git bundle/commit created by a no-secret job. Set `GIT_NO_REPLACE_OBJECTS=1`, disable hooks (`core.hooksPath=/dev/null`), use an explicit remote URL, and do not trust the agent's local Git config.
- Verify the canonical status artifact (exact run/base/phase and `verified=true`), the patch base SHA, and the task/result head binding immediately before push. The green-check gate, human approval, final head read, and `gh pr merge --match-head-commit` all use one captured SHA; no queued auto-merge fallback exists.
- Use a lease/idempotency record so a retry cannot create a second branch or PR. A newly created PR is immediately re-fetched; a changed head is closed and fails closed. The same pinned-head contract is applied to the existing AI review merge path.

## Artifact and state contract

Artifacts are untrusted input. Each artifact must include a run ID, base SHA, attempt number, file list, byte count, and SHA-256 checksum. Reject missing/mismatched metadata, symlinks, paths outside the workspace, patches touching `.git` internals, and unexpected workflow/secret files. Autonomous patches may not modify package manifests/lockfiles, TypeScript/test/gate configuration, or test harness trees (including nested manifests), because repository-controlled lifecycle scripts would otherwise redefine the verification gate. Keep logs bounded and redacted.

Persist a compact state record (`run_id`, `base_sha`, `attempt`, `phase`, `artifact`, `verification`, `branch`, `head_sha`, `lease_owner`, `updated_at`) so a timeout or runner restart can resume the last safe phase. A publish retry must be idempotent and fail closed on a different head.

## Failure and retry policy

- `environment` / `opencode` availability: bounded retry or manual intervention; never fall back to a random/free router.
- `verification` failure: one repair job, then final verification; no infinite model loop.
- `publish`/Git failure: retry only the idempotent publish operation with a pinned head.
- `merge`/human approval: never self-apply `autofix:merge-approved`.

## Implementation map

The combined implementation uses these trusted-baseline helpers:

- `.github/scripts/sec001-artifact.sh` creates and validates metadata-bound patch/status/wrapper artifacts, with bounded sizes, exact file sets, symlink rejection, and secret-path policy.
- `.github/scripts/sec001-finalize-status.sh` runs only in a fresh no-secret job and treats the successful GitHub supervisor conclusion—not a model-writable raw status—as the verification authority; it also binds hourly task/result numbers and head SHAs.
- `.github/scripts/sec001-trusted-publish.sh` publishes from a fresh clone with an exact expected GitHub repository URL, scrubbed Git environment, askpass authentication, replacement-object protection, hook suppression, expected merge-SHA checks, and deterministic lease/idempotency checks.
- `.github/scripts/sec001-hourly-agent.sh`, `sec001-hourly-verify.sh`, and `sec001-hourly-publish.sh` keep hourly provider work, no-secret verification, and GitHub publication in separate jobs.
- `.github/scripts/tests/test-sec001-boundary.sh` is the deterministic adversarial regression suite wired into CI.

The hourly flow uses the same raw→fresh-package boundary: `package-agent` rebuilds the result wrapper and revalidates every patch tree before `verify` consumes it. All security-boundary checkouts use the immutable workflow commit (`github.sha`) and assert the recorded base before invoking helpers; a moving `main` cannot substitute packaging or verification code between jobs. Agent/verification jobs also snapshot trusted helpers before model execution, and packaging invokes fresh trusted helper code through fixed PATH/`BASH_ENV` controls. The existing main-branch merge-gate and human-approval scripts are executed only in fresh trusted-main publish jobs, never from a PR checkout. Both workflows are schedule-only; manual issue fixes use the GitHub-token-only trusted handoff rather than a mixed-secret inline action.


1. Workflow/job matrix proving the exact secret set for every job and that no job containing GitHub credentials runs model or repository-controlled commands.
2. Artifact validation tests for checksum, base SHA, path traversal, symlink, and unexpected-file rejection.
3. Fresh-runner integration test proving agent-written `GITHUB_ENV`, `GITHUB_PATH`, `BASH_ENV`, local Git config, and replacement refs cannot affect verification or publish jobs.
4. Real askpass test against a disposable remote, plus a hook-marker test that proves hooks cannot run during publish.
5. Interruption/resume tests for artifact loss, stale base SHA, duplicate publish, and changed PR head.
6. Full workspace gates and a post-merge check of the resulting workflow.

## Non-goals and approved scope

This design does not change model selection, provider routing, free-model policy, paid-model handling, merge-approval semantics, or unrelated repository behavior. The human approved a combined implementation across both workflows; implementation must preserve each workflow's existing orchestration outcomes while moving untrusted execution and credentialed operations onto separate runners/jobs.

## Primary sources (accessed 2026-09-25)

- [GitHub Actions artifact storage and sharing](https://docs.github.com/en/actions/tutorials/store-and-share-data)
- [GitHub Actions workflow syntax, jobs, outputs, and environment](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [GitHub Actions secure-use reference](https://docs.github.com/en/actions/reference/security/secure-use)
- [GitHub Actions secrets guidance](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)
- [GitHub Actions environment variables](https://docs.github.com/en/actions/reference/environment-variables)
