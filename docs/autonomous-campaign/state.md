# Autonomous Campaign — State

Concise record so the next agent can resume without re-deriving anything.
**Verify every line against the current tree before acting on it.**

## Current baseline

- `main`: `6b3a94a6722fdae1841bc7b24acd618adb81f04d`
- Working tree clean at last check.
- lib tests 242 passing / 2 skipped; action 324; app 242; cli 32; platform 58.
- SEC-001 boundary suite 332 passing; merge-approval suite 32/32.

## Merge authorization — READ THIS FIRST

`autofix:merge-approved` is the **only** merge authorization. `autofix:ready` is
advisory. The gate is enforced by `.github/scripts/autofix-merge-approval.sh`,
which also binds approval to the current head SHA and validates the approver.

**No open PR currently carries `autofix:merge-approved`. Therefore nothing may
be merged autonomously.** Leave such PRs open and blocked; move to other work.
Never weaken the gate, never reinterpret `autofix:ready` as approval.

## Active objectives

1. **#840** — reconciled. F1, F2, F3, F4 fixed. F5 (60s positive permission
   cache) investigated: **not a forgery vector**, accepted with documented
   constraints. Residual is bounded privilege-revocation lag of <=60s.
   See the PR adding the two cache-isolation tests (blocked on approval).
2. **#835** — OpenCode integrity asymmetry. Verified from current source:
   `resolveRequireChecksum` is fail-open by default while `action.yml` is
   fail-closed. Flipping the default alone **breaks the Probot/Docker path**,
   because `docker/Dockerfile:39` verifies the archive at build time, `:91`
   puts the binary on PATH, and `app/src/handlers/setup.ts:30` never sets
   `requireChecksum`. Needs a real build-time attestation before the flip.
3. **Secret-bearing execution trust boundary** — under investigation.

## Do not repeat these retired claims

- "PR #813's privilege gate is dead code" — **RETRACTED**. A `git grep` pathspec
  silently returned nothing and I read that as zero call sites. The gate is
  wired. Corrected on the PR.
- "#821 is a main-branch test failure" — retracted; it was a base-vs-subject
  misattribution of a `workflow_run` head SHA.
- "PR #796 adds tests" — it shipped a feature with **no** test file.
- Any claim sourced from a run's `headSha` without checking the trigger.

## Open PR disposition

| PR | Subject | Disposition |
|----|---------|-------------|
| #850 | privilege cache isolation tests | OPEN — correct, **blocked on `autofix:merge-approved`** |
| #847 | performance-efficiency | needs fresh-context review; blocked on approval |
| #845 | error sanitization | needs review; blocked on approval |
| #774 | Set allocation micro-opt | has `autofix:ready` only — **NOT authorization**; blocked |
| #772 | code-quality | needs review; blocked on approval |

## Health issues

Many auto-generated `health:*` issues exist. Judge the underlying failure, not
the issue count. Two previously filed as `SOURCE_PR_FAILURE` and closed
(#821, #832) because the run's `headSha` was the base, not the executed code.

## Next task

Finish #835's attestation work, then the trust-boundary findings, then
disposition the open PRs once an approval signal exists.
