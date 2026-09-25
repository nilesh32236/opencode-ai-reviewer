# SEC-001: isolated self-improvement job design

**Status:** design only — REF-006 / issue #776 is blocked pending human approval
**Date:** 2026-09-25
**Scope:** self-improvement workflow; hourly-orchestrator isolation is a separate follow-up

## Why same-job isolation was rejected

The first manual revision of #776 passed ordinary CI but did not establish a security boundary. On a same-UID runner, untrusted code can inspect secret-bearing ancestors through `/proc`, write `GITHUB_ENV`/`GITHUB_PATH`/`BASH_ENV`, alter local Git configuration, and create `refs/replace/*`. A later step in the same job is therefore not a trusted process. `env -i` only sanitizes the direct child. Credential-free reproductions are recorded in [SEC-001-threat-model-evidence.md](SEC-001-threat-model-evidence.md).

The required invariant is stronger:

> No process with a secret may be an ancestor, peer, or writable configuration source for a process that runs repository-controlled code.

## Proposed job graph

```text
agent (provider key only)
  └─ patch + metadata artifact
       ├─ verify-initial (no secrets)
       │    └─ failure log/status artifact
       │         └─ repair (provider key only, no GitHub token)
       │              └─ repaired patch artifact
       │                   └─ verify-final (no secrets)
       └─ publish (GitHub token only, no model/provider key)
```

### `agent`

- Permissions: `contents: read`; no `issues`, `pull-requests`, or write permission.
- Environment: model/provider credentials required by the configured model only; no `GITHUB_TOKEN`, `GH_TOKEN`, `GITLAB_TOKEN`, or `CONTEXT7_API_KEY` unless a later design explicitly proves that key is required by the model adapter.
- Checkout: default-branch `main`, `persist-credentials: false`.
- Runs the existing bounded self-improvement prompt and creates a deterministic patch artifact plus metadata (`base_sha`, `run_id`, summary, changed-file list, artifact checksum).
- Never pushes, creates a PR, or writes to a shared workspace that a credentialed job will reuse.

### `verify-initial`

- Permissions: `contents: read`; no write permission and no secrets.
- Fresh checkout of `main`; download and validate the patch metadata/checksum before applying it.
- Apply the patch without running repository hooks or lifecycle scripts, then run `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm lint`, and `pnpm doc:check`.
- Publish only a bounded, redacted failure log and a machine-readable status. A failed check is data for the repair job, not a reason to retry the same model indefinitely.

### `repair`

- Runs only when `verify-initial` reports failure.
- Permissions: `contents: read`; provider credential only; no GitHub token.
- Fresh checkout and a fresh copy of the patch; feed the exact redacted failure log into one bounded repair attempt.
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
- Verify the patch base SHA, run ID, and head SHA immediately before push. Use a lease/idempotency record so a retry cannot create a second branch or PR.

## Artifact and state contract

Artifacts are untrusted input. Each artifact must include a run ID, base SHA, attempt number, file list, byte count, and SHA-256 checksum. Reject missing/mismatched metadata, symlinks, paths outside the workspace, patches touching `.git` internals, and unexpected workflow/secret files. Keep logs bounded and redacted.

Persist a compact state record (`run_id`, `base_sha`, `attempt`, `phase`, `artifact`, `verification`, `branch`, `head_sha`, `lease_owner`, `updated_at`) so a timeout or runner restart can resume the last safe phase. A publish retry must be idempotent and fail closed on a different head.

## Failure and retry policy

- `environment` / `opencode` availability: bounded retry or manual intervention; never fall back to a random/free router.
- `verification` failure: one repair job, then final verification; no infinite model loop.
- `publish`/Git failure: retry only the idempotent publish operation with a pinned head.
- `merge`/human approval: never self-apply `autofix:merge-approved`.

## Required tests before implementation

1. Workflow/job matrix proving the exact secret set for every job and that no job containing GitHub credentials runs model or repository-controlled commands.
2. Artifact validation tests for checksum, base SHA, path traversal, symlink, and unexpected-file rejection.
3. Fresh-runner integration test proving agent-written `GITHUB_ENV`, `GITHUB_PATH`, `BASH_ENV`, local Git config, and replacement refs cannot affect verification or publish jobs.
4. Real askpass test against a disposable remote, plus a hook-marker test that proves hooks cannot run during publish.
5. Interruption/resume tests for artifact loss, stale base SHA, duplicate publish, and changed PR head.
6. Full workspace gates and a post-merge check of the resulting workflow.

## Non-goals and open decision

This design does not change model selection, provider routing, free-model policy, paid-model handling, merge-approval semantics, or the hourly orchestrator. The human decision required before implementation is whether to approve this self-improvement-only job/artifact design first, or to require both workflows to be redesigned in one larger change. No new issue is created while REF-006 is blocked.

## Primary sources (accessed 2026-09-25)

- [GitHub Actions artifact storage and sharing](https://docs.github.com/en/actions/tutorials/store-and-share-data)
- [GitHub Actions workflow syntax, jobs, outputs, and environment](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [GitHub Actions secure-use reference](https://docs.github.com/en/actions/reference/security/secure-use)
- [GitHub Actions secrets guidance](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)
- [GitHub Actions environment variables](https://docs.github.com/en/actions/reference/environment-variables)
