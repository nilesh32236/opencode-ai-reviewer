# OpenCode AI Reviewer campaign progress

## State
- REF-006 / SEC-001 is complete through PR [#785](https://github.com/nilesh32236/opencode-ai-reviewer/pull/785), merged as `3c2f9817ff9e33a57877324d50838956fb39f899` from exact candidate head `b39dd0095488ffffdfb845e989881fcf08091ac4`. The merge commit is reachable from `main` (current main is the later unrelated commit `ad2d12b10c5a47c56cdc527c3ffdcfd45b87e7b7`).
- Post-merge verification on current main is green: CI run `36127736168`, CodeQL run `36127736199`, Workflow Health run `36127765727`, and the merged-tree SEC-001 boundary suite (`55 passed`) with workflow YAML and shell syntax checks. The original merge-commit CI run was canceled by the subsequent unrelated main push; the current-main rerun includes the merge and passed.
- The later main commit changed only unrelated action/lib merge-approval files; no SEC-001 workflow or script changed after the merge. PR #785 was merged by the human account `nilesh32236`; the issue timeline exposed no `autofix:merge-approved` label event, so that governance anomaly is recorded rather than treated as workflow evidence.
- Follow-up issue [#786](https://github.com/nilesh32236/opencode-ai-reviewer/issues/786) (`SEC-002`) is the only active follow-up item, now `ready` after its analysis and staged implementation plan were posted. It covers bounded model output/comments, structured approval parsing, temporary cleanup, hardened archive extraction, publish/path-policy parity, and dependency-install efficiency. No implementation PR exists for it yet.

## Next
- Begin the first bounded #786 implementation slice only after confirming the staged plan remains within the issue scope: shared model-text/path validation and strict approval parsing.
- Implement and independently review only the approved #786 scope, then run exact-head CI and the human merge gate before any merge or post-merge verification.
- Do not reopen PR #785, change model/provider routing, weaken security gates, or start unrelated backlog work.

## Blockers
- OpenCode's own model/tool subprocesses may inherit the selected provider credential inside the provider-only agent job; this residual is documented and is not claimed as full sandboxing.
- Local Node is `v24.20.0`, below the declared `>=24.21.0` floor; CI uses Node 24.
