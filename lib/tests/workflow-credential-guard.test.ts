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
  on?: Record<string, unknown> | string;
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
const jobs = workflow.jobs;

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
 * Fails closed: an unparseable or absent `on:` is treated as declaring every
 * event, so a malformed trigger block cannot quietly empty the exposed set.
 */
function declaresPullRequestTrigger(file: WorkflowFile): boolean {
  const triggers = file.on;
  if (triggers === undefined || triggers === null) return true;
  if (typeof triggers === 'string') return triggers === 'pull_request';
  return Object.keys(triggers).includes('pull_request');
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
