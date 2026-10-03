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
  run?: string;
  id?: string;
  env?: Record<string, string>;
  name?: string;
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

/** The subset that is actually exposed: pull_request-reachable AND holding secrets. */
function exposedJobs(file: WorkflowFile): string[] {
  return jobsReachableFromPullRequest(file).filter((name) => {
    const job = file.jobs[name];
    const runsLocalAction = (job?.steps ?? []).some((step) => step.uses === './');
    return runsLocalAction && secretsInJob(job as WorkflowJob).length > 0;
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
    const exposed = Object.entries(allWorkflows).flatMap(([fileName, file]) =>
      exposedJobs(file).map((job) => `${fileName}:${job}`),
    );
    expect(exposed.sort()).toEqual(['ai-review.yml:autofix', 'ai-review.yml:review']);
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
    expect(exposedJobs(workflow)).toEqual(['autofix', 'review']);
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
 * The `review` job's Checkout comment states which jobs in ai-review.yml pin
 * `base.sha`. That comment was wrong: it said "used here and nowhere else in
 * this file" while `auto-merge` pinned the same expression, and the line above
 * it said the pin "mirrors `auto-merge` below" — so a reader grepping `base.sha`
 * found two hits and could not trust either claim. A comment whose entire
 * purpose is to be trustworthy about which ref is pinned must be correct.
 *
 * Asserting the INVARIANT rather than the comment text is what stops it rotting
 * again: if a third job adopts the pin, or `autofix` is ever repinned to base,
 * this fails and the comment is forced to move in the same change.
 */
describe('base.sha pin inventory (what the Checkout comment claims)', () => {
  /** Jobs whose checkout pins the PR base sha. */
  function baseShaPinnedJobs(file: WorkflowFile): string[] {
    return Object.entries(file.jobs ?? {})
      .filter(([, job]) =>
        (job.steps ?? []).some((step) =>
          String(step.with?.ref ?? '').includes('pull_request.base.sha'),
        ),
      )
      .map(([name]) => name)
      .sort();
  }

  it('pins base.sha in exactly the two jobs the comment names', () => {
    expect(baseShaPinnedJobs(workflow)).toEqual(['auto-merge', 'review']);
  });

  it('does NOT pin autofix to base — fix mode must run the PR head', () => {
    // `autofix` is the deliberate exception and the comment now says so. If this
    // ever changes, either the exception or the comment must move together.
    const autofixRef = (workflow.jobs?.autofix?.steps ?? [])
      .map((step) => step.with?.ref ?? '')
      .find(Boolean);
    expect(autofixRef).toBe('${{ steps.resolve-ref.outputs.ref }}');
  });

  it('keeps the comment free of the now-false "and nowhere else" claim', () => {
    // A targeted guard on the one phrase that was factually wrong. Deliberately
    // narrow: pinning prose wholesale would make this test a hostage to rewording.
    const source = readFileSync(
      new URL('../../.github/workflows/ai-review.yml', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/base\.sha` is used here and nowhere else/);
    // The corrected claim must actually be present, or the invariant above would
    // be enforced with nothing documenting it.
    expect(source).toMatch(/`base\.sha` is used here and in `auto-merge` below/);
  });
});

/**
 * Issue #852 forces the `review` job's checkout to the BASE sha, because an
 * unpinned `actions/checkout` on `pull_request` resolves to
 * `refs/pull/N/merge` and `uses: ./` would then execute PR-controlled code in
 * the same step that holds GH_PAT and four provider keys.
 *
 * The cost of that pin is a CONTENT problem, not just a safety one: the
 * worktree holds base content, so every file a pull request ADDS is absent
 * from disk and the deterministic secret scan cannot read it. Unpinning would
 * close the scanner gap by re-opening code execution — strictly worse — so the
 * proposed blobs are read as DATA instead.
 *
 * These assertions pin the whole shape, because the safe configuration and the
 * unsafe one differ by a single `ref:` line:
 *
 *  - the base pin must survive (SEC-001 must not be traded away);
 *  - the proposed content must be materialized from fetched objects by a
 *    `run:` step, never by a checkout of the PR ref;
 *  - it must land OUTSIDE the checkout that `uses: ./` loads its bundle from;
 *  - and the action step must actually be told where that directory is.
 */
describe('review job proposed-content scan directory', () => {
  const reviewJob = jobs.review ?? {};
  const steps = reviewJob.steps ?? [];

  /** Every `actions/checkout` `with:` block in the job, in step order. */
  function checkoutRefs(): string[] {
    return steps
      .filter((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout'))
      .map((step) => step.with?.ref ?? '<unpinned>');
  }

  /** The step that materializes proposed blobs, located by its scan-only dir. */
  function materializeStep(): WorkflowStep | undefined {
    return steps.find((step) =>
      `${step.run ?? ''}${JSON.stringify(step.env ?? {})}${step.name ?? ''}`.includes(
        'proposed-content',
      ),
    );
  }

  it('keeps the base pin: no checkout of the job may run the PR ref', () => {
    // If this fails, someone "fixed" the secret-scanner gap by executing PR
    // code with credentials in hand. That is SEC-001 and it is worse.
    const refs = checkoutRefs();
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(
        ref,
        'the review job checked out something other than the base sha, so `uses: ./` ' +
          'may execute PR-controlled code while holding GH_PAT and provider keys',
      ).toBe('${{ github.event.pull_request.base.sha }}');
    }
  });

  it('resolves the PR head through a fail-closed resolver, reusing the autofix step id', () => {
    // Same mechanism the autofix job already uses (`steps.resolve-ref.outputs.ref`).
    // One resolver shape in this file, not two that can drift apart.
    const resolver = steps.find((step) => step.id === 'resolve-ref');
    expect(resolver, 'the review job has no `resolve-ref` step').toBeDefined();
    // The sha expression lives in `env:` — `run:` consumes the resolved variable,
    // which is what keeps a mutable branch name out of the script.
    expect((resolver as WorkflowStep).env?.PR_HEAD_SHA).toBe(
      '${{ github.event.pull_request.head.sha }}',
    );
    const script = String((resolver as WorkflowStep).run ?? '');
    expect(script).toContain('"$PR_HEAD_SHA"');
    // Fail closed: never fall back to a mutable branch ref, and never proceed
    // with an unresolvable SHA.
    expect(script).toMatch(/exit 1/);
    expect(script).not.toMatch(/head\.ref/);
  });

  it('materializes proposed blobs with a run: step, never by checking out the PR ref', () => {
    const materialize = materializeStep();
    expect(materialize, 'no step materializes the PR content for scanning').toBeDefined();
    // `run:` means git plumbing only: fetch objects, print blobs. Nothing here
    // installs, builds, or executes PR code.
    expect((materialize as WorkflowStep).uses).toBeUndefined();
    const script = String((materialize as WorkflowStep).run ?? '');
    expect(script).toMatch(/git fetch/);
    expect(script).toMatch(/git show/);
    expect((materialize as WorkflowStep).env?.SCAN_REF).toBe(
      '${{ steps.resolve-ref.outputs.ref }}',
    );
  });

  it('writes the scan-only directory outside the checkout that `uses: ./` loads from', () => {
    const materialize = materializeStep();
    expect(materialize).toBeDefined();
    const script = String((materialize as WorkflowStep).run ?? '');
    const env = (materialize as WorkflowStep).env ?? {};
    // `${{ github.workspace }}` (or a bare relative path) would be INSIDE the
    // checkout, i.e. the very directory `uses: ./` resolves the action from.
    // `${{ runner.temp }}` is outside the workspace entirely.
    expect(env.SCAN_DIR).toContain('${{ runner.temp }}');
    expect(script + JSON.stringify(env)).not.toContain('${{ github.workspace }}');
  });

  it('fails the step closed if the proposed ref cannot be fetched', () => {
    // A silently empty scan-only directory would send every changed file back to
    // base content — the exact state these steps exist to fix — so the fetch
    // must abort the job rather than continue.
    const script = String((materializeStep() as WorkflowStep).run ?? '');
    expect(script).toMatch(/git fetch[\s\S]*?\|\|\s*\n?\s*then|if ! git fetch/);
    expect(script).toMatch(/exit 1/);
  });

  it('hands the scan-only directory to the action so the scanner reads proposed content', () => {
    const actionStep = steps.find((step) => step.uses === './');
    expect(actionStep).toBeDefined();
    const env = (actionStep as WorkflowStep).env ?? {};
    expect(
      env.OPENCODE_PROPOSED_CONTENT_DIR,
      'the action is never told where the proposed content is, so it would keep ' +
        'falling back to base content',
    ).toContain('${{ runner.temp }}');
  });
});
