import { readFileSync, readdirSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

/**
 * Issue #852: a job that runs `uses: ./` on a `pull_request` ref while holding a
 * PAT or provider API key executes PR-controlled code, because `uses: ./` loads
 * the action manifest from the checkout -- which on `pull_request` is
 * `refs/pull/N/merge` -- not from the default branch.
 *
 * These assertions are static on purpose. The property being defended is a
 * property of the workflow file, and a runtime test could not observe it: the
 * job either starts with a credential or it does not.
 *
 * The property is asserted across EVERY workflow, not just the one the original
 * report named. `scheduled-audit.yml` also runs `uses: ./` with the same
 * credential set and is safe today only because of its triggers -- a fact that
 * no assertion encoded until now.
 */

const workflowsDir = new URL('../../.github/workflows/', import.meta.url);

interface WorkflowStep {
  uses?: string;
  with?: Record<string, string>;
}

interface WorkflowJob {
  if?: string;
  'runs-on'?: string;
  env?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface WorkflowFile {
  // `on:` is typed loosely on purpose: a YAML 1.1 boolean or any other scalar
  // is a legal parse result here, and the fail-closed branches exist to handle
  // exactly those, so the type must admit them rather than force a cast.
  on?: Record<string, unknown> | string | boolean | null;
  jobs: Record<string, WorkflowJob>;
}

/** Every workflow in `.github/workflows/`, keyed by file name. */
const allWorkflows: Record<string, WorkflowFile> = Object.fromEntries(
  readdirSync(workflowsDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map((name) => [name, load(readFileSync(new URL(name, workflowsDir), 'utf8')) as WorkflowFile]),
);

const workflow = allWorkflows['ai-review.yml'];
// Optional-chained deliberately: if ai-review.yml is renamed or removed, a hard
// dereference here would throw during collection, before any test body runs, so
// the anti-vacuity test below could never report its own message about exactly
// that class of broken read. All downstream uses are `?.`-chained already.
const jobs = workflow?.jobs ?? {};

const publisherSource = readFileSync(
  new URL('../../.github/workflows/self-improvement.yml', import.meta.url),
  'utf8',
);

/**
 * The branch prefix the autonomous publisher actually writes to, read from the
 * publisher itself rather than restated here. If `BRANCH="improvement/..."` is
 * renamed, this follows it and the guard assertion fails loudly — instead of
 * both the assertion and the workflow guard silently protecting a prefix nobody
 * publishes to any more.
 */
const publishedPrefix = /^\s*BRANCH="([a-z][a-z0-9-]*)\//m.exec(publisherSource)?.[1];

/** Every `secrets.*` reference appearing in a job's `if:`, `env:`, or its steps. */
function secretsInJob(job: WorkflowJob): string[] {
  // A job-level `env:` is legal in Actions and is the natural place to hoist
  // `github_token: ${{ secrets.GH_PAT }}` out of a step, so scan it too —
  // otherwise a hoisted secret would drop the job out of the exposed set.
  const body = `${job.if ?? ''}\n${JSON.stringify(job.env ?? {})}\n${JSON.stringify(job.steps ?? [])}`;
  return [...new Set([...body.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
}

/** Jobs that execute this repository's own action code. */
function jobsUsingLocalAction(file: WorkflowFile): string[] {
  return Object.entries(file.jobs)
    .filter(([, job]) => (job.steps ?? []).some((step) => step.uses === './'))
    .map(([name]) => name)
    .sort();
}

/**
 * Events a job may be *positively* restricted to.
 *
 * Classification is deliberately fail-closed: a job counts as
 * pull_request-reachable unless its `if:` positively pins it to a non-PR event
 * AND never reads a pull-request payload. Matching on the *presence* of
 * `event_name == 'pull_request'` instead would drop a job that is reachable
 * through some other spelling — or through no `if:` at all — and the security
 * loop below would then pass vacuously over a smaller set than it claims.
 *
 * The payload check is what keeps this honest in both directions: `autofix`
 * names `issue_comment` but also serves `pull_request`, so it stays in the set,
 * while `fix-issue` only ever reads `github.event.issue.pull_request` (a URL
 * fragment on an *issue* event, not a PR payload) and is correctly excluded.
 */
const NON_PULL_REQUEST_EVENT =
  /github\.event_name\s*==\s*'(issues|issue_comment|workflow_dispatch|schedule|push)'/;
const READS_PULL_REQUEST_PAYLOAD = /github\.event\.pull_request\./;

/**
 * The workflow-level trigger set — the authoritative statement of which events
 * can start a job at all. `scheduled-audit.yml` runs `uses: ./` with the same
 * credential set as `ai-review.yml` and is safe purely because its `on:` is
 * `schedule` + `workflow_dispatch`; that fact is now encoded rather than
 * assumed, so adding a `pull_request` trigger there fails this suite.
 *
 * `workflow_run` counts as PR-reachable. It is a first-class path from a
 * pull-request run to a secret-bearing job: `workflow-health.yml` subscribes to
 * `workflow_run` for `CI`, `CodeQL` and `AI Multi-Agent Review` — all of which
 * run on `pull_request` — and already holds `secrets.GH_PAT`. It is safe today
 * only because its checkout omits `ref:` and it drives the `gh` CLI via `run:`
 * rather than `uses: ./`. Adding `ref: ${{ github.event.workflow_run.head_sha }}`
 * plus a `uses: ./` step would otherwise open it with this suite still green.
 *
 * Fails closed on every ambiguous input: an absent `on:`, a non-mapping scalar,
 * or a trigger name this helper does not recognise is all treated as declaring
 * every event, so a malformed trigger block cannot quietly empty the exposed
 * set. Verified: `on: yes` parses to the *string* `'yes'` under js-yaml v4's
 * default schema, not to a boolean, so the string branch — not the scalar one —
 * is where an unrecognised trigger actually lands.
 */

/** Event names this helper is willing to treat as "definitely not a PR path". */
const NON_PULL_REQUEST_TRIGGERS: ReadonlySet<string> = new Set([
  'push',
  'schedule',
  'workflow_dispatch',
  'issues',
  'issue_comment',
  'repository_dispatch',
  'release',
]);

function declaresPullRequestTrigger(file: WorkflowFile): boolean {
  const triggers = file.on;
  if (triggers === undefined || triggers === null) return true;

  if (typeof triggers === 'string') {
    // `on: push` is a legal single-trigger form. Anything else is either
    // `pull_request`/`workflow_run`, or a scalar GitHub would not accept as a
    // trigger at all — ambiguous, so fail closed rather than declare it safe.
    return (
      triggers === 'pull_request' ||
      triggers === 'workflow_run' ||
      !NON_PULL_REQUEST_TRIGGERS.has(triggers)
    );
  }

  // A YAML boolean, an array, or any other non-mapping: not a trigger map we
  // can read. Object.keys() on it yields nothing, which would silently empty
  // the exposed set, so treat it as "every event" instead.
  if (typeof triggers !== 'object' || Array.isArray(triggers)) return true;

  const names = Object.keys(triggers);
  return names.includes('pull_request') || names.includes('workflow_run');
}

function jobsReachableFromPullRequest(file: WorkflowFile): string[] {
  // A job cannot start on an event its workflow does not subscribe to.
  if (!declaresPullRequestTrigger(file)) return [];
  return Object.entries(file.jobs)
    .filter(([, job]) => {
      const condition = job.if ?? '';
      if (READS_PULL_REQUEST_PAYLOAD.test(condition)) return true;
      return !NON_PULL_REQUEST_EVENT.test(condition);
    })
    .map(([name]) => name)
    .sort();
}

/**
 * The ONE checkout ref expression this guard treats as trusted.
 *
 * This suite used to be ref-blind, and PR #986 records why that was load-
 * bearing: `violations()` in the sibling shell guard contains no `ref` term at
 * all, so a pinned and an unpinned checkout are flagged identically. Ref-
 * blindness was CORRECT while the `review` job's checkout was unpinned, because
 * an unpinned `actions/checkout` on `pull_request` resolves to
 * `refs/pull/N/merge` -- precisely the PR-controlled code that executing
 * `uses: ./` beside GH_PAT is the whole hazard.
 *
 * #979 pinned that checkout to `pull_request.base.sha`. The bundle the
 * credentialed step executes is now base content: the job is still credentialed
 * and still PR-triggered, but the code holding GH_PAT is no longer code the PR
 * author wrote. So the ref-blind clause no longer describes the risk, and
 * leaving it in place would keep reporting an exposure that has been closed.
 *
 * This is an ALLOWLIST, and deliberately the narrowest one expressible: an
 * expression is trusted only if it is byte-identical to the base-sha pin.
 * Classification is therefore fail-closed by construction:
 *
 *   - `${{ github.sha }}`     -> UNTRUSTED. On `pull_request` this IS the merge
 *                                ref, so it is the exact #919 defect wearing the
 *                                costume of a pin -- the trap this allowlist
 *                                exists to refuse rather than reward.
 *   - `pull_request.head.sha` -> UNTRUSTED. That is the author's own commit.
 *   - `${{ github.ref }}`, `main`, a typo, or an absent `ref:` -> UNTRUSTED.
 *
 * Any future base-ref spelling (a tag, a branch, a differently-quoted
 * expression) reads as untrusted and must be widened deliberately, with the
 * mutation check below still covering the revert.
 */
const TRUSTED_CHECKOUT_REF = '${{ github.event.pull_request.base.sha }}';

/**
 * True when every `actions/checkout` in the job pins the trust boundary to
 * base content.
 *
 * Fail-closed on both edges, because each edge is a way to *look* pinned while
 * not being pinned:
 *
 *  - ZERO checkouts: the bundle's origin is unestablished, so this is false.
 *  - ANY checkout that is not the base pin: false, even when a sibling step in
 *    the same job IS pinned. A job with one trusted and one untrusted checkout
 *    has no single trust boundary, and the untrusted one could be the last to
 *    repopulate `action/lib/` before `uses: ./` resolves it.
 */
function loadsBundleFromTrustedCheckout(job: WorkflowJob | undefined): boolean {
  const refs = (job?.steps ?? [])
    .filter((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout'))
    .map((step) => String(step.with?.ref ?? '').trim());
  if (refs.length === 0) return false;
  return refs.every((ref) => ref === TRUSTED_CHECKOUT_REF);
}

/**
 * The subset that is actually exposed: pull_request-reachable AND holding
 * secrets AND loading `uses: ./` from a ref the PR author cannot write.
 *
 * The third clause makes this suite STRICTLY STRONGER than the ref-blind
 * version it replaces rather than laxer, because it converts an invisible edit
 * into a failing one: before it, a job's checkout was never examined at all, so
 * deleting the base pin changed nothing this function could see. After it,
 * deleting that pin puts the job straight back into the exposed set and fails
 * the enumeration assertion below. The mutation check proves that end to end.
 *
 * What it costs is real and is not glossed: a job that leaves the exposed set
 * also leaves the generic "every exposed job needs a same-repository guard"
 * sweep above. `review` is therefore still pinned there, but by named
 * assertions instead of by that sweep -- the `if:` clause-list tests below
 * (`the review job carries both the same-repository guard and the publisher
 * exclusion` and `keeps the review guard a pure conjunction ...`) read
 * `jobs.review.if` directly and are unaffected by membership in the exposed
 * set. Trust for `review` is now the base pin PLUS those two guards. Stated
 * here so a later edit does not assume the generic sweep still covers it.
 */
function exposedJobs(file: WorkflowFile): string[] {
  return jobsReachableFromPullRequest(file).filter((name) => {
    const job = file.jobs[name];
    const runsLocalAction = (job?.steps ?? []).some((step) => step.uses === './');
    return (
      runsLocalAction &&
      secretsInJob(job as WorkflowJob).length > 0 &&
      !loadsBundleFromTrustedCheckout(job as WorkflowJob)
    );
  });
}

describe('workflow credential guards', () => {
  it('reads every workflow in .github/workflows/', () => {
    // If the directory read breaks, every per-file assertion below is vacuous.
    expect(Object.keys(allWorkflows).length).toBeGreaterThan(1);
    expect(Object.keys(allWorkflows)).toContain('ai-review.yml');
  });

  it('no workflow anywhere runs `uses: ./` with secrets on a pull_request ref unguarded', () => {
    for (const [fileName, file] of Object.entries(allWorkflows)) {
      for (const name of exposedJobs(file)) {
        const job = file.jobs[name];
        expect(
          job?.if ?? '',
          `${fileName}: job "${name}" runs \`uses: ./\` on a pull_request ref with ` +
            `${secretsInJob(job as WorkflowJob).join(', ')} but its \`if:\` does not require a ` +
            `same-repository head, so a fork or agent-authored PR can reach it. ` +
            `Observed: ${job?.if || '<none>'}`,
        ).toContain('github.event.pull_request.head.repo.full_name == github.repository');
      }
    }
  });

  it('enumerates every exposed job, so a new one has to be looked at', () => {
    // The pin makes the surface reviewable in a diff. If this fails, some
    // workflow gained a credential-bearing `uses: ./` job on a pull_request ref
    // — work out whether it is genuinely safe before widening the list.
    //
    // `review` left this set because its checkout pins the executed bundle to
    // base content (#979), so the code beside GH_PAT is not PR-controlled. It
    // is NOT untrusted and it is NOT unguarded: the mutation check below
    // restores the unpinned checkout and requires `review` to return here.
    // `autofix` stays, deliberately and forever-ish: fix mode must run the PR's
    // own code, so its checkout cannot be pinned to base and its credential
    // co-location is structural, not incidental.
    const exposed = Object.entries(allWorkflows).flatMap(([fileName, file]) =>
      exposedJobs(file).map((job) => `${fileName}:${job}`),
    );
    expect(exposed.sort()).toEqual(['ai-review.yml:autofix']);
  });

  it('parses and finds the expected secret-bearing jobs in ai-review.yml', () => {
    // If this fails the guards below are vacuously passing.
    expect(jobsUsingLocalAction(workflow)).toEqual([
      'autofix',
      'fast-review',
      'fix-issue',
      'review',
    ]);
    // `auto-merge` and `notify-merged` are pull_request-reachable but drive the gh
    // CLI rather than `uses: ./`, so they are not part of the exposed set.
    // `review` runs `uses: ./` and is credentialed, and is absent here only
    // because its checkout is base-pinned — see the exposed-set mutation below,
    // which fails if that pin is ever removed.
    expect(exposedJobs(workflow)).toEqual(['autofix']);
  });

  it('the review job carries both the same-repository guard and the publisher exclusion', () => {
    const condition = jobs.review?.if ?? '';
    expect(publishedPrefix, 'could not read BRANCH prefix from self-improvement.yml').toBeDefined();
    expect(condition).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository',
    );
    // self-improvement.yml opens agent-authored PRs on same-repo branches, so
    // the same-repository guard alone does not close that chain. The prefix is
    // read from the publisher, not restated, so a rename breaks this assertion.
    expect(condition).toContain(
      `!startsWith(github.event.pull_request.head.ref, '${publishedPrefix}/')`,
    );
    // The pre-existing autofix/ exclusion must survive the change.
    expect(condition).toContain("!startsWith(github.event.pull_request.head.ref, 'autofix/')");
  });

  it('keeps the bot-actor exclusion, so bot-authored PRs stay unreviewed', () => {
    for (const actor of ['github-actions[bot]', 'opencode-ai-reviewer[bot]', 'dependabot[bot]']) {
      expect(jobs.review?.if ?? '').toContain(actor);
    }
  });

  it('keeps the review guard a pure conjunction of exactly the intended clauses', () => {
    // `toContain` alone cannot tell a guard from `if: false` with decoration:
    // both satisfy any substring check. Nor can a clause-shape check alone --
    // `A == B || true && ...` still contains `==`, still satisfies every
    // `toContain` above, and because `&&` binds tighter than `||` it parses as
    // `A == B || (true && ...)`, i.e. unconditionally true. Verified: that edit
    // left all 7 tests green with forks, `autofix/`, `improvement/` and bot
    // authors all reaching the secret-bearing job.
    //
    // So reject any disjunction outright -- no legitimate guard here needs one --
    // and then pin the clause list exactly. With `||` excluded, splitting on
    // `&&` yields the true top-level conjunction, so each clause must be one of
    // the expected ones verbatim. That also rejects a self-comparison tautology
    // (`x == x`), which the shape check alone would accept.
    const condition = jobs.review?.if ?? '';
    expect(condition.length).toBeGreaterThan(0);
    expect(condition, 'a `||` in the guard can make every clause vacuous').not.toMatch(/\|\|/);

    const clauses = condition
      .split('&&')
      .map((clause) => clause.trim())
      .filter(Boolean);

    expect(clauses).toEqual([
      "github.event_name == 'pull_request'",
      'github.event.pull_request.head.repo.full_name == github.repository',
      "!startsWith(github.event.pull_request.head.ref, 'autofix/')",
      `!startsWith(github.event.pull_request.head.ref, '${publishedPrefix}/')`,
      `!contains(fromJson('["github-actions[bot]","opencode-ai-reviewer[bot]","dependabot[bot]"]'), github.actor)`,
    ]);
  });

  it('the autofix job keeps its own same-repository guard (regression guard for #852)', () => {
    expect(jobs.autofix?.if ?? '').toContain(
      'github.event.pull_request.head.repo.full_name == github.repository',
    );
  });
});

/**
 * Issue #852 is the property that `uses: ./` must not resolve PR-controlled
 * code in a step that holds GH_PAT. #979 closed the `review` half of it by
 * pinning that checkout to the base sha; the guard above was ref-blind and so
 * could not see the difference.
 *
 * These assertions pin the closing mechanism itself, so the fix cannot be
 * undone by an edit that looks like a refactor:
 *
 *  - `review`'s checkout is base-pinned, asserted directly on the real file;
 *  - the allowlist classifies each tempting-but-wrong ref as UNTRUSTED;
 *  - and, critically, MUTATION — restoring the unpinned checkout of the pre-fix
 *    file must put `review` BACK into the exposed set. A guard that stopped
 *    firing when the bug returned would be worse than no guard, because it
 *    would report the repository as clean.
 */
describe('trusted-checkout allowlist (#852 / #919)', () => {
  /** The `actions/checkout` steps of a job, in step order. */
  function checkouts(job: WorkflowJob): WorkflowStep[] {
    return (job.steps ?? []).filter(
      (step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout'),
    );
  }

  it('still finds `review` as a credential-bearing `uses: ./` job on this file', () => {
    // Anti-vacuity for the whole block: if `review` stopped running the local
    // action, stopped holding secrets, or stopped being PR-reachable, every
    // assertion below would pass for the wrong reason.
    expect(jobsUsingLocalAction(workflow)).toContain('review');
    expect(secretsInJob(jobs.review as WorkflowJob)).toContain('GH_PAT');
    expect(jobsReachableFromPullRequest(workflow)).toContain('review');
  });

  it('pins the review job checkout to the base sha, so `uses: ./` is base code', () => {
    // Asserted on the REAL file, not derived from exposedJobs, so that a bug in
    // the classifier cannot hide a pin that was actually deleted.
    const refs = checkouts(jobs.review as WorkflowJob).map((step) => String(step.with?.ref ?? ''));
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(
        ref,
        'the review job checked out something other than the base sha, so `uses: ./` ' +
          'executes PR-controlled code while holding GH_PAT and four provider keys (#919)',
      ).toBe(TRUSTED_CHECKOUT_REF);
    }
    expect(loadsBundleFromTrustedCheckout(jobs.review)).toBe(true);
  });

  it('classifies every wrong ref as untrusted, including the merge-ref impostor', () => {
    // `${{ github.sha }}` is the one that matters most: on `pull_request` it IS
    // refs/pull/N/merge, so it re-opens #919 while looking exactly like a pin.
    const impostors = [
      '${{ github.sha }}',
      '${{ github.event.pull_request.head.sha }}',
      '${{ github.event.pull_request.head.ref }}',
      '${{ github.ref }}',
      'main',
      'refs/pull/${{ github.event.number }}/merge',
      '',
    ];
    for (const ref of impostors) {
      const probe: WorkflowJob = {
        steps: [
          { uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', with: { ref } },
          { uses: './', with: { github_token: '${{ secrets.GH_PAT }}' } },
        ],
      };
      expect(
        loadsBundleFromTrustedCheckout(probe),
        `"${ref}" was treated as a trusted checkout`,
      ).toBe(false);
    }
  });

  it('refuses a job with no checkout at all, and one with a mixed pair', () => {
    // No checkout means the bundle's origin is unestablished. A mixed pair means
    // there is no single trust boundary: one untrusted checkout is enough,
    // even beside a correctly pinned one.
    const checkout = (ref: string): WorkflowStep => ({
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: { ref },
    });
    expect(loadsBundleFromTrustedCheckout({ steps: [{ uses: './' }] })).toBe(false);
    expect(
      loadsBundleFromTrustedCheckout({
        steps: [checkout(TRUSTED_CHECKOUT_REF), checkout('${{ github.sha }}')],
      }),
      'a job with one pinned and one unpinned checkout was treated as trusted',
    ).toBe(false);
    expect(
      loadsBundleFromTrustedCheckout({
        steps: [checkout(TRUSTED_CHECKOUT_REF), checkout(TRUSTED_CHECKOUT_REF)],
      }),
    ).toBe(true);
  });

  /**
   * MUTATION. Reconstructs the PRE-FIX file — the #919 state, where the review
   * job's checkout carries no `ref:` at all — and requires the exposed set to
   * put `review` back.
   *
   * This is the assertion that makes the narrowing above meaningful. Without
   * it, "review is no longer exposed" and "the scan stopped looking at review"
   * are indistinguishable, which is precisely the failure mode the rest of this
   * suite is written against.
   */
  it('MUTATION: the pre-fix unpinned checkout puts `review` back in the exposed set', () => {
    const preFix = structuredClone(workflow);
    const job = preFix.jobs.review as WorkflowJob;
    const reviewCheckouts = checkouts(job);
    expect(reviewCheckouts.length).toBeGreaterThan(0);
    for (const step of reviewCheckouts) {
      // Exactly the #919 revert: the pin line is removed, nothing else changes.
      // Rebuilt rather than `delete`d so the mutation cannot depend on the
      // key being absent versus present-but-undefined.
      const { ref: _removedPin, ...withoutPin } = step.with ?? {};
      step.with = withoutPin;
    }

    // The mutant must be a real mutation before its verdict means anything.
    expect(loadsBundleFromTrustedCheckout(job), 'the mutation did not apply').toBe(false);
    expect(exposedJobs(preFix), 'the pre-fix file must re-expose `review`').toContain('review');
    // And the shipped file, for contrast, must not.
    expect(exposedJobs(workflow)).not.toContain('review');
  });

  it('MUTATION: re-pinning to `${{ github.sha }}` also re-exposes `review`', () => {
    // The subtler revert. `github.sha` LOOKS like a pin and reads as one in
    // review, but on a pull_request event it is the merge ref — the #919 defect
    // wearing a costume. A guard that accepted it would let the fix be undone
    // with a one-word edit that no reviewer would question.
    const impostor = structuredClone(workflow);
    const job = impostor.jobs.review as WorkflowJob;
    for (const step of checkouts(job)) {
      step.with = { ...(step.with ?? {}), ref: '${{ github.sha }}' };
    }
    expect(loadsBundleFromTrustedCheckout(job), 'the mutation did not apply').toBe(false);
    expect(exposedJobs(impostor)).toContain('review');
  });

  it('keeps autofix exposed: fix mode must run the PR head, so it cannot be pinned', () => {
    // If autofix were ever pinned to base, its loop would push commits derived
    // from base content and could clobber the author's work — a behaviour change
    // that needs its own evidence, not something to slip in via a pin.
    const ref = checkouts(jobs.autofix as WorkflowJob)
      .map((step) => String(step.with?.ref ?? ''))
      .find(Boolean);
    expect(ref).toBe('${{ steps.resolve-ref.outputs.ref }}');
    expect(loadsBundleFromTrustedCheckout(jobs.autofix)).toBe(false);
    expect(exposedJobs(workflow)).toContain('autofix');
  });

  it('does not touch the sibling shell guard, which stays ref-blind on purpose', () => {
    // `test-ai-job-credential-isolation.sh` documents its own ref-blindness as
    // a deliberate trade and is not modified here. Its invariant is co-location,
    // not code provenance, so teaching it about pins would retire a finding on
    // the strength of an annotation rather than an actual separation. This
    // assertion exists so a later "consistency" edit has to justify itself.
    const shellGuard = readFileSync(
      new URL('../../.github/scripts/tests/test-ai-job-credential-isolation.sh', import.meta.url),
      'utf8',
    );
    expect(shellGuard).toContain('ai-review.yml:review:Review pull request');
    expect(shellGuard).toMatch(/PERMISSION-BLIND — DELIBERATE/);
  });
});
