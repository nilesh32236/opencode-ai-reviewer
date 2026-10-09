# Credential-class job split: the prerequisite, and the one entry that is buildable today

**Status:** design note — **not implemented, no workflow or code changed by this document**
**Date:** 2026-10-02 (rewritten; the head had already moved twice over factual errors)
**Scope:** the six live entries in `KNOWN_VIOLATIONS`
(`.github/scripts/tests/test-ai-job-credential-isolation.sh:104-109`)
**Companion:** [SEC-001-job-isolation-design.md](SEC-001-job-isolation-design.md) — this note follows its shape and borrows its invariant verbatim.

---

## 0. Read this first: the split cannot be written until the action contract changes

**Five of the six entries cannot be built today. One can. The prerequisite is not a
workflow edit, and it is not a `ref:` pin — it is a change to the published action's
input contract, which needs its own PR and its own review.**

If you skip to section 6 or 7 and implement a job split from the shapes recorded
there, you will write a workflow that cannot run. That is not a style concern; it is
the specific failure this note exists to prevent, and an earlier draft of this note
made it.

### 0.1 What actually blocks it — and it is not `action.yml`

`parseInputs` runs unconditionally at the top of every action run, before any mode
dispatch:

```ts
// action/src/index.ts:101
inputs = parseInputs(loadedConfig?.llm);
```

and inside it, with no mode branch and no exception for read-only modes:

```ts
// action/src/inputs.ts:499-501
const githubToken = core.getInput('github_token', { required: true });
if (!githubToken) {
  throw new Error('github_token input is required but was empty');
}
```

**So a credential-free job 1 cannot invoke this action in *any* mode.** `review`,
`fix` and `audit` are all equally blocked; there is no read-only mode that gets a
pass.

**What is *not* the blocker — correcting the inherited claim.** Earlier drafts of
this note, and the state this rewrite inherited, all put the blocker at
`action.yml:14-16`:

```yaml
github_token:
  description: 'GitHub token for API access'
  required: true
```

That YAML is real and it is still `required: true`. But it is **not what stops the
job.** GitHub's own metadata reference says so in as many words, under
[`inputs`](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax#example-specifying-inputs):

> Actions using `required: true` will not automatically return an error if the input
> is not specified.

`required: true` in action metadata is documentation. The runner does not enforce it.
The enforcement is `inputs.ts:499-501`, which is **code**.

This distinction is not pedantry, because it changes what the fix is:

| | if `action.yml` were the blocker | the actual blocker |
|---|---|---|
| the change | flip one word to `false` | restructure a conditional in `inputs.ts` |
| where | metadata | action source |
| per-mode | no, one flag for all modes | **yes** — `review` and `analyze` need no token; `fix`/`audit` need one when they write |
| what else must be decided | nothing | what "fail closed" means when a writing mode finds the token absent, and where that check lands |
| blast radius | metadata of a published action | behaviour of a published action, on every existing consumer |

Either way it is a contract change to a published action, which is why it is **not**
smuggled in inside a workflow PR. It gets its own PR and its own review.

### 0.2 The obvious workaround fails, and the guard is why

Handing job 1 a *read-only* token looks like the cheap way out: the model cannot
write with it. It does not work, and the reason is the guard's own rule
(`.github/scripts/tests/test-ai-job-credential-isolation.sh:124`):

```python
GH = re.compile(r'secrets\.(GITHUB_TOKEN|GH_PAT)|github\.token')
```

The rule matches the **built-in `github.token`** as well as the two PATs. A
read-only token is still a GitHub credential, and the credential-class this repo is
closing is the *co-location*, not the *scope*. Re-run to confirm:

```
$ # baseline
$ python3 <the guard's own violations() body> .
6

$ # replace the audit step's PAT with the read-only built-in token
$ #   github_token: ${{ secrets.GH_PAT || secrets.GITHUB_TOKEN }}
$ #   github_token: ${{ github.token }}
$ python3 <the guard's own violations() body> .
6   # UNCHANGED — scheduled-audit.yml:audit:./ is still listed
```

The entry stays flagged. The workaround retires nothing and would ship a job that is
still a violation.

### 0.3 The full set of required inputs — the earlier known-unknown, now closed

An earlier draft left this as an unenumerated known-unknown. It is now enumerated
against the file:

```
$ grep -n "required: true" action.yml
11:    required: true      # mode          (has default: 'review' at line 12)
16:    required: true      # github_token  (NO default)
```

`action.yml` declares exactly two required inputs. `github_token` is the only one
**without a default**, and the only one any of these five workflows cannot supply.
That is sufficient to establish the blocker on its own; nothing below depends on
resolving how GitHub treats a required input that *has* a default.

### 0.4 Per-entry verdict — five blocked, one buildable

| # | entry | status | reason |
|---|---|---|---|
| 1 | `upstream-monitor.yml:create-issues` | **implementable today** | runs `bash .github/scripts/upstream-monitor.sh publish` (`.github/workflows/upstream-monitor.yml:169`), **not** `uses: ./`. No `github_token` input is consumed, so `inputs.ts:499` never applies. Design in §6. |
| 2 | `scheduled-audit.yml:audit` | **blocked** | `uses: ./` at `scheduled-audit.yml:56` with `github_token` at `:63` → §0.1. **Blocked twice**: also needs the engine-side completion signal in §2. |
| 3 | `ai-review.yml:fix-issue` | **blocked** | `uses: ./` + `github_token` → §0.1. |
| 4 | `ai-review.yml:review` | **blocked** | `uses: ./` + `github_token` → §0.1. |
| 5 | `ai-review.yml:fast-review` | **blocked** | `uses: ./` + `github_token` → §0.1. |
| 6 | `ai-review.yml:autofix` | **blocked** | `uses: ./` + `github_token` → §0.1. |

**Entry 1 is buildable today and only because it is a script, not because it is
easier.** Every one of the other five runs the model through the action, and the
action will not start without a credential.

### 0.5 What the prerequisite PR has to contain

Not a one-line metadata change. Whoever picks this up needs:

1. `inputs.ts`: stop requiring `github_token` unconditionally; require it **per
   mode**, and only on the paths that actually write.
2. An explicit fail-closed behaviour for a writing mode that finds it absent —
   named, tested, and surfaced through `core.setFailed`, not a silent no-op (§4).
3. A per-mode audit of every remaining input the five blocked jobs need, before any
   split is attempted. `mode` is the only other `required: true` input (§0.3), but
   this note has **not** verified the remaining inputs resolve cleanly per mode.
4. A decision on whether the guard's rule changes. It should not — see §1.
5. Its own PR and its own review, because it changes the behaviour of a published
   action for every existing consumer.

---

## 1. Finding: the guard's rule is a CREDENTIAL check, not an AUTHORSHIP check

**Retiring an entry proves that a credential is no longer in the environment. It
proves nothing about the code that ran.** These are different properties, and
conflating them is how a split ships looking defended and not being defended.

The rule is a **credential-presence** check over the step's assembled text — workflow
`env:`, job `env:`, step `env:`, step `with:` (`:124`, `:126`). It never reads a
checkout `ref:`, and it never asks who wrote anything. Re-run on the live corpus:

| experiment | result | what it shows |
|---|---|---|
| baseline | 6 entries | matches `KNOWN_VIOLATIONS` `:104-109` |
| pin `scheduled-audit.yml`'s checkout to `github.sha` | still **6** | a `ref:` pin retires nothing; the guard never reads `ref:` |
| delete `github_token:` from the audit model step | **5**, dropping exactly `scheduled-audit.yml:audit:./` | removing the credential is what retires an entry |
| substitute read-only `${{ github.token }}` | still **6**, entry still listed | a narrower credential is still a credential (§0.2) |

### 1.1 The ownership gap, on the branch job 2 pushes to — corrected again

An earlier draft of this note cited `fix.ts:819-888` as the branch-reuse guard and
claimed it verified the bot authored the branch. A second draft corrected that to
"freshness only, ownership does not exist today". **Both were partly wrong. What the
tree actually has, re-read line by line:**

`fix.ts:819-830` is the docstring and signature of `isAutofixBranchFresh` — a
**freshness** check: `merge-base --is-ancestor default branch`, default tip must be an
ancestor of the branch tip. It says nothing about authorship. That part of the first
draft was right.

But the caller pairs it with a second, separate check that the drafts missed:

```ts
// fix.ts:970-975
const tipEmail = await exec
  .getExecOutput('git', ['log', '-1', '--format=%ae', `origin/${branchName}`], ...)
  .then((r) => (r.exitCode === 0 ? r.stdout.trim() : ''))
  .catch(() => '');

// fix.ts:977-989
if (tipEmail === gitEmail) {
  if (await isAutofixBranchFresh(branchName, defaultBranch)) {
    reuseBotBranch = true;
    await exec.exec('git', ['checkout', '-B', branchName, `origin/${branchName}`]);
  } else { /* bot-authored but stale -> recreate from origin/${defaultBranch} */ }
} else {
  await exec.exec('git', ['checkout', '-B', branchName, `origin/${defaultBranch}`]);
}
```

**So an ownership probe exists** — tip commit author email against the configured bot
email (`gitEmail`, `fix.ts:902`). It is real code, not a comment.

**And the code says in its own words that it is not a security boundary**
(`fix.ts:956-959`, verbatim):

> Note this email check is a stale-branch-reuse heuristic, **not a security boundary**
> — git author emails are self-asserted and forgeable, so an attacker can pass it;
> **the recreate-from-default path below is the actual security control.**

So the accurate statement is sharper than either earlier draft, and it is not "the
check is missing":

> There are **two** guards on the push target, not one and not zero. **Freshness**
> (`fix.ts:819`) and **ownership** (`fix.ts:977`) are both implemented and both
> paired. The ownership check is **forgeable by design** and is denied by the code
> itself to be a security boundary. The actual control is the **recreate-from-default
> path** (`fix.ts:981-988`): anything not provably bot-authored-and-fresh is rebuilt
> from `origin/${defaultBranch}` instead of being reused.

**For job 2 this is a trap in the specific direction of "it looks handled".** An
implementer who copies the existing helper has copied a control the code explicitly
disclaims. The requirement job 2 inherits is therefore *not* "add an ownership
check" — it is: **do not treat the email check as one.** Reproduce all three
elements, or reproduce the recreate-from-default control alone and drop the reuse
path.

### 1.2 The other half of the trap

The guard flagging an entry means the credential was co-located. It does not mean the
job was *wrong* — `fast-review` declares `permissions: {}` and is still flagged,
because it receives a write-capable `GH_PAT` through `with:`. A PAT's scope comes
from the PAT, not from the workflow's `permissions:` block. Any argument of the form
"this job has no write permission, so it is fine" is arguing against a property this
repo has already recorded as a false negative.

---

## 2. Finding: the `audit` blocker was mis-diagnosed — the gap is `audit.ts:282`

This was diagnosed wrong once and is recorded here so it is not diagnosed wrong a
third time. **The `if (!result)` refusal is not the gap.** It is silent, and silent
is already correct.

`action/src/audit.ts:261-288`, both branches, in full:

```ts
// Two different things land here and must not be conflated:
//  - The engine returned NO result at all. That is never a clean audit; ...
//  - The engine returned a result with no summary and no findings. That is
//    ambiguous — a legitimately empty audit is possible — so it stays a
//    warning, but the message now names what to check.

if (!result) {                       // audit.ts:272  — CORRECT, silent
  core.setFailed(
    sanitize(`Audit produced no result (category: ${category}, target: ${auditTarget}). ` +
      'Nothing was audited, so this is not a passing audit.'),
  );
  return;                            // no output is published on this path
}

if (!result.summary && result.issues.length === 0) {   // audit.ts:282  — THE GAP
  core.warning(
    `Audit returned no summary and no findings (category: ${category}, target: ${auditTarget}). ` +
    'If you expected findings, check that the audit prompt for this category exists and is non-empty.',
  );
  return;                            // returns SUCCESS, having published nothing
}
```

**`audit.ts:272` calls `core.setFailed` and returns. It publishes no output. It is
already the behaviour the empty-output contract wants.**

**`audit.ts:282` is the sibling that is not.** A non-null result with no summary and
no issues — an ambiguous state the code itself declines to call a pass — takes a
`core.warning`, returns, and the **job succeeds**: no issue, no output, no
artifact. And once #955 (`feat/audit-findings-output`, unmerged at the tree
recorded in §A) lands, an `audit_findings` output emitted before this check —
`core.setOutput('audit_findings', …)` at `audit.ts:326` on that branch — publishes
`[]` for a run that did not complete. A
consumer reading that payload sees "the audit ran and found nothing", which is
exactly the false-clean-pass class this repo has fought for four PRs. Here it is
worse than in a test: an empty-but-present payload *looks like evidence*.

**Closing it is a design decision, not a workflow edit.** It needs an engine-side
signal distinguishing *completed-and-empty* from *failed*, spanning `lib` and
`action`. That is why PR #982 is held rather than iterated on: its output cannot
currently carry the distinction, and a held PR is the correct response to a contract
that cannot yet express the thing it needs to express.

---

## 3. The invariant

> No process holding a GitHub credential may be an ancestor, peer, or writable
> configuration source for a process that runs repository-controlled or
> model-authored code.

Job 1 runs the model and holds no GitHub credential. Job 2 holds the credential and
runs no model. Everything the model produces crosses as an artifact and is treated
as hostile input.

---

## 4. The case that has broken this design twice: job 1 produces nothing

This is the whole reason PR #982 is held rather than iterated on.

An absent artifact and an artifact containing an empty list are **different facts**,
and a consumer that cannot tell them apart will read "the audit ran and found
nothing" when the truth is "the audit never completed".

Three rules, and every split in §6 obeys all three:

1. **An empty result is an explicit, attested value.** Job 1 emits a payload with
   `findings: []` **and** a terminal marker such as `status: "complete"`. "Ran and
   found nothing" is a positive claim, never an absence of data.
2. **A run that did not complete emits nothing at all**, and fails. No
   `status: "complete"` marker is ever written on a failure path. Job 2 treats a
   missing artifact, a missing marker, or a job conclusion of anything other than
   success as **fail closed**: skip publishing and surface an operator-visible error.
   It must never be recorded as "nothing to do".
3. **The job conclusion is the authority.** Not the artifact's own `status` field,
   and not a model-writable status file — a field the model wrote cannot be the thing
   that authorises a credentialed write. Job 2 checks `needs.job1.result == 'success'`
   **before** it reads the payload.

Rule 3 is the one most likely to be got wrong, because a `status` field inside the
artifact feels like it should be trusted. It must not be, on its own.

**`skipped` is a third state, and rules 2 and 3 as first written mishandled it.** A
job can be legitimately skipped — `fast-review` is `workflow_dispatch`-only
(`ai-review.yml:183-185`) and `autofix` is gated on a label, so on most runs neither
is applicable. `skipped` is neither "ran and found nothing" nor "failed", and it must
never reach rule 2's fail-closed path as though something went wrong, nor be
published as a clean run. **Job 2 must not run when job 1 was skipped**, guarded with
`if: needs.job1.result == 'success'` rather than `!cancelled()`:

| job 1 outcome | job 2 | meaning |
|---|---|---|
| `success` + attested `[]` | runs, publishes nothing, **logs it** | ran, found nothing |
| `success` + populated | runs, validates, writes | normal case |
| `failure` | **does not run**, workflow fails | never completed — evidence of nothing |
| `skipped` | **does not run** | not applicable to this event |
| `cancelled` | does not run | superseded run |

**§2 is this section failing inside the action itself** — latent at this tree (no
`audit_findings` output exists yet; see §2), firing the moment #955 lands.
`audit.ts:282` is a job that
did not complete publishing an attested-empty. Every one of the three rules above is
a guard against re-creating it downstream.

---

## 5. Shared artifact contract

Applies to any split, today or after the prerequisite lands. Every artifact is
hostile input. Each carries `run_id`, `base_sha`, `attempt`, a byte count and a
SHA-256 checksum. Job 2 must reject:

- **absent artifact, absent completion marker, or a non-success job conclusion**
  (rule 3 above) — never silently proceed;
- **checksum mismatch**, or any file in the artifact that is a symlink, a hardlink, a
  device node, or a path escaping the extraction directory;
- **payload that is not valid JSON**, or whose top-level shape is not exactly the
  documented object — unknown keys rejected, not ignored, so a future field cannot
  slip past unnoticed;
- **content over a bounded size**, and per-item bounds on title, body, label count and
  finding count, so an artifact cannot be used as a resource-exhaustion vector;
- **markup and injection payloads**: NUL and other control characters, ANSI escapes,
  `@` mention pings aimed at privileged users, HTML/comment injection, and — for
  anything rendered as markdown — the escaping the repo already applies in
  `buildAuditIssueBody`. Redaction alone is not sanitisation; a finding body is both
  secret-bearing *and* injection-capable;
- **path fields** (`file`) that are absolute, contain `..`, or are not normalised
  against the repository root;
- **any field the publishing job does not consume**, which is why the payload should
  be an explicit allowlist rather than a spread of the producer's object. A spread
  copies whatever the producer's type grows next — the defect found in review on
  #982, where `suggestionCode` carried raw repository source into a readable artifact.

Job 2 must **parse** the artifact into structured values and pass them to the CLI as
argv or via `--input`, never interpolated into a shell command string. Never `eval`.
Never `sh -c` with model-authored text.

---

## 6. The one entry that is implementable today: `upstream-monitor.yml` → `create-issues`

This is the only one of the six that can be built now, because it is the only one
that does not go through `uses: ./` (§0.4). It is also the cheapest. It is not
mechanical.

### 6.1 Today

`research` runs the model with `OPENCODE_API_KEY` and `CONTEXT7_API_KEY` only
(`upstream-monitor.yml:73,75`) — no GitHub credential — and uploads the findings
artifact (`monitor-findings-json`, `:91`).

`create-issues` (`permissions: contents: read, issues: write`, `:142-144`) downloads
that artifact and runs:

```yaml
# .github/workflows/upstream-monitor.yml:167-174
- name: Publish improvement issues
  id: publish
  run: bash .github/scripts/upstream-monitor.sh publish
  env:
    MONITOR_OUT_DIR: ${{ runner.temp }}/monitor
    GH_TOKEN: ${{ secrets.GH_PAT || secrets.GITHUB_TOKEN }}   # credential
    OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}         # model key
```

Both in one `env:` block. `publish` builds a prompt
(`build_publish_prompt`, `upstream-monitor.sh:860`) and shells out to
`opencode run --auto --agent monitor-issue-publisher` (helper at
`upstream-monitor.sh:596`, invoked at `:812` with `AGENT_PUBLISHER` from `:49`), and
that prompt tells the model to run `gh issue create` itself. **The model performs
the writes with the credential in its environment.**

### 6.2 The split

**Job 1 — `draft-issues`** (credential-free). Consumes the existing findings
artifact; runs the publisher model with the provider key alone; emits **draft issue
bodies**, not issues. No `GH_TOKEN`, no `issues: write`.

**Artifact.** `issue-drafts.json`:
`{run_id, base_sha, attempt, status, drafts:[{title, body, labels, finding_ref}], byte_count, sha256}`.
`finding_ref` binds each draft to a finding so publish can account for all of them.

**Job 2 — `publish-issues`** (`permissions: issues: write`, `contents: read`; **no**
provider key). Validates the draft artifact against §5. Creates one issue per
validated draft with `gh issue create`. No model, no `opencode`, no `pnpm`.

**Least privilege.** Job 1: `contents: read`. Job 2: `issues: write` only.

**Empty-output case.** If `research` produced findings and the draft model returns
none, `draft-issues` must still emit `status: "complete"` with `drafts: []`, and Job
2 must recognise that as a legitimate no-op **and log it**. If `draft-issues` failed,
Job 2 fails closed and `notify-create-issues` reports the cause rather than
reporting a quiet day. (§4.)

### 6.3 Moving the model out deletes a dedup judgement — and this is the product decision

**This does not preserve product behaviour, and an earlier draft of this note claimed
it did.**

The publisher model deduplicates **itself**. The prompt says:

```
# upstream-monitor.sh:900-903
## DEDUP + CAP (strict)
Input is pre-capped at 8 findings. BEFORE EACH gh issue create, run:
gh issue list --state all --label monitor --search "<keywords from title>" --json number,title,body --limit 20
Skip if any existing issue contains the same <!-- monitor-id --> fingerprint, or if title overlap is >60% (reason "already tracked").
```

> **Citation correction.** Earlier drafts cited `upstream-monitor.sh:863` for the
> fingerprint and the 60% rule. Line 863 is the prompt's *opening* line
> ("You are monitor-issue-publisher for the opencode-ai-reviewer project…"). The
> dedup rule is at **`:903`**, under the `## DEDUP + CAP (strict)` header at `:900`.
> `:901` (the "BEFORE EACH" instruction) and `:902` (the `gh issue list` call) are
> correct as cited.

**The repository already knows this judgement is weak**, and says so in the script's
own comment (`upstream-monitor.sh:126-142`):

> The publish prompt TELLS the model to search before each create and skip on a
> matching `<!-- monitor-id: ... -->` fingerprint. **That is a prompt instruction,
> not an enforced control:**
>
> 1. The model searches with `--limit 20` and a keyword query, so older matches are
>    hidden …
> 2. **"title overlap >60%" is the model judging its own output.**
> 3. The agent is the UNTRUSTED party in this repository's SEC-001 threat model, yet
>    it is the only thing deduplicating its own findings …

**And a deterministic id-based gate already exists.** `cmd_dedup_verify`
(`upstream-monitor.sh:407`) reads each created issue's fingerprint **back from
GitHub, not from the manifest, so a misreporting agent cannot hide a duplicate by
omitting it** (`:402-404`), and closes every other holder (`:499`). It **fails
closed** — an unreadable manifest, a missing fingerprint or a failed holder lookup
all make the run `UNVERIFIED` rather than clean (`:405-406`, `:558-559`). The holder
lookups are the two `gh issue list` calls at **`:290`** and **`:375`**, and its
verdicts already surface as step outputs (`upstream-monitor.yml:132-139`).

> **Citation correction.** Earlier drafts cited `upstream-monitor.sh:231` and `:316`
> for the registry and dedup lookups. Line 231 is a comment about the weekly issue
> cap and line 316 is inside the unreadable-fingerprint loop. Neither is a `gh issue
> list` call. The actual calls are at `:290` and `:375`.

**This reframes the choice.** It is not "keep the 60% heuristic or invent an
id-based rule" — the id-based rule already ships, as a *post-hoc* gate that closes
duplicates after they exist. The split's job 2 would run the same deterministic
fingerprint check **before** creating rather than after. That is strictly better
than both options earlier drafts offered, and it is the reason the cheapest of the
six is still not a mechanical change: the behaviour that gets moved is a judgement
the repo has already documented as unenforced.

---

## 7. The five that are blocked: what is known, and what is deliberately not designed

**No per-job split design appears in this section.** Each of these five needs
`github_token` to stop being unconditionally required (§0.1), and designing a job
layout against a contract that forbids it produces a document that reads as a spec
and is not one — which is what this note's first two drafts were. What follows is
what is verified about each today, and what must be settled before any layout is
written.

### 7.1 `scheduled-audit.yml` → `audit` — blocked twice

**Today.** `schedule` + `workflow_dispatch`. Workflow-level permissions are
`contents: write, pull-requests: write, issues: write` and the job inherits them. A
`uses: ./` step (`:56`) receives `github_token` (`:63`) plus four provider keys, with
`audit_create_issues: true` and `audit_auto_fix: true`. A second step creates autofix
labels with `GH_TOKEN`.

**Blocked on (a)** §0.1 — `uses: ./` cannot run without a token.
**Blocked on (b)** §2 — the engine-side *completed-and-empty* vs *failed* signal.

**(b) is the deeper one and does not go away when (a) does.** Splitting the job does
not make `audit.ts:282` stop publishing `[]` for a run that did not complete; it only
moves the consequence further downstream, to a job that cannot tell the difference.
This is the entry to settle second and the one most likely to be rushed.

### 7.2 `ai-review.yml` → `fix-issue` — blocked, plus the §1.1 trap

**Today.** `issues` and `issue_comment` triggers, with `if:` requiring
`github.event.issue.pull_request == null` (`ai-review.yml:37`), so by construction
**there is no PR**. `permissions: contents: write, pull-requests: write, issues: write`.
A `uses: ./` step in `mode: fix` receives `github_token` plus four provider keys.

**Not a ref-pin problem**, and recorded so nobody reintroduces it: on its own triggers
`github.sha` is already the default branch, and a decorative `ref: ${{ github.sha }}`
would certify nothing, since on a `pull_request` trigger that expression is the merge
ref.

**Write target.** Job 2 does **not** push to "the PR branch" — there is no PR.
`fix.ts:935` builds `autofix/issue-${issueNumber}` and opens a PR from it. Any job 2
here inherits the §1.1 trap: reproduce freshness (`fix.ts:819`) **and** ownership
(`fix.ts:977`) **and** the recreate-from-default control (`fix.ts:981-988`), or
reproduce only the last. The email check alone is forgeable and the code says so.

### 7.3 `ai-review.yml` → `review` — blocked

**Today.** `pull_request`, same-repo head, excluding `autofix/` and `improvement/`
heads and bot actors. `permissions: pull-requests: write`. Since #979 the checkout is
pinned to `github.event.pull_request.base.sha`, so the **bundle** is trusted — but the
step still receives `github_token` plus four provider keys and the guard still flags
it. Pinning removed the code-execution half of the risk; it did not remove the
credential co-location.

**Known cost, already accepted in #979 rather than hidden:** because the job runs the
base bundle, a PR touching `action.yml`/`action/lib/**` is reviewed by the pre-change
bundle, and with `enableReachability: true` the reachability graph resolves against
base content.

**Before a layout is written:** decide whether job 2 posts a review *and* inline
comments, or only one. That determines whether `issues: write` is ever in scope, and
it is a product decision this note has not made.

### 7.4 `ai-review.yml` → `fast-review` — blocked

**Today.** `workflow_dispatch`-only, `inputs.fast_review == 'true'`,
`permissions: {}` (`:183-185`) — and still flagged, because the `uses: ./` step
receives `github_token` plus provider keys through `with:` (§1.2). The manual trigger
means the dispatcher is already privileged, so this is the lowest-risk of the six; it
is listed because the class is the class.

**Option worth weighing when it becomes buildable.** If this job is genuinely a manual
operator convenience, deleting `github_token` from the model step and posting from a
second job is cheap. An alternative is to drop the `with:` credential entirely and
accept a review that cannot comment — a product decision, recorded rather than
assumed.

### 7.5 `ai-review.yml` → `autofix` — blocked

**Today.** `pull_request` with the `autofix` label, or `issue_comment` `/fix` from an
OWNER/MEMBER/COLLABORATOR on a PR. `permissions: contents: write, pull-requests: write,
issues: write`. **Already pinned** to `steps.resolve-ref.outputs.ref` — an immutable
PR-head SHA — with fail-closed guards refusing cross-repository PRs and unresolvable
SHAs. The moving-ref TOCTOU is closed; the PR's own code still executes beside a write
PAT.

**Why this is not simply "pin it to base".** `autofix` builds commits and pushes them
to the PR branch. Checking out the base would mean pushing a base-derived branch onto
a branch that has diverged, which can clobber the author's commits. That is a change
in the loop's semantics, not in its pin, and it needs its own evidence.

**Before a layout is written:** the head-moved detection that job 2 needs is the same
shape as the §1.1 freshness check, but bound to a PR head rather than a default tip.
Whether that generalises has not been verified here.

---

## 8. Sequencing

1. **`upstream-monitor:create-issues`** — first, and the only thing that can be built
   today. The boundary artifact already exists; only the publisher model moves. Take
   the §6.3 product decision before starting.
2. **Make `github_token` optional, per mode, in `inputs.ts`** — §0.5. Nothing in
   §7.1–§7.5 can start before this. Own PR, own review. The guard's rule must not
   change: §0.2 shows a read-only token is still the credential the class is about.
3. **The engine-side completion signal** for `audit` (§2) — *completed-and-empty* vs
   *failed* — before any audit workflow is written. Independent of step 2; can run in
   parallel.
4. **The four `ai-review.yml` jobs**, which share one shape, once 2 and 3 have landed.

Trim each `KNOWN_VIOLATIONS` entry in the **same** commit that splits its job. A guard
that stops flagging a job that still runs the model beside the credential is worse
than no guard.

---

## 9. What this note does not do, and what it has not verified

It changes no workflow, no script, no `action.yml` and no allowlist entry. It is the
reversible part of the work, and it exists so the credential-class question is decided
by a human with the whole design visible, rather than one split at a time under
deadline.

**This note is not a claim of completeness.** Specifically:

- **§7 writes no designs**, by choice (§0, §7 preamble). Five of six entries have no
  per-job layout in this document, and that is the accurate state of the work.
- The per-mode behaviour of `lib` and `action` with an absent `github_token` has
  **not** been traced beyond `inputs.ts:499-501`. §0.5(3) is a real open item.
- The bundle rebuild for #982 is **not verifiable in this environment** — the build
  refuses below Node 24.21.0 and a below-floor build differs by module-ID renumbering
  alone — and waits for a conforming runner.
- No statement here was taken from an earlier draft of this note on trust. Every
  citation in this document was re-read against the tree at the head SHA recorded in
  §A. Three of them were wrong and are corrected inline; the corrections are marked,
  not silently applied.

---

## Appendix A — verification log

Re-run against this branch's head. Commands are exact; results are actual.

| claim | command | result |
|---|---|---|
| tree this log was taken against | `git rev-parse HEAD` | `3bcd8e0971838d8dc3a24289d38b7232d950e3b1` (merge base with `main`: `f55bc99edf8234f22cc7bc1d7c9b73b87677a2ee`) |
| `github_token` is `required: true` | `sed -n '14,16p' action.yml` | holds — **but see §0.1**: GitHub documents that `required: true` does not itself error on an omitted input |
| the real enforcement | `sed -n '499,501p' action/src/inputs.ts` | `core.getInput('github_token', { required: true })` + `throw` on empty, unconditional |
| it runs for every mode | `sed -n '101p' action/src/index.ts` | `parseInputs` called before any mode dispatch |
| the other required inputs | `grep -n "required: true" action.yml` | lines 11 (`mode`, has default) and 16 (`github_token`, no default) |
| guard rule | `sed -n '124p' test-ai-job-credential-isolation.sh` | `GH = re.compile(r'secrets\.(GITHUB_TOKEN\|GH_PAT)\|github\.token')` |
| live count is 6 | the guard's own `violations()` body | 6, matching `KNOWN_VIOLATIONS` `:104-109` |
| a `ref:` pin retires nothing | pin `scheduled-audit.yml`'s checkout, re-run | still 6 |
| removing the credential retires it | delete `github_token:` from the audit step | 5, dropping exactly `scheduled-audit.yml:audit:./` |
| a read-only token does not | substitute `${{ github.token }}` | still 6, entry still listed |
| audit gap | `sed -n '261,288p' action/src/audit.ts` | `:272` `setFailed` + return (silent); `:282` `core.warning` + return — **the gap** |
| freshness guard | `sed -n '819,830p' action/src/fix.ts` | `merge-base --is-ancestor`; docstring says freshness only |
| ownership probe | `sed -n '970,989p' action/src/fix.ts` | `tipEmail === gitEmail`; exists |
| ownership is not a boundary | `sed -n '956,959p' action/src/fix.ts` | verbatim: "not a security boundary … attacker can pass it; the recreate-from-default path below is the actual security control" |
| push target | `sed -n '935p' action/src/fix.ts` | `` `autofix/issue-${issueNumber}` `` |
| no PR on `fix-issue` | `sed -n '37p' .github/workflows/ai-review.yml` | `github.event.issue.pull_request == null` |
| prompt dedup rule | `sed -n '900,903p' upstream-monitor.sh` | `## DEDUP + CAP (strict)` at 900, rule at **903** — earlier drafts' `:863` is the prompt's opening line |
| deterministic gate exists | `sed -n '400,413p' upstream-monitor.sh` | `cmd_dedup_verify` reads fingerprints back from GitHub, fails closed to `UNVERIFIED` |
| registry lookups | `grep -n "gh issue list" upstream-monitor.sh` | `:290` and `:375` — earlier drafts' `:231`/`:316` are comments |
| `create-issues` is script-based | `sed -n '167,174p' upstream-monitor.yml` | `run: bash .github/scripts/upstream-monitor.sh publish`, `GH_TOKEN` + `OPENCODE_API_KEY` in one `env:` |
| guard test suite | `bash .github/scripts/tests/test-ai-job-credential-isolation.sh` | `passed: 37  failed: 0`, exit 0 |

**Pattern worth recording.** Three drafts, and each round of review found real
factual errors in the one before — because the note is meant to be the durable spec,
so an inaccuracy in it is a spec bug, not a typo. Two rounds produced six such
errors; this rewrite re-read every citation against the tree and found three more in
the round-two corrections themselves (§0.1, §1.1, §6.3). The discipline that made
the #982 redaction test non-vacuous is the same one: assert on the line the code
actually has, not the line the document claims — and when the two disagree, the
document is what is wrong.
