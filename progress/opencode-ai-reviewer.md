# OpenCode AI Reviewer campaign progress

## State
- REF-006 issue #776 is approved for the combined SEC-001 redesign. PR #785 is the sole active implementation PR on `campaign/ref-006-combined-sec001` at `c208c0a`; historical PRs #777/#780/#781/#783 remain closed.
- The current working tree implements separate provider-only agent, no-secret supervisor, fresh status-finalizer, and GitHub-token-only publish jobs in both workflows. Verification authority is the trusted workflow job conclusion; raw status files are diagnostic only.
- Credential-free evidence and bounded regressions cover path/symlink/size policy, status/task/head binding, exact repository remotes, scrubbed Git state, head-pinned merges, BASH_ENV/PATH/GITHUB_ENV neutralization, and provenance forgery rejection. See `docs/architecture/SEC-001-threat-model-evidence.md`.

## Next
- Commit and push the current security fixes, then re-query PR #785 exact head/files/checks and monitor exact-head CI, CodeQL, and AI review.
- Update issue #776 and the architecture queue with the new head. Require a genuine current-head human `autofix:merge-approved`; never self-approve or queue auto-merge.
- After merge, verify the merged commit on `main`, post-merge checks, and only then select the next queue item. Do not create another SEC-001 issue or modify unrelated PRs #772/#774.

## Blockers
- OpenCode's own model/tool subprocesses may inherit the selected provider credential; this residual is documented, not claimed as a full sandbox.
- Node 24.20.0 is below the declared 24.21.0 floor; CI uses Node 24.
