# Credential-class job split: the recommended design for all six grandfathered entries

**Status:** design note — **not implemented, no workflow or code changed by this document**
**Date:** 2026-10-02
**Scope:** the six live entries in `KNOWN_VIOLATIONS`
(`.github/scripts/tests/test-ai-job-credential-isolation.sh`)
**Companion:** [SEC-001-job-isolation-design.md](SEC-001-job-isolation-design.md) — this note follows its shape and borrows its invariant verbatim.

## Why a ref pin is not a fix, and why the allowlist cannot be trimmed by hand

The guard's rule is: a step that invokes the model (`uses: ./`, `opencode run`, or a
repo script that does) whose scanned text — assembled from workflow `env:`, job
`env:`, step `env:` and step `with:` — holds **both** an LLM key and a GitHub
credential. It never reads a checkout `ref:`. Two consequences decide everything below:

- **Pinning a checkout retires nothing.** A pinned and an unpinned checkout are
  flagged identically. Verified on the real corpus: removing the credential from
  the `audit` model step takes the live count 6 → 5 and removes exactly
  `scheduled-audit.yml:audit:./`; pinning `scheduled-audit.yml`'s checkout, as
  #979 did for `ai-review.yml:review`, leaves the count at 6.
- **The guard is deliberately permission-blind.** `fast-review` declares
  `permissions: {}` and is still flagged, because it receives a write-capable
  `GH_PAT` through `with:`. A PAT's scope comes from the PAT. Any design that
  argues "this job has no write permission, so it is fine" is arguing against a
  property the repo has already recorded as a false negative.

So the only thing that retires an entry is **separating the model invocation from
the credential**. That is a job split, per job, and it is a product decision
rather than a refactor. This note lays out all six so the decision can be made
with the whole design in front of it.

## The invariant

> No process holding a GitHub credential may be an ancestor, peer, or writable
> configuration source for a process that runs repository-controlled or
> model-authored code.

Job 1 runs the model and holds no GitHub credential. Job 2 holds the credential
and runs no model. Everything the model produces crosses as an artifact and is
treated as hostile input.

## The case that has broken this design twice: job 1 produces nothing

This is the whole reason PR #982 is held rather than iterated on.

An absent artifact and an artifact containing an empty list are **different
facts**, and a consumer that cannot tell them apart will read "the audit ran and
found nothing" when the truth is "the audit never completed". That is the
false-clean-pass class this repo has fought for four PRs, and it is worse here
than in a test: an empty-but-present payload *looks like evidence*.

Three rules, and every split below obeys all three:

1. **An empty result is an explicit, attested value.** Job 1 emits a payload
   with `findings: []` **and** a terminal marker such as
   `status: "complete"`. "Ran and found nothing" is therefore a positive claim,
   never an absence of data.
2. **A run that did not complete emits nothing at all**, and fails. No
   `status: "complete"` marker is ever written on a failure path. Job 2 treats a
   missing artifact, a missing marker, or a job conclusion of anything other than
   success as **fail closed**: skip publishing and surface an operator-visible
   error. It must never be recorded as "nothing to do".
3. **The job conclusion is the authority.** Not the artifact's own `status`
   field, and not a model-writable status file — the SEC-001 design makes this
   explicit and the reasoning applies unchanged: a field the model wrote cannot
   be the thing that authorises a credentialed write. Job 2 checks
   `needs.job1.result == 'success'` **before** it reads the payload.

Rule 3 is the one most likely to be got wrong, because a `status` field inside
the artifact feels like it should be trusted. It must not be, on its own.

**`skipped` is a third state, and rules 2 and 3 as first written mishandled it.**
A job can be legitimately skipped — `fast-review` is `workflow_dispatch`-only and
`autofix` is gated on a label, so on most runs neither is applicable. `skipped` is
neither "ran and found nothing" nor "failed", and it must never reach rule 2's
fail-closed path as though something went wrong, nor be published as a clean run.
**Job 2 must not run when job 1 was skipped**, guarded with
`if: needs.job1.result == 'success'` rather than `!cancelled()`. Five outcomes,
not two:

| job 1 outcome | job 2 | meaning |
|---|---|---|
| `success` + attested `[]` | runs, publishes nothing, **logs it** | audit ran, found nothing |
| `success` + populated | runs, validates, writes | normal case |
| `failure` | **does not run**, workflow fails | never completed — evidence of nothing |
| `skipped` | **does not run** | not applicable to this event |
| `cancelled` | does not run | superseded run |

## Shared artifact contract

Every artifact below is hostile input. Each carries `run_id`, `base_sha`,
`attempt`, a byte count and a SHA-256 checksum. Job 2 must reject:

- **absent artifact, absent completion marker, or a non-success job conclusion**
  (rule 3 above) — never silently proceed;
- **checksum mismatch**, or any file in the artifact that is a symlink,
  a hardlink, a device node, or a path escaping the extraction directory;
- **payload that is not valid JSON**, or whose top-level shape is not exactly the
  documented object — unknown keys rejected, not ignored, so a future field
  cannot slip past unnoticed;
- **content over a bounded size**, and per-item bounds on title, body, label
  count and finding count, so an artifact cannot be used as a resource-exhaustion
  vector;
- **markup and injection payloads**: NUL and other control characters, ANSI
  escapes, `@` mention pings aimed at privileged users, HTML/comment injection,
  and — for anything rendered as markdown — the escaping the repo already applies
  in `buildAuditIssueBody`. Redaction alone is not sanitisation; a finding body is
  both secret-bearing *and* injection-capable;
- **path fields** (`file`) that are absolute, contain `..`, or are not
  normalised against the repository root;
- **any field the publishing job does not consume**, which is why the payload
  should be an explicit allowlist rather than a spread of the producer's object.
  A spread copies whatever the producer's type grows next — the defect found in
  review on #982, where `suggestionCode` carried raw repository source into a
  readable artifact.

Job 2 must **parse** the artifact into structured values and pass them to the
CLI as argv or via `--input`, never interpolated into a shell command string.
Never `eval`. Never `sh -c` with model-authored text.

## Blocking prerequisite: five of these six cannot be built as written

`action.yml:14-16` declares:

```yaml
github_token:
  description: 'GitHub token for API access'
  required: true
```

**A job 1 that holds no GitHub credential cannot invoke `uses: ./` at all.** The
action demands the input, so there is no credential-free invocation of the action
today. And the obvious workaround does not clear the guard either: `GH` in the
guard is `r'secrets\.(GITHUB_TOKEN|GH_PAT)|github\.token'`, so a **read-only
`github.token` is matched too** and the entry stays flagged. Handing job 1 a
narrow-privilege token is therefore not a fix, and this note's first draft
proposed it for five of the six entries.

The real prerequisite is an action change: make `github_token` **optional**, and
have the action fail closed only when a mode that *writes* actually needs it.
Until that lands:

| entry | implementable as written? |
|---|---|
| `upstream-monitor:create-issues` | **yes** — it runs `upstream-monitor.sh`, not `uses: ./` |
| `scheduled-audit:audit` | no — blocked twice (see its section) |
| `fix-issue`, `review`, `fast-review`, `autofix` | no — need optional `github_token` first, **and** a per-mode audit of the remaining `required: true` inputs, which this note has not enumerated |

This is the same shape as the blocker that stalled #982: a design that reads as
obvious is unimplementable because a single input contract forbids it. It should
have been found before the six splits were designed, not after.

## The six entries

### 1. `upstream-monitor.yml` → `create-issues` → "Publish improvement issues"

**Today.** The job is *already split-shaped* and this is the cheapest of the six.
`research` runs the model with `OPENCODE_API_KEY` and `CONTEXT7_API_KEY` only —
no GitHub credential — and already uploads a findings JSON artifact.
`create-issues` (`permissions: contents: read, issues: write`) downloads that
artifact and runs `upstream-monitor.sh publish` with `GH_TOKEN` **and**
`OPENCODE_API_KEY` in one env block. `publish` builds a prompt and shells out to
`opencode run --agent monitor-issue-publisher` (`upstream-monitor.sh:596`), and
that prompt instructs the model to run `gh issue create` itself
(`build_publish_prompt`, `upstream-monitor.sh:863`). So the model performs the
writes while the credential is in its environment. The registry and dedup lookups
(`gh issue list`, `upstream-monitor.sh:231` and `:316`) are already credentialed
script steps.

**Job 1 — `draft-issues`** (credential-free). Consumes the existing findings
artifact; runs the publisher model with the provider key alone; emits
**draft issue bodies**, not issues. No `GH_TOKEN`, no `issues: write`.

**Artifact.** `issue-drafts.json`: `{run_id, base_sha, attempt, status, drafts:[{title, body, labels, finding_ref}], byte_count, sha256}`. The `finding_ref` binds each draft to a finding so publish can account for all of them.

**Job 2 — `publish-issues`** (`permissions: issues: write`, `contents: read`; **no** provider key). Validates the draft artifact against the shared contract. Performs the dedup and registry search itself using `gh issue list`, then creates one issue per validated draft with `gh issue create`. No model, no `opencode`, no `pnpm`.

**This does not preserve product behaviour, and an earlier draft claimed it did.**
The publisher model performs the dedup **itself**: its prompt tells it to run
`gh issue list --search` before each create (`upstream-monitor.sh:901`) and to skip
a finding when an existing issue carries the same `<!-- monitor-id -->` fingerprint
**or when title overlap exceeds 60%** (`upstream-monitor.sh:863`). Moving the model
to a credential-free job deletes that judgement, and job 2 must reimplement it
deterministically.

So it is a product decision, not a refactor: keep a 60%-overlap dedup heuristic
(now deterministic and testable, losing the model's context) or adopt a stricter
id-based rule (losing fuzzy duplicate suppression and risking duplicate monitor
issues). It is here rather than buried because it is the main reason the cheapest
of the six is still not a mechanical change.

**Least privilege.** Job 1: `contents: read`. Job 2: `issues: write` only, and only if the label writes need it.

**Empty-output case.** If `research` produced findings and the draft model returns
none, `draft-issues` must still emit `status: "complete"` with `drafts: []`, and
Job 2 must recognise that as a legitimate no-op **and log it**. If `draft-issues`
failed, Job 2 fails closed and `notify-create-issues` reports the cause rather
than reporting a quiet day.

### 2. `scheduled-audit.yml` → `audit`

**Today.** One job, `schedule` + `workflow_dispatch`. Workflow-level permissions
are `contents: write, pull-requests: write, issues: write` and the job inherits
them. A `uses: ./` step receives `github_token` (GH_PAT or `GITHUB_TOKEN`) plus
four provider keys, with `audit_create_issues: true` and `audit_auto_fix: true`.
A second step creates autofix labels with `GH_TOKEN`.

**This entry is blocked twice, not once.**

**(a) The prerequisite above.** Job 1 is a `uses: ./` step, so it cannot run
without a token until `github_token` is optional.

**(b) A contract decision, not a workflow edit.** PR #982 attempted the first
half — an `audit_findings` output emitted independently of `audit_create_issues` —
and is **held**. Stated precisely, because the first draft of this note got it
wrong: the action's `if (!result)` refusal (`audit.ts:272`) *is* silent and is
therefore **not** the gap. The gap is the sibling path at `audit.ts:282`, where a
non-null but empty result (`!result.summary && result.issues.length === 0`) only
warns and returns. An output emitted before that check publishes `[]` for a run
that failed, so a consumer reads "audit ran and found nothing" when the truth is
"the audit never completed". An empty-but-present payload looks like evidence.

Closing (b) needs an engine-side signal distinguishing *completed-and-empty* from
*failed*, spanning `lib` and `action`. That is a design decision, and it is the
reason #982 is held rather than iterated on.

**Job 1 — `analyse`** (`permissions: contents: read`; no GitHub credential).
Runs the audit with a read-only token and `audit_create_issues: false`,
`audit_auto_fix: false`. Emits the findings artifact.

**Artifact.** `audit-findings.json`: `{run_id, base_sha, attempt, status, category, target, summary, stats, findings:[…], byte_count, sha256}` — with the allowlist/redaction discipline the held PR established.

**Job 2 — `publish-findings`** (`permissions: issues: write`; no provider key). Validates, then creates the audit issues deterministically. No model.

**Least privilege.** Job 1: `contents: read`. Job 2: `issues: write` only. The label-creation step moves to Job 2.

**Empty-output case.** The crux, and the reason this entry is held. Job 1 must
emit `status: "complete"` with `findings: []` **only** when the audit genuinely
completed. On any failure — including the `!result` refusal the action already
performs — Job 1 must emit **no artifact** and fail. Job 2 treats a missing
artifact or a non-success conclusion as fail-closed, never as "no findings". This
is precisely the distinction #982's output cannot currently carry, and it must be
settled before any workflow is written.

### 3. `ai-review.yml` → `fix-issue`

**Today.** `issues` and `issue_comment` triggers, with `if:` requiring
`github.event.issue.pull_request == null`, so it cannot run on a `pull_request`.
`permissions: contents: write, pull-requests: write, issues: write`. A `uses: ./`
step in `mode: fix` receives `github_token` plus four provider keys and runs up to
`max_fix_iterations: 1`, pushing commits.

**Not a ref-pin problem.** On its own triggers `github.sha` is already the default
branch, so the checkout is not the exposure; a decorative `ref: ${{ github.sha }}`
would certify nothing, since on a `pull_request` trigger that expression is the
merge ref. Recorded here so nobody reintroduces it.

**Job 1 — `draft-fix`** (`contents: read`; no GitHub credential). Runs the model
to produce a patch over a read-only checkout. Emits a patch artifact.

**Job 2 — `apply-fix`** (`contents: write, pull-requests: write`). Validates the
patch — including that it does not touch lockfiles, workflow files, or anything
under `.github/scripts/` — then commits and pushes.

**Correction to an earlier draft of this note:** job 2 does **not** push to "the
PR branch". This job's `if:` requires `github.event.issue.pull_request == null`,
so by construction **there is no PR**. `fix.ts:935` builds a fresh
`autofix/issue-${issueNumber}` branch and opens a PR from it, and
`autofix/issue-${issueNumber}` branch and opens a PR from it. It reuses an
existing `autofix/issue-N` only when that branch is **fresh** — `fix.ts:819`
checks that the current default-branch tip is an ancestor of the branch tip
(`merge-base --is-ancestor default branch`).

Correcting an earlier draft: that is a **freshness** check, not an **authorship**
check. Nothing in the cited code establishes that this bot wrote the branch.

So job 2 needs *two* independent guards, and an implementer copying the existing
one gets only the first: freshness (does the branch still contain the current
default tip) **and** ownership (is this branch ours to push to). The second is
not implemented today and would have to be added. Treating the existing helper
as sufficient would let job 2 push onto a same-named branch it does not own —
the clobber case, reached by a path that looks defended.

**Least privilege.** Job 1: `contents: read`. Job 2: `contents: write` and
`pull-requests: write`; `issues: write` only if the job also comments.

**Empty-output case.** If the model finds no fix, Job 1 emits
`status: "complete", patch: null`. Job 2 recognises that as a legitimate no-op.
A failed Job 1 emits nothing and Job 2 fails closed.

### 4. `ai-review.yml` → `review`

**Today.** `pull_request`, same-repo head, excluding `autofix/` and `improvement/`
heads and bot actors. `permissions: pull-requests: write`. Since #979 the checkout
is pinned to `github.event.pull_request.base.sha`, so the **bundle** is trusted —
but the step still receives `github_token` plus four provider keys, and the guard
still flags it. Pinning removed the code-execution half of the risk; it did not
remove the credential co-location.

**Known cost, already accepted.** Because the job now runs the base bundle, a PR
touching `action.yml`/`action/lib/**` is reviewed by the pre-change bundle, and
with `enableReachability: true` the reachability graph resolves against base
content. Stated in #979 rather than hidden.

**Job 1 — `analyse-pr`** (`pull-requests: read, contents: read`; no credential). Runs the model over the PR diff supplied as **data**.

**Job 2 — `post-review`** (`pull-requests: write`; no provider key). Validates the review artifact — finding set, inline anchors, counts — then posts the review and the inline comments.

**Least privilege.** Job 1 read-only across the board. Job 2: `pull-requests: write`.

**Empty-output case.** A completed review with no findings emits
`status: "complete", findings: []` and Job 2 posts a clean verdict — a real
result. A failed Job 1 emits nothing and Job 2 posts nothing and surfaces the
failure; it must never post "no issues found".

### 5. `ai-review.yml` → `fast-review`

**Today.** `workflow_dispatch`-only, `inputs.fast_review == 'true'`.
`permissions: {}` — and still flagged, because the `uses: ./` step receives
`github_token` plus provider keys through `with:`. The manual trigger means the
dispatcher is already privileged, so this is the **lowest-risk** of the six; it is
listed because the class is the class.

**Job 1 — `fast-analyse`** (`pull-requests: read, contents: read`; no credential). Runs the model.

**Job 2 — `fast-post`** (`pull-requests: write`). Validates and posts.

**Least privilege.** As for `review`.

**Empty-output case.** Identical to `review`.

**Option worth weighing.** If this job is genuinely a manual operator convenience,
deleting `github_token` from the model step and posting from a second job is cheap.
An alternative is to drop the `with:` credential entirely and accept a review that
cannot comment — a product decision, recorded rather than assumed.

### 6. `ai-review.yml` → `autofix`

**Today.** `pull_request` with the `autofix` label, or `issue_comment` `/fix` from
an OWNER/MEMBER/COLLABORATOR on a PR. `permissions: contents: write,
pull-requests: write, issues: write`. **Already pinned** to
`steps.resolve-ref.outputs.ref` — an immutable PR-head SHA — with fail-closed
guards that refuse cross-repository PRs and unresolvable SHAs. So the moving-ref
TOCTOU is closed, but the PR's own code still executes beside a write PAT.

**Why this is not simply "pin it to base".** `autofix` builds commits and pushes
them to the PR branch. Checking out the base would mean pushing a base-derived
branch onto a branch that has diverged, which can clobber the author's commits.
That is a change in the loop's semantics, not in its pin, and it needs its own
evidence.

**Job 1 — `draft-autofix`** (`contents: read`; no GitHub credential). Checks out the PR head, runs the model, emits a patch artifact bound to the PR head SHA.

**Artifact.** Patch plus `{pr_number, head_sha, base_sha, run_id, attempt, status, byte_count, sha256}`. The `head_sha` binding is what makes a later push safe.

**Job 2 — `apply-autofix`** (`contents: write, pull-requests: write, issues: write`). Re-reads the PR head; **fails closed if it has moved**; validates the patch; commits and pushes. No model.

**Least privilege.** Job 1: `contents: read`. Job 2: the three writes above, which this job genuinely needs.

**Empty-output case.** A completed run with nothing to fix emits
`status: "complete", patch: null` and Job 2 is a no-op. A failed Job 1 emits
nothing; Job 2 fails closed and does **not** remove the `autofix` label, so the
PR cannot be left in a state that looks processed.

## Sequencing, if this is approved

**1. `upstream-monitor:create-issues`, first and immediately.** The only one of the
six implementable today: the boundary artifact already exists and only the
publisher model has to move.

**2. Make `github_token` optional** in `action.yml`, with the action failing closed
only when a writing mode needs it. **Nothing in the other four can start before
this**, and the guard must keep matching `github.token` afterwards — a read-only
token is still the credential the class is about.

   Treat this as a **known-unknown**, not the whole list: `action.yml` declares
   more than one `required: true` input, and this note enumerates the required
   inputs only for `github_token`. Step 2 therefore includes enumerating the
   remaining required inputs **per mode** (`review`, `fix`, `audit`) before any
   split is attempted. An earlier draft implied `github_token` was the only
   blocker, and that is not established.

**3. The engine-side completion signal** for `audit` — *completed-and-empty* vs
*failed* — before any audit workflow is written.

**4. The four `ai-review.yml` jobs**, which share one shape and one design, once 2
has landed.

Trim each `KNOWN_VIOLATIONS` entry in the **same** commit that splits its job; a
guard that stops flagging a job that still runs the model beside the credential is
worse than no guard.

## What this note does not do

It changes no workflow, no script and no allowlist entry. It is the reversible
part of the work, and it exists so that the credential-class question is decided
by a human with the full design visible rather than one split at a time under
deadline. The bundle rebuild for #982 is **not verifiable in this environment** —
the build refuses below Node 24.21.0 and a below-floor build differs by
module-ID renumbering alone — and waits for a conforming runner.